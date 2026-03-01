/**
 * Claude Code CLI provider.
 *
 * Spawns the `claude` CLI binary as a subprocess and parses its streaming JSON
 * output (`--output-format stream-json`). Each CC CLI turn is mapped to an OMPI
 * `AssistantMessage` so that the agent loop can display tool calls and text in
 * the standard UI.
 *
 * Designed to leverage Claude Code Max subscriptions (200 requests) without
 * requiring separate OAuth credentials — CC CLI manages its own auth.
 *
 * Usage:
 * ```ts
 * const cc = createClaudeCodeCliProvider({ model: "sonnet" });
 * const agent = new Agent({
 *   streamFn: cc.streamFn,
 *   initialState: { model: cc.model, tools: cc.tools },
 * });
 * await agent.prompt("Fix the auth bug");
 * ```
 */
import type { Subprocess } from "bun";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	Provider,
	ProviderSessionState,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

// ---------------------------------------------------------------------------
// CC CLI event types (stream-json output)
// ---------------------------------------------------------------------------

interface CcCliSystemEvent {
	type: "system";
	subtype: "init";
	session_id?: string;
	tools?: string[];
	model?: string;
}

interface CcCliAssistantContentText {
	type: "text";
	text: string;
}

interface CcCliAssistantContentThinking {
	type: "thinking";
	thinking: string;
}

interface CcCliAssistantContentToolUse {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

type CcCliAssistantContent = CcCliAssistantContentText | CcCliAssistantContentThinking | CcCliAssistantContentToolUse;

interface CcCliAssistantMessage {
	id: string;
	type: "message";
	role: "assistant";
	content: CcCliAssistantContent[];
	model: string;
	stop_reason: string;
	stop_sequence?: string | null;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

interface CcCliAssistantEvent {
	type: "assistant";
	message: CcCliAssistantMessage;
	session_id?: string;
}

interface CcCliToolResultEvent {
	type: "tool_result";
	tool_use_id?: string;
	content?: string | Array<{ type: string; text?: string }>;
	is_error?: boolean;
	// Nested shape used by some CC CLI versions
	tool_result?: {
		type: "tool_result";
		tool_use_id: string;
		content: string | Array<{ type: string; text?: string }>;
		is_error?: boolean;
	};
}

interface CcCliResultEvent {
	type: "result";
	subtype: "success" | "error";
	result?: string;
	session_id?: string;
	cost_usd?: number;
	is_error?: boolean;
	duration_ms?: number;
	duration_api_ms?: number;
	num_turns?: number;
}

type CcCliEvent =
	| CcCliSystemEvent
	| CcCliAssistantEvent
	| CcCliToolResultEvent
	| CcCliResultEvent
	| Record<string, unknown>;

// ---------------------------------------------------------------------------
// Async primitives
// ---------------------------------------------------------------------------

/** Simple async FIFO channel. */
class AsyncChannel<T> {
	#buffer: T[] = [];
	#waiters: Array<(value: T | null) => void> = [];
	#closed = false;

	send(value: T): void {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter(value);
		} else {
			this.#buffer.push(value);
		}
	}

