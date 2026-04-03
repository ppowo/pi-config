/**
 * Handoff Reminder Extension
 *
 * Strategy:
 * - Disable compaction entirely (auto + manual /compact)
 * - Warn when context usage crosses percentage thresholds
 * - Nudge user to run /handoff with a custom goal before overflow
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ReminderThreshold = {
	percent: number;
	notifyType: "info" | "warning";
	label: string;
};

type PendingHandoffLiteState = {
	kind: "pending";
	token: string;
	prompt: string;
};

type HandoffLiteState =
	| PendingHandoffLiteState
	| { kind: "dispatched"; token: string }
	| { kind: "submitted"; token: string }
	| { kind: "failed"; token: string; error: string };

const DEFAULT_THRESHOLDS: ReminderThreshold[] = [
	{ percent: 72, notifyType: "info", label: "heads-up" },
	{ percent: 82, notifyType: "warning", label: "recommended" },
	{ percent: 90, notifyType: "warning", label: "urgent" },
];

// GitHub Copilot GPT 5.3 Codex reports 400k context but actually has ~270k
// Adjusted thresholds = default × (270/400) = default × 0.675
const COPILOT_CODEX_53_THRESHOLDS: ReminderThreshold[] = [
	{ percent: 49, notifyType: "info", label: "heads-up" },      // 72% × 0.675
	{ percent: 55, notifyType: "warning", label: "recommended" }, // 82% × 0.675
	{ percent: 61, notifyType: "warning", label: "urgent" },    // 90% × 0.675
];

// Pattern to match GitHub Copilot GPT 5.3 Codex models
// Examples: "gpt-5.3-codex", "gpt-5.3-codex-spark", etc.
const COPILOT_CODEX_53_PATTERN = /^gpt-5\.3-codex/;
const HANDOFF_LITE_STATE_TYPE = "handoff-lite-state";

function getThresholds(provider: string, modelId: string): ReminderThreshold[] {
	// Only apply adjusted thresholds to GitHub Copilot GPT 5.3 Codex
	if (provider === "github-copilot" && COPILOT_CODEX_53_PATTERN.test(modelId)) {
		return COPILOT_CODEX_53_THRESHOLDS;
	}
	return DEFAULT_THRESHOLDS;
}

const RESET_BELOW_PERCENT = 64;
const HIGH_USAGE_REPEAT_EVERY_TURNS = 4;
const HANDOFF_GUIDANCE = "Use /handoff <goal> (or /handoff-lite <goal> if context is too full for summarization).";

const tokenFormatter = new Intl.NumberFormat("en-US");

type ReminderState = {
	sessionKey: string | null;
	highestNotifiedThreshold: number;
	highUsageTurnsSinceReminder: number;
};

function formatTokens(value: number): string {
	return tokenFormatter.format(Math.max(0, Math.round(value)));
}

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `in-memory:${ctx.cwd}`;
}

function getCrossedThresholdIndex(percent: number, thresholds: ReminderThreshold[]): number {
	let crossed = -1;
	for (let i = 0; i < thresholds.length; i += 1) {
		if (percent >= thresholds[i].percent) crossed = i;
	}
	return crossed;
}

function createHandoffLiteToken(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isHandoffLiteState(data: unknown): data is HandoffLiteState {
	if (!data || typeof data !== "object") return false;
	const candidate = data as Record<string, unknown>;

	if (candidate.kind === "pending") {
		return typeof candidate.token === "string" && typeof candidate.prompt === "string";
	}

	if (candidate.kind === "dispatched" || candidate.kind === "submitted") {
		return typeof candidate.token === "string";
	}

	if (candidate.kind === "failed") {
		return typeof candidate.token === "string" && typeof candidate.error === "string";
	}

	return false;
}

function getPendingHandoffLiteState(ctx: ExtensionContext): PendingHandoffLiteState | undefined {
	const pending: PendingHandoffLiteState[] = [];
	const handled = new Set<string>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== HANDOFF_LITE_STATE_TYPE || !isHandoffLiteState(entry.data)) {
			continue;
		}

		if (entry.data.kind === "pending") {
			pending.push(entry.data);
		} else {
			handled.add(entry.data.token);
		}
	}

	for (let i = pending.length - 1; i >= 0; i -= 1) {
		if (!handled.has(pending[i].token)) {
			return pending[i];
		}
	}

	return undefined;
}

async function startHandoffLiteSession(
	ctx: ExtensionCommandContext,
	prompt: string,
	parentSession: string | undefined,
): Promise<boolean> {
	const token = createHandoffLiteToken();
	const newSessionResult = await ctx.newSession({
		parentSession,
		setup: async (sessionManager) => {
			sessionManager.appendCustomEntry(HANDOFF_LITE_STATE_TYPE, {
				kind: "pending",
				token,
				prompt,
			});
		},
	});
	return !newSessionResult.cancelled;
}

export default function (pi: ExtensionAPI) {
	const state: ReminderState = {
		sessionKey: null,
		highestNotifiedThreshold: -1,
		highUsageTurnsSinceReminder: 0,
	};
	let scheduledAutoSubmit: ReturnType<typeof setTimeout> | undefined;

	const resetReminderState = () => {
		state.highestNotifiedThreshold = -1;
		state.highUsageTurnsSinceReminder = 0;
	};

	const clearScheduledAutoSubmit = () => {
		if (scheduledAutoSubmit !== undefined) {
			clearTimeout(scheduledAutoSubmit);
			scheduledAutoSubmit = undefined;
		}
	};

	const syncSessionState = (ctx: ExtensionContext) => {
		const sessionKey = getSessionKey(ctx);
		if (state.sessionKey !== sessionKey) {
			state.sessionKey = sessionKey;
			resetReminderState();
		}
	};

	// Disable all compaction paths. User should hand off instead.
	pi.on("session_before_compact", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`Compaction is disabled in this setup. ${HANDOFF_GUIDANCE}`, "warning");
		}
		return { cancel: true };
	});

	pi.on("session_shutdown", async () => {
		clearScheduledAutoSubmit();
	});

	pi.on("session_start", async (_event, ctx) => {
		clearScheduledAutoSubmit();
		state.sessionKey = null;
		resetReminderState();

		const pending = getPendingHandoffLiteState(ctx);
		if (!pending) return;

		scheduledAutoSubmit = setTimeout(() => {
			scheduledAutoSubmit = undefined;
			void (async () => {
				try {
					pi.appendEntry(HANDOFF_LITE_STATE_TYPE, { kind: "dispatched", token: pending.token });
					await pi.sendUserMessage(pending.prompt);
					pi.appendEntry(HANDOFF_LITE_STATE_TYPE, { kind: "submitted", token: pending.token });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					pi.appendEntry(HANDOFF_LITE_STATE_TYPE, { kind: "failed", token: pending.token, error: message });
					if (ctx.hasUI) {
						ctx.ui.setEditorText(pending.prompt);
						ctx.ui.notify(`handoff-lite auto-submit failed: ${message}. Prompt restored to editor.`, "warning");
					}
				}
			})();
		}, 0);
	});

	pi.registerCommand("handoff-lite", {
		description: "Start a new session without LLM summarization and link to parent session",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff-lite <goal>", "error");
				return;
			}

			const parentSession = ctx.sessionManager.getSessionFile();
			const promptBody = parentSession
				? `${goal}\n\n/skill:session-query\n\n**Parent session:** \`${parentSession}\`\n\n## Handoff Notes\nThis handoff skipped automatic summarization (handoff-lite).\nStart by querying the parent session for:\n- main goal\n- key decisions\n- files modified\n- open issues and next steps`
				: `${goal}\n\n## Handoff Notes\nThis handoff skipped automatic summarization (handoff-lite), and no parent session file is available.`;

			const started = await startHandoffLiteSession(ctx, promptBody, parentSession);
			if (!started) return;
		},
	});


	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		syncSessionState(ctx);

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.tokens === null) return;

		const percent = usage.percent;
		
		// Skip warnings when percent > 100 - indicates bogus contextWindow metadata
		// (e.g., openai-codex/gpt-5.4 reports 272k but actually supports 1M+ tokens)
		if (percent > 100) {
			resetReminderState();
			return;
		}
		
		if (percent < RESET_BELOW_PERCENT) {
			resetReminderState();
			return;
		}

		const provider = ctx.model?.provider ?? "";
		const modelId = ctx.model?.id ?? "";
		const thresholds = getThresholds(provider, modelId);
		const crossedThreshold = getCrossedThresholdIndex(percent, thresholds);
		if (crossedThreshold < 0) return;

		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current model";
		const usedTokens = formatTokens(usage.tokens);
		const totalTokens = formatTokens(usage.contextWindow);
		const remainingTokens = formatTokens(usage.contextWindow - usage.tokens);

		const sendReminder = (repeatUrgent = false) => {
			const threshold = thresholds[crossedThreshold];
			const prefix = repeatUrgent ? "Still near context limit" : `Context ${threshold.label}`;
			ctx.ui.notify(
				`${prefix}: ${percent.toFixed(1)}% on ${modelLabel} (${usedTokens}/${totalTokens}, ${remainingTokens} left). ${HANDOFF_GUIDANCE}`,
				threshold.notifyType,
			);
		};

		if (crossedThreshold > state.highestNotifiedThreshold) {
			state.highestNotifiedThreshold = crossedThreshold;
			state.highUsageTurnsSinceReminder = 0;
			sendReminder(false);
			return;
		}

		const highestThresholdIndex = thresholds.length - 1;
		if (crossedThreshold === highestThresholdIndex && state.highestNotifiedThreshold === highestThresholdIndex) {
			state.highUsageTurnsSinceReminder += 1;
			if (state.highUsageTurnsSinceReminder >= HIGH_USAGE_REPEAT_EVERY_TURNS) {
				state.highUsageTurnsSinceReminder = 0;
				sendReminder(true);
			}
		}
	});
}
