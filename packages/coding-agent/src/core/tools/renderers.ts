/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getLanguageFromPath, type Theme } from "../../modes/interactive/theme/theme";
import type { RenderResultOptions } from "../custom-tools/types";
import type { AskToolDetails } from "./ask";
import type { FindToolDetails } from "./find";
import type { GrepToolDetails } from "./grep";
import type { LsToolDetails } from "./ls";
import { renderCall as renderLspCall, renderResult as renderLspResult } from "./lsp/render";
import type { LspToolDetails } from "./lsp/types";
import type { NotebookToolDetails } from "./notebook";
import type { OutputToolDetails } from "./output";
import { renderCall as renderTaskCall, renderResult as renderTaskResult } from "./task/render";
import type { TaskToolDetails } from "./task/types";
import { renderWebFetchCall, renderWebFetchResult, type WebFetchToolDetails } from "./web-fetch";
import { renderWebSearchCall, renderWebSearchResult, type WebSearchRenderDetails } from "./web-search/render";

// Tree drawing characters

interface ToolRenderer<TArgs = any, TDetails = any> {
	renderCall(args: TArgs, theme: Theme): Component;
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TDetails },
		options: RenderResultOptions,
		theme: Theme,
	): Component;
}

// ============================================================================
// Grep Renderer
// ============================================================================

interface GrepArgs {
	pattern: string;
	path?: string;
	glob?: string;
	type?: string;
	ignoreCase?: boolean;
	caseSensitive?: boolean;
	literal?: boolean;
	multiline?: boolean;
	context?: number;
	limit?: number;
	outputMode?: string;
}

