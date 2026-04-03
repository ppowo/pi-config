import type { TextContent } from "@mariozechner/pi-ai";
import type { BashToolDetails, ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREVIEW_MAX_LINES = 100;
const PREVIEW_MAX_BYTES = 16 * 1024;
// Keep this aligned with pi-hashline-readmap so test output is never trimmed.
const TEST_COMMANDS = ["vitest", "jest", "pytest", "cargo test", "npm test", "npx vitest", "bun test", "go test", "mocha"];

type ContentBlock = ToolResultEvent["content"][number];

function isBashToolResult(event: ToolResultEvent): event is ToolResultEvent & {
	toolName: "bash";
	input: { command?: string };
	details: BashToolDetails | undefined;
	content: ContentBlock[];
} {
	return event.toolName === "bash";
}

function isTestCommand(command: string): boolean {
	const normalized = command.toLowerCase();
	return TEST_COMMANDS.some((testCommand) => normalized.includes(testCommand));
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

		const truncation = truncateHead(text, {
			maxLines: PREVIEW_MAX_LINES,
			maxBytes: PREVIEW_MAX_BYTES,
		});

		if (!truncation.truncated) {
			return undefined;
		}

		const upstreamFullOutputPath = getExistingFullOutputPath(event.details);
		const tempDir = mkdtempSync(join(tmpdir(), "pi-bash-trim-"));
		const fullOutputPath = join(tempDir, "bash-output.txt");
		writeFileSync(fullOutputPath, text, "utf-8");

		const preview = [
			truncation.content,
			"",
			`[Bash output trimmed after hashline: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}. Use read on that path for the rest.${upstreamFullOutputPath ? ` Upstream full output: ${upstreamFullOutputPath}.` : ""}]`,
		].join("\n");

		return {
			content: [{ type: "text", text: preview }] as TextContent[],
			details: {
				...(event.details ?? {}),
				truncation,
				fullOutputPath,
				...(upstreamFullOutputPath ? { upstreamFullOutputPath } : {}),
			},
		};
	});
}
