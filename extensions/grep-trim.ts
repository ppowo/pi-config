import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { formatSize, isGrepToolResult, truncateHead } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREVIEW_MAX_LINES = 60;
const PREVIEW_MAX_BYTES = 12 * 1024;

type ContentBlock = ToolResultEvent["content"][number];

function extractText(content: ContentBlock[]): string | undefined {
	const textBlocks = content.filter(
		(block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
	);

	if (textBlocks.length === 0 || textBlocks.length !== content.length) {
		return undefined;
	}

	return textBlocks.map((block) => block.text).join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (!isGrepToolResult(event)) {
			return undefined;
		}

		const text = extractText(event.content);
		if (!text) {
			return undefined;
		}

		const truncation = truncateHead(text, {
			maxLines: PREVIEW_MAX_LINES,
			maxBytes: PREVIEW_MAX_BYTES,
		});

		if (!truncation.truncated) {
			return undefined;
		}

		const tempDir = mkdtempSync(join(tmpdir(), "pi-grep-trim-"));
		const fullOutputPath = join(tempDir, "grep-output.txt");
		writeFileSync(fullOutputPath, text, "utf-8");

		const preview = [
			truncation.content,
			"",
			`[Output trimmed: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}. Use read on that path for the rest.]`,
		].join("\n");

		return {
			content: [{ type: "text", text: preview }] as TextContent[],
			details: {
				...(event.details ?? {}),
				truncation,
				fullOutputPath,
			},
		};
	});
}
