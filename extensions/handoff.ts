/**
 * handoff — start a new pi session with a deterministic, lineage-aware summary.
 *
 * This is a context-full-safe replacement for LLM-generated handoff prompts: it
 * compiles compact local summaries and exposes older sessions as bounded refs
 * that can be queried with session_query only when exact details are needed.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
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
	commits: string[];
	briefTranscript: string[];
	outstandingContext: string[];
	userPreferences: string[];
}

interface SessionHeader {
	type?: string;
	parentSession?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const clip = (text: string, max = 200): string => text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";

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

const NON_GOAL_RE =
	/^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;
const TEMPLATE_SIGNAL_RE =
	/^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

const stripLeadingBullet = (line: string): string =>
	line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const truncateAtTemplate = (lines: string[]): string[] => {
	const idx = lines.findIndex((line) => TEMPLATE_SIGNAL_RE.test(line));
	return idx >= 0 ? lines.slice(0, idx) : lines;
};

const isSubstantiveGoal = (text: string): boolean => {
	const trimmed = text.trim();
	return trimmed.length > 5
		&& trimmed.length <= 200
		&& !NOISE_SHORT_RE.test(trimmed)
		&& !NON_GOAL_RE.test(trimmed);
};

const extractGoals = (blocks: NormalizedBlock[]): string[] => {
	const goals: string[] = [];
	let latestScopeChange: string[] | null = null;

	for (const block of blocks) {
		if (block.kind !== "user") continue;
		const lines = truncateAtTemplate(nonEmptyLines(block.text))
			.filter(isSubstantiveGoal)
			.map(stripLeadingBullet)
			.filter((line) => line.length > 5);
		if (lines.length === 0) continue;

		if (goals.length === 0) {
			goals.push(...lines.slice(0, 6));
			continue;
		}

		const leading = block.text.slice(0, 200);
		if (SCOPE_CHANGE_RE.test(leading)) {
			latestScopeChange = lines.slice(0, 3).map((line) => clip(line, 200));
		} else if (TASK_RE.test(leading) && lines[0].length > 15) {
			latestScopeChange = lines.slice(0, 2).map((line) => clip(line, 200));
		}
	}

	if (latestScopeChange && latestScopeChange.length > 0) goals.push("[Scope change]", ...latestScopeChange);
	return goals.slice(0, 8);
};

// ─── extract: files ──────────────────────────────────────────────────────────

const FILE_READ_TOOLS = new Set(["Read", "read", "read_file", "View"]);
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "edit", "write", "edit_file", "write_file", "MultiEdit"]);
const FILE_CREATE_TOOLS = new Set(["Write", "write", "write_file"]);

const longestCommonDirPrefix = (paths: string[]): string => {
	const absolute = paths.filter((path) => path.startsWith("/"));
	if (absolute.length < 2) return "";
	const split = absolute.map((path) => path.split("/"));
	const min = Math.min(...split.map((parts) => parts.length));
	let i = 0;
	while (i < min - 1) {
		const segment = split[0][i];
		if (!split.every((parts) => parts[i] === segment)) break;
		i++;
	}
	if (i < 2) return "";
	return split[0].slice(0, i).join("/") + "/";
};

const trimPathSet = (set: Set<string>, prefix: string): Set<string> => {
	if (!prefix) return set;
	return new Set([...set].map((path) => path.startsWith(prefix) ? path.slice(prefix.length) : path));
};

const extractFiles = (blocks: NormalizedBlock[]) => {
	let read = new Set<string>();
	let modified = new Set<string>();
	let created = new Set<string>();

	for (const block of blocks) {
		if (block.kind !== "tool_call") continue;
		const path = extractPath(block.args);
		if (!path) continue;
		if (FILE_READ_TOOLS.has(block.name)) read.add(path);
		if (FILE_WRITE_TOOLS.has(block.name)) modified.add(path);
		if (FILE_CREATE_TOOLS.has(block.name)) created.add(path);
	}

	for (const path of modified) created.delete(path);
	const prefix = longestCommonDirPrefix([...read, ...modified, ...created]);
	read = trimPathSet(read, prefix);
	modified = trimPathSet(modified, prefix);
	created = trimPathSet(created, prefix);
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

// ─── extract: commits ────────────────────────────────────────────────────────

const GIT_LOG_COMMIT_RE = /^\s*([0-9a-f]{7,40})\s+(.+)$/gim;
const ANCHORISH_SUBJECT_RE = /^\d+:[0-9a-f]{3,}\|/;

const isGitLogToolCall = (block: NormalizedBlock | undefined): boolean => {
	if (!block || block.kind !== "tool_call") return false;
	if (block.name !== "bash" && block.name !== "Bash") return false;
	const command = String(block.args.command ?? "");
	return /\bgit\s+log\b/.test(command);
};

const extractCommits = (blocks: NormalizedBlock[]): string[] => {
	const commits: string[] = [];
	const seenHashes = new Set<string>();
	let previousToolCall: NormalizedBlock | undefined;

	for (const block of blocks) {
		if (block.kind === "tool_call") {
			previousToolCall = block;
			continue;
		}

		// Only trust git-log-shaped output from a git log tool call. Assistant/user
		// summaries and unrelated tool output can contain commit-ish anchors or bullets.
		if (block.kind !== "tool_result" || !isGitLogToolCall(previousToolCall)) continue;
		for (const match of block.text.matchAll(GIT_LOG_COMMIT_RE)) {
			const hash = match[1].slice(0, 7);
			const subject = match[2].trim();
			if (!subject || ANCHORISH_SUBJECT_RE.test(subject)) continue;
			if (seenHashes.has(hash)) continue;
			seenHashes.add(hash);
			commits.push(`${hash}: ${clip(subject, 120)}`);
		}
	}
	return commits.slice(-8);
};

// ─── brief transcript ────────────────────────────────────────────────────────

const BRIEF_USER_TOKENS = 220;
const BRIEF_ASSISTANT_TOKENS = 160;
const BRIEF_MAX_LINES = 16;
const BRIEF_MAX_TOOL_RUN = 6;
const SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

const truncateWords = (text: string, limit: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	const words = flat.split(/\s+/);
	if (words.length <= limit) return flat;
	return words.slice(0, limit).join(" ") + "…";
};

const compressShellCommand = (raw: string): string => {
	let cmd = raw.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? raw;
	cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
	for (let i = 0; i < 3; i++) {
		const stripped = cmd.replace(/\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/, "");
		if (stripped === cmd) break;
		cmd = stripped;
	}
	return clip(cmd, 120);
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
	const path = extractPath(args);
	if (path) return `* ${name} "${path}"`;
	if (name === "bash" || name === "Bash") return `* ${name} "${compressShellCommand(String(args.command ?? ""))}"`;
	if (typeof args.query === "string") return `* ${name} "${clip(args.query, 60)}"`;
	return `* ${name}`;
};

const compactToolRuns = (lines: string[]): string[] => {
	const out: string[] = [];
	let pendingTools: string[] = [];

	const flushTools = () => {
		if (pendingTools.length === 0) return;
		const shown = pendingTools.slice(0, BRIEF_MAX_TOOL_RUN);
		out.push(...shown);
		if (pendingTools.length > shown.length) out.push(`[assistant] * … ${pendingTools.length - shown.length} more tool call(s)`);
		pendingTools = [];
	};

	for (const line of lines) {
		if (line.startsWith("[assistant] * ")) {
			pendingTools.push(line);
			continue;
		}
		flushTools();
		out.push(line);
	}
	flushTools();
	return out;
};

const extractBriefTranscript = (blocks: NormalizedBlock[]): string[] => {
	const lines: string[] = [];
	const push = (line: string) => {
		if (!line.trim()) return;
		const previous = lines[lines.length - 1];
		if (previous === line) return;
		lines.push(line);
	};

	for (const block of blocks) {
		if (block.kind === "user") push(`[user] ${truncateWords(block.text, BRIEF_USER_TOKENS)}`);
		if (block.kind === "assistant") {
			let text = block.text;
			for (let i = 0; i < 2; i++) {
				const stripped = text.replace(SELF_TALK_PREFIX_RE, "");
				if (stripped === text) break;
				text = stripped;
			}
			push(`[assistant] ${truncateWords(text, BRIEF_ASSISTANT_TOKENS)}`);
		}
		if (block.kind === "tool_call") push(`[assistant] ${toolOneLiner(block.name, block.args)}`);
		if (block.kind === "tool_result" && block.isError) push(`[tool_error] ${block.name}: ${firstLine(block.text, 150)}`);
	}

	return compactToolRuns(lines).slice(-BRIEF_MAX_LINES);
};


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
const IMPLEMENTATION_HEADING_RE = /^(changes made|changed|implemented|updated|done|summary)\s*:?$/i;
const IMPLEMENTATION_STOP_RE = /^(validation|tests?|no output|done\.?|validation passed:?|next steps:?)/i;

const cleanImplementationNote = (line: string): string | null => {
	// Prefer top-level summary bullets/headings. Plain sub-bullets like
	// "- Only extracts commits..." are usually details, not file-change labels.
	if (/^[-*]\s+/.test(line) && !/^[-*]\s+\*\*/.test(line)) return null;
	const bullet = line
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/^\*\*(.*?)\*\*:?\s*/, "$1: ")
		.trim();
	const cleaned = bullet.replace(/\s+/g, " ").replace(/:+\s*$/, "").trim();
	if (!cleaned || cleaned.length > 160) return null;
	if (IMPLEMENTATION_HEADING_RE.test(cleaned)) return null;
	if (/^```/.test(cleaned)) return null;
	return cleaned;
};

const extractImplementationNotes = (blocks: NormalizedBlock[], modifiedFiles: Set<string>): string[] => {
	if (modifiedFiles.size !== 1) return [];
	const [file] = [...modifiedFiles];
	const assistantTexts = blocks.filter((block) => block.kind === "assistant").map((block) => block.text).reverse();
	for (const text of assistantTexts) {
		if (!text.includes(file)) continue;
		const notes: string[] = [];
		let collecting = false;
		for (const rawLine of text.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			if (!collecting && /implemented|changed|updated|added|done/i.test(line) && line.includes(file)) {
				collecting = true;
				continue;
			}
			if (collecting && IMPLEMENTATION_STOP_RE.test(line)) break;
			const note = collecting ? cleanImplementationNote(line) : null;
			if (note && !notes.includes(note)) notes.push(note);
			if (notes.length >= 4) break;
		}
		if (notes.length > 0) return notes;
	}
	return [];
};

const formatFileActivity = (blocks: NormalizedBlock[]): string[] => {
	const activity = extractFiles(blocks);
	const lines: string[] = [];
	const cap = (set: Set<string>, limit: number): string => {
		const arr = [...set];
		if (arr.length <= limit) return arr.join(", ");
		return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
	};
	const notes = extractImplementationNotes(blocks, activity.modified);
	const noteSuffix = notes.length > 0 ? ` — ${notes.join("; ")}` : "";
	if (activity.modified.size > 0) lines.push(`Modified: ${cap(activity.modified, 10)}${noteSuffix}`);
	if (activity.created.size > 0) lines.push(`Created: ${cap(activity.created, 10)}`);
	return lines;
};

const buildSections = (blocks: NormalizedBlock[]): SectionData => {
	const sessionGoal = extractGoals(blocks);
	return {
		sessionGoal,
		filesAndChanges: formatFileActivity(blocks),
		commits: extractCommits(blocks),
		briefTranscript: extractBriefTranscript(blocks),
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
	section("Commits", data.commits),
	section("Brief Transcript", data.briefTranscript),
	section("Outstanding Context", data.outstandingContext),
	section("User Preferences", data.userPreferences),
].filter(Boolean).join("\n\n");

const compactLine = (text: string, max = 180): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1).trimEnd()}…`;
};

