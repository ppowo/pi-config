import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// Minimal companion shim for pi-amplike's command-path /handoff.
// It piggybacks on amplike's internal pending symbol instead of replacing /handoff.

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type HandoffOptions = {
	mode?: string;
	model?: string;
};

type PendingAmplikeHandoff = {
	prompt: string;
	options?: HandoffOptions;
} | null;

type PendingAmplikeRestore = {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
} | null;

const AMPLIKE_HANDOFF_PENDING_KEY = Symbol.for("pi-amplike-handoff-pending");
const AMPLIKE_HANDOFF_RESTORE_KEY = Symbol.for("pi-config-amplike-handoff-restore");

function getPendingAmplikeHandoff(): PendingAmplikeHandoff {
	return (globalThis as Record<symbol, PendingAmplikeHandoff | undefined>)[AMPLIKE_HANDOFF_PENDING_KEY] ?? null;
}

function getPendingAmplikeRestore(): PendingAmplikeRestore {
	return (globalThis as Record<symbol, PendingAmplikeRestore | undefined>)[AMPLIKE_HANDOFF_RESTORE_KEY] ?? null;
}

function setPendingAmplikeRestore(data: PendingAmplikeRestore) {
	if (data) {
		(globalThis as Record<symbol, PendingAmplikeRestore | undefined>)[AMPLIKE_HANDOFF_RESTORE_KEY] = data;
	} else {
		delete (globalThis as Record<symbol, PendingAmplikeRestore | undefined>)[AMPLIKE_HANDOFF_RESTORE_KEY];
	}
}

async function restoreModelAndThinking(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	pending: Exclude<PendingAmplikeRestore, null>,
) {
	const model = ctx.modelRegistry.find(pending.provider, pending.modelId);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Amplike handoff shim: could not restore ${pending.provider}/${pending.modelId}; using current session model`,
				"warning",
			);
		}
	} else {
		const ok = await pi.setModel(model);
		if (!ok && ctx.hasUI) {
			ctx.ui.notify(
				`Amplike handoff shim: no API key for ${pending.provider}/${pending.modelId}; using current session model`,
				"warning",
			);
		}
	}
	pi.setThinkingLevel(pending.thinkingLevel);
}

export default function (pi: ExtensionAPI) {
	let pendingRestore: PendingAmplikeRestore = null;

	pi.on("session_before_switch", async (event, ctx) => {
		if (event.reason !== "new" || !ctx.model) return;

		const pending = getPendingAmplikeHandoff();
		if (!pending) return;
		if (pending.options?.mode || pending.options?.model) return;

		setPendingAmplikeRestore({
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		});
	});

	pi.on("session_start", async (event) => {
		pendingRestore = null;
		if (event.reason !== "new") return;

		pendingRestore = getPendingAmplikeRestore();
		setPendingAmplikeRestore(null);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!pendingRestore) return;

		const restore = pendingRestore;
		pendingRestore = null;
		await restoreModelAndThinking(pi, ctx, restore);
	});
}
