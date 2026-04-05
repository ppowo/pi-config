/**
 * handoff-lite — start a new pi session with a VCC algorithmic summary + session_query.
 *
 * Summarization pipeline adapted from pi-vcc (MIT License)
 * https://github.com/sting8k/pi-vcc — Copyright (c) sting8k
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { readFileSync } from "fs";

// ─── types ───────────────────────────────────────────────────────────────────

type NormalizedBlock =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool_call"; name: string; args: Record<string, unknown> }
	| { kind: "tool_result"; name: string; text: string; isError: boolean }
	| { kind: "thinking"; text: string; redacted: boolean };

interface SectionData {
	sessionGoal: string[];
	keyConversationTurns: string[];
	actionsTaken: string[];
	importantEvidence: string[];
	filesRead: string[];
	filesModified: string[];
	filesCreated: string[];
	outstandingContext: string[];
	userPreferences: string[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const clip = (text: string, max = 200): string => text.slice(0, max);

const nonEmptyLines = (text: string): string[] =>
	text.split("\n").map((l) => l.trim()).filter(Boolean);

const firstLine = (text: string, max = 200): string =>
	clip(text.split("\n")[0] ?? "", max);

const textOf = (content: Message["content"]): string => {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
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
	text.replace(SENSITIVE_RE, (m) => `${m.split(/[=:\s]+/)[0]} [REDACTED]`);

// ─── normalize ───────────────────────────────────────────────────────────────

const normalizeOne = (msg: Message): NormalizedBlock[] => {
	if (msg.role === "user") {
		const blocks: NormalizedBlock[] = [];
		const text = sanitize(textOf(msg.content));
		if (text) blocks.push({ kind: "user", text });
		if (msg.content && typeof msg.content !== "string") {
			for (const part of msg.content) {
				if (part.type === "image") {
					blocks.push({ kind: "user", text: `[image: ${part.mimeType}]` });
				}
			}
		}
		return blocks.length > 0 ? blocks : [{ kind: "user", text: "" }];
	}
	if (msg.role === "toolResult") {
		return [{
			kind: "tool_result",
			name: msg.toolName,
			text: sanitize(textOf(msg.content)),
			isError: msg.isError,
		}];
	}
	if (msg.role === "assistant") {
		if (!msg.content) return [];
		if (typeof msg.content === "string") {
			return [{ kind: "assistant", text: sanitize(msg.content) }];
		}
		const blocks: NormalizedBlock[] = [];
		for (const part of msg.content) {
			if (part.type === "text") {
				blocks.push({ kind: "assistant", text: sanitize(part.text) });
			} else if (part.type === "thinking") {
				blocks.push({ kind: "thinking", text: sanitize(part.thinking), redacted: part.redacted ?? false });
			} else if (part.type === "toolCall") {
				blocks.push({ kind: "tool_call", name: part.name, args: part.arguments });
			}
		}
		return blocks;
	}
	return [];
};

const normalize = (messages: Message[]): NormalizedBlock[] => messages.flatMap(normalizeOne);

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

const cleanUserText = (text: string): string => text.replace(XML_WRAPPER_RE, "").trim();

const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => {
	const out: NormalizedBlock[] = [];
	for (const b of blocks) {
		if (b.kind === "thinking") continue;
		if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
		if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
		if (b.kind === "user") {
			if (isNoiseUserBlock(b.text)) continue;
			const cleaned = cleanUserText(b.text);
			if (!cleaned) continue;
			out.push({ kind: "user", text: cleaned });
			continue;
		}
		out.push(b);
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
	for (const b of blocks) {
		if (b.kind !== "user") continue;
		const lines = nonEmptyLines(b.text).filter(isSubstantiveGoal);
		if (lines.length === 0) continue;
		if (goals.length === 0) { goals.push(...lines.slice(0, 3)); continue; }
		if (SCOPE_CHANGE_RE.test(b.text)) {
			latestScopeChange = lines.slice(0, 3).map((l) => clip(l, 200));
		} else if (TASK_RE.test(b.text) && lines[0].length > 15) {
			latestScopeChange = lines.slice(0, 2).map((l) => clip(l, 200));
		}
	}
	if (latestScopeChange) goals.push("[Scope change]", ...latestScopeChange);
	return goals.slice(0, 8);
};

// ─── extract: files ──────────────────────────────────────────────────────────

const FILE_READ_TOOLS = new Set(["Read", "read_file", "tilth", "View"]);
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "edit", "write", "edit_file", "write_file", "MultiEdit"]);
const FILE_CREATE_TOOLS = new Set(["Write", "write", "write_file"]);

const extractFiles = (blocks: NormalizedBlock[]) => {
	const read = new Set<string>();
	const modified = new Set<string>();
	const created = new Set<string>();
	for (const b of blocks) {
		if (b.kind !== "tool_call") continue;
		const p = extractPath(b.args);
		if (!p) continue;
		if (FILE_READ_TOOLS.has(b.name)) read.add(p);
		if (FILE_WRITE_TOOLS.has(b.name)) modified.add(p);
		if (FILE_CREATE_TOOLS.has(b.name)) created.add(p);
	}
	return { read, modified, created };
};

// ─── extract: findings ───────────────────────────────────────────────────────

const FINDING_NOISE_TOOLS = new Set(["TodoWrite", "ToolSearch", "Skill"]);
const FINDING_RE = /\b(fail|error|broken|cannot|bug|issue|root cause|leak|crash|timeout)\b/i;

const truncateText = (text: string, limit = 128): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	const words = flat.split(/\s+/).filter(Boolean);
	if (words.length <= limit) return flat;
	return words.slice(0, limit).join(" ") + "...(truncated)";
};

const extractFindings = (blocks: NormalizedBlock[]): string[] => {
	const results: string[] = [];
	const seen = new Set<string>();
	for (const b of blocks) {
		const text = b.kind === "tool_result" || b.kind === "assistant" || b.kind === "user"
			? (b as any).text?.trim() : undefined;
		if (!text || text.length < 20) continue;
		let label = "";
		if (b.kind === "tool_result") {
			if (b.isError) continue;
			if (FINDING_NOISE_TOOLS.has(b.name)) continue;
			label = `[${b.name}] ${truncateText(text)}`;
		} else if (b.kind === "assistant" && FINDING_RE.test(text)) {
			label = truncateText(text);
		} else { continue; }
		const key = label.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		results.push(label);
	}
	return results.slice(-8);
};

// ─── extract: preferences ────────────────────────────────────────────────────

const PREF_PATTERNS = [
	/\bprefer\b/i, /\bdon'?t want\b/i, /\balways\b/i, /\bnever\b/i,
	/\bplease\s+(use|avoid|keep|make)\b/i, /\bstyle[:\s]/i, /\bformat[:\s]/i, /\blanguage[:\s]/i,
];

const extractPreferences = (blocks: NormalizedBlock[]): string[] => {
	const prefs: string[] = [];
	for (const b of blocks) {
		if (b.kind !== "user") continue;
		for (const line of nonEmptyLines(b.text)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.length < 5) continue;
			if (PREF_PATTERNS.some((p) => p.test(trimmed))) prefs.push(clip(trimmed, 200));
		}
	}
	return [...new Set(prefs)].slice(0, 10);
};

// ─── build sections ──────────────────────────────────────────────────────────

const TOOL_SUMMARY_FIELDS: Record<string, string> = {
	Read: "file_path", Edit: "file_path", Write: "file_path",
	read: "file_path", edit: "file_path", write: "file_path",
	Glob: "pattern", Grep: "pattern",
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
	const field = TOOL_SUMMARY_FIELDS[name];
	if (field && typeof args[field] === "string") return `* ${name} "${clip(args[field] as string, 60)}"`;
	const path = extractPath(args);
	if (path) return `* ${name} "${clip(path, 60)}"`;
	if (name === "bash" || name === "Bash") {
		const cmd = (args.command ?? args.description ?? "") as string;
		return `* ${name} "${redact(clip(cmd, 80))}"`;
	}
	if (typeof args.query === "string") return `* ${name} "${clip(args.query as string, 60)}"`;
	return `* ${name}`;
};

const FILLER_RE = /^(ok|sure|done|got it|alright|let me|i('ll| will)|here'?s|understood)/i;
const BLOCKER_RE =
	/\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const extractActionsTaken = (blocks: NormalizedBlock[]): string[] => {
	const raw: string[] = [];
	for (const b of blocks) {
		if (b.kind === "tool_call") raw.push(toolOneLiner(b.name, b.args));
	}
	const counts = new Map<string, number>();
	for (const d of raw) counts.set(d, (counts.get(d) ?? 0) + 1);
	const collapsed = [...counts.entries()].map(([k, v]) => (v > 1 ? `${k} x${v}` : k));
	if (collapsed.length <= 8) return collapsed;
	const omitted = collapsed.length - 5;
	return [...collapsed.slice(0, 3), `+${omitted} actions omitted`, ...collapsed.slice(-2)];
};

const extractKeyConversationTurns = (blocks: NormalizedBlock[]): string[] => {
	const turns: string[] = [];
	const conversational = blocks.filter((b) => b.kind === "user" || b.kind === "assistant");
	for (const b of conversational.slice(-12)) {
		const text = (b as any).text?.trim();
		if (!text || text.length < 10) continue;
		if (b.kind === "user" && FILLER_RE.test(text)) continue;
		turns.push((b.kind === "user" ? "[user] " : "[assistant] ") + truncateText(text));
	}
	return turns.slice(-8);
};

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
	const items: string[] = [];
	for (const b of blocks.slice(-20)) {
		if (b.kind === "tool_result" && b.isError) {
			items.push(`[${b.name}] ${firstLine(b.text, 150)}`);
			continue;
		}
		if (b.kind === "assistant" || b.kind === "user") {
			for (const line of nonEmptyLines((b as any).text)) {
				if (!BLOCKER_RE.test(line) || line.length < 15) continue;
				const clipped = b.kind === "user" ? `[user] ${clip(line, 150)}` : clip(line, 150);
				if (!items.includes(clipped)) items.push(clipped);
				break;
			}
		}
	}
	return items.slice(0, 5);
};

const buildSections = (blocks: NormalizedBlock[]): SectionData => {
	const fa = extractFiles(blocks);
	return {
		sessionGoal: extractGoals(blocks),
		keyConversationTurns: extractKeyConversationTurns(blocks),
		actionsTaken: extractActionsTaken(blocks),
		importantEvidence: extractFindings(blocks),
		filesRead: [...fa.read],
		filesModified: [...fa.modified],
		filesCreated: [...fa.created],
		outstandingContext: extractOutstandingContext(blocks),
		userPreferences: extractPreferences(blocks),
	};
};

// ─── format ──────────────────────────────────────────────────────────────────

const section = (title: string, items: string[]): string => {
	if (items.length === 0) return "";
	return `[${title}]\n${items.map((i) => `- ${i}`).join("\n")}`;
};

const filesSection = (data: SectionData): string => {
	const parts: string[] = [];
	if (data.filesRead.length > 0)
		parts.push("Read:\n" + data.filesRead.map((f) => `  - ${f}`).join("\n"));
	if (data.filesModified.length > 0)
		parts.push("Modified:\n" + data.filesModified.map((f) => `  - ${f}`).join("\n"));
	if (data.filesCreated.length > 0)
		parts.push("Created:\n" + data.filesCreated.map((f) => `  - ${f}`).join("\n"));
	if (parts.length === 0) return "";
	return `[Files And Changes]\n${parts.join("\n")}`;
};

const formatSummary = (data: SectionData): string => {
	return [
		section("Session Goal", data.sessionGoal),
		section("Key Conversation Turns", data.keyConversationTurns),
		section("Actions Taken", data.actionsTaken),
		section("Important Evidence", data.importantEvidence),
		filesSection(data),
		section("Outstanding Context", data.outstandingContext),
		section("User Preferences", data.userPreferences),
	].filter(Boolean).join("\n\n");
};

// ─── compile ─────────────────────────────────────────────────────────────────

const compile = (messages: Message[]): string => {
	const blocks = filterNoise(normalize(messages));
	const data = buildSections(blocks);
	return redact(formatSummary(data));
};

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
	return convertToLlm(rawMessages);
};

// ─── handoff-lite ────────────────────────────────────────────────────────────

const HANDOFF_LITE_GLOBAL_KEY = Symbol.for("pi-config-handoff-lite-pending");

type PendingHandoffLite = { prompt: string } | null;

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
	return `/skill:session-query Continue this task from the parent session below.

**Goal:** ${goal}

**Parent session summary:**
${summary}

**Parent session:** \`${parentSession}\`

Before doing anything else, use \`session_query\` on the parent session above to recover only the context needed to continue from there. Start with targeted questions about the latest task state, relevant files or changes, and any remaining work or blockers. Then continue the goal.`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx: ExtensionContext) => {
		const pending = getPendingHandoffLite();
		if (!pending) return;

		setPendingHandoffLite(null);
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

			let summary = "(no summary available)";
			try {
				const messages = loadSessionMessages(parentSession);
				if (messages.length > 0) summary = compile(messages);
			} catch {}

			setPendingHandoffLite({ prompt: buildHandoffLitePrompt(goal, parentSession, summary) });
			const result = await ctx.newSession({ parentSession });
			if (result.cancelled) {
				setPendingHandoffLite(null);
			}
		},
	});
}
