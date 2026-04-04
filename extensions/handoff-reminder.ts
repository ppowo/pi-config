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

function getThresholds(provider: string, modelId: string): ReminderThreshold[] {
	// Only apply adjusted thresholds to GitHub Copilot GPT 5.3 Codex
	if (provider === "github-copilot" && COPILOT_CODEX_53_PATTERN.test(modelId)) {
		return COPILOT_CODEX_53_THRESHOLDS;
	}
	return DEFAULT_THRESHOLDS;
}

const RESET_BELOW_PERCENT = 64;
const HIGH_USAGE_REPEAT_EVERY_TURNS = 4;
const HANDOFF_GUIDANCE = "Use /handoff <goal> while there's still room, or /handoff-lite <goal> if the context is already tight.";
const HANDOFF_LITE_GUIDANCE = "Use /handoff-lite <goal> before the context overflows.";
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

function getGuidance(crossedThreshold: number, thresholds: ReminderThreshold[]): string {
	const highestThresholdIndex = thresholds.length - 1;
	if (highestThresholdIndex <= 0) return HANDOFF_LITE_GUIDANCE;
	return crossedThreshold >= 1 ? HANDOFF_LITE_GUIDANCE : HANDOFF_GUIDANCE;
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
			ctx.ui.notify(`Compaction is disabled in this setup. ${HANDOFF_LITE_GUIDANCE}`, "warning");
		}
		return { cancel: true };
	});

	pi.on("session_start", async () => {
		state.sessionKey = null;
		resetReminderState();
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
			const guidance = getGuidance(crossedThreshold, thresholds);
			ctx.ui.notify(
				`${prefix}: ${percent.toFixed(1)}% on ${modelLabel} (${usedTokens}/${totalTokens}, ${remainingTokens} left). ${guidance}`,
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