	async receive(): Promise<T | null> {
		if (this.#buffer.length > 0) return this.#buffer.shift()!;
		if (this.#closed) return null;
		return new Promise<T | null>(resolve => this.#waiters.push(resolve));
	}

	close(): void {
		this.#closed = true;
		for (const waiter of this.#waiters) waiter(null);
		this.#waiters = [];
	}
}

/** Keyed async store — put a value by key, get waits until available. */
class ToolResultStore {
	#results = new Map<string, CcCliResolvedToolResult>();
	#waiters = new Map<string, (result: CcCliResolvedToolResult) => void>();
	#closed = false;

	put(toolUseId: string, result: CcCliResolvedToolResult): void {
		const waiter = this.#waiters.get(toolUseId);
		if (waiter) {
			this.#waiters.delete(toolUseId);
			waiter(result);
		} else {
			this.#results.set(toolUseId, result);
		}
	}

	async get(toolUseId: string): Promise<CcCliResolvedToolResult> {
		const buffered = this.#results.get(toolUseId);
		if (buffered) {
			this.#results.delete(toolUseId);
			return buffered;
		}
		if (this.#closed) {
			return { content: "Claude Code CLI session closed", isError: true };
		}
		return new Promise<CcCliResolvedToolResult>(resolve => {
			this.#waiters.set(toolUseId, resolve);
		});
	}

	close(): void {
		this.#closed = true;
		const placeholder: CcCliResolvedToolResult = {
			content: "Claude Code CLI session closed",
			isError: true,
		};
		for (const [, waiter] of this.#waiters) waiter(placeholder);
		this.#waiters.clear();
	}
}

interface CcCliResolvedToolResult {
	content: string;
	isError: boolean;
}

// ---------------------------------------------------------------------------
// CC CLI session — manages the subprocess lifecycle
// ---------------------------------------------------------------------------

export interface ClaudeCodeCliSessionOptions {
	/** CC CLI model override (e.g. "sonnet", "opus"). */
	model?: string;
	/** Maximum agentic turns CC CLI is allowed to take. */
	maxTurns?: number;
	/** Working directory for CC CLI. Default: process.cwd() */
	cwd?: string;
	/** Additional CLI flags to pass to `claude`. */
	extraArgs?: string[];
	/** Path to `claude` binary. Default: "claude" (uses PATH). */
	binaryPath?: string;
	/** Whether to allow CC CLI to execute tools (--dangerously-skip-permissions). Default: false */
	allowPermissions?: boolean;
}

export class ClaudeCodeCliSession implements ProviderSessionState {
	readonly #assistantChannel: AsyncChannel<CcCliAssistantEvent>;
	readonly #toolResultStore: ToolResultStore;
	readonly #resultChannel: AsyncChannel<CcCliResultEvent>;

	#process: Subprocess | null = null;
	#sessionId?: string;
	#availableTools: string[] = [];
	#readerPromise: Promise<void> | null = null;
	#stderr = "";
	#closed = false;

	constructor(prompt: string, options?: ClaudeCodeCliSessionOptions) {
		this.#assistantChannel = new AsyncChannel();
		this.#toolResultStore = new ToolResultStore();
		this.#resultChannel = new AsyncChannel();

		this.#spawn(prompt, options);
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	get availableTools(): string[] {
		return this.#availableTools;
	}

	// -- public API ----------------------------------------------------------

	/** Get the next assistant response from CC CLI. Returns null when session ends. */
	async nextAssistantEvent(): Promise<CcCliAssistantEvent | null> {
		return this.#assistantChannel.receive();
	}

	/** Get a tool result by tool_use_id. Blocks until available. */
	async getToolResult(toolUseId: string): Promise<CcCliResolvedToolResult> {
		return this.#toolResultStore.get(toolUseId);
	}

	/** Get the session result (final summary). Returns null if not yet available. */
	async getResult(): Promise<CcCliResultEvent | null> {
		return this.#resultChannel.receive();
	}

	/** Kill the subprocess and clean up. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#process?.kill();
		} catch {}
		this.#assistantChannel.close();
		this.#toolResultStore.close();
		this.#resultChannel.close();
	}

	// -- private -------------------------------------------------------------

	#spawn(prompt: string, options?: ClaudeCodeCliSessionOptions): void {
		const bin = options?.binaryPath || "claude";
		const args = [bin, "-p", prompt, "--output-format", "stream-json"];

		if (options?.model) {
			args.push("--model", options.model);
		}
		if (options?.maxTurns) {
			args.push("--max-turns", String(options.maxTurns));
		}
		if (options?.allowPermissions) {
			args.push("--dangerously-skip-permissions");
		}
		if (options?.extraArgs) {
			args.push(...options.extraArgs);
		}

		this.#process = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "pipe",
			cwd: options?.cwd,
		});

		// Read stderr in background
		this.#readStderr();
		// Read stdout events in background
		this.#readerPromise = this.#readEvents();
	}

	async #readStderr(): Promise<void> {
		if (!this.#process?.stderr) return;
		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.#stderr += decoder.decode(value, { stream: true });
			}
		} catch {}
	}

	async #readEvents(): Promise<void> {
		if (!this.#process?.stdout) {
			this.#assistantChannel.close();
			return;
		}

		const reader = this.#process.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop()!; // Keep incomplete last line

				for (const line of lines) {
					this.#parseLine(line);
				}
			}

			// Handle remaining buffer
			if (buffer.trim()) {
				this.#parseLine(buffer);
			}
		} catch (err) {
			// Stream read error — session is done
		} finally {
			this.#assistantChannel.close();
			this.#resultChannel.close();
			this.#toolResultStore.close();
		}
	}

	#parseLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let event: CcCliEvent;
		try {
			event = JSON.parse(trimmed);
		} catch {
			return; // Skip malformed lines
		}

		this.#routeEvent(event);
	}

	#routeEvent(event: CcCliEvent): void {
		switch (event.type) {
			case "system":
				this.#handleSystem(event as CcCliSystemEvent);
				break;
			case "assistant":
				this.#assistantChannel.send(event as CcCliAssistantEvent);
				break;
			case "tool_result":
				this.#handleToolResult(event as CcCliToolResultEvent);
				break;
			case "result":
				this.#resultChannel.send(event as CcCliResultEvent);
				break;
			// Ignore: tool_use (echoed from assistant), content_block_*, message_*
		}
	}

	#handleSystem(event: CcCliSystemEvent): void {
		if (event.session_id) this.#sessionId = event.session_id;
		if (event.tools) this.#availableTools = event.tools;
	}

	#handleToolResult(event: CcCliToolResultEvent): void {
		// CC CLI may use two shapes for tool results
		const toolUseId = event.tool_use_id ?? event.tool_result?.tool_use_id;
		if (!toolUseId) return;

		const rawContent = event.content ?? event.tool_result?.content ?? "";
		const isError = event.is_error ?? event.tool_result?.is_error ?? false;

		let content: string;
		if (typeof rawContent === "string") {
			content = rawContent;
		} else if (Array.isArray(rawContent)) {
			content = rawContent.map(b => (typeof b === "string" ? b : (b.text ?? JSON.stringify(b)))).join("\n");
		} else {
			content = JSON.stringify(rawContent);
		}

		this.#toolResultStore.put(toolUseId, { content, isError });
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapCcCliStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "stop_sequence":
			return "stop";
		default:
			return "stop";
	}
}

function extractUserPrompt(messages: Context["messages"]): string | undefined {
	// Walk backwards to find the last user message
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") return msg.content;
			if (Array.isArray(msg.content)) {
				return msg.content
					.filter((b): b is TextContent => b.type === "text")
					.map(b => b.text)
					.join("\n");
			}
		}
	}
	return undefined;
}

function buildUsage(ccUsage?: CcCliAssistantMessage["usage"]): Usage {
	const input = ccUsage?.input_tokens ?? 0;
	const output = ccUsage?.output_tokens ?? 0;
	const cacheRead = ccUsage?.cache_read_input_tokens ?? 0;
	const cacheWrite = ccUsage?.cache_creation_input_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function convertCcCliAssistantMessage(ccMsg: CcCliAssistantMessage, model: Model): AssistantMessage {
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];

	for (const block of ccMsg.content) {
		switch (block.type) {
			case "text":
				content.push({ type: "text", text: block.text });
				break;
			case "thinking":
				content.push({ type: "thinking", thinking: block.thinking });
				break;
			case "tool_use":
				content.push({
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: block.input ?? {},
				});
				break;
		}
	}

	const hasToolCalls = content.some(b => b.type === "toolCall");

	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: ccMsg.model || model.id,
		usage: buildUsage(ccMsg.usage),
		stopReason: hasToolCalls ? "toolUse" : mapCcCliStopReason(ccMsg.stop_reason),
		timestamp: Date.now(),
	};
}

function createEmptyAssistantMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: buildUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createErrorAssistantMessage(model: Model, error: Error | string): AssistantMessage {
	const msg = typeof error === "string" ? error : error.message;
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: buildUsage(),
		stopReason: "error",
		errorMessage: msg,
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Stream function — called once per agent loop turn
// ---------------------------------------------------------------------------

const CC_SESSION_KEY = "claude-code-cli-session";

export interface ClaudeCodeCliStreamOptions extends SimpleStreamOptions {
	/** Options for the CC CLI session (used on first turn). */
	ccCliOptions?: ClaudeCodeCliSessionOptions;
}

/**
 * Create a `StreamFn` that routes to Claude Code CLI.
 *
 * The returned function maintains a persistent CC CLI session across multiple
 * agent loop turns. On the first call, it extracts the user prompt from the
 * context, spawns CC CLI, and reads the first assistant response. On subsequent
 * calls, it reads the next response from the existing session.
 */
export function streamClaudeCodeCli(
	model: Model,
	context: Context,
	options?: ClaudeCodeCliStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();

		try {
			// Retrieve or create session
			const sessionState = options?.providerSessionState ?? new Map<string, ProviderSessionState>();
			let session = sessionState.get(CC_SESSION_KEY) as ClaudeCodeCliSession | undefined;

			if (!session) {
				// First turn — extract prompt and spawn CC CLI
				const prompt = extractUserPrompt(context.messages);
				if (!prompt) {
					throw new Error("No user message found in context. Cannot start Claude Code CLI session.");
				}

				// Resolve CC CLI model: explicit ccCliOptions.model takes priority,
				// otherwise extract variant from model ID (e.g. "claude-code-cli/sonnet" → "sonnet")
				let ccCliModel = options?.ccCliOptions?.model;
				if (!ccCliModel && model.id.includes("/")) {
					ccCliModel = model.id.split("/").pop();
				}

				session = new ClaudeCodeCliSession(prompt, {
					model: ccCliModel,
					maxTurns: options?.ccCliOptions?.maxTurns,
					cwd: options?.ccCliOptions?.cwd,
					extraArgs: options?.ccCliOptions?.extraArgs,
					binaryPath: options?.ccCliOptions?.binaryPath,
					allowPermissions: options?.ccCliOptions?.allowPermissions ?? true,
				});
				sessionState.set(CC_SESSION_KEY, session);
			}

			// Read next assistant response
			const assistantEvent = await session.nextAssistantEvent();

			if (!assistantEvent) {
				// Session ended — no more assistant messages
				const output = createEmptyAssistantMessage(model);
				output.duration = Date.now() - startTime;
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();

				// Clean up session
				session.close();
				sessionState.delete(CC_SESSION_KEY);
				return;
			}

			// Convert CC CLI message to OMPI format
			const output = convertCcCliAssistantMessage(assistantEvent.message, model);
			stream.push({ type: "start", partial: output });

			// Emit content blocks for UI rendering
			for (let i = 0; i < output.content.length; i++) {
				const block = output.content[i];
				switch (block.type) {
					case "text":
						stream.push({ type: "text_start", contentIndex: i, partial: output });
						stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: output });
						stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output });
						break;
					case "thinking":
						stream.push({ type: "thinking_start", contentIndex: i, partial: output });
						stream.push({ type: "thinking_delta", contentIndex: i, delta: block.thinking, partial: output });
						stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: output });
						break;
					case "toolCall":
						stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: i,
							delta: JSON.stringify(block.arguments),
							partial: output,
						});
						stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: output });
						break;
				}
			}

			output.duration = Date.now() - startTime;

			if (output.stopReason === "toolUse") {
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else {
				stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
				// If no tool calls and session is done, clean up on next call
			}

			stream.end();
		} catch (error: any) {
			const output = createErrorAssistantMessage(model, error);
			output.duration = Date.now() - startTime;
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();

			// Clean up session on error
			const sessionState = options?.providerSessionState;
			const session = sessionState?.get(CC_SESSION_KEY) as ClaudeCodeCliSession | undefined;
			session?.close();
			sessionState?.delete(CC_SESSION_KEY);
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Virtual tools — proxy OMPI tool calls to CC CLI tool results
// ---------------------------------------------------------------------------

/** Well-known CC CLI tool names. */
const CC_CLI_TOOL_NAMES = [
	"Read",
	"Write",
	"Edit",
	"MultiEdit",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	"TodoRead",
	"TodoWrite",
	"Agent",
	"NotebookRead",
	"NotebookEdit",
	"AskFollowupQuestion",
] as const;

export interface ClaudeCodeCliVirtualToolOptions {
	/** Reference to the providerSessionState map for session lookup. */
	providerSessionState: Map<string, ProviderSessionState>;
}

/**
 * Create virtual tools that proxy OMPI tool execution to CC CLI session results.
 *
 * When the agent loop sees tool calls from CC CLI, it executes these virtual
 * tools. Each tool reads the corresponding result from the CC CLI session's
 * buffered tool results.
 */
export function createClaudeCodeCliTools(options: ClaudeCodeCliVirtualToolOptions) {
	const { providerSessionState } = options;

	const getSession = (): ClaudeCodeCliSession | undefined => {
		return providerSessionState.get(CC_SESSION_KEY) as ClaudeCodeCliSession | undefined;
	};

	return CC_CLI_TOOL_NAMES.map(toolName => ({
		name: toolName,
		label: `CC: ${toolName}`,
		description: `Claude Code CLI tool: ${toolName}. Executed internally by CC CLI subprocess.`,
		parameters: {
			type: "object" as const,
			properties: {} as Record<string, unknown>,
			additionalProperties: true,
		},
		lenientArgValidation: true,
		concurrency: "shared" as const,
		execute: async (toolCallId: string, _params: Record<string, unknown>, _signal?: AbortSignal) => {
			const session = getSession();
			if (!session) {
				return {
					content: [{ type: "text" as const, text: "Claude Code CLI session is not active." }],
					details: { source: "claude-code-cli", toolName },
				};
			}

			const result = await session.getToolResult(toolCallId);

			return {
				content: [{ type: "text" as const, text: result.content }],
				details: {
					source: "claude-code-cli",
					toolName,
					isError: result.isError,
				},
			};
		},
	}));
}

// ---------------------------------------------------------------------------
// High-level provider factory
// ---------------------------------------------------------------------------

export interface ClaudeCodeCliProviderOptions {
	/** CC CLI model to use. If not set, CC CLI uses its configured default. */
	model?: string;
	/** Maximum agentic turns. Default: no limit. */
	maxTurns?: number;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Path to the `claude` binary. Default: "claude" (uses PATH). */
	binaryPath?: string;
	/** Additional CLI flags. */
	extraArgs?: string[];
	/** Allow CC CLI tool execution without prompts. Default: false */
	allowPermissions?: boolean;
}

export interface ClaudeCodeCliProvider {
	/** Custom StreamFn for the Agent constructor. */
	streamFn: (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Virtual tools that bridge OMPI tool execution to CC CLI. */
	tools: ReturnType<typeof createClaudeCodeCliTools>;
	/** Model definition for CC CLI. */
	model: Model;
	/** Shared session state (pass to Agent's providerSessionState). */
	providerSessionState: Map<string, ProviderSessionState>;
	/** Terminate the active CC CLI session. */
	resetSession: () => void;
}

/**
 * Create a complete CC CLI provider bundle — streamFn + tools + model.
 *
 * ```ts
 * const cc = createClaudeCodeCliProvider({ model: "sonnet" });
 * const agent = new Agent({
 *   streamFn: cc.streamFn,
 *   initialState: {
 *     model: cc.model,
 *     tools: cc.tools,
 *     systemPrompt: "You are a coding assistant.",
 *   },
 *   providerSessionState: cc.providerSessionState,
 * });
 * await agent.prompt("Fix the bug in auth.ts");
 * cc.resetSession();
 * ```
 */
export function createClaudeCodeCliProvider(options?: ClaudeCodeCliProviderOptions): ClaudeCodeCliProvider {
	const providerSessionState = new Map<string, ProviderSessionState>();

	const ccCliOptions: ClaudeCodeCliSessionOptions = {
		model: options?.model,
		maxTurns: options?.maxTurns,
		cwd: options?.cwd,
		binaryPath: options?.binaryPath,
		extraArgs: options?.extraArgs,
		allowPermissions: options?.allowPermissions,
	};

	const modelDef: Model = {
		id: options?.model || "claude-code-cli",
		name: "Claude Code CLI",
		api: "claude-code-cli" as Api,
		provider: "claude-code" as Provider,
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
	};

	const streamFn = (model: Model, context: Context, streamOptions?: SimpleStreamOptions) => {
		return streamClaudeCodeCli(model, context, {
			...streamOptions,
			providerSessionState,
			ccCliOptions,
		});
	};

	const tools = createClaudeCodeCliTools({ providerSessionState });

	return {
		streamFn,
		tools,
		model: modelDef,
		providerSessionState,
		resetSession: () => {
			const session = providerSessionState.get(CC_SESSION_KEY) as ClaudeCodeCliSession | undefined;
			session?.close();
			providerSessionState.delete(CC_SESSION_KEY);
		},
	};
}
