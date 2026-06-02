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

