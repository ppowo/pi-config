/**
 * Handoff Reminder Extension
 *
 * Strategy:
 * - Disable compaction entirely (auto + manual /compact)
 * - Warn when context usage crosses percentage thresholds
 * - Nudge user to run /handoff with a custom goal before overflow
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ReminderThreshold = {
	percent: number;
	notifyType: "info" | "warning";
	label: string;
};

const REMINDER_THRESHOLDS: ReminderThreshold[] = [
	{ percent: 72, notifyType: "info", label: "heads-up" },
	{ percent: 82, notifyType: "warning", label: "recommended" },
	{ percent: 90, notifyType: "warning", label: "urgent" },
];

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

function getCrossedThresholdIndex(percent: number): number {
	let crossed = -1;
	for (let i = 0; i < REMINDER_THRESHOLDS.length; i += 1) {
		if (percent >= REMINDER_THRESHOLDS[i].percent) crossed = i;
	}
	return crossed;
}

export default function (pi: ExtensionAPI) {
	const state: ReminderState = {
		sessionKey: null,
		highestNotifiedThreshold: -1,
		highUsageTurnsSinceReminder: 0,
	};

	const resetReminderState = () => {
		state.highestNotifiedThreshold = -1;
		state.highUsageTurnsSinceReminder = 0;
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

	// Session changes reset reminder progression.
	pi.on("session_start", async () => {
		state.sessionKey = null;
		resetReminderState();
	});

	pi.on("session_switch", async () => {
		state.sessionKey = null;
		resetReminderState();
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

			const newSessionResult = await ctx.newSession({ parentSession });
			if (newSessionResult.cancelled) return;

			pi.sendUserMessage(promptBody);
		},
	});


	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		syncSessionState(ctx);

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.tokens === null) return;

		const percent = usage.percent;
		if (percent < RESET_BELOW_PERCENT) {
			resetReminderState();
			return;
		}

		const crossedThreshold = getCrossedThresholdIndex(percent);
		if (crossedThreshold < 0) return;

		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current model";
		const usedTokens = formatTokens(usage.tokens);
		const totalTokens = formatTokens(usage.contextWindow);
		const remainingTokens = formatTokens(usage.contextWindow - usage.tokens);

		const sendReminder = (repeatUrgent = false) => {
			const threshold = REMINDER_THRESHOLDS[crossedThreshold];
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

		const highestThresholdIndex = REMINDER_THRESHOLDS.length - 1;
		if (crossedThreshold === highestThresholdIndex && state.highestNotifiedThreshold === highestThresholdIndex) {
			state.highUsageTurnsSinceReminder += 1;
			if (state.highUsageTurnsSinceReminder >= HIGH_USAGE_REPEAT_EVERY_TURNS) {
				state.highUsageTurnsSinceReminder = 0;
				sendReminder(true);
			}
		}
	});
}
