import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

function buildHandoffLitePrompt(goal: string, parentSession: string): string {
	return `/skill:session-query Continue this task from the parent session below.

**Goal:** ${goal}

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
		description: "Start a new session with a static session-query handoff prompt",
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

			setPendingHandoffLite({ prompt: buildHandoffLitePrompt(goal, parentSession) });
			const result = await ctx.newSession({ parentSession });
			if (result.cancelled) {
				setPendingHandoffLite(null);
			}
		},
	});
}