const compactItems = (items: string[], maxItems = 2, maxChars = 180): string =>
	items.slice(0, maxItems).map((item) => compactLine(item, maxChars)).join("; ");

// ─── compile ─────────────────────────────────────────────────────────────────

const compileData = (messages: Message[]): SectionData => {
	const blocks = filterNoise(normalize(messages));
	return buildSections(blocks);
};


const HANDOFF_PROMPT_PREFIX = "/skill:session-query Continue this task from the session lineage below.";
const LEGACY_HANDOFF_PROMPT_PREFIX = "/skill:session-query Continue this task from the parent session below.";

const isSyntheticHandoffPrompt = (text: string): boolean => {
	const trimmed = text.trim();
	const hasKnownPrefix = trimmed.startsWith(HANDOFF_PROMPT_PREFIX)
		|| trimmed.startsWith(LEGACY_HANDOFF_PROMPT_PREFIX);
	if (!hasKnownPrefix) return false;
	if (!trimmed.includes("**Goal:**")) return false;
	return trimmed.includes("**Parent session:**") || trimmed.includes("**Session lineage refs:**");
};

// Important: exclude synthetic /handoff user prompts before re-summarizing a session.
// Those prompts already contain prior summaries/lineage refs, so keeping them would
// recursively summarize older summaries and gradually bloat/degrade handoff context.
const stripSyntheticHandoffMessages = (messages: Message[]): Message[] =>
	messages.filter((msg) => msg.role !== "user" || !isSyntheticHandoffPrompt(textOf(msg.content)));

