/**
 * Truncated find/tree tool — 300 lines / 16KB cap.
 * Uses fd (respects .gitignore) with fallback to find.
 * Excludes node_modules/.git/dist/build by default. maxdepth 5.
 * Returns entry count + listing. Full output saved to temp file.
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

// Detect fd availability once at load time
let hasFd = false;
try {
	execSync("fd --version", { stdio: "ignore" });
	hasFd = true;
} catch {}

function buildCommand(searchPath: string, maxdepth: number, excludeDirs: string[], type?: string, glob?: string): string {
	if (hasFd) {
		const args = ["fd", "--max-depth", String(maxdepth), "--color=never"];
		for (const dir of excludeDirs) {
			args.push("--exclude", dir);
		}
		if (type === "f") args.push("--type", "file");
		else if (type === "d") args.push("--type", "directory");
		if (glob) args.push("--glob", glob);
		args.push(".", searchPath);
		return `${args.join(" ")} 2>/dev/null | sort`;
	}

	// Fallback: plain find
	const args = ["find", searchPath, "-maxdepth", String(maxdepth)];
	for (const dir of excludeDirs) {
		args.push("-not", "-path", `*/${dir}/*`, "-not", "-name", dir);
	}
	if (type) args.push("-type", type);
	if (glob) args.push("-name", glob);
	return `${args.join(" ")} 2>/dev/null | sort`;
}

const Params = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Name pattern, e.g. '*.ts', 'package.json'" })),
	type: Type.Optional(Type.String({ description: "Type filter: 'f' for files, 'd' for directories (default: both)" })),
	maxdepth: Type.Optional(Type.Number({ description: "Maximum directory depth (default: 5)" })),
	exclude: Type.Optional(Type.String({ description: "Directories to exclude, comma-separated (default: node_modules,.git,dist,build)" })),
});

interface Details {
	totalEntries: number;
	truncated: boolean;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "find_files",
		label: "find",
		description: `List files/directories. ${hasFd ? "Uses fd (respects .gitignore)" : "Uses find"}. Capped to ${MAX_LINES} lines or ${formatSize(MAX_BYTES)}. Excludes node_modules/.git/dist/build by default, maxdepth 5. Returns entry count + listing. Full output saved to temp file if truncated.`,
		parameters: Params,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const searchPath = params.path || ".";
			const maxdepth = params.maxdepth ?? 5;
			const excludeDirs = (params.exclude || "node_modules,.git,dist,build").split(",").map((d) => d.trim());

			const cmd = buildCommand(searchPath, maxdepth, excludeDirs, params.type, params.glob);

			let output: string;
			try {
				output = execSync(cmd, {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 100 * 1024 * 1024,
				});
			} catch (err: any) {
				throw new Error(`${hasFd ? "fd" : "find"} failed: ${err.message}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No entries found." }],
					details: { totalEntries: 0, truncated: false } as Details,
				};
			}

			const totalEntries = output.split("\n").filter((l) => l.trim()).length;
			const truncation = truncateHead(output, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
			const details: Details = { totalEntries, truncated: truncation.truncated };

			let resultText = `Total entries: ${totalEntries}\n\n${truncation.content}`;

			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-find-"));
				const tempFile = join(tempDir, "listing.txt");
				writeFileSync(tempFile, output);
				details.fullOutputPath = tempFile;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("find "));
			if (args.path) text += theme.fg("accent", args.path);
			if (args.glob) text += theme.fg("dim", ` -name ${args.glob}`);
			if (args.type) text += theme.fg("dim", ` -type ${args.type}`);
			if (args.maxdepth) text += theme.fg("dim", ` -maxdepth ${args.maxdepth}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as Details | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			if (!details || details.totalEntries === 0) return new Text(theme.fg("dim", "No entries found"), 0, 0);

			let text = theme.fg("success", `${details.totalEntries} entries`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 25);
					for (const line of lines) text += `\n${theme.fg("dim", line)}`;
					if (content.text.split("\n").length > 25) text += `\n${theme.fg("muted", "...")}`;
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
