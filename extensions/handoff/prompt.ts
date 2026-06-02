import type { LineageRef } from "./session-lineage";

export const HANDOFF_PROMPT_PREFIX = "/skill:session-query Continue this task from the session lineage below.";
const LEGACY_HANDOFF_PROMPT_PREFIX = "/skill:session-query Continue this task from the parent session below.";

const MAX_LINEAGE_SECTION_CHARS = 2500;

const compactLine = (text: string, max = 180): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1).trimEnd()}…`;
};

const compactItems = (items: string[], maxItems = 2, maxChars = 180): string =>
	items.slice(0, maxItems).map((item) => compactLine(item, maxChars)).join("; ");

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

export const formatSessionLineage = (refs: LineageRef[]): string => {
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

export const buildHandoffPrompt = (goal: string, parentSession: string, summary: string, lineageRefs: LineageRef[]): string => [
	HANDOFF_PROMPT_PREFIX,
	`**Goal:** ${goal}`,
	`**Parent session summary:**\n${summary}`,
	`**Parent session:** \`${parentSession}\``,
	formatSessionLineage(lineageRefs),
	"Continue from the visible handoff summary. If an exact fact is missing, use `session_query` with the relevant listed session path. Do not query every session by default.",
].filter(Boolean).join("\n\n");

export const isSyntheticHandoffPrompt = (text: string): boolean => {
	const trimmed = text.trim();
	const hasKnownPrefix = trimmed.startsWith(HANDOFF_PROMPT_PREFIX)
		|| trimmed.startsWith(LEGACY_HANDOFF_PROMPT_PREFIX);
	if (!hasKnownPrefix) return false;
	if (!trimmed.includes("**Goal:**")) return false;
	return trimmed.includes("**Parent session:**") || trimmed.includes("**Session lineage refs:**");
};