// ─── session JSONL reader ────────────────────────────────────────────────────

const loadSessionHeader = (sessionFile: string): SessionHeader => {
	const content = readFileSync(sessionFile, "utf-8");
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			return entry?.type === "session" ? entry : {};
		} catch {
			return {};
		}
	}
	return {};
};

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
	return stripSyntheticHandoffMessages(convertToLlm(rawMessages));
};

// ─── lineage refs ────────────────────────────────────────────────────────────

type LineageRef = {
	relation: string;
	sessionFile: string;
	data?: SectionData;
	error?: string;
};

const MAX_LINEAGE_SESSIONS = 6; // parent + up to 5 older ancestors
const MAX_LINEAGE_SECTION_CHARS = 2500;

const relationName = (index: number): string => {
	if (index === 0) return "Parent";
	if (index === 1) return "Grandparent";
	return `Ancestor ${index + 1}`;
};

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

const collectSessionLineage = (parentSession: string, parentData: SectionData): LineageRef[] => {
	const refs: LineageRef[] = [];
	const seen = new Set<string>();
	let sessionFile: string | undefined = parentSession;

	for (let index = 0; sessionFile && index < MAX_LINEAGE_SESSIONS; index++) {
		if (seen.has(sessionFile)) break;
		seen.add(sessionFile);

		let data: SectionData | undefined = index === 0 ? parentData : undefined;
		let error: string | undefined;
		let nextSession: string | undefined;

		try {
			if (!data) {
				const messages = loadSessionMessages(sessionFile);
				data = compileData(messages);
			}
			const header = loadSessionHeader(sessionFile);
			nextSession = typeof header.parentSession === "string" ? header.parentSession : undefined;
		} catch (err) {
			error = errorText(err);
		}

		refs.push({ relation: relationName(index), sessionFile, data, error });
		sessionFile = nextSession;
	}

	return refs;
};

