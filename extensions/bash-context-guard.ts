/**
 * Bash Context Guard Extension (post-RTK)
 *
 * Loads AFTER pi-hashline-readmap (user-auto, rank 3).
 * Guards LLM context by replacing large post-RTK bash output with a
 * clearly-labeled preview that points to the actual output files.
 *
 * Key behaviors:
 * - Detects `details.bashSnapshot` from the pre-RTK snapshot extension
 * - Preserves ALL RTK notices, hints, and bypass instructions
 * - Writes full post-RTK content to a temp file before trimming
 * - Replaces oversized output with an explicit guarded preview
 * - Makes it unmistakably clear the visible text is NOT the full output
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatSize } from "@mariozechner/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Guard configuration — adjust these to control the context budget */
const GUARD_MAX_LINES = 400;
const GUARD_MAX_BYTES = 16 * 1024; // 16 KB

/** Lines to show from the head and tail of the output body in previews */
const PREVIEW_HEAD_LINES = 20;
const PREVIEW_TAIL_LINES = 20;

/** Regex patterns for lines that MUST be preserved regardless of trimming */
const PROTECTED_LINE_PATTERNS = [
	/^\[RTK:/,                          // RTK compression notice
	/^\[Hint:/,                         // RTK hint line
	/PI_RTK_BYPASS=1/,                  // RTK bypass instruction
	/^\[Output truncated\./,            // pi built-in truncation notice
	/^Full output:/,                    // pi full-output path line
	/^Ran `/,                           // "Ran `command`" header line
	/^Exit code:/,                      // Exit code line
];

function countLines(text: string): number {
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

interface BashSnapshotMeta {
	snapshotPath: string;
	originalBytes: number;
	originalLines: number;
	reusedFullOutputPath: boolean;
	fullOutputPath?: string;
}

interface BashContextGuardMeta {
	/** Absolute path to the full post-RTK content */
	guardOutputPath: string;
	/** Post-RTK content byte size */
	postRtkBytes: number;
	/** Post-RTK content line count */
	postRtkLines: number;
	/** Whether the guard trimmed the output */
	trimmed: boolean;
	/** The guard limits applied */
	guardMaxLines: number;
	guardMaxBytes: number;
}

/**
 * Check if a line matches any protected pattern.
 */
function isProtectedLine(line: string): boolean {
	return PROTECTED_LINE_PATTERNS.some((pat) => pat.test(line));
}

/**
 * Split content into protected lines and body lines.
 * Protected lines are always preserved; body lines are subject to trimming.
 */
function partitionContent(text: string): { protectedLines: string[]; bodyLines: string[] } {
	const lines = text.split("\n");
	const protectedLines: string[] = [];
	const bodyLines: string[] = [];

	for (const line of lines) {
		if (isProtectedLine(line)) {
			protectedLines.push(line);
		} else {
			bodyLines.push(line);
		}
	}

	return { protectedLines, bodyLines };
}

/**
 * Create a trimmed preview from body lines with head+tail and omission marker.
 */
function createBodyPreview(bodyLines: string[]): string {
	if (bodyLines.length <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES + 5) {
		// Body is small enough to include entirely
		return bodyLines.join("\n");
	}

	const head = bodyLines.slice(0, PREVIEW_HEAD_LINES);
	const tail = bodyLines.slice(-PREVIEW_TAIL_LINES);
	const omitted = bodyLines.length - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES;

	return [
		...head,
		"",
		`  ... ${omitted} lines omitted (read the full output file for complete content) ...`,
		"",
		...tail,
	].join("\n");
}

/**
 * Build the guarded preview that replaces the original content.
 */
function buildGuardedPreview(opts: {
	protectedLines: string[];
	bodyPreview: string;
	snapshotPath: string;
	guardOutputPath: string;
	postRtkBytes: number;
	postRtkLines: number;
	originalBytes: number;
	originalLines: number;
	fullOutputPath?: string;
	trimmed: boolean;
	command: string;
}): string {
	const {
		protectedLines,
		bodyPreview,
		snapshotPath,
		guardOutputPath,
		postRtkBytes,
		postRtkLines,
		originalBytes,
		originalLines,
		fullOutputPath,
		trimmed,
		command,
	} = opts;

	const lines: string[] = [];

	// === Banner: unmistakable warning ===
	lines.push("┌─────────────────────────────────────────────────────────────┐");
	lines.push("│  ⚠  CONTEXT GUARD: This is NOT the full bash output.       │");
	lines.push("│     It is a guarded preview to protect LLM context.        │");
	lines.push("│     Read the files below when exact diagnostics matter.    │");
	lines.push("└─────────────────────────────────────────────────────────────┘");
	lines.push("");

	// === File manifest ===
	lines.push("Output files (read these for full content):");
	lines.push(`  • Pre-RTK original:  ${snapshotPath}  (${formatSize(originalBytes)}, ${originalLines} lines)`);
	lines.push(`  • Post-RTK full:     ${guardOutputPath}  (${formatSize(postRtkBytes)}, ${postRtkLines} lines)`);
	if (fullOutputPath && fullOutputPath !== snapshotPath) {
		lines.push(`  • Pi built-in full:  ${fullOutputPath}`);
	}
	lines.push("");

	// === Guard metadata ===
	if (trimmed) {
		lines.push(`Guard trimmed output to stay within ${formatSize(GUARD_MAX_BYTES)} / ${GUARD_MAX_LINES} lines.`);
	}
	lines.push("");

	// === Protected lines (RTK notices, bypass, exit code, etc.) ===
	if (protectedLines.length > 0) {
		lines.push("Preserved notices:");
		for (const pl of protectedLines) {
			lines.push(`  ${pl}`);
		}
		lines.push("");
	}

	// === Instruction ===
	lines.push("When you need the full bash output, read the post-RTK file:");
	lines.push(`  read("${guardOutputPath}")`);
	if (command) {
		lines.push(`  (command was: ${command})`);
	}
	lines.push("");

	// === Preview body ===
	lines.push("── preview (incomplete) ──");
	lines.push(bodyPreview);
	lines.push("── end preview ──");

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return undefined;

		const details =
			event.details && typeof event.details === "object"
				? (event.details as Record<string, unknown>)
				: {};

		// Require the pre-RTK snapshot to exist
		const bashSnapshot = details.bashSnapshot as BashSnapshotMeta | undefined;
		if (!bashSnapshot || typeof bashSnapshot.snapshotPath !== "string") {
			return undefined;
		}

		// Extract the post-RTK text (after hashline-readmap has modified it)
		let postRtkText: string;
		const nonTextParts: Array<{ type: string; [key: string]: unknown }> = [];
		if (Array.isArray(event.content)) {
			const textChunks: string[] = [];
			for (const c of event.content as Array<{ type?: unknown; text?: unknown }>) {
				if (c.type === "text" && typeof c.text === "string") {
					textChunks.push(c.text);
				} else {
					nonTextParts.push(c as { type: string; [key: string]: unknown });
				}
			}
			postRtkText = textChunks.join("\n");
		} else if (typeof event.content === "string") {
			postRtkText = event.content;
		} else {
			return undefined;
		}
		if (!postRtkText) return undefined;

		const postRtkBytes = Buffer.byteLength(postRtkText, "utf-8");
		const postRtkLines = countLines(postRtkText);

		// Check if output exceeds guard limits
		const exceedsLines = postRtkLines > GUARD_MAX_LINES;
		const exceedsBytes = postRtkBytes > GUARD_MAX_BYTES;

		if (!exceedsLines && !exceedsBytes) {
			// Output is within limits — no guarding needed, just record metadata
			return {
				content: event.content,
				details: {
					...details,
					bashContextGuard: {
						guardOutputPath: "",
						postRtkBytes,
						postRtkLines,
						trimmed: false,
						guardMaxLines: GUARD_MAX_LINES,
						guardMaxBytes: GUARD_MAX_BYTES,
					} satisfies BashContextGuardMeta,
				},
				isError: event.isError,
			};
		}

		// Output exceeds limits — write full post-RTK content to temp file
		const dir = await mkdtemp(join(tmpdir(), "pi-bash-guard-"));
		const id = randomBytes(4).toString("hex");
		const guardOutputPath = join(dir, `post-rtk-${id}.log`);
		await writeFile(guardOutputPath, postRtkText, "utf-8");

		// Partition into protected lines and body
		const { protectedLines, bodyLines } = partitionContent(postRtkText);

		// Create trimmed preview
		const bodyPreview = createBodyPreview(bodyLines);

		// Build command string for the instruction
		const command = (event.input as { command?: string })?.command ?? "";

		// Build the guarded preview
		const guardedText = buildGuardedPreview({
			protectedLines,
			bodyPreview,
			snapshotPath: bashSnapshot.snapshotPath,
			guardOutputPath,
			postRtkBytes,
			postRtkLines,
			originalBytes: bashSnapshot.originalBytes,
			originalLines: bashSnapshot.originalLines,
			fullOutputPath: bashSnapshot.fullOutputPath,
			trimmed: true,
			command,
		});

		const guardMeta: BashContextGuardMeta = {
			guardOutputPath,
			postRtkBytes,
			postRtkLines,
			trimmed: true,
			guardMaxLines: GUARD_MAX_LINES,
			guardMaxBytes: GUARD_MAX_BYTES,
		};

		return {
			content: [...nonTextParts, { type: "text" as const, text: guardedText }],
			details: { ...details, bashContextGuard: guardMeta },
			isError: event.isError,
		};
	});
}
