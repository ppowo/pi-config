/**
 * Context Guard — intercepts built-in tool calls to enforce context hygiene.
 *
 * Layer 1 (tool_call): blocks and redirects before execution.
 *   - `read`: enforces max 400 lines per call via `limit` parameter.
 *   - `bash`: blocks commands that should use dedicated truncated tools.
 *     Uses broad matching (anywhere in command, not just start) to catch
 *     chained commands, env prefixes, subshells, etc.
 *
 * Layer 2 (tool_result): safety net after execution.
 *   - Truncates ANY tool result content that exceeds 16KB / 300 lines.
 *   - This catches anything that slips through Layer 1.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType, formatSize, truncateTail } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MAX_READ_LINES = 400;
const RESULT_MAX_LINES = 300;
const RESULT_MAX_BYTES = 16 * 1024;

// Per-turn cumulative budget — once exceeded, subsequent results are aggressively truncated.
const TURN_BUDGET_BYTES = 60 * 1024;
const AGGRESSIVE_MAX_LINES = 100;
const AGGRESSIVE_MAX_BYTES = 4 * 1024;

// Large file threshold — force smaller read chunks on big files.
const LARGE_FILE_BYTES = 50 * 1024;
const LARGE_FILE_READ_LIMIT = 200;

// Patterns in bash commands that should use dedicated truncated tools instead.
// Matched ANYWHERE in the command string (not just start) to catch chaining,
// env prefixes, subshells, semicolons, pipes, etc.
const BASH_REDIRECTS: Array<{ pattern: RegExp; suggestion: string }> = [
	{ pattern: /\bgit\s+diff\b/, suggestion: "Use the git_diff tool instead of bash for git diff." },
	{ pattern: /\bgit\s+log\b/, suggestion: "Use the git_log tool instead of bash for git log." },
	{ pattern: /\bgit\s+show\b/, suggestion: "Use the git_diff tool (or read with offset/limit) instead of bash for git show." },
	{ pattern: /\bfind\s+[.\/~]/, suggestion: "Use the find_files tool instead of bash for find." },
	{ pattern: /\bls\s+-[^\s]*R/, suggestion: "Use the find_files tool instead of bash for recursive ls." },
	{ pattern: /\bcat\s+/, suggestion: "Use the read tool (with offset/limit) instead of bash cat." },
	{ pattern: /\btail\s+-n\s*\d{4,}/, suggestion: "Use the run tool instead of bash for large tail output." },
	{ pattern: /\bhead\s+-n\s*\d{4,}/, suggestion: "Use the read tool (with offset/limit) instead of bash for large head output." },
	{ pattern: /\bless\b/, suggestion: "Use the read tool (with offset/limit) instead of bash less." },
	{ pattern: /\bmore\b/, suggestion: "Use the read tool (with offset/limit) instead of bash more." },
	{ pattern: /\bstrings\s+/, suggestion: "Use the run tool instead of bash for strings (output may be huge)." },
];

export default function (pi: ExtensionAPI) {
	// ── Per-turn cumulative byte counter ─────────────────────────────────
	let turnBytes = 0;

	pi.on("turn_start", async () => {
		turnBytes = 0;
	});

	// ── Layer 1: Block before execution ──────────────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		// --- Enforce read limit ---
		if (isToolCallEventType("read", event)) {
			const limit = event.input.limit;
			if (limit === undefined) {
				return {
					block: true,
					reason: `Context hygiene: read calls must include a \`limit\` parameter (max ${MAX_READ_LINES} lines). Re-call with limit: ${MAX_READ_LINES} (or less). Use offset to paginate.`,
				};
			}
			if (limit > MAX_READ_LINES) {
				return {
					block: true,
					reason: `Context hygiene: read limit ${limit} exceeds max ${MAX_READ_LINES}. Re-call with limit: ${MAX_READ_LINES} (or less). Use offset to paginate.`,
				};
			}

			// --- Force smaller chunks on large files ---
			try {
				const stats = statSync(event.input.path);
				if (stats.size > LARGE_FILE_BYTES && limit > LARGE_FILE_READ_LIMIT) {
					return {
						block: true,
						reason: `Context hygiene: file is large (${formatSize(stats.size)}). Use limit: ${LARGE_FILE_READ_LIMIT} or less, and use rg first to find the relevant section before reading.`,
					};
				}
			} catch {
				// File might not exist or be unreadable — let the read tool handle that error.
			}
		}

		// --- Block built-in grep/find/ls — use our truncated replacements ---
		if (isToolCallEventType("grep", event)) {
			return {
				block: true,
				reason: "Context hygiene: use the rg tool instead of built-in grep (it has proper truncation).",
			};
		}
		if (isToolCallEventType("find", event)) {
			return {
				block: true,
				reason: "Context hygiene: use the find_files tool instead of built-in find (it has proper truncation and sane defaults).",
			};
		}
		if (isToolCallEventType("ls", event)) {
			return {
				block: true,
				reason: "Context hygiene: use the find_files tool (with maxdepth: 1) instead of built-in ls.",
			};
		}

		// --- Redirect noisy bash commands to truncated tools ---
		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command || "";
			for (const { pattern, suggestion } of BASH_REDIRECTS) {
				if (pattern.test(cmd)) {
					return {
						block: true,
						reason: `Context hygiene: ${suggestion}`,
					};
				}
			}
		}
	});

	// ── Layer 2: Truncate results after execution (safety net) ───────────

	pi.on("tool_result", async (event, _ctx) => {
		// Check each text content block for size and accumulate turn bytes
		const content = event.content;
		if (!content || !Array.isArray(content)) return;

		// Accumulate turn bytes (even for self-truncating tools)
		for (const block of content) {
			if (block.type === "text" && block.text) {
				turnBytes += Buffer.byteLength(block.text, "utf-8");
			}
		}

		// Skip truncation for tools that already handle their own
		const selfTruncatingTools = ["rg", "git_diff", "git_log", "find_files", "run"];
		if (selfTruncatingTools.includes(event.toolName)) {
			// But if over turn budget, still truncate aggressively
			if (turnBytes <= TURN_BUDGET_BYTES) return;
		}

		// Determine effective limits based on turn budget
		const overBudget = turnBytes > TURN_BUDGET_BYTES;
		const effectiveMaxLines = overBudget ? AGGRESSIVE_MAX_LINES : RESULT_MAX_LINES;
		const effectiveMaxBytes = overBudget ? AGGRESSIVE_MAX_BYTES : RESULT_MAX_BYTES;

		let needsTruncation = false;
		for (const block of content) {
			if (block.type === "text" && block.text) {
				const bytes = Buffer.byteLength(block.text, "utf-8");
				const lines = block.text.split("\n").length;
				if (bytes > effectiveMaxBytes || lines > effectiveMaxLines) {
					needsTruncation = true;
					break;
				}
			}
		}

		if (!needsTruncation) return;

		// Truncate and save full output to temp file
		const newContent = content.map((block: any) => {
			if (block.type !== "text" || !block.text) return block;

			const bytes = Buffer.byteLength(block.text, "utf-8");
			const lines = block.text.split("\n").length;

			if (bytes <= effectiveMaxBytes && lines <= effectiveMaxLines) return block;

			// Save full output
			const tempDir = mkdtempSync(join(tmpdir(), `pi-guard-${event.toolName}-`));
			const tempFile = join(tempDir, "output.txt");
			writeFileSync(tempFile, block.text);

			// Truncate (tail — keep end where errors/results usually are)
			const truncation = truncateTail(block.text, {
				maxLines: effectiveMaxLines,
				maxBytes: effectiveMaxBytes,
			});

			let truncatedText = truncation.content;
			truncatedText += `\n\n[Context guard: output truncated from ${event.toolName} tool.`;
			truncatedText += ` Showing last ${truncation.outputLines} of ${truncation.totalLines} lines`;
			truncatedText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
			if (overBudget) {
				truncatedText += ` AGGRESSIVE: per-turn budget exceeded (${formatSize(turnBytes)} of ${formatSize(TURN_BUDGET_BYTES)} used). Narrow your scope.`;
			}
			truncatedText += ` Full output saved to: ${tempFile}]`;

			return { ...block, text: truncatedText };
		});

		return { content: newContent };
	});
}