const formatLineageRef = (ref: LineageRef, index: number): string => {
	const lines = [`${index + 1}. ${ref.relation}: \`${ref.sessionFile}\``];
	if (index === 0) {
		lines.push("   - Summary: see Parent session summary above.");
		lines.push("   - Query if: exact details from the immediate previous session are required.");
		return lines.join("\n");
	}
	if (ref.error) {
		lines.push(`   - Summary unavailable: ${compactLine(ref.error, 140)}`);
		lines.push("   - Query if: you specifically need this session and the file is available.");
		return lines.join("\n");
	}

	const data = ref.data;
	if (!data) {
		lines.push("   - Summary unavailable.");
		lines.push("   - Query if: you specifically need exact details from this earlier session.");
		return lines.join("\n");
	}

	const goal = compactItems(data.sessionGoal, 2, 170);
	const files = compactItems(data.filesAndChanges, 2, 170);
	const outstanding = compactItems(data.outstandingContext, 1, 170);
	const prefs = compactItems(data.userPreferences, 1, 170);

	if (goal) lines.push(`   - Goal: ${goal}`);
	if (files) lines.push(`   - Files: ${files}`);
	if (outstanding) lines.push(`   - Outstanding: ${outstanding}`);
	if (prefs) lines.push(`   - Preference: ${prefs}`);
	if (!goal && !files && !outstanding && !prefs) lines.push("   - Summary: no high-signal deterministic summary extracted.");
	lines.push("   - Query if: this card matches a specific missing fact you need.");
	return lines.join("\n");
};

