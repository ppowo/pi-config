/**
 * Part 1 of 2 for the local pi-hashline-readmap bash workaround.
 *
 * Load this before pi-hashline-readmap (currently via settings.json -> extensions)
 * so it can trim oversized bash text early, save the full pre-RTK text, and
 * expose details.preRtkOutputPath for later use.
 *
 * Snapshots are written under ~/.pi/agent/tmp/bash-pre-rtk/ with restrictive
 * permissions, and old snapshots are pruned automatically.
 *
 * Companion: extensions/bash-post-hashline-readmap-breadcrumb.ts
 * That second extension must run later (currently via settings.json -> packages)
 * because pi-hashline-readmap can rewrite the visible bash tool_result text.
 */
import type { TextContent } from "@mariozechner/pi-ai";
import type { BashToolDetails, ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { formatSize, truncateHead, truncateTail } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREVIEW_MAX_LINES = 100;
const PREVIEW_MAX_BYTES = 16 * 1024;
const SNAPSHOT_DIR = join(homedir(), ".pi", "agent", "tmp", "bash-pre-rtk");
const SNAPSHOT_RETENTION_HOURS = 72;
const SNAPSHOT_RETENTION_MS = SNAPSHOT_RETENTION_HOURS * 60 * 60 * 1000;
const HEAD_TAIL_SEPARATOR = "[... trimmed middle ...]";
const HEAD_TAIL_HEAD_LINES = 35;
const HEAD_TAIL_TAIL_LINES = 64;
const HEAD_TAIL_HEAD_BYTES = Math.floor(PREVIEW_MAX_BYTES * 0.35);
const HEAD_TAIL_TAIL_BYTES = Math.max(
	1024,
	PREVIEW_MAX_BYTES - HEAD_TAIL_HEAD_BYTES - Buffer.byteLength(`\n${HEAD_TAIL_SEPARATOR}\n`, "utf-8"),
);
// Keep this aligned with the active pi-hashline-readmap bash-filter bypass list.
const TEST_COMMANDS = ["vitest", "jest", "pytest", "cargo test", "npm test", "npx vitest", "bun test", "go test", "mocha"];
const HEAD_TAIL_COMMAND_HINTS = [
	"npm install",
	"npm ci",
	"npm update",
	"pnpm install",
	"pnpm add",
	"pnpm update",
	"yarn install",
	"yarn add",
	"bun install",
	"cargo build",
	"cargo check",
	"cargo run",
	"docker build",
	"git diff",
	"make",
	"cmake",
	"pip install",
	"poetry install",
];

type ContentBlock = ToolResultEvent["content"][number];
type BashTrimDetails = BashToolDetails & {
	preRtkOutputPath?: string;
	upstreamFullOutputPath?: string;
};
type TailPreview = ReturnType<typeof truncateTail> & { mode: "tail" };
type HeadTailPreview = {
	mode: "head_tail";
	content: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	headOutputLines: number;
	tailOutputLines: number;
};
type Preview = TailPreview | HeadTailPreview;

function isBashToolResult(event: ToolResultEvent): event is ToolResultEvent & {
	toolName: "bash";
	input: { command?: string };
	details: BashToolDetails | undefined;
	content: ContentBlock[];
} {
	return event.toolName === "bash";
}

function isTestCommand(command: string): boolean {
	if (!command) {
		return false;
	}

	// Only examine the command name/subcommands so words like "tests" in
	// quoted args or messages do not accidentally bypass trimming.
	const tokens = command.toLowerCase().split(/\s+/);
	const firstFlagIdx = tokens.findIndex((t) => t.startsWith("-") || t.startsWith('"') || t.startsWith("'"));
	const cmdBase = (firstFlagIdx === -1 ? tokens : tokens.slice(0, firstFlagIdx)).join(" ");

	return TEST_COMMANDS.some((testCommand) => cmdBase.includes(testCommand));
}

function extractText(content: ContentBlock[]): string | undefined {
	const textBlocks = content.filter(
		(block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
	);

	if (textBlocks.length === 0 || textBlocks.length !== content.length) {
		return undefined;
	}

	return textBlocks.map((block) => block.text).join("\n");
}

function getExistingFullOutputPath(details: BashToolDetails | undefined): string | undefined {
	return typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
}

function ensureSnapshotDir(): void {
	mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
}

function pruneOldSnapshots(): void {
	const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;

	try {
		for (const entry of readdirSync(SNAPSHOT_DIR, { withFileTypes: true })) {
			const entryPath = join(SNAPSHOT_DIR, entry.name);

			try {
				const stats = statSync(entryPath);
				if (stats.mtimeMs < cutoff) {
					rmSync(entryPath, { force: true, recursive: true });
				}
			} catch {
				// Best-effort cleanup only.
			}
		}
	} catch {
		// Best-effort cleanup only.
	}
}

function writePreRtkSnapshot(text: string): string {
	ensureSnapshotDir();
	pruneOldSnapshots();

	const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
	const snapshotName = `${timestamp}-pid${process.pid}-${randomUUID().slice(0, 8)}.bash-output.pre-rtk.txt`;
	const snapshotPath = join(SNAPSHOT_DIR, snapshotName);
	writeFileSync(snapshotPath, text, { encoding: "utf-8", mode: 0o600 });
	return snapshotPath;
}

function looksLikeHeadTailCandidate(command: string, totalLines: number): boolean {
	const normalized = command.toLowerCase();
	if (HEAD_TAIL_COMMAND_HINTS.some((hint) => normalized.includes(hint))) {
		return true;
	}

	return totalLines >= PREVIEW_MAX_LINES * 3;
}

function buildHeadTailPreview(text: string): HeadTailPreview | undefined {
	const head = truncateHead(text, {
		maxLines: HEAD_TAIL_HEAD_LINES,
		maxBytes: HEAD_TAIL_HEAD_BYTES,
	});
	const tail = truncateTail(text, {
		maxLines: HEAD_TAIL_TAIL_LINES,
		maxBytes: HEAD_TAIL_TAIL_BYTES,
	});

	if (!head.content || !tail.content) {
		return undefined;
	}

	if (head.outputLines + tail.outputLines >= head.totalLines) {
		return undefined;
	}

	const content = [head.content, HEAD_TAIL_SEPARATOR, tail.content].join("\n");
	return {
		mode: "head_tail",
		content,
		totalLines: head.totalLines,
		totalBytes: head.totalBytes,
		outputLines: head.outputLines + tail.outputLines + 1,
		outputBytes: Buffer.byteLength(content, "utf-8"),
		headOutputLines: head.outputLines,
		tailOutputLines: tail.outputLines,
	};
}

function buildPreview(text: string, command: string): Preview | undefined {
	const tail = truncateTail(text, {
		maxLines: PREVIEW_MAX_LINES,
		maxBytes: PREVIEW_MAX_BYTES,
	});

	if (!tail.truncated) {
		return undefined;
	}

	if (tail.lastLinePartial || !looksLikeHeadTailCandidate(command, tail.totalLines)) {
		return { ...tail, mode: "tail" };
	}

	const headTail = buildHeadTailPreview(text);
	return headTail ?? { ...tail, mode: "tail" };
}

function buildPreviewNotice(
	text: string,
	preview: Preview,
	preRtkOutputPath: string,
	upstreamFullOutputPath?: string,
): string {
	let summary: string;
	if (preview.mode === "head_tail") {
		summary = `showing first ${preview.headOutputLines} and last ${preview.tailOutputLines} lines of ${preview.totalLines}`;
	} else if (preview.lastLinePartial) {
		const lastLine = text.split("\n").pop() ?? "";
		summary = `showing last ${formatSize(preview.outputBytes)} of line ${preview.totalLines} (line is ${formatSize(Buffer.byteLength(lastLine, "utf-8"))})`;
	} else if (preview.truncatedBy === "lines") {
		const startLine = Math.max(1, preview.totalLines - preview.outputLines + 1);
		summary = `showing lines ${startLine}-${preview.totalLines} of ${preview.totalLines}`;
	} else {
		const startLine = Math.max(1, preview.totalLines - preview.outputLines + 1);
		summary = `showing lines ${startLine}-${preview.totalLines} of ${preview.totalLines} (${formatSize(PREVIEW_MAX_BYTES)} limit)`;
	}

	return `[Bash output trimmed before RTK: ${summary}. Pre-RTK snapshot: ${preRtkOutputPath}. Use read on that path for the full pre-RTK text.${upstreamFullOutputPath ? ` Existing full output: ${upstreamFullOutputPath}.` : ""}]`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event)) {
			return undefined;
		}

		const command = (event.input as { command?: string }).command ?? "";
		if (isTestCommand(command)) {
			return undefined;
		}

		const text = extractText(event.content);
		if (!text) {
			return undefined;
		}

		const preview = buildPreview(text, command);
		if (!preview) {
			return undefined;
		}

		let preRtkOutputPath: string;
		try {
			preRtkOutputPath = writePreRtkSnapshot(text);
		} catch {
			return undefined;
		}

		const upstreamFullOutputPath = getExistingFullOutputPath(event.details);
		const details: BashTrimDetails = {
			...(event.details ?? {}),
			truncation: preview.mode === "tail" ? preview : undefined,
			preRtkOutputPath,
			...(upstreamFullOutputPath ? { upstreamFullOutputPath } : { fullOutputPath: preRtkOutputPath }),
		};
		if (preview.mode !== "tail") {
			delete details.truncation;
		}

		return {
			content: [{
				type: "text",
				text: [preview.content, "", buildPreviewNotice(text, preview, preRtkOutputPath, upstreamFullOutputPath)].join("\n"),
			}] as TextContent[],
			details,
		};
	});
}
