/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Provides both:
 * - /handoff command: user types `/handoff <goal>`
 * - handoff tool: agent can call when user explicitly requests a handoff
 *
 * Usage:
 *   /handoff implement this for teams as well
 *
 * The new session starts with a generated prompt and parent-session metadata.
 *
 * Vendored from pi-amplike with mode/model switch support removed.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CONTEXT_SUMMARY_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;


type PendingHandoff = {
	prompt: string;
	parentSession: string | undefined;
};


type ResolvedRequestAuth = {
	apiKey: string | undefined;
	headers: Record<string, string> | undefined;
};

async function getRequestAuth(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>): Promise<ResolvedRequestAuth> {
	const registry = ctx.modelRegistry as {
		getApiKeyAndHeaders?: (model: NonNullable<ExtensionContext["model"]>) => Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string> }
			| { ok: false; error: string }
		>;
		getApiKey?: (model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>;
	};

	if (typeof registry.getApiKeyAndHeaders === "function") {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			throw new Error(auth.error);
		}
		return { apiKey: auth.apiKey, headers: auth.headers ?? model.headers };
	}

	if (typeof registry.getApiKey === "function") {
		const apiKey = await registry.getApiKey(model);
		return { apiKey, headers: model.headers };
	}

	return { apiKey: undefined, headers: model.headers };
}

/**
 * Generate a context summary by asking an LLM to distill the conversation
 * into a focused prompt for a new session.
 *
 * @returns The generated summary text, or null if aborted.
 */
async function generateContextSummary(
	model: any,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	messages: Parameters<typeof convertToLlm>[0],
	goal: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const conversationText = serializeConversation(convertToLlm(messages));

	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: CONTEXT_SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey, headers, signal },
	);

	if (response.stopReason === "aborted") {
		return null;
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Core handoff logic. Returns an error string on failure, or undefined on success.
 */
async function performHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: string,
	setPendingHandoff: (v: PendingHandoff | null) => void,
	fromTool = false,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return "Handoff requires interactive mode.";
	}

	if (!ctx.model) {
		return "No model selected.";
	}

	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return "No conversation to hand off.";
	}

	const currentSessionFile = ctx.sessionManager.getSessionFile();

	// Generate the handoff prompt with loader UI
	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
		loader.onAbort = () => done(null);

		const doGenerate = async () => {
			const { apiKey, headers } = await getRequestAuth(ctx, ctx.model!);
			return generateContextSummary(ctx.model!, apiKey, headers, messages, goal, loader.signal);
		};

		doGenerate()
			.then(done)
			.catch((err) => {
				console.error("Handoff generation failed:", err);
				done(null);
			});

		return loader;
	});

	if (result === null) {
		return "Handoff cancelled.";
	}

	// Build the final prompt with user's goal first for easy identification
	let finalPrompt = result;
	if (currentSessionFile) {
		finalPrompt = `${goal}\n\n/skill:session-query\n\n**Parent session:** \`${currentSessionFile}\`\n\n${result}`;
	} else {
		finalPrompt = `${goal}\n\n${result}`;
	}

	if (!fromTool && "newSession" in ctx) {
		// Command path: full reset via ctx.newSession()
		const cmdCtx = ctx as ExtensionCommandContext;
		const newSessionResult = await cmdCtx.newSession({ parentSession: currentSessionFile });
		if (newSessionResult.cancelled) return;
		pi.sendUserMessage(finalPrompt);
	} else {
		// Tool path: defer session switch to agent_end handler.
		setPendingHandoff({ prompt: finalPrompt, parentSession: currentSessionFile });
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Shared state for tool-path handoff coordination between handlers
	let pendingHandoff: PendingHandoff | null = null;

	// Timestamp marking when the handoff session switch occurred.
	let handoffTimestamp: number | null = null;

	const setPendingHandoff = (v: PendingHandoff | null) => {
		pendingHandoff = v;
	};

	// --- Event handlers for tool-path handoff ---
	// See original pi-amplike source for detailed explanation of why
	// the tool path requires this three-handler coordination pattern.

	// After the agent loop ends, perform the deferred session switch.
	pi.on("agent_end", (_event, ctx) => {
		if (!pendingHandoff) return;

		const { prompt, parentSession } = pendingHandoff;
		pendingHandoff = null;

		handoffTimestamp = Date.now();

		(ctx.sessionManager as any).newSession({ parentSession });

		setTimeout(() => {
			pi.sendUserMessage(prompt);
		}, 0);
	});

	// Before each LLM call, filter out pre-handoff messages.
	pi.on("context", (event) => {
		const cutoff = handoffTimestamp;
		if (cutoff === null) return;

		const newMessages = event.messages.filter((m) => m.timestamp >= cutoff);
		if (newMessages.length > 0) {
			return { messages: newMessages };
		}
	});

	// When a proper session switch occurs, clear the context filter.
	pi.on("session_switch", () => {
		handoffTimestamp = null;
	});

	// /handoff command
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal>", "error");
				return;
			}

			const error = await performHandoff(pi, ctx, goal, setPendingHandoff);
			if (error) {
				ctx.ui.notify(error, "error");
			}
		},
	});

	// handoff tool (agent-callable)
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. ONLY use this when the user explicitly asks for a handoff. Provide a goal describing what the new session should focus on.",
		parameters: Type.Object({
			goal: Type.String({ description: "The goal/task for the new session" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const error = await performHandoff(pi, ctx, params.goal, setPendingHandoff, true);
			const message = error ?? "Handoff initiated. The session will switch after the current turn completes.";
			return {
				content: [{ type: "text", text: message }],
				details: {
					goal: params.goal,
					status: error ? "error" : "pending",
					message,
				},
			};
		},
	});
}
