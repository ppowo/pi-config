import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatSize } from "@mariozechner/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	BASH_COMMAND_MAX_CHARS,
	BASH_GUARD_MAX_BYTES,
	BASH_GUARD_MAX_LINES,
	BASH_PREVIEW_HEAD_LINES,
	BASH_PREVIEW_TAIL_LINES,
	BASH_PREVIEW_MAX_LINE_CHARS,
	byteLength,
	countLines,
} from "./bash-guard-config.ts";

const PROTECTED_LINE_PATTERNS = [
	/^\[RTK:/,
	/^\[Hint:/,
	/PI_RTK_BYPASS=1/,
	/^\[Output truncated\./,
	/^\[Full output:/,
	/^\[After RTK readmap:/,
	/^\[Output \(RTK bypassed\:/,
	/^\[Full RTK readmap output:/,
  /^Command exited with code\s/,
  /^\[If you need more detail/
];

const HIDDEN_OPERATIONAL_LINE_PATTERNS = [
	/^Ran `.*`$/,
];

interface BashSnapshotMeta {
	enabled?: true;
	source?: string;
	snapshotPath?: string;
	originalBytes?: number;
	originalLines?: number;
	fullOutputPath?: string;
	reusedFullOutputPath?: boolean;
}

interface BashContextGuardMeta {
	enabled: true;
	trimmed: boolean;
	trimWanted: boolean;
	postRtkOutputPath?: string;
	postRtkBytes: number;
	postRtkLines: number;
	guardMaxLines: number;
	guardMaxBytes: number;
	previewHeadLines: number;
	previewTailLines: number;
	previewMaxLineChars: number;
	postRtkWriteError?: string;
}

function extractText(content: unknown): { text: string; nonTextParts: Array<{ type: string; [key: string]: unknown }> } | undefined {
	if (Array.isArray(content)) {
		const textChunks: string[] = [];
		const nonTextParts: Array<{ type: string; [key: string]: unknown }> = [];
		for (const c of content as Array<{ type?: unknown; text?: unknown }>) {
			if (c.type === "text" && typeof c.text === "string") textChunks.push(c.text);
			else nonTextParts.push(c as { type: string; [key: string]: unknown });
		}
		return { text: textChunks.join("\n"), nonTextParts };
	}
	if (typeof content === "string") return { text: content, nonTextParts: [] };
	return undefined;
}

function isProtectedLine(line: string): boolean {
	return PROTECTED_LINE_PATTERNS.some((pat) => pat.test(line));
}

function isHiddenOperationalLine(line: string): boolean {
	return HIDDEN_OPERATIONAL_LINE_PATTERNS.some((pat) => pat.test(line));
}

function partitionContent(text: string): { protectedLines: string[]; bodyLines: string[] } {
	const protectedLines: string[] = [];
	const bodyLines: string[] = [];
	const seenProtected = new Set<string>();

	for (const line of text.split("\n")) {
		if (isHiddenOperationalLine(line)) continue;
		if (isProtectedLine(line)) {
			if (!seenProtected.has(line)) {
				seenProtected.add(line);
				protectedLines.push(line);
			}
			continue;
		}
		bodyLines.push(line);
	}

	return { protectedLines, bodyLines };
}

function truncatePreviewLine(line: string): string {
	if (line.length <= BASH_PREVIEW_MAX_LINE_CHARS) return line;
	return `${line.slice(0, BASH_PREVIEW_MAX_LINE_CHARS - 1)}…`;
}

function createBodyPreview(bodyLines: string[]): string {
	const truncatedBodyLines = bodyLines.map(truncatePreviewLine);
	if (truncatedBodyLines.length <= BASH_PREVIEW_HEAD_LINES + BASH_PREVIEW_TAIL_LINES + 1) {
		return truncatedBodyLines.join("\n");
	}

	const head = truncatedBodyLines.slice(0, BASH_PREVIEW_HEAD_LINES);
	const tail = truncatedBodyLines.slice(-BASH_PREVIEW_TAIL_LINES);
	const omitted = truncatedBodyLines.length - BASH_PREVIEW_HEAD_LINES - BASH_PREVIEW_TAIL_LINES;

	return [
		...head,
		`[... ${omitted} lines omitted from guarded bash preview ...]`,
		...tail,
	].join("\n");
}

function compactCommand(input: unknown): string | undefined {
	const command = (input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const compact = command.replace(/\s+/g, " ").trim();
	if (!compact) return undefined;
	if (compact.length <= BASH_COMMAND_MAX_CHARS) return compact;
	return `${compact.slice(0, BASH_COMMAND_MAX_CHARS - 1)}…`;
}

function tempLogPath(prefix: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}


function buildGuardedPreview(opts: {
	protectedLines: string[];
	bodyPreview: string;
	postRtkOutputPath: string;
	postRtkBytes: number;
	postRtkLines: number;
	originalBytes?: number;
	originalLines?: number;
	originalPath?: string;
	reusedFullOutputPath?: boolean;
	rtkBypassed?: boolean;
  compressionTechnique?: string;
  isError?: boolean;
	command?: string;
}): string {
	const lines: string[] = [];
	lines.push("[Bash output guarded: showing preview only]");
	lines.push("");

	if (opts.protectedLines.length > 0) {
		lines.push("Preserved notices:");
		for (const line of opts.protectedLines) lines.push(`  ${line}`);
		lines.push("");
	}

	lines.push("Preview:");
	lines.push(opts.bodyPreview);
	lines.push("");

  lines.push("[If you need more detail, read the full output file with targeted offset/limit — don't add it all to context]");

	// Footer metadata
	const original = typeof opts.originalBytes === "number" && typeof opts.originalLines === "number"
		? `; original: ${formatSize(opts.originalBytes)}, ${opts.originalLines} lines`
		: "";
  const technique = opts.compressionTechnique && opts.compressionTechnique !== "none"
    ? ` (${opts.compressionTechnique})`
    : "";
	if (opts.rtkBypassed) {
		lines.push(`[Output (RTK bypassed): ${formatSize(opts.postRtkBytes)}, ${opts.postRtkLines} lines${original}]`);
	} else {
    lines.push(`[After RTK readmap${technique}: ${formatSize(opts.postRtkBytes)}, ${opts.postRtkLines} lines${original}]`);
	}
	if (opts.originalPath && !opts.reusedFullOutputPath) lines.push(`[Full output: ${opts.originalPath}]`);
	lines.push(`[Full RTK readmap output${opts.rtkBypassed ? " (only stripped ANSI escape codes because of bypass)" : ""}: ${opts.postRtkOutputPath}]`);
	if (opts.command) lines.push(`[Command: ${opts.command}]`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
		(pi.on as any)("tool_result", async (event: any) => {
		if (event.toolName !== "bash") return undefined;

		const extracted = extractText(event.content);
		if (!extracted || !extracted.text) return undefined;

		const details = event.details && typeof event.details === "object"
			? (event.details as Record<string, unknown>)
			: {};
		const bashSnapshot = details.bashSnapshot as BashSnapshotMeta | undefined;
	const compressionInfo = details.compressionInfo as { technique?: string; bypassedBy?: string } | undefined;

		const postRtkText = extracted.text;
		const postRtkBytes = byteLength(postRtkText);
		const postRtkLines = countLines(postRtkText);
		const trimWanted = postRtkBytes > BASH_GUARD_MAX_BYTES || postRtkLines > BASH_GUARD_MAX_LINES;

		const baseMeta = {
			enabled: true as const,
			trimWanted,
			postRtkBytes,
			postRtkLines,
			guardMaxLines: BASH_GUARD_MAX_LINES,
			guardMaxBytes: BASH_GUARD_MAX_BYTES,
			previewHeadLines: BASH_PREVIEW_HEAD_LINES,
			previewTailLines: BASH_PREVIEW_TAIL_LINES,
			previewMaxLineChars: BASH_PREVIEW_MAX_LINE_CHARS,
		};

		if (!trimWanted) {
			return {
				content: event.content,
				details: { ...details, bashContextGuard: { ...baseMeta, trimmed: false } satisfies BashContextGuardMeta },
				isError: event.isError,
			};
		}

		let postRtkOutputPath: string;
		try {
			postRtkOutputPath = tempLogPath("pi-bash-post-rtk");
			await writeFile(postRtkOutputPath, postRtkText, { encoding: "utf-8", mode: 0o600 });
		} catch (error) {
			return {
				content: event.content,
				details: {
					...details,
					bashContextGuard: {
						...baseMeta,
						trimmed: false,
						postRtkWriteError: errorMessage(error),
					} satisfies BashContextGuardMeta,
				},
				isError: event.isError,
			};
		}

		const { protectedLines, bodyLines } = partitionContent(postRtkText);
      const guardedText = buildGuardedPreview({
        protectedLines,
        bodyPreview: createBodyPreview(bodyLines),
        postRtkOutputPath,
        postRtkBytes,
        postRtkLines,
        originalBytes: bashSnapshot?.originalBytes,
        originalLines: bashSnapshot?.originalLines,
        originalPath: bashSnapshot?.snapshotPath,
        reusedFullOutputPath: bashSnapshot?.reusedFullOutputPath,
        rtkBypassed: compressionInfo?.bypassedBy === "env-var",
        compressionTechnique: compressionInfo?.technique,
        command: compactCommand(event.input),
      });

		return {
			content: [...extracted.nonTextParts, { type: "text" as const, text: guardedText }],
			details: {
				...details,
				bashContextGuard: {
					...baseMeta,
					trimmed: true,
					postRtkOutputPath,
				} satisfies BashContextGuardMeta,
			},
			isError: event.isError,
		};
	});
}
