import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	byteLength,
	countLines,
	exceedsBashGuardBudget,
	BASH_GUARD_MAX_BYTES,
	BASH_GUARD_MAX_LINES,
} from "./bash-guard-config.ts";

type BashSnapshotSource = "pi-full-output-path" | "pi-visible" | "pi-visible-fallback";

interface BashSnapshotMeta {
	enabled: true;
	source: BashSnapshotSource;
	restoredContentForRtk: boolean;
	snapshotNeeded: boolean;
	snapshotPath?: string;
	originalBytes: number;
	originalLines: number;
	piVisibleBytes: number;
	piVisibleLines: number;
	reusedFullOutputPath: boolean;
	fullOutputPath?: string;
	fullOutputReadError?: string;
	snapshotWriteError?: string;
	guardMaxLines: number;
	guardMaxBytes: number;
}

function extractText(content: unknown): { text: string; nonTextParts: Array<{ type: string; [key: string]: unknown }> } | undefined {
	if (Array.isArray(content)) {
		const textChunks: string[] = [];
		const nonTextParts: Array<{ type: string; [key: string]: unknown }> = [];
		for (const c of content as Array<{ type?: unknown; text?: unknown }>) {
			if (c.type === "text" && typeof c.text === "string") {
				textChunks.push(c.text);
			} else {
				nonTextParts.push(c as { type: string; [key: string]: unknown });
			}
		}
		return { text: textChunks.join("\n"), nonTextParts };
	}
	if (typeof content === "string") return { text: content, nonTextParts: [] };
	return undefined;
}

function replaceTextContent(originalContent: unknown, text: string, nonTextParts: Array<{ type: string; [key: string]: unknown }>): unknown {
	if (Array.isArray(originalContent)) return [...nonTextParts, { type: "text" as const, text }];
	return text;
}

function tempLogPath(prefix: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
		(pi.on as any)("tool_result", async (event: any) => {
		if (event.toolName !== "bash") return undefined;

		const extracted = extractText(event.content);
		if (!extracted || !extracted.text) return undefined;

		const details = event.details && typeof event.details === "object"
			? (event.details as Record<string, unknown>)
			: {};

		const piVisibleText = extracted.text;
		const piVisibleBytes = byteLength(piVisibleText);
		const piVisibleLines = countLines(piVisibleText);
		const fullOutputPath = typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;

		let source: BashSnapshotSource = "pi-visible";
		let originalText = piVisibleText;
		let restoredContentForRtk = false;
		let snapshotPath: string | undefined;
		let reusedFullOutputPath = false;
		let fullOutputReadError: string | undefined;
		let snapshotWriteError: string | undefined;

		if (fullOutputPath) {
			try {
				originalText = await readFile(fullOutputPath, "utf-8");
				source = "pi-full-output-path";
				restoredContentForRtk = true;
				snapshotPath = fullOutputPath;
				reusedFullOutputPath = true;
			} catch (error) {
				source = "pi-visible-fallback";
				originalText = piVisibleText;
				fullOutputReadError = errorMessage(error);
			}
		}

		const originalBytes = byteLength(originalText);
		const originalLines = countLines(originalText);
		const snapshotNeeded = Boolean(snapshotPath) || exceedsBashGuardBudget(originalText);

		if (!snapshotPath && snapshotNeeded) {
			try {
				snapshotPath = tempLogPath("pi-bash-original");
				await writeFile(snapshotPath, originalText, { encoding: "utf-8", mode: 0o600 });
			} catch (error) {
				snapshotPath = undefined;
				snapshotWriteError = errorMessage(error);
			}
		}

		const bashSnapshot: BashSnapshotMeta = {
			enabled: true,
			source,
			restoredContentForRtk,
			snapshotNeeded,
			snapshotPath,
			originalBytes,
			originalLines,
			piVisibleBytes,
			piVisibleLines,
			reusedFullOutputPath,
			fullOutputPath,
			fullOutputReadError,
			snapshotWriteError,
			guardMaxLines: BASH_GUARD_MAX_LINES,
			guardMaxBytes: BASH_GUARD_MAX_BYTES,
		};

		return {
			content: restoredContentForRtk
				? replaceTextContent(event.content, originalText, extracted.nonTextParts)
				: event.content,
			details: { ...details, bashSnapshot },
			isError: event.isError,
		};
	});
}
