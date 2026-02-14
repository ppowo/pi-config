/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isSafeCommand, markCompletedSteps, type TodoItem } from "./utils";
import { validatePlanOutput } from "./validation";
import {
	getPlanDir,
	openPlanInEditor,
	readPlanMarkdown,
	resolveLatestPlanPath,
	sanitizePlanPath,
	savePlanMarkdown,
	truncatePlanPreview,
} from "./storage";

const PLAN_MODE_TOOL_PREFERENCE = ["read", "grep", "find", "ls", "bash", "questionnaire", "question"];
const EXECUTION_MODE_TOOL_PREFERENCE = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"questionnaire",
	"question",
];

interface PlanModeStateEntry {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	lastPlanPrompt?: string;
	lastPlanPath?: string;
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function normalizeCommandArgs(args: unknown): string {
	if (typeof args === "string") return args.trim();
	if (Array.isArray(args)) {
		return args
			.map((a) => (typeof a === "string" ? a : String(a)))
			.join(" ")
			.trim();
	}
	return "";
}

function resolveAvailableTools(pi: ExtensionAPI, preferred: string[]): string[] {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	return preferred.filter((name) => available.has(name));
}

function uniqueTools(tools: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tool of tools) {
		if (!seen.has(tool)) {
			seen.add(tool);
			result.push(tool);
		}
	}
	return result;
}

function getClarificationGuidance(tools: string[]): string {
	const hasQuestionnaire = tools.includes("questionnaire");
	const hasQuestion = tools.includes("question");
	const availableTools = [hasQuestionnaire ? "questionnaire" : "", hasQuestion ? "question" : ""]
		.filter(Boolean)
		.join(" or ");

	if (!availableTools) {
		return "If key information is missing, state concise assumptions and continue with the best possible plan.";
	}

	return `Ask focused clarifying questions with ${availableTools} both before drafting and during exploration whenever ambiguity blocks progress.`;
}

function buildPlanContext(tools: string[]): string {
	const planToolsList = tools.length > 0 ? tools.join(", ") : "(none)";
	const clarificationGuidance = getClarificationGuidance(tools);

	return `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Allowed tools (read-only):
- ${planToolsList}
- edit/write are disabled
- bash and user ! commands are limited to allowlisted read-only commands

Clarification policy:
- ${clarificationGuidance}
- Keep clarification questions minimal and high-impact.
- Once critical ambiguities are resolved, return the plan in this response.
- If clarification is unavailable, state assumptions briefly and continue.

Context hygiene:
1. Built-in tool outputs are capped by pi (50KB / 2000 lines).
2. For large files, prefer read with offset+limit in smaller chunks.
3. Summarize findings first, then fetch more only as needed.

Plan output style:
- Freeform markdown (this is the only style).
- Goal/Scope/Assumptions/Plan/Risks/Validation headings are optional.
- Include at least one clearly identifiable numbered or bulleted action list for execution tracking.
- Keep steps concrete, actionable, and repository-specific.

Do not attempt to make code changes.
Do not execute changes in plan mode.`;
}

function buildExecutionContext(remaining: TodoItem[]): string {
	const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
	return `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`;
}

