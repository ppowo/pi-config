/**
 * Vendored /handoff extension: starts a fresh pi session that continues from a
 * deterministic summary of the current saved session.
 *
 * Current behaviour, intentionally documented for future maintainers:
 * - `/handoff <goal>` reads the current session JSONL file and extracts a local
 *   parent summary: session goal, changed files, commits, brief transcript,
 *   outstanding context, and user preferences.
 * - It redacts obvious secrets, strips prior synthetic `/handoff` prompts before
 *   summarising, and falls back to `(no summary available)` if reading fails.
 * - It builds a bounded ancestor chain from each session header's `parentSession`:
 *   the immediate parent is represented by the full visible summary; older
 *   ancestors are compact ref cards with just enough signal to decide whether to
 *   call `session_query`.
 * - The generated prompt explicitly tells the next agent to use visible summaries
 *   first and to query only the matching lineage ref when an exact missing fact is
 *   needed. Do not change this casually: it prevents smaller LLMs from traversing
 *   every ancestor session by default.
 * - Before creating the new session, it stores the prompt, current model, and
 *   current thinking level in a global pending slot. On `session_start`, it
 *   restores that model/thinking level when possible, sends the generated prompt
 *   as the first user message, then clears the slot.
 *
 * Pi command/session wiring lives here. Deterministic extraction/formatting lives
 * in ./core; ancestor-chain loading/formatting lives in ./session-lineage so both
 * can be tested without loading the extension command.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	compileData,
	formatSummary,
	HANDOFF_PROMPT_PREFIX,
	loadSessionMessages,
	redact,
} from "./core";
import {
	collectSessionLineage,
	formatSessionLineage,
} from "./session-lineage";
import type { SectionData } from "./core";

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
