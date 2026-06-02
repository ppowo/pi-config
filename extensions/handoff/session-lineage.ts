import { readFileSync } from "fs";
import { compileData, loadSessionMessages } from "./core";
import type { SectionData } from "./core";

interface SessionHeader {
	type?: string;
	parentSession?: string;
}

export type LineageRef = {
	relation: string;
	sessionFile: string;
	data?: SectionData;
	error?: string;
};

const MAX_LINEAGE_SESSIONS = 6; // parent + up to 5 older ancestors
const MAX_LINEAGE_SECTION_CHARS = 2500;

const compactLine = (text: string, max = 180): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1).trimEnd()}…`;
};

const compactItems = (items: string[], maxItems = 2, maxChars = 180): string =>
	items.slice(0, maxItems).map((item) => compactLine(item, maxChars)).join("; ");

const relationName = (index: number): string => {
	if (index === 0) return "Parent";
	if (index === 1) return "Grandparent";
	return `Ancestor ${index + 1}`;
};

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

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

export const collectSessionLineage = (parentSession: string, parentData: SectionData): LineageRef[] => {
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
