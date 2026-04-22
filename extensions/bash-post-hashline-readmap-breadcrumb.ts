/**
 * Part 2 of 2 for the local pi-hashline-readmap bash workaround.
 *
 * Load this after pi-hashline-readmap (currently via settings.json -> packages)
 * so it can append a visible breadcrumb after RTK/hashline processing rewrites
 * the final bash tool_result text.
 *
 * Companion: extensions/bash-pre-hashline-readmap-trim.ts
 * That first extension captures the full pre-RTK text, stores
 * details.preRtkOutputPath, and saves snapshots under ~/.pi/agent/tmp/bash-pre-rtk/.
 */
import type { TextContent } from "@mariozechner/pi-ai";
import type { BashToolDetails, ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";

type ContentBlock = ToolResultEvent["content"][number];
type BreadcrumbDetails = BashToolDetails & {
	preRtkOutputPath?: string;
	compressionInfo?: unknown;
};

function isBashToolResult(event: ToolResultEvent): event is ToolResultEvent & {
	toolName: "bash";
	details: BreadcrumbDetails | undefined;
	content: ContentBlock[];
} {
	return event.toolName === "bash";
}

function getPreRtkOutputPath(details: BreadcrumbDetails | undefined): string | undefined {
	return typeof details?.preRtkOutputPath === "string" ? details.preRtkOutputPath : undefined;
}

function hasCompressionInfo(details: BreadcrumbDetails | undefined): boolean {
	return details != null && "compressionInfo" in details && details.compressionInfo != null;
}

function buildBreadcrumb(preRtkOutputPath: string): string {
	return `[Pre-RTK snapshot: ${preRtkOutputPath} — use read on that path for the full pre-RTK text]`;
}

function hasBreadcrumb(text: string, preRtkOutputPath: string): boolean {
	return text.includes(`[Pre-RTK snapshot: ${preRtkOutputPath}`);
}

function appendBreadcrumb(content: ContentBlock[], preRtkOutputPath: string): TextContent[] | undefined {
	const textBlocks = content.filter(
		(block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
	);

	if (textBlocks.length === 0 || textBlocks.length !== content.length) {
		return undefined;
	}

	if (textBlocks.some((block) => hasBreadcrumb(block.text, preRtkOutputPath))) {
		return undefined;
	}

	const note = buildBreadcrumb(preRtkOutputPath);
	const lastIndex = content.length - 1;
	const lastBlock = content[lastIndex] as Extract<ContentBlock, { type: "text" }>;
	const separator = lastBlock.text.endsWith("\n") ? "\n" : "\n\n";

	return content.map((block, index) =>
		index === lastIndex ? { ...block, text: `${lastBlock.text}${separator}${note}` } : block,
	) as TextContent[];
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event)) {
			return undefined;
		}

		const preRtkOutputPath = getPreRtkOutputPath(event.details);
		if (!preRtkOutputPath || !hasCompressionInfo(event.details)) {
			return undefined;
		}

		const content = appendBreadcrumb(event.content, preRtkOutputPath);
		if (!content) {
			return undefined;
		}

		return { content };
	});
}
