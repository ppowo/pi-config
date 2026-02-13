/**
 * Truncated git diff tool — 300 lines / 16KB cap.
 * Returns stat summary + truncated patch. Full output saved to temp file.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MAX_LINES = 300;
const MAX_BYTES = 16 * 1024;

const Params = Type.Object({
	args: Type.Optional(
		Type.String({
			description: "Arguments for git diff, e.g. 'HEAD~3', '--staged', 'main..feature', '-- path/to/file'. Defaults to unstaged changes.",
		}),
	),
});

interface Details {
	args?: string;
	summary: string;
	truncated: boolean;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_diff",
		label: "git diff",
		description: `Run git diff with truncated output. Returns a --stat summary header + truncated patch. Capped to ${MAX_LINES} lines or ${formatSize(MAX_BYTES)}. Full output saved to temp file if truncated.`,
		parameters: Params,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const diffArgs = params.args || "";

			let summary: string;
			try {
				summary = execSync(`git diff --stat ${diffArgs}`, {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
				}).trim();
			} catch (err: any) {
				throw new Error(`git diff --stat failed: ${err.message}`);
			}

			if (!summary) {
				return {
					content: [{ type: "text", text: "No changes." }],
					details: { args: diffArgs, summary: "No changes", truncated: false } as Details,
				};
			}

			let patch: string;
			try {
				patch = execSync(`git diff ${diffArgs}`, {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 100 * 1024 * 1024,
				});
			} catch (err: any) {
				throw new Error(`git diff failed: ${err.message}`);
			}

			const truncation = truncateHead(patch, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
			const details: Details = { args: diffArgs, summary, truncated: truncation.truncated };

			let resultText = `## Summary\n${summary}\n\n## Patch\n${truncation.content}`;

			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-git-diff-"));
				const tempFile = join(tempDir, "diff.patch");
				writeFileSync(tempFile, patch);
				details.fullOutputPath = tempFile;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("git diff "));
			if (args.args) text += theme.fg("accent", args.args);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as Details | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Running git diff..."), 0, 0);
			if (!details) return new Text(theme.fg("dim", "No output"), 0, 0);

			let text = theme.fg("success", details.summary.split("\n").pop() || "No changes");
			if (details.truncated) text += theme.fg("warning", " (truncated)");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) text += `\n${theme.fg("dim", line)}`;
					if (content.text.split("\n").length > 20)
						text += `\n${theme.fg("muted", "... (read temp file for full output)")}`;
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
