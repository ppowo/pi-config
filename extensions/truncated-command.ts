/**
 * Truncated command wrapper — for build/test/log output.
 * Uses TAIL truncation (keeps last N lines) since errors/results
 * typically appear at the end. Capped to 300 lines / 16KB.
 * Full output saved to temp file when truncated.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatSize, truncateTail } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MAX_LINES = 300;
const MAX_BYTES = 16 * 1024;

const Params = Type.Object({
	command: Type.String({ description: "Shell command to run (e.g. 'npm test', 'make build', 'tail -n 500 app.log')" }),
	cwd: Type.Optional(Type.String({ description: "Working directory (default: current directory)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 120)" })),
});

interface Details {
	command: string;
	exitCode: number;
	totalLines: number;
	truncated: boolean;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "run",
		label: "run command",
		description: `Run a shell command with tail-truncated output (keeps last ${MAX_LINES} lines or ${formatSize(MAX_BYTES)}) so errors at the end are preserved. Full output saved to temp file if truncated. Use for build, test, and log commands.`,
		parameters: Params,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { command } = params;
			const cwd = params.cwd || ctx.cwd;
			const timeout = (params.timeout ?? 120) * 1000;

			let output: string;
			let exitCode = 0;

			try {
				output = execSync(command, {
					cwd,
					encoding: "utf-8",
					maxBuffer: 100 * 1024 * 1024,
					timeout,
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err: any) {
				exitCode = err.status ?? 1;
				output = (err.stdout || "") + (err.stderr || "");
				if (!output.trim()) {
					return {
						content: [{ type: "text", text: `Command failed (exit ${exitCode}): ${err.message}` }],
						details: { command, exitCode, totalLines: 0, truncated: false } as Details,
					};
				}
			}

			const totalLines = output.split("\n").length;
			const truncation = truncateTail(output, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });

			const details: Details = {
				command,
				exitCode,
				totalLines,
				truncated: truncation.truncated,
			};

			let resultText = "";
			if (exitCode !== 0) resultText += `[exit code: ${exitCode}]\n\n`;

			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-run-"));
				const tempFile = join(tempDir, "output.txt");
				writeFileSync(tempFile, output);
				details.fullOutputPath = tempFile;

				resultText += `[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]\n\n`;
			}

			resultText += truncation.content;

			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			text += theme.fg("accent", args.command);
			if (args.cwd) text += theme.fg("dim", ` (in ${args.cwd})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as Details | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
			if (!details) return new Text(theme.fg("dim", "No output"), 0, 0);

			const statusColor = details.exitCode === 0 ? "success" : "error";
			let text = theme.fg(statusColor, `exit ${details.exitCode}`);
			text += theme.fg("dim", ` (${details.totalLines} lines)`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n");
					const tail = lines.slice(-20);
					if (lines.length > 20) text += `\n${theme.fg("muted", "...")}`;
					for (const line of tail) text += `\n${theme.fg("dim", line)}`;
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