function buildValidationNotes(validation: ReturnType<typeof validatePlanOutput>): string {
	const notes: string[] = [];
	if (!validation.hasNumberedPlanSteps) {
		notes.push("ℹ No numbered/bulleted step list detected. Saved anyway; execution tracking may be unavailable.");
	}
	return notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let lastPlanPrompt = "";
	let lastPlanPath = "";
	let refinementTargetPath = "";
	let toolsBeforePlanMode: string[] | null = null;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function getPlanModeTools(): string[] {
		return resolveAvailableTools(pi, PLAN_MODE_TOOL_PREFERENCE);
	}

	function getExecutionTools(): string[] {
		const preferred = resolveAvailableTools(pi, EXECUTION_MODE_TOOL_PREFERENCE);
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const previous = (toolsBeforePlanMode ?? []).filter((name) => available.has(name));
		return uniqueTools([...preferred, ...previous]);
	}

	function rememberToolsBeforePlanMode(): void {
		if (toolsBeforePlanMode && toolsBeforePlanMode.length > 0) return;
		const active = pi.getActiveTools();
		if (active.length > 0) {
			toolsBeforePlanMode = [...active];
		}
	}

	function restoreToolsAfterPlanMode(): void {
		if (toolsBeforePlanMode && toolsBeforePlanMode.length > 0) {
			pi.setActiveTools(toolsBeforePlanMode);
		} else {
			pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
		}
		toolsBeforePlanMode = null;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		rememberToolsBeforePlanMode();
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		refinementTargetPath = "";

		const tools = getPlanModeTools();
		pi.setActiveTools(tools);
		updateStatus(ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(`Plan mode enabled. Tools: ${tools.join(", ")}`);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (!planModeEnabled) {
			enterPlanMode(ctx);
			return;
		}

		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		refinementTargetPath = "";
		restoreToolsAfterPlanMode();
		updateStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify("Plan mode disabled. Tool access restored.");
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			lastPlanPrompt,
			lastPlanPath,
		});
	}

	pi.registerCommand("plan", {
		description: 'Toggle plan mode or run planning prompt: /plan "your request"',
		handler: async (args, ctx) => {
			const prompt = normalizeCommandArgs(args);
			if (!prompt) {
				togglePlanMode(ctx);
				persistState();
				return;
			}

			lastPlanPrompt = prompt;
			refinementTargetPath = "";
			if (!planModeEnabled) enterPlanMode(ctx);

			persistState();
			pi.sendUserMessage(prompt);
		},
	});


	pi.registerCommand("plan-latest", {
		description: "Show the latest saved plan markdown path and preview",
		handler: async (_args, ctx) => {
			try {
				const planPath = await resolveLatestPlanPath(lastPlanPath);
				if (!planPath) {
					const message = `No plans found in ${getPlanDir()}`;
					if (ctx.hasUI) {
						ctx.ui.notify(message, "info");
					} else {
						pi.sendMessage({ customType: "plan-latest-empty", content: message, display: true }, { triggerTurn: false });
					}
					return;
				}

				lastPlanPath = planPath;
				const markdown = await readPlanMarkdown(planPath);
				const preview = truncatePlanPreview(markdown, 80);

				pi.sendMessage(
					{ customType: "plan-latest", content: `Latest plan:\n\`${planPath}\`\n\n${preview}`, display: true },
					{ triggerTurn: false },
				);
				if (ctx.hasUI) {
					ctx.ui.notify(`Latest plan: ${planPath}`, "info");
				}
				persistState();
			} catch (error) {
				const message = `Failed to load latest plan: ${String(error)}`;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
				} else {
					pi.sendMessage({ customType: "plan-latest-error", content: message, display: true }, { triggerTurn: false });
				}
			}
		},
	});

	pi.registerCommand("plan-open", {
		description: "Open the latest saved plan markdown in your editor",
		handler: async (_args, ctx) => {
			try {
				const planPath = await resolveLatestPlanPath(lastPlanPath);
				if (!planPath) {
					const message = `No plans found in ${getPlanDir()}`;
					if (ctx.hasUI) {
						ctx.ui.notify(message, "info");
					} else {
						pi.sendMessage({ customType: "plan-open-empty", content: message, display: true }, { triggerTurn: false });
					}
					return;
				}

				lastPlanPath = planPath;
				await openPlanInEditor(planPath);
				if (ctx.hasUI) {
					ctx.ui.notify(`Opened plan: ${planPath}`, "info");
				}
				pi.sendMessage({ customType: "plan-open", content: `Opened plan:\n\`${planPath}\``, display: true }, { triggerTurn: false });
				persistState();
			} catch (error) {
				const message = `Failed to open latest plan: ${String(error)}\nUse /plan-latest to get the path.`;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
				} else {
					pi.sendMessage({ customType: "plan-open-error", content: message, display: true }, { triggerTurn: false });
				}
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				const message = "No todos. Create a plan first with /plan";
				if (ctx.hasUI) {
					ctx.ui.notify(message, "info");
				} else {
					pi.sendMessage({ customType: "plan-todos-empty", content: message, display: true }, { triggerTurn: false });
				}
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			const message = `Plan Progress:\n${list}`;
			if (ctx.hasUI) {
				ctx.ui.notify(message, "info");
			} else {
				pi.sendMessage({ customType: "plan-todos", content: message, display: true }, { triggerTurn: false });
			}
		},
	});

	pi.registerShortcut("ctrl+alt+shift+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			togglePlanMode(ctx);
			persistState();
		},
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is blocked. Use /plan to disable plan mode first.`,
			};
		}

		const allowedTools = getPlanModeTools();
		if (!allowedTools.includes(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: tool "${event.toolName}" is not allowed. Allowed tools: ${allowedTools.join(", ") || "(none)"}`,
			};
		}

		if (event.toolName !== "bash") return;

		const command = String(event.input.command ?? "");
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: bash command blocked (not allowlisted read-only). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	pi.on("user_bash", async (event) => {
		if (!planModeEnabled) return;

		const command = String(event.command ?? "");
		if (isSafeCommand(command)) return;

		return {
			result: {
				output:
					`Plan mode: user command blocked (not allowlisted read-only). Use /plan to disable plan mode first.\n` +
					`Command: ${command}`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: buildPlanContext(getPlanModeTools()),
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			if (remaining.length === 0) return;
			return {
				message: {
					customType: "plan-execution-context",
					content: buildExecutionContext(remaining),
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				restoreToolsAfterPlanMode();
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		let planMarkdownPath: string | undefined;
		let canExecutePlan = false;
		if (lastAssistant) {
			const assistantText = getTextContent(lastAssistant);
			const validation = validatePlanOutput(assistantText);

			if (validation.valid) {
				todoItems = validation.todoItems;
				canExecutePlan = todoItems.length > 0;
				try {
					const saveResult = await savePlanMarkdown(
						assistantText,
						lastPlanPrompt || todoItems[0]?.text || "plan",
						refinementTargetPath || undefined,
					);
					planMarkdownPath = saveResult.path;
					lastPlanPath = saveResult.path;
					refinementTargetPath = "";

					const validationNotes = buildValidationNotes(validation);
					pi.sendMessage(
						{
							customType: saveResult.updated ? "plan-md-updated" : "plan-md-saved",
							content: `${saveResult.updated ? "Plan updated:" : "Plan saved to:"}\n\`${planMarkdownPath}\`${validationNotes}`,
							display: true,
						},
						{ triggerTurn: false },
					);

				} catch (error) {
					const message = `Failed to save plan markdown: ${String(error)}`;
					if (ctx.hasUI) {
						ctx.ui.notify(message, "error");
					} else {
						pi.sendMessage({ customType: "plan-md-save-error", content: message, display: true }, { triggerTurn: false });
					}
				}
			} else {
				todoItems = [];
				const message = "Plan not saved: assistant output was empty. Please refine and try again.";
				if (ctx.hasUI) {
					ctx.ui.notify(message, "warning");
				} else {
					pi.sendMessage({ customType: "plan-md-skipped", content: message, display: true }, { triggerTurn: false });
				}
			}
		}

		persistState();
		if (!ctx.hasUI) return;

		if (todoItems.length > 0) {
			const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}
		if (planMarkdownPath) {
			ctx.ui.notify(`Plan markdown: ${planMarkdownPath}`, "info");
		}

		const options = canExecutePlan
			? ["Execute the plan (track progress)", "Stay in plan mode", "Refine the plan"]
			: ["Stay in plan mode", "Refine the plan"];
		const choice = await ctx.ui.select("Plan mode - what next?", options);

		if (canExecutePlan && choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			pi.setActiveTools(getExecutionTools());
			if (!executionMode) {
				toolsBeforePlanMode = null;
			}
			updateStatus(ctx);

			const execMessage = `Execute the plan. Start with: ${todoItems[0].text}`;
			pi.sendMessage({ customType: "plan-mode-execute", content: execMessage, display: true }, { triggerTurn: true });
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			const refinedPrompt = refinement?.trim();
			if (refinedPrompt) {
				lastPlanPrompt = refinedPrompt;
				refinementTargetPath = sanitizePlanPath(lastPlanPath) ?? "";
				persistState();
				pi.sendUserMessage(refinedPrompt);
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}


		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeStateEntry } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			lastPlanPrompt = planModeEntry.data.lastPlanPrompt ?? lastPlanPrompt;
			lastPlanPath = sanitizePlanPath(planModeEntry.data.lastPlanPath) ?? lastPlanPath;
		}

		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (executionMode) {
			pi.setActiveTools(getExecutionTools());
		} else if (planModeEnabled) {
			rememberToolsBeforePlanMode();
			pi.setActiveTools(getPlanModeTools());
		}
		updateStatus(ctx);
	});
}
