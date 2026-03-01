/**
 * Claude Code CLI integration module.
 *
 * Spawns the `claude` CLI binary as a subprocess and maps its multi-turn
 * streaming JSON output into OMPI agent tool calls. This allows leveraging
 * Claude Code Max subscriptions (200 requests) without requiring separate
 * OAuth credentials - CC CLI manages its own auth.
 *
 * Each CC CLI turn produces an assistant message that may contain tool calls.
 * Those tool calls are executed internally by the CC CLI process. Virtual tools
 * bridge the gap by reading pre-computed results from the CC CLI session so that
 * the OMPI agent loop can render them in the standard TUI.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ClaudeCodeCliProviderOptions,
	ClaudeCodeCliSession,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// CC CLI model definitions
// ---------------------------------------------------------------------------

/** Default CC CLI models. CC CLI picks the actual upstream model internally. */
const CC_CLI_MODELS: Model<"claude-code-cli">[] = [
	{
		id: "claude-code-cli",
		name: "Claude Code CLI",
		api: "claude-code-cli" as Api as "claude-code-cli",
		provider: "claude-code",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
	},
	{
		id: "claude-code-cli/sonnet",
		name: "Claude Code CLI (Sonnet)",
		api: "claude-code-cli" as Api as "claude-code-cli",
		provider: "claude-code",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
	},
	{
		id: "claude-code-cli/opus",
		name: "Claude Code CLI (Opus)",
		api: "claude-code-cli" as Api as "claude-code-cli",
		provider: "claude-code",
		baseUrl: "",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
	},
];

/**
 * Extract the CC CLI model name from a model ID.
 * e.g. "claude-code-cli/sonnet" -> "sonnet", "claude-code-cli" -> undefined
 */
function extractCcCliModelName(modelId: string): string | undefined {
	const slash = modelId.indexOf("/");
	if (slash === -1) return undefined;
	return modelId.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Check if the `claude` CLI binary is available on PATH.
 */
export function isClaudeCodeCliAvailable(): boolean {
	return Bun.which("claude") !== null;
}

/**
 * Get CC CLI model definitions if the binary is available.
 */
export function discoverClaudeCodeCliModels(): Model<Api>[] {
	if (!isClaudeCodeCliAvailable()) {
		return [];
	}
	return CC_CLI_MODELS as Model<Api>[];
}

// ---------------------------------------------------------------------------
// Virtual tool factory
// ---------------------------------------------------------------------------

/** CC CLI session key used in providerSessionState map. */
const CC_SESSION_KEY = "claude-code-cli-session";

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

/**
 * Create OMPI-compatible AgentTools that proxy CC CLI tool execution.
 *
 * Uses a lazy getter to resolve the providerSessionState from the AgentSession
 * after it is created. This avoids needing the session map at tool creation time.
 *
 * When the agent loop sees tool calls from a CC CLI assistant message,
 * these virtual tools read the pre-computed results from the CC CLI session's
 * ToolResultStore instead of executing the tools locally.
 */
export function createCcCliVirtualTools(getProviderSessionState: () => Map<string, ProviderSessionState>): AgentTool[] {
	return CC_CLI_TOOL_NAMES.map(toolName => ({
		name: toolName,
		label: `CC: ${toolName}`,
		description: `Claude Code CLI tool: ${toolName}. Executed internally by CC CLI subprocess.`,
		parameters: Type.Object({}, { additionalProperties: true }),
		lenientArgValidation: true,
		concurrency: "shared" as const,
		async execute(toolCallId: string, _params: unknown, _signal?: AbortSignal): Promise<AgentToolResult> {
			const sessionState = getProviderSessionState();
			const session = sessionState.get(CC_SESSION_KEY) as ClaudeCodeCliSession | undefined;

			if (!session) {
				return {
					content: [{ type: "text", text: "Claude Code CLI session is not active." }],
					details: { source: "claude-code-cli", toolName },
				};
			}

			const result = await session.getToolResult(toolCallId);

			return {
				content: [{ type: "text", text: result.content }],
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
// Integration options
// ---------------------------------------------------------------------------

export interface CcCliIntegrationOptions {
	/** CC CLI model name override (e.g. "sonnet", "opus"). */
	ccCliModel?: string;
	/** Maximum agentic turns. */
	maxTurns?: number;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Path to `claude` binary. Default: "claude" (uses PATH). */
	binaryPath?: string;
	/** Allow CC CLI tool execution without prompts. Default: true */
	allowPermissions?: boolean;
}

/**
 * Check if a model is a CC CLI model.
 */
export function isCcCliModel(model: Model<Api> | undefined): boolean {
	return model?.api === "claude-code-cli";
}

/**
 * Build CC CLI session options from a model definition and integration options.
 */
export function buildCcCliSessionOptions(
	model: Model<Api>,
	options?: CcCliIntegrationOptions,
): ClaudeCodeCliProviderOptions {
	const ccModel = extractCcCliModelName(model.id) ?? options?.ccCliModel;
	return {
		model: ccModel,
		maxTurns: options?.maxTurns,
		cwd: options?.cwd,
		binaryPath: options?.binaryPath,
		allowPermissions: options?.allowPermissions ?? true,
	};
}
