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
import { formatSize, type BashToolDetails, type ExtensionAPI, type ToolResultEvent } from "@mariozechner/pi-coding-agent";

type ContentBlock = ToolResultEvent["content"][number];
type CompressionInfo = {
	originalBytes: number;
	outputBytes: number;
	technique?: string;
	bypassedBy?: string;
};
type PreRtkTrimInfo = {
	summary?: unknown;
};
type BreadcrumbDetails = BashToolDetails & {
	preRtkOutputPath?: string;
	preRtkTrim?: PreRtkTrimInfo;
	compressionInfo?: unknown;
};

const NON_COMPRESSIVE_TECHNIQUES = new Set(["none", "test-output"]);
const NOTE_PREFIX = "[Bash output note:";

function isBashToolResult(event: ToolResultEvent): event is ToolResultEvent & {
	toolName: "bash";
	input: { command?: string };
	details: BreadcrumbDetails | undefined;
	content: ContentBlock[];
} {
	return event.toolName === "bash";
}

function getPreRtkOutputPath(details: BreadcrumbDetails | undefined): string | undefined {
	return typeof details?.preRtkOutputPath === "string" ? details.preRtkOutputPath : undefined;
}

function getPreRtkTrimSummary(details: BreadcrumbDetails | undefined): string | undefined {
	const trim = details?.preRtkTrim;
	return trim && typeof trim.summary === "string" ? trim.summary : undefined;
}

function getCompressionInfo(details: BreadcrumbDetails | undefined): CompressionInfo | undefined {
	const raw = details?.compressionInfo;
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const info = raw as Record<string, unknown>;
	if (typeof info.originalBytes !== "number" || typeof info.outputBytes !== "number") {
		return undefined;
	}

	return {
		originalBytes: info.originalBytes,
		outputBytes: info.outputBytes,
		technique: typeof info.technique === "string" ? info.technique : undefined,
		bypassedBy: typeof info.bypassedBy === "string" ? info.bypassedBy : undefined,
	};
}

function isRouteCompressed(info: CompressionInfo | undefined): info is CompressionInfo & { technique: string } {
	return !!info
		&& !info.bypassedBy
		&& typeof info.technique === "string"
		&& !NON_COMPRESSIVE_TECHNIQUES.has(info.technique)
		&& info.outputBytes < info.originalBytes;
}

function formatCompression(info: CompressionInfo & { technique: string }): string {
	return `${info.technique} ${formatSize(info.originalBytes)} → ${formatSize(info.outputBytes)}`;
}

function formatBypassHint(command: string): string {
	const trimmed = command.trim();
	if (!trimmed || trimmed.includes("\n")) {
		return "rerun with PI_RTK_BYPASS=1 for exact output";
	}

	return `rerun with \`PI_RTK_BYPASS=1 ${trimmed}\` for exact output`;
}

function buildBreadcrumb(
	details: BreadcrumbDetails | undefined,
	info: CompressionInfo | undefined,
	command: string,
): string | undefined {
	const parts: string[] = [];
	const preRtkOutputPath = getPreRtkOutputPath(details);
	if (preRtkOutputPath) {
		const summary = getPreRtkTrimSummary(details);
		parts.push(`pre-RTK output was trimmed${summary ? ` (${summary})` : ""}; full pre-RTK text: ${preRtkOutputPath} (use read)`);
	}

	if (isRouteCompressed(info)) {
		parts.push(`visible output was RTK-compressed (${formatCompression(info)}); ${formatBypassHint(command)}`);
	}

	if (parts.length === 0) {
		return undefined;
	}

	return `${NOTE_PREFIX} ${parts.join("; ")}]`;
}

function hasBreadcrumb(text: string, note: string, preRtkOutputPath?: string): boolean {
	if (text.includes(NOTE_PREFIX) || text.includes(note)) {
		return true;
	}

	// Avoid doubling up with older in-band pre-RTK notes while sessions are being reloaded.
	return !!preRtkOutputPath && text.includes(preRtkOutputPath) && text.includes("Pre-RTK");
}

function appendBreadcrumb(content: ContentBlock[], note: string, preRtkOutputPath?: string): TextContent[] | undefined {
	const textBlocks = content.filter(
		(block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
	);

	if (textBlocks.length === 0 || textBlocks.length !== content.length) {
		return undefined;
	}

	if (textBlocks.some((block) => hasBreadcrumb(block.text, note, preRtkOutputPath))) {
		return undefined;
	}

	const lastIndex = content.length - 1;
	const lastBlock = content[lastIndex] as Extract<ContentBlock, { type: "text" }>;
	const separator = lastBlock.text.endsWith("\n") ? "\n" : "\n\n";

	return content.map((block, index) =>
		index === lastIndex ? { ...block, text: `${lastBlock.text}${separator}${note}` } : block,
	) as TextContent[];
}

function removeStaleTruncation(details: BreadcrumbDetails | undefined): BreadcrumbDetails | undefined {
	if (!details?.truncation) {
		return undefined;
	}

	const next: BreadcrumbDetails = { ...details };
	delete next.truncation;
	return next;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event)) {
			return undefined;
		}

		const info = getCompressionInfo(event.details);
		const note = buildBreadcrumb(event.details, info, event.input.command ?? "");
		const content = note ? appendBreadcrumb(event.content, note, getPreRtkOutputPath(event.details)) : undefined;
		const details = isRouteCompressed(info) ? removeStaleTruncation(event.details) : undefined;

		if (!content && !details) {
			return undefined;
		}

		return {
			...(content ? { content } : {}),
			...(details ? { details } : {}),
		};
	});
}