const formatSessionLineage = (refs: LineageRef[]): string => {
	if (refs.length === 0) return "";
	const intro = [
		"**Session lineage refs:**",
		"Use visible summaries first. Do not query every session. Use `session_query` only for a specific missing fact, choosing the listed session whose ref card matches the need.",
	].join("\n");

	const rendered: string[] = [];
	let chars = intro.length;
	for (const [index, ref] of refs.entries()) {
		const card = formatLineageRef(ref, index);
		if (rendered.length > 0 && chars + card.length + 2 > MAX_LINEAGE_SECTION_CHARS) {
			rendered.push(`… ${refs.length - rendered.length} older session ref(s) omitted to keep the handoff bounded.`);
			break;
		}
		rendered.push(card);
		chars += card.length + 2;
	}

	return [intro, ...rendered].join("\n\n");
};

// ─── handoff ─────────────────────────────────────────────────────────────────

const HANDOFF_GLOBAL_KEY = Symbol.for("pi-config-handoff-pending");

const EMPTY_SECTION_DATA: SectionData = {
	sessionGoal: [],
	filesAndChanges: [],
	commits: [],
	briefTranscript: [],
	outstandingContext: [],
	userPreferences: [],
};

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type PendingHandoff = {
	prompt: string;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
} | null;

function getPendingHandoff(): PendingHandoff {
	return (globalThis as Record<symbol, PendingHandoff | undefined>)[HANDOFF_GLOBAL_KEY] ?? null;
}

function setPendingHandoff(data: PendingHandoff) {
	if (data) {
		(globalThis as Record<symbol, PendingHandoff | undefined>)[HANDOFF_GLOBAL_KEY] = data;
	} else {
		delete (globalThis as Record<symbol, PendingHandoff | undefined>)[HANDOFF_GLOBAL_KEY];
	}
}

function buildHandoffPrompt(goal: string, parentSession: string, summary: string, lineageSection: string): string {
	return [
		HANDOFF_PROMPT_PREFIX,
		`**Goal:** ${goal}`,
		`**Parent session summary:**\n${summary}`,
		`**Parent session:** \`${parentSession}\``,
		lineageSection,
		"Continue from the visible handoff summary. If an exact fact is missing, use `session_query` with the relevant listed session path. Do not query every session by default.",
	].filter(Boolean).join("\n\n");
}

async function restoreHandoffState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	pending: Exclude<PendingHandoff, null>,
) {
	const model = ctx.modelRegistry.find(pending.provider, pending.modelId);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Handoff: could not restore ${pending.provider}/${pending.modelId}; using current session model`,
				"warning",
			);
		}
	} else {
		const ok = await pi.setModel(model);
		if (!ok && ctx.hasUI) {
			ctx.ui.notify(
				`Handoff: no API key for ${pending.provider}/${pending.modelId}; using current session model`,
				"warning",
			);
		}
	}
	pi.setThinkingLevel(pending.thinkingLevel);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const pending = getPendingHandoff();
		if (!pending) return;

		setPendingHandoff(null);
		await restoreHandoffState(pi, ctx, pending);
		pi.sendUserMessage(pending.prompt);
	});

	pi.registerCommand("handoff", {
		description: "Start a new session with a deterministic summary + bounded session lineage refs",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal>", "error");
				return;
			}

			const parentSession = ctx.sessionManager.getSessionFile();
			if (!parentSession) {
				ctx.ui.notify("Handoff needs a saved parent session.", "error");
				return;
			}

			const currentModel = ctx.model;
			if (!currentModel) {
				ctx.ui.notify("Handoff requires an active model.", "error");
				return;
			}
			const currentThinkingLevel = pi.getThinkingLevel();

			let parentData: SectionData = EMPTY_SECTION_DATA;
			let summary = "(no summary available)";
			try {
				const messages = loadSessionMessages(parentSession);
				parentData = messages.length > 0 ? compileData(messages) : EMPTY_SECTION_DATA;
				const compiled = redact(formatSummary(parentData)).trim();
				if (compiled) summary = compiled;
			} catch {}

			const lineageSection = formatSessionLineage(collectSessionLineage(parentSession, parentData));

			setPendingHandoff({
				prompt: buildHandoffPrompt(goal, parentSession, summary, lineageSection),
				provider: currentModel.provider,
				modelId: currentModel.id,
				thinkingLevel: currentThinkingLevel,
			});
			const result = await ctx.newSession({ parentSession });
			if (result.cancelled) {
				setPendingHandoff(null);
			}
		},
	});
}
