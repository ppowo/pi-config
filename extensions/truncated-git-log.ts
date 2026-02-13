/**
 * Truncated git log tool — 300 lines / 16KB cap.
 * Defaults to last 20 commits --oneline. Full output saved to temp file.
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
			description: "Arguments for git log, e.g. '-n 20', '--oneline', '--since=2024-01-01', '-- path'. Defaults to '-n 20 --oneline'.",
		}),
	),
});

interface Details {
	args?: string;
	commitCount: number;
	truncated: boolean;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_log",
		label: "git log",
		description: `Run git log with truncated output. Defaults to last 20 commits --oneline. Capped to ${MAX_LINES} lines or ${formatSize(MAX_BYTES)}. Full output saved to temp file if truncated.`,
		parameters: Params,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const logArgs = params.args || "-n 20 --oneline";

			let output: string;
			try {
				output = execSync(`git log ${logArgs}`, {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 100 * 1024 * 1024,
				});
			} catch (err: any) {
				throw new Error(`git log failed: ${err.message}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No commits found." }],
					details: { args: logArgs, commitCount: 0, truncated: false } as Details,
				};
			}

			const truncation = truncateHead(output, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
			const commitCount = output.split("\n").filter((l) => l.startsWith("commit ") || /^[0-9a-f]{7,}/.test(l)).length;

			const details: Details = { args: logArgs, commitCount, truncated: truncation.truncated };

			let resultText = truncation.content;

			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-git-log-"));
				const tempFile = join(tempDir, "log.txt");
				writeFileSync(tempFile, output);
				details.fullOutputPath = tempFile;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("git log "));
			if (args.args) text += theme.fg("accent", args.args);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as Details | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Running git log..."), 0, 0);
			if (!details || details.commitCount === 0) return new Text(theme.fg("dim", "No commits"), 0, 0);

			let text = theme.fg("success", `${details.commitCount} commits`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) text += `\n${theme.fg("dim", line)}`;
					if (content.text.split("\n").length > 20) text += `\n${theme.fg("muted", "...")}`;
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
