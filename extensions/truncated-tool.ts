/**
 * Truncated rg (ripgrep) tool — overrides the built-in rg.
 * Uses rg with fallback to grep -rn.
 * Caps output to 300 lines / 16KB.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatSize, type TruncationResult, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MAX_LINES = 300;
const MAX_BYTES = 16 * 1024;
const MAX_BUFFER = 100 * 1024 * 1024;

// Detect rg availability once at load time
let hasRg = false;
try {
	execSync("rg --version", { stdio: "ignore" });
	hasRg = true;
} catch {}

interface CommandInvocation {
	command: "rg" | "grep";
	args: string[];
}

function buildInvocation(pattern: string, searchPath: string, glob?: string): CommandInvocation {
	if (hasRg) {
		const args = ["--line-number", "--color=never", "--max-count=200"];
		if (glob) args.push("--glob", glob);
		args.push("--", pattern, searchPath);
		return { command: "rg", args };
	}

	// Fallback: grep -rn
	const args = ["-rn", "--color=never", "-m", "200"];
	if (glob) args.push("--include", glob);
	args.push("--", pattern, searchPath);
	return { command: "grep", args };
}

const RgParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex)" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File glob pattern, e.g. '*.ts'" })),
});

interface RgDetails {
	pattern: string;
	path?: string;
	glob?: string;
	matchCount: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "ripgrep",
		description: `Search file contents. ${hasRg ? "Uses rg (respects .gitignore)" : "Uses grep"}. Output is truncated to ${MAX_LINES} lines or ${formatSize(MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
		parameters: RgParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { pattern, path: searchPath, glob } = params;
			const targetPath = searchPath || ".";
			const invocation = buildInvocation(pattern, targetPath, glob);

			const result = spawnSync(invocation.command, invocation.args, {
				cwd: ctx.cwd,
				encoding: "utf-8",
				maxBuffer: MAX_BUFFER,
			});

			if (result.error) {
				throw new Error(`${invocation.command} failed: ${result.error.message}`);
			}

			const output = result.stdout || "";
			const stderr = (result.stderr || "").trim();
			const exitCode = result.status ?? 0;

			if (exitCode === 1 && !output.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
				};
			}

			if (exitCode !== 0 && exitCode !== 1) {
				const suffix = stderr ? ` ${stderr}` : "";
				throw new Error(`${invocation.command} failed (exit ${exitCode}).${suffix}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
				};
			}

			const truncation = truncateHead(output, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
			const matchCount = output.split("\n").filter((line) => line.trim()).length;

			const details: RgDetails = { pattern, path: searchPath, glob, matchCount };

			let resultText = truncation.content;

			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-rg-"));
				const tempFile = join(tempDir, "output.txt");
				writeFileSync(tempFile, output);

				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("rg "));
			text += theme.fg("accent", `"${args.pattern}"`);
			if (args.path) text += theme.fg("muted", ` in ${args.path}`);
			if (args.glob) text += theme.fg("dim", ` --glob ${args.glob}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as RgDetails | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			if (!details || details.matchCount === 0) return new Text(theme.fg("dim", "No matches found"), 0, 0);

			let text = theme.fg("success", `${details.matchCount} matches`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) text += `\n${theme.fg("dim", line)}`;
					if (content.text.split("\n").length > 20) {
						text += `\n${theme.fg("muted", "... (use read tool to see full output)")}`;
					}
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
