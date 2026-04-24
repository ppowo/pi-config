/**
 * Bash Snapshot Extension (pre-RTK)
 *
 * Loads BEFORE pi-hashline-readmap (project-local, rank 0).
 * Captures original bash tool_result content before RTK modifies it,
 * preserving the pre-compression text for later recovery or analysis.
 *
 * - Records `details.fullOutputPath` if pi's built-in truncation wrote to a temp file
 * - Otherwise writes original content to `/tmp/pi-bash-snapshot-XXXX.log`
 * - Stores snapshot metadata in `details.bashSnapshot`
 * - Returns NO content modification — only enriches details
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

function countLines(text: string): number {
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
interface BashSnapshotMeta {
	/** Absolute path to the pre-RTK original output */
	snapshotPath: string;
	/** Byte length of the original content text */
	originalBytes: number;
	/** Line count of the original content text */
	originalLines: number;
	/** True when the snapshot reuses pi's built-in fullOutputPath */
	reusedFullOutputPath: boolean;
	/** Pi's built-in fullOutputPath, if it existed at snapshot time */
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return undefined;

		// Extract original text content
		let originalText: string;
		if (Array.isArray(event.content)) {
			const textParts = (event.content as Array<{ type?: unknown; text?: unknown }>)
				.filter(
					(c): c is { type: "text"; text: string } =>
						c.type === "text" && typeof c.text === "string",
				)
				.map((c) => c.text);
			originalText = textParts.join("\n");
		} else if (typeof event.content === "string") {
			originalText = event.content;
		} else {
			return undefined;
		}
		if (!originalText) return undefined;

		const details =
			event.details && typeof event.details === "object"
				? (event.details as Record<string, unknown>)
				: {};

		const originalBytes = Buffer.byteLength(originalText, "utf-8");
		const originalLines = countLines(originalText);

		// Prefer pi's built-in fullOutputPath (from built-in truncation)
		const fullOutputPath = typeof details.fullOutputPath === "string"
			? (details.fullOutputPath as string)
			: undefined;

		let snapshotPath: string;
		let reusedFullOutputPath: boolean;

		if (fullOutputPath) {
			// pi already wrote the full output to a temp file — reuse it
			snapshotPath = fullOutputPath;
			reusedFullOutputPath = true;
		} else {
			// No temp file from pi — write original content ourselves
			const dir = await mkdtemp(join(tmpdir(), "pi-bash-snapshot-"));
			const id = randomBytes(4).toString("hex");
			snapshotPath = join(dir, `snapshot-${id}.log`);
			await writeFile(snapshotPath, originalText, "utf-8");
			reusedFullOutputPath = false;
		}

		const bashSnapshot: BashSnapshotMeta = {
			snapshotPath,
			originalBytes,
			originalLines,
			reusedFullOutputPath,
			fullOutputPath,
		};

		// Enrich details with snapshot metadata — do NOT modify content
		return {
			content: event.content,
			details: { ...details, bashSnapshot },
			isError: event.isError,
		};
	});
}
