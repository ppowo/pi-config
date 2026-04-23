/**
 * handoff-lite — start a new pi session with a compact handoff summary + session_query.
 *
 * Originally adapted from pi-vcc (MIT License), but intentionally simplified here for
 * handoff-lite so the injected summary stays short and high-signal for the next model.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { readFileSync } from "fs";

// ─── types ───────────────────────────────────────────────────────────────────

type NormalizedBlock =
	| { kind: "user"; text: string; sourceIndex?: number }
	| { kind: "assistant"; text: string; sourceIndex?: number }
	| { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
	| { kind: "tool_result"; name: string; text: string; isError: boolean; sourceIndex?: number }
	| { kind: "thinking"; text: string; redacted: boolean; sourceIndex?: number };

interface SectionData {
	sessionGoal: string[];
	filesAndChanges: string[];
	outstandingContext: string[];
	userPreferences: string[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const clip = (text: string, max = 200): string => text.slice(0, max);

const nonEmptyLines = (text: string): string[] =>
	text.split("\n").map((line) => line.trim()).filter(Boolean);

const firstLine = (text: string, max = 200): string =>
	clip(text.split("\n")[0] ?? "", max);

const normalizeComparableText = (text: string): string =>
	text.toLowerCase().replace(/\s+/g, " ").trim();

// Avoid duplicating goal-style user requests into Outstanding Context when the
// same blocker phrase already appears in Session Goal (for example: "Fix the build failure").

const matchesSessionGoal = (line: string, sessionGoals: string[]): boolean => {
	const normalizedLine = normalizeComparableText(line);
	if (!normalizedLine) return false;
	return sessionGoals.some((goal) => {
		if (goal === "[Scope change]") return false;
		const normalizedGoal = normalizeComparableText(goal);
		return normalizedGoal === normalizedLine
			|| normalizedGoal.startsWith(normalizedLine)
			|| normalizedLine.startsWith(normalizedGoal);
	});
};

const textOf = (content: Message["content"]): string => {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
};

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

const sanitize = (text: string): string =>
	text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");

const extractPath = (args: Record<string, unknown>): string | null => {
	for (const key of ["path", "file_path", "filePath", "file"]) {
		if (typeof args[key] === "string") return args[key] as string;
	}
	return null;
};

const SENSITIVE_RE =
	/(?:sshpass\s+-p\s*'[^']*'|sshpass\s+-p\s*"[^"]*"|sshpass\s+-p\s*\S+|password[=:]\s*\S+|api[_-]?key[=:]\s*\S+|secret[=:]\s*\S+|token[=:]\s*[A-Za-z0-9_\-\.]{8,}|-i\s+\S+\.pem\b)/gi;

const redact = (text: string): string =>
	text.replace(SENSITIVE_RE, (match) => `${match.split(/[=:\s]+/)[0]} [REDACTED]`);


// ─── normalize ───────────────────────────────────────────────────────────────

const normalizeOne = (msg: Message, msgIndex: number): NormalizedBlock[] => {
	if (msg.role === "user") {
		const blocks: NormalizedBlock[] = [];
		const text = sanitize(textOf(msg.content));
		if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
		if (msg.content && typeof msg.content !== "string") {
			for (const part of msg.content) {
				if (part.type === "image") {
					blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
				}
			}
		}
		return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
	}

	if (msg.role === "toolResult") {
		return [{
			kind: "tool_result",
			name: msg.toolName,
			text: sanitize(textOf(msg.content)),
			isError: msg.isError,
			sourceIndex: msgIndex,
		}];
	}

	if (msg.role === "assistant") {
		if (!msg.content) return [];
		if (typeof msg.content === "string") {
			return [{ kind: "assistant", text: sanitize(msg.content), sourceIndex: msgIndex }];
		}

		const blocks: NormalizedBlock[] = [];
		for (const part of msg.content) {
			if (part.type === "text") {
				blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex: msgIndex });
			} else if (part.type === "thinking") {
				blocks.push({
					kind: "thinking",
					text: sanitize(part.thinking),
					redacted: part.redacted ?? false,
					sourceIndex: msgIndex,
				});
			} else if (part.type === "toolCall") {
				blocks.push({
					kind: "tool_call",
					name: part.name,
					args: part.arguments,
					sourceIndex: msgIndex,
				});
			}
		}
		return blocks;
	}

	return [];
};

const normalize = (messages: Message[]): NormalizedBlock[] =>
	messages.flatMap((msg, i) => normalizeOne(msg, i));

// ─── filter noise ────────────────────────────────────────────────────────────

const NOISE_TOOLS = new Set([
	"TodoWrite", "TodoRead", "ToolSearch", "WebSearch",
	"AskUser", "ExitSpecMode", "GenerateDroid",
]);

const NOISE_STRINGS = [
	"Continue from where you left off.",
	"No response requested.",
	"IMPORTANT: TodoWrite was not called yet.",
];

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

const isNoiseUserBlock = (text: string): boolean => {
	const trimmed = text.trim();
	if (NOISE_STRINGS.some((s) => trimmed.includes(s))) return true;
	return trimmed.replace(XML_WRAPPER_RE, "").trim().length === 0;
};

const cleanUserText = (text: string): string =>
	text.replace(XML_WRAPPER_RE, "").trim();

const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => {
	const out: NormalizedBlock[] = [];
	for (const block of blocks) {
		if (block.kind === "thinking") continue;
		if (block.kind === "tool_call" && NOISE_TOOLS.has(block.name)) continue;
		if (block.kind === "tool_result" && NOISE_TOOLS.has(block.name)) continue;
		if (block.kind === "user") {
			if (isNoiseUserBlock(block.text)) continue;
			const cleaned = cleanUserText(block.text);
			if (!cleaned) continue;
			out.push({ kind: "user", text: cleaned, sourceIndex: block.sourceIndex });
			continue;
		}
		out.push(block);
	}
	return out;
};

// ─── extract: goals ──────────────────────────────────────────────────────────

const SCOPE_CHANGE_RE =
	/\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;
const TASK_RE =
	/\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;
const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

const isSubstantiveGoal = (text: string): boolean =>
	text.length > 5 && !NOISE_SHORT_RE.test(text.trim());

const extractGoals = (blocks: NormalizedBlock[]): string[] => {
	const goals: string[] = [];
	let latestScopeChange: string[] | null = null;

	for (const block of blocks) {
		if (block.kind !== "user") continue;
		const lines = nonEmptyLines(block.text).filter(isSubstantiveGoal);
		if (lines.length === 0) continue;

		if (goals.length === 0) {
			goals.push(...lines.slice(0, 3));
			continue;
		}

		if (SCOPE_CHANGE_RE.test(block.text)) {
			latestScopeChange = lines.slice(0, 3).map((line) => clip(line, 200));
		} else if (TASK_RE.test(block.text) && lines[0].length > 15) {
			latestScopeChange = lines.slice(0, 2).map((line) => clip(line, 200));
		}
	}

	if (latestScopeChange) goals.push("[Scope change]", ...latestScopeChange);
	return goals.slice(0, 8);
};

// ─── extract: files ──────────────────────────────────────────────────────────

const FILE_READ_TOOLS = new Set(["Read", "read", "read_file", "View"]);
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "edit", "write", "edit_file", "write_file", "MultiEdit"]);
const FILE_CREATE_TOOLS = new Set(["Write", "write", "write_file"]);

const extractFiles = (blocks: NormalizedBlock[]) => {
	const read = new Set<string>();
	const modified = new Set<string>();
	const created = new Set<string>();

	for (const block of blocks) {
		if (block.kind !== "tool_call") continue;
		const path = extractPath(block.args);
		if (!path) continue;
		if (FILE_READ_TOOLS.has(block.name)) read.add(path);
		if (FILE_WRITE_TOOLS.has(block.name)) modified.add(path);
		if (FILE_CREATE_TOOLS.has(block.name)) created.add(path);
	}

	return { read, modified, created };
};

// ─── extract: preferences ────────────────────────────────────────────────────

const PREF_PATTERNS = [
	/\bprefer\b/i,
	/\bdon'?t want\b/i,
	/\balways\b/i,
	/\bnever\b/i,
	/\bplease\s+(use|avoid|keep|make)\b/i,
	/\bstyle[:\s]/i,
	/\bformat[:\s]/i,
	/\blanguage[:\s]/i,
];

const extractPreferences = (blocks: NormalizedBlock[]): string[] => {
	const prefs: string[] = [];
	for (const block of blocks) {
		if (block.kind !== "user") continue;
		for (const line of nonEmptyLines(block.text)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.length < 5) continue;
			if (PREF_PATTERNS.some((pattern) => pattern.test(trimmed))) {
				prefs.push(clip(trimmed, 200));
			}
		}
	}
	return [...new Set(prefs)].slice(0, 10);
};

// ─── brief transcript ────────────────────────────────────────────────────────


// ─── build sections ──────────────────────────────────────────────────────────

const BLOCKER_RE =
	/\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const extractOutstandingContext = (blocks: NormalizedBlock[], sessionGoals: string[]): string[] => {
	const items: string[] = [];
	for (const block of blocks.slice(-20)) {
		if (block.kind === "tool_result" && block.isError) {
			items.push(`[${block.name}] ${firstLine(block.text, 150)}`);
			continue;
		}
		if (block.kind === "assistant" || block.kind === "user") {
			for (const line of nonEmptyLines(block.text)) {
				if (!BLOCKER_RE.test(line) || line.length < 15) continue;
				if (block.kind === "user" && matchesSessionGoal(line, sessionGoals)) continue;
				const clipped = block.kind === "user" ? `[user] ${clip(line, 150)}` : clip(line, 150);
				if (!items.includes(clipped)) items.push(clipped);
				break;
			}
		}
	}
	return items.slice(0, 5);
};
const formatFileActivity = (blocks: NormalizedBlock[]): string[] => {
	const activity = extractFiles(blocks);
	const lines: string[] = [];
	const cap = (set: Set<string>, limit: number): string => {
		const arr = [...set];
		if (arr.length <= limit) return arr.join(", ");
		return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
	};
	if (activity.modified.size > 0) lines.push(`Modified: ${cap(activity.modified, 10)}`);
	if (activity.created.size > 0) lines.push(`Created: ${cap(activity.created, 10)}`);
	return lines;
};

const buildSections = (blocks: NormalizedBlock[]): SectionData => {
	const sessionGoal = extractGoals(blocks);
	return {
		sessionGoal,
		filesAndChanges: formatFileActivity(blocks),
		outstandingContext: extractOutstandingContext(blocks, sessionGoal),
		userPreferences: extractPreferences(blocks),
	};
};

// ─── format ──────────────────────────────────────────────────────────────────

const section = (title: string, items: string[]): string => {
	if (items.length === 0) return "";
	const body = items.map((item) => `- ${item}`).join("\n");
	return `[${title}]\n${body}`;
};

const formatSummary = (data: SectionData): string => [
	section("Session Goal", data.sessionGoal),
	section("Files And Changes", data.filesAndChanges),
	section("Outstanding Context", data.outstandingContext),
	section("User Preferences", data.userPreferences),
].filter(Boolean).join("\n\n");

// ─── compile ─────────────────────────────────────────────────────────────────

const compile = (messages: Message[]): string => {
	const blocks = filterNoise(normalize(messages));
	const data = buildSections(blocks);
	return redact(formatSummary(data));
};

const HANDOFF_LITE_PROMPT_PREFIX = "/skill:session-query Continue this task from the parent session below.";
const HANDOFF_LITE_QUERY_INSTRUCTION =
	"Before doing anything else, use `session_query` on the parent session above to recover only the context needed to continue from there. Start with targeted questions about the latest task state, relevant files or changes, and any remaining work or blockers. Then continue the goal.";

const isSyntheticHandoffLitePrompt = (text: string): boolean => {
	const trimmed = text.trim();
	if (!trimmed.startsWith(HANDOFF_LITE_PROMPT_PREFIX)) return false;
	if (!trimmed.includes("**Goal:**")) return false;
	if (!trimmed.includes("**Parent session:**")) return false;
	return trimmed.includes(HANDOFF_LITE_QUERY_INSTRUCTION)
		|| trimmed.includes("Before doing anything else, use `session_query` on the parent session above");
};

// Important: exclude the synthetic /handoff-lite user prompt before re-summarizing a session.
// That prompt already contains a prior "Parent session summary", so keeping it would
// recursively summarize older summaries and gradually bloat/degrade the handoff context.
// If buildHandoffLitePrompt() changes, keep this detector/filter in sync.
const stripSyntheticHandoffLiteMessages = (messages: Message[]): Message[] =>
	messages.filter((msg) => msg.role !== "user" || !isSyntheticHandoffLitePrompt(textOf(msg.content)));

// ─── session JSONL reader ────────────────────────────────────────────────────

const loadSessionMessages = (sessionFile: string): Message[] => {
	const content = readFileSync(sessionFile, "utf-8");
	const rawMessages: any[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) rawMessages.push(entry.message);
		} catch {}
	}
	return stripSyntheticHandoffLiteMessages(convertToLlm(rawMessages));
};

// ─── handoff-lite ────────────────────────────────────────────────────────────

const HANDOFF_LITE_GLOBAL_KEY = Symbol.for("pi-config-handoff-lite-pending");

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type PendingHandoffLite = {
	prompt: string;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
} | null;

function getPendingHandoffLite(): PendingHandoffLite {
	return (globalThis as Record<symbol, PendingHandoffLite | undefined>)[HANDOFF_LITE_GLOBAL_KEY] ?? null;
}

function setPendingHandoffLite(data: PendingHandoffLite) {
	if (data) {
		(globalThis as Record<symbol, PendingHandoffLite | undefined>)[HANDOFF_LITE_GLOBAL_KEY] = data;
	} else {
		delete (globalThis as Record<symbol, PendingHandoffLite | undefined>)[HANDOFF_LITE_GLOBAL_KEY];
	}
}

function buildHandoffLitePrompt(goal: string, parentSession: string, summary: string): string {
	return [
		HANDOFF_LITE_PROMPT_PREFIX,
		`**Goal:** ${goal}`,
		`**Parent session summary:**\n${summary}`,
		`**Parent session:** \`${parentSession}\``,
		HANDOFF_LITE_QUERY_INSTRUCTION,
	].join("\n\n");
}

async function restoreHandoffLiteState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	pending: Exclude<PendingHandoffLite, null>,
) {
	const model = ctx.modelRegistry.find(pending.provider, pending.modelId);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Handoff-lite: could not restore ${pending.provider}/${pending.modelId}; using current session model`,
				"warning",
			);
		}
	} else {
		const ok = await pi.setModel(model);
		if (!ok && ctx.hasUI) {
			ctx.ui.notify(
				`Handoff-lite: no API key for ${pending.provider}/${pending.modelId}; using current session model`,
				"warning",
			);
		}
	}
	pi.setThinkingLevel(pending.thinkingLevel);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		if (event.reason !== "new") return;

		const pending = getPendingHandoffLite();
		if (!pending) return;

		setPendingHandoffLite(null);
		await restoreHandoffLiteState(pi, ctx, pending);
		pi.sendUserMessage(pending.prompt);
	});

	pi.registerCommand("handoff-lite", {
		description: "Start a new session with a VCC summary + session-query handoff prompt",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff-lite <goal>", "error");
				return;
			}

			const parentSession = ctx.sessionManager.getSessionFile();
			if (!parentSession) {
				ctx.ui.notify("Handoff-lite needs a saved parent session.", "error");
				return;
			}

			const currentModel = ctx.model;
			if (!currentModel) {
				ctx.ui.notify("Handoff-lite requires an active model.", "error");
				return;
			}
			const currentThinkingLevel = pi.getThinkingLevel();

			let summary = "(no summary available)";
			try {
				const messages = loadSessionMessages(parentSession);
				const compiled = messages.length > 0 ? compile(messages).trim() : "";
				if (compiled) summary = compiled;
			} catch {}

			setPendingHandoffLite({
				prompt: buildHandoffLitePrompt(goal, parentSession, summary),
				provider: currentModel.provider,
				modelId: currentModel.id,
				thinkingLevel: currentThinkingLevel,
			});
			const result = await ctx.newSession({ parentSession });
			if (result.cancelled) {
				setPendingHandoffLite(null);
			}
		},
	});
}