const grepRenderer: ToolRenderer<GrepArgs, GrepToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("grep "));
		text += theme.fg("accent", args.pattern || "?");

		const meta: string[] = [];
		if (args.path) meta.push(args.path);
		if (args.glob) meta.push(`glob:${args.glob}`);
		if (args.type) meta.push(`type:${args.type}`);
		if (args.outputMode && args.outputMode !== "files_with_matches") meta.push(args.outputMode);
		if (args.caseSensitive) {
			meta.push("--case-sensitive");
		} else if (args.ignoreCase) {
			meta.push("-i");
		}
		if (args.multiline) meta.push("multiline");

		if (meta.length > 0) {
			text += ` ${theme.fg("muted", meta.join(" "))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;

		// Error case
		if (details?.error) {
			return new Text(`${theme.styledSymbol("status.error", "error")} ${theme.fg("error", details.error)}`, 0, 0);
		}

		// Check for detailed rendering data - fall back to structured output if not available
		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.content?.find((c) => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(
					`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", "No matches found")}`,
					0,
					0,
				);
			}

			const lines = textContent.split("\n").filter((line) => line.trim() !== "");
			const maxLines = expanded ? lines.length : 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			let text = `${theme.styledSymbol("status.success", "success")} ${theme.fg("toolTitle", "grep")} ${theme.fg(
				"dim",
				`${lines.length} item${lines.length !== 1 ? "s" : ""}`,
			)}`;

			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg("toolOutput", displayLines[i])}`;
			}

			if (remaining > 0) {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					`${theme.format.ellipsis} ${remaining} more items`,
				)}`;
			}
			return new Text(text, 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const mode = details?.mode ?? "files_with_matches";
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		// No matches
		if (matchCount === 0) {
			return new Text(
				`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", "No matches found")}`,
				0,
				0,
			);
		}

		// Build summary
		const icon = theme.styledSymbol("status.success", "success");
		let summary: string;
		if (mode === "files_with_matches") {
			summary = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		} else if (mode === "count") {
			summary = `${matchCount} match${matchCount !== 1 ? "es" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		} else {
			summary = `${matchCount} match${matchCount !== 1 ? "es" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		}

		if (truncated) {
			summary += theme.fg("warning", " (truncated)");
		}

		const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
		const scopeLabel = details?.scopePath ? ` ${theme.fg("muted", `in ${details.scopePath}`)}` : "";
		let text = `${icon} ${theme.fg("toolTitle", "grep")} ${theme.fg("dim", summary)}${scopeLabel}${expandHint}`;

		const truncationReasons: string[] = [];
		if (details?.matchLimitReached) {
			truncationReasons.push(`limit ${details.matchLimitReached} matches`);
		}
		if (details?.headLimitReached) {
			truncationReasons.push(`head limit ${details.headLimitReached}`);
		}
		if (details?.truncation?.truncated) {
			truncationReasons.push("size limit");
		}
		if (details?.linesTruncated) {
			truncationReasons.push("line length");
		}

		const fileEntries: Array<{ path: string; count?: number }> = details?.fileMatches?.length
			? details.fileMatches.map((entry) => ({ path: entry.path, count: entry.count }))
			: files.map((path) => ({ path }));

		// Show file tree if we have files
		if (fileEntries.length > 0) {
			const maxFiles = expanded ? fileEntries.length : Math.min(fileEntries.length, 8);
			for (let i = 0; i < maxFiles; i++) {
				const entry = fileEntries[i];
				const isLast = i === maxFiles - 1 && (expanded || fileEntries.length <= 8);
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				const isDir = entry.path.endsWith("/");
				const entryPath = isDir ? entry.path.slice(0, -1) : entry.path;
				const lang = isDir ? undefined : getLanguageFromPath(entryPath);
				const entryIcon = isDir
					? theme.fg("accent", theme.icon.folder)
					: theme.fg("muted", theme.getLangIcon(lang));
				const countLabel =
					entry.count !== undefined
						? ` ${theme.fg("dim", `(${entry.count} match${entry.count !== 1 ? "es" : ""})`)}`
						: "";
				text += `\n ${theme.fg("dim", branch)} ${entryIcon} ${theme.fg("accent", entry.path)}${countLabel}`;
			}

			if (!expanded && fileEntries.length > 8) {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					`${theme.format.ellipsis} ${fileEntries.length - 8} more files`,
				)}`;
			}
		}

		if (truncationReasons.length > 0) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"warning",
				`truncated: ${truncationReasons.join(", ")}`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Find Renderer
// ============================================================================

interface FindArgs {
	pattern: string;
	path?: string;
	type?: string;
	hidden?: boolean;
	sortByMtime?: boolean;
	limit?: number;
}

const findRenderer: ToolRenderer<FindArgs, FindToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("find "));
		text += theme.fg("accent", args.pattern || "*");

		const meta: string[] = [];
		if (args.path) meta.push(args.path);
		if (args.type && args.type !== "all") meta.push(`type:${args.type}`);
		if (args.hidden) meta.push("--hidden");

		if (meta.length > 0) {
			text += ` ${theme.fg("muted", meta.join(" "))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;

		// Error case
		if (details?.error) {
			return new Text(`${theme.styledSymbol("status.error", "error")} ${theme.fg("error", details.error)}`, 0, 0);
		}

		// Check for detailed rendering data - fall back to parsing raw output if not available
		const hasDetailedData = details?.fileCount !== undefined;

		// Get text content for fallback or to extract file list
		const textContent = result.content?.find((c) => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (!textContent || textContent.includes("No files matching") || textContent.trim() === "") {
				return new Text(
					`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", "No files found")}`,
					0,
					0,
				);
			}

			// Parse the raw output as file list
			const lines = textContent.split("\n").filter((l) => l.trim());
			const maxLines = expanded ? lines.length : Math.min(lines.length, 8);
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			let text = `${theme.styledSymbol("status.success", "success")} ${theme.fg("toolTitle", "find")} ${theme.fg(
				"dim",
				`${lines.length} file${lines.length !== 1 ? "s" : ""}`,
			)}`;
			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", displayLines[i])}`;
			}
			if (remaining > 0) {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					`${theme.format.ellipsis} ${remaining} more files`,
				)}`;
			}
			return new Text(text, 0, 0);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		// No matches
		if (fileCount === 0) {
			return new Text(
				`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", "No files found")}`,
				0,
				0,
			);
		}

		// Build summary
		const icon = theme.styledSymbol("status.success", "success");
		let summary = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;

		if (truncated) {
			summary += theme.fg("warning", " (truncated)");
		}

		const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
		const scopeLabel = details?.scopePath ? ` ${theme.fg("muted", `in ${details.scopePath}`)}` : "";
		let text = `${icon} ${theme.fg("toolTitle", "find")} ${theme.fg("dim", summary)}${scopeLabel}${expandHint}`;

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) {
			truncationReasons.push(`limit ${details.resultLimitReached} results`);
		}
		if (details?.truncation?.truncated) {
			truncationReasons.push("size limit");
		}

		// Show file tree if we have files
		if (files.length > 0) {
			const maxFiles = expanded ? files.length : Math.min(files.length, 8);
			for (let i = 0; i < maxFiles; i++) {
				const isLast = i === maxFiles - 1 && (expanded || files.length <= 8);
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				const entry = files[i];
				const isDir = entry.endsWith("/");
				const entryPath = isDir ? entry.slice(0, -1) : entry;
				const lang = isDir ? undefined : getLanguageFromPath(entryPath);
				const entryIcon = isDir
					? theme.fg("accent", theme.icon.folder)
					: theme.fg("muted", theme.getLangIcon(lang));
				text += `\n ${theme.fg("dim", branch)} ${entryIcon} ${theme.fg("accent", entry)}`;
			}

			if (!expanded && files.length > 8) {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					`${theme.format.ellipsis} ${files.length - 8} more files`,
				)}`;
			}
		}

		if (truncationReasons.length > 0) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"warning",
				`truncated: ${truncationReasons.join(", ")}`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Notebook Renderer
// ============================================================================

interface NotebookArgs {
	action: string;
	notebookPath: string;
	cellNumber?: number;
	cellType?: string;
	content?: string;
}

function normalizeCellLines(lines: string[]): string[] {
	return lines.map((line) => (line.endsWith("\n") ? line.slice(0, -1) : line));
}

function renderCellPreview(lines: string[], expanded: boolean, theme: Theme): string {
	const normalized = normalizeCellLines(lines);
	if (normalized.length === 0) {
		return `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "(empty cell)")}`;
	}

	const maxLines = expanded ? normalized.length : Math.min(normalized.length, 6);
	let text = "";

	for (let i = 0; i < maxLines; i++) {
		const isLast = i === maxLines - 1 && (expanded || normalized.length <= maxLines);
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		const line = normalized[i];
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("toolOutput", line)}`;
	}

	const remaining = normalized.length - maxLines;
	if (remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
			"muted",
			`${theme.format.ellipsis} ${remaining} more lines`,
		)}`;
	}

	return text;
}

const notebookRenderer: ToolRenderer<NotebookArgs, NotebookToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("notebook "));
		text += theme.fg("accent", args.action || "?");

		const meta: string[] = [];
		meta.push(args.notebookPath || "?");
		if (args.cellNumber !== undefined) meta.push(`cell:${args.cellNumber}`);
		if (args.cellType) meta.push(args.cellType);

		if (meta.length > 0) {
			text += ` ${theme.fg("muted", meta.join(" "))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;

		// Error case - check for error in content
		const content = result.content?.[0];
		if (content?.type === "text" && content.text?.startsWith("Error:")) {
			return new Text(`${theme.styledSymbol("status.error", "error")} ${theme.fg("error", content.text)}`, 0, 0);
		}

		const action = details?.action ?? "edit";
		const cellIndex = details?.cellIndex;
		const cellType = details?.cellType;
		const totalCells = details?.totalCells;
		const cellSource = details?.cellSource;
		const lineCount = cellSource?.length;
		const canExpand = cellSource !== undefined && cellSource.length > 6;

		// Build summary
		const icon = theme.styledSymbol("status.success", "success");
		let summary: string;

		switch (action) {
			case "insert":
				summary = `Inserted ${cellType || "cell"} at index ${cellIndex}`;
				break;
			case "delete":
				summary = `Deleted cell at index ${cellIndex}`;
				break;
			default:
				summary = `Edited ${cellType || "cell"} at index ${cellIndex}`;
		}

		if (lineCount !== undefined) {
			summary += ` (${lineCount} line${lineCount !== 1 ? "s" : ""})`;
		}

		if (totalCells !== undefined) {
			summary += ` (${totalCells} total)`;
		}

		const expandHint = !expanded && canExpand ? theme.fg("dim", " (Ctrl+O to expand)") : "";
		let text = `${icon} ${theme.fg("toolTitle", "notebook")} ${theme.fg("dim", summary)}${expandHint}`;

		if (cellSource) {
			text += renderCellPreview(cellSource, expanded, theme);
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Ask Renderer
// ============================================================================

interface AskArgs {
	question: string;
	options?: Array<{ label: string }>;
	multi?: boolean;
}

const askRenderer: ToolRenderer<AskArgs, AskToolDetails> = {
	renderCall(args, theme) {
		if (!args.question) {
			return new Text(theme.fg("error", "ask: no question provided"), 0, 0);
		}

		const multiTag = args.multi ? theme.fg("muted", " [multi-select]") : "";
		let text = theme.fg("toolTitle", "? ") + theme.fg("accent", args.question) + multiTag;

		if (args.options?.length) {
			for (const opt of args.options) {
				text += `\n${theme.fg("dim", `  ${theme.checkbox.unchecked} `)}${theme.fg("muted", opt.label)}`;
			}
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, _opts, theme) {
		const { details } = result;
		if (!details) {
			const txt = result.content[0];
			return new Text(txt?.type === "text" && txt.text ? txt.text : "", 0, 0);
		}

		const hasSelection = details.customInput || details.selectedOptions.length > 0;
		const statusIcon = hasSelection
			? theme.styledSymbol("status.success", "success")
			: theme.styledSymbol("status.warning", "warning");

		let text = `${statusIcon} ${theme.fg("toolTitle", "ask")} ${theme.fg("accent", details.question)}`;

		if (details.customInput) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.styledSymbol(
				"status.success",
				"success",
			)} ${theme.fg("toolOutput", details.customInput)}`;
		} else if (details.selectedOptions.length > 0) {
			const selected = details.selectedOptions;
			for (let i = 0; i < selected.length; i++) {
				const isLast = i === selected.length - 1;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg(
					"success",
					theme.checkbox.checked,
				)} ${theme.fg("toolOutput", selected[i])}`;
			}
		} else {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.styledSymbol(
				"status.warning",
				"warning",
			)} ${theme.fg("warning", "Cancelled")}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Export
// ============================================================================

// ============================================================================
// LSP Renderer
// ============================================================================

interface LspArgs {
	action: string;
	file?: string;
	files?: string[];
	line?: number;
	column?: number;
}

const lspRenderer: ToolRenderer<LspArgs, LspToolDetails> = {
	renderCall: renderLspCall,
	renderResult: renderLspResult,
};

// ============================================================================
// Output Renderer
// ============================================================================

interface OutputArgs {
	ids: string[];
	format?: "raw" | "json" | "stripped";
}

/** Format byte count for display */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function truncateLine(text: string, maxLen: number, ellipsis: string): string {
	if (text.length <= maxLen) return text;
	const sliceLen = Math.max(0, maxLen - ellipsis.length);
	return `${text.slice(0, sliceLen)}${ellipsis}`;
}

type OutputEntry = OutputToolDetails["outputs"][number];

function formatOutputMeta(entry: OutputEntry, theme: Theme): string {
	const metaParts = [`${entry.lineCount} lines, ${formatBytes(entry.charCount)}`];
	if (entry.provenance) {
		metaParts.push(`agent ${entry.provenance.agent}(${entry.provenance.index})`);
	}
	return theme.fg("dim", metaParts.join(theme.sep.dot));
}

const outputRenderer: ToolRenderer<OutputArgs, OutputToolDetails> = {
	renderCall(args, theme) {
		const ids = args.ids?.join(", ") ?? "?";
		const label = theme.fg("toolTitle", theme.bold("output"));
		const format = args.format && args.format !== "raw" ? theme.fg("muted", ` (${args.format})`) : "";
		return new Text(`${label} ${theme.fg("dim", ids)}${format}`, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;

		// Error case: some IDs not found
		if (details?.notFound?.length) {
			let text = `${theme.styledSymbol("status.error", "error")} Not found: ${details.notFound.join(", ")}`;
			if (details.availableIds?.length) {
				text += `\n${theme.fg("dim", "Available:")} ${details.availableIds.join(", ")}`;
			} else {
				text += `\n${theme.fg("dim", "No outputs available in current session")}`;
			}
			return new Text(text, 0, 0);
		}

		const outputs = details?.outputs ?? [];

		// No session case
		if (outputs.length === 0) {
			const textContent = result.content?.find((c) => c.type === "text")?.text;
			return new Text(
				`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", textContent || "No outputs")}`,
				0,
				0,
			);
		}

		// Success: summary + tree display
		const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
		const icon = theme.styledSymbol("status.success", "success");
		const summary = `read ${outputs.length} output${outputs.length !== 1 ? "s" : ""}`;
		let text = `${icon} ${theme.fg("toolTitle", "output")} ${theme.fg("dim", summary)}${expandHint}`;

		const previewLimit = expanded ? 3 : 1;
		const maxOutputs = expanded ? outputs.length : Math.min(outputs.length, 5);
		for (let i = 0; i < maxOutputs; i++) {
			const o = outputs[i];
			const isLast = i === maxOutputs - 1 && (expanded || outputs.length <= 5);
			const branch = isLast ? theme.tree.last : theme.tree.branch;
			text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", o.id)} ${formatOutputMeta(o, theme)}`;

			const previewLines = o.previewLines ?? [];
			const shownPreview = previewLines.slice(0, previewLimit);
			if (shownPreview.length > 0) {
				const childPrefix = isLast ? "   " : ` ${theme.fg("dim", theme.tree.vertical)} `;
				for (const line of shownPreview) {
					const previewText = truncateLine(line, 80, theme.format.ellipsis);
					text += `\n${childPrefix}${theme.fg("dim", theme.tree.hook)} ${theme.fg("muted", "preview:")} ${theme.fg(
						"toolOutput",
						previewText,
					)}`;
				}
			}
		}

		if (!expanded && outputs.length > 5) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"muted",
				`${theme.format.ellipsis} ${outputs.length - 5} more outputs`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Task Renderer
// ============================================================================

const taskRenderer: ToolRenderer<any, TaskToolDetails> = {
	renderCall: renderTaskCall,
	renderResult: renderTaskResult,
};

// ============================================================================
// Ls Renderer
// ============================================================================

interface LsArgs {
	path?: string;
	limit?: number;
}

const lsRenderer: ToolRenderer<LsArgs, LsToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("ls "));
		text += theme.fg("accent", args.path || ".");
		if (args.limit !== undefined) {
			text += ` ${theme.fg("muted", `(limit ${args.limit})`)}`;
		}
		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;
		const textContent = result.content?.find((c: any) => c.type === "text")?.text ?? "";

		if (
			(!textContent || textContent.trim() === "" || textContent.trim() === "(empty directory)") &&
			(!details?.entries || details.entries.length === 0)
		) {
			return new Text(
				`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", "Empty directory")}`,
				0,
				0,
			);
		}

		let entries: string[] = details?.entries ? [...details.entries] : [];
		if (entries.length === 0) {
			const rawLines = textContent.split("\n").filter((l: string) => l.trim());
			entries = rawLines.filter((line) => !/^\[.*\]$/.test(line.trim()));
		}

		if (entries.length === 0) {
			return new Text(
				`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", "Empty directory")}`,
				0,
				0,
			);
		}

		let dirCount = details?.dirCount;
		let fileCount = details?.fileCount;
		if (dirCount === undefined || fileCount === undefined) {
			dirCount = 0;
			fileCount = 0;
			for (const entry of entries) {
				if (entry.endsWith("/")) {
					dirCount += 1;
				} else {
					fileCount += 1;
				}
			}
		}

		const truncated = Boolean(details?.truncation?.truncated || details?.entryLimitReached);
		const icon = truncated
			? theme.styledSymbol("status.warning", "warning")
			: theme.styledSymbol("status.success", "success");

		const dirLabel = `${dirCount} dir${dirCount !== 1 ? "s" : ""}`;
		const fileLabel = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		let text = `${icon} ${theme.fg("toolTitle", "ls")} ${theme.fg("dim", `${dirLabel}, ${fileLabel}`)}`;

		if (truncated) {
			const reasonParts: string[] = [];
			if (details?.entryLimitReached) {
				reasonParts.push(`entry limit ${details.entryLimitReached}`);
			}
			if (details?.truncation?.truncated) {
				reasonParts.push(`output cap ${formatBytes(details.truncation.maxBytes)}`);
			}
			const reasonText = reasonParts.length > 0 ? `truncated: ${reasonParts.join(", ")}` : "truncated";
			text += ` ${theme.fg("warning", `(${reasonText})`)}`;
		}

		if (!expanded) {
			text += `\n${theme.fg("dim", `${theme.nav.expand} Ctrl+O to expand list`)}`;
		}

		const maxEntries = expanded ? entries.length : Math.min(entries.length, 12);
		for (let i = 0; i < maxEntries; i++) {
			const entry = entries[i];
			const isLast = i === maxEntries - 1 && (expanded || entries.length <= 12);
			const branch = isLast ? theme.tree.last : theme.tree.branch;
			const isDir = entry.endsWith("/");
			const entryPath = isDir ? entry.slice(0, -1) : entry;
			const lang = isDir ? undefined : getLanguageFromPath(entryPath);
			const entryIcon = isDir
				? theme.fg("accent", theme.icon.folder)
				: theme.fg("muted", theme.getLangIcon(lang));
			const entryColor = isDir ? "accent" : "toolOutput";
			text += `\n ${theme.fg("dim", branch)} ${entryIcon} ${theme.fg(entryColor, entry)}`;
		}

		if (!expanded && entries.length > 12) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"muted",
				`${theme.format.ellipsis} ${entries.length - 12} more entries`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Web Fetch Renderer
// ============================================================================

interface WebFetchArgs {
	url: string;
	timeout?: number;
	raw?: boolean;
}

const webFetchRenderer: ToolRenderer<WebFetchArgs, WebFetchToolDetails> = {
	renderCall: renderWebFetchCall,
	renderResult: renderWebFetchResult,
};

// ============================================================================
// Web Search Renderer
// ============================================================================

interface WebSearchArgs {
	query: string;
	provider?: string;
	[key: string]: unknown;
}

const webSearchRenderer: ToolRenderer<WebSearchArgs, WebSearchRenderDetails> = {
	renderCall: renderWebSearchCall,
	renderResult: renderWebSearchResult,
};

// ============================================================================
// Export
// ============================================================================

export const toolRenderers: Record<
	string,
	{
		renderCall: (args: any, theme: Theme) => Component;
		renderResult: (result: any, options: RenderResultOptions, theme: Theme) => Component;
	}
> = {
	ask: askRenderer,
	grep: grepRenderer,
	find: findRenderer,
	notebook: notebookRenderer,
	ls: lsRenderer,
	lsp: lspRenderer,
	output: outputRenderer,
	task: taskRenderer,
	web_fetch: webFetchRenderer,
	web_search: webSearchRenderer,
};
