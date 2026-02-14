/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+Shift+P to toggle
 * - /plan "..." seeds planning immediately
 * - /plan-latest and /plan-open for saved plan files
 * - Bash commands allowed only for read-only inspection in plan mode
 * - Structured plan validation (Goal/Scope/Assumptions/Plan/Risks/Validation)
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils";

// Tool sets
const PLAN_MODE_TOOL_PREFERENCE = ["read", "grep", "find", "ls", "bash", "questionnaire"];
const EXECUTION_MODE_TOOL_PREFERENCE = ["read", "grep", "find", "ls", "bash", "edit", "write", "questionnaire"];

const REQUIRED_PLAN_SECTIONS = ["Goal", "Scope", "Assumptions", "Plan", "Risks", "Validation"] as const;
type RequiredPlanSection = (typeof REQUIRED_PLAN_SECTIONS)[number];

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
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

function getPlanDir(): string {
	return path.join(os.homedir(), "Plans");
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
	return slug || "plan";
}

interface PlanSaveResult {
	path: string;
	updated: boolean;
}

async function savePlanMarkdown(planText: string, promptHint?: string, preferredPath?: string): Promise<PlanSaveResult> {
	const normalizedPlan = `${planText.trim()}\n`;

	if (preferredPath && (await fileExists(preferredPath))) {
		await writeFile(preferredPath, normalizedPlan, "utf8");
		return { path: preferredPath, updated: true };
	}

	const plansDir = getPlanDir();
	await mkdir(plansDir, { recursive: true });

	const now = new Date();
	const stamp = now.toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
	const name = `${stamp}-${slugify(promptHint ?? "plan")}.md`;
	const filePath = path.join(plansDir, name);
	await writeFile(filePath, normalizedPlan, "utf8");
	return { path: filePath, updated: false };
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPlanSectionRegex(section: RequiredPlanSection, global = false): RegExp {
	return new RegExp(
		`^\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?(?:\\*{1,2})?${escapeRegex(section)}(?:\\*{1,2})?\\s*:`,
		global ? "gim" : "im",
	);
}

function countPlanSectionOccurrences(text: string, section: RequiredPlanSection): number {
	const pattern = buildPlanSectionRegex(section, true);
	return Array.from(text.matchAll(pattern)).length;
}

interface PlanValidationResult {
	valid: boolean;
	missingSections: RequiredPlanSection[];
	duplicateSections: RequiredPlanSection[];
	hasNumberedPlanSteps: boolean;
	todoItems: TodoItem[];
}

interface PlanModeStateEntry {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	lastPlanPrompt?: string;
	lastPlanPath?: string;
}

function validatePlanOutput(text: string): PlanValidationResult {
	const sectionCounts = {} as Record<RequiredPlanSection, number>;
	for (const section of REQUIRED_PLAN_SECTIONS) {
		sectionCounts[section] = countPlanSectionOccurrences(text, section);
	}

	const missingSections = REQUIRED_PLAN_SECTIONS.filter((section) => sectionCounts[section] === 0);
	const duplicateSections = REQUIRED_PLAN_SECTIONS.filter((section) => sectionCounts[section] > 1);
	const todoItems = extractTodoItems(text);
	const hasNumberedPlanSteps = todoItems.length > 0;

	return {
		valid: missingSections.length === 0 && hasNumberedPlanSteps,
		missingSections,
		duplicateSections,
		hasNumberedPlanSteps,
		todoItems,
	};
}

function truncatePlanPreview(text: string, maxLines = 120): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return "(empty file)";
	const lines = normalized.split("\n");
	if (lines.length <= maxLines) return normalized;
	return `${lines.slice(0, maxLines).join("\n")}\n\n[Preview truncated: showing ${maxLines} of ${lines.length} lines]`;
}

async function findLatestPlanPath(): Promise<string | undefined> {
	const plansDir = getPlanDir();
	await mkdir(plansDir, { recursive: true });
	const entries = await readdir(plansDir, { withFileTypes: true });
	const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
	if (markdownFiles.length === 0) return undefined;

	const filesWithMtime = await Promise.all(
		markdownFiles.map(async (entry) => {
			const filePath = path.join(plansDir, entry.name);
			const fileStats = await stat(filePath);
			return { filePath, mtimeMs: fileStats.mtimeMs };
		}),
	);

	filesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return filesWithMtime[0]?.filePath;
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
	if (!filePath) return false;
	try {
		const fileStats = await stat(filePath);
		return fileStats.isFile();
	} catch {
		return false;
	}
}

async function resolveLatestPlanPath(lastPlanPath: string): Promise<string | undefined> {
	if (await fileExists(lastPlanPath)) return lastPlanPath;
	return findLatestPlanPath();
}

function runOpenCommand(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
		});
	});
}

async function openInEditor(filePath: string): Promise<void> {
	const candidates: Array<{ command: string; args: string[] }> = [{ command: "code", args: [filePath] }];

	if (process.platform === "darwin") {
		candidates.push({ command: "open", args: ["-a", "Visual Studio Code", filePath] });
	} else if (process.platform === "win32") {
		candidates.push({ command: "cmd", args: ["/c", "start", "", filePath] });
	} else if (process.platform === "linux") {
		candidates.push({ command: "xdg-open", args: [filePath] });
	}

	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			await runOpenCommand(candidate.command, candidate.args);
			return;
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unknown error"));
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

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
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
		description: "Toggle plan mode or run planning prompt: /plan \"your request\"",
		handler: async (args, ctx) => {
			const prompt = normalizeCommandArgs(args);

			if (!prompt) {
				togglePlanMode(ctx);
				persistState();
				return;
			}

			lastPlanPrompt = prompt;
			refinementTargetPath = "";
			if (!planModeEnabled) {
				enterPlanMode(ctx);
			}

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
				const markdown = await readFile(planPath, "utf8");
				const preview = truncatePlanPreview(markdown, 80);

				pi.sendMessage(
					{
						customType: "plan-latest",
						content: `Latest plan:\n\`${planPath}\`\n\n${preview}`,
						display: true,
					},
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
				await openInEditor(planPath);
				if (ctx.hasUI) {
					ctx.ui.notify(`Opened plan: ${planPath}`, "info");
				}
				pi.sendMessage(
					{ customType: "plan-open", content: `Opened plan:\n\`${planPath}\``, display: true },
					{ triggerTurn: false },
				);
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

	// Allow only read-only bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;
		if (event.toolName !== "bash") return;

		const command = String(event.input.command ?? "");
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: bash command blocked (not allowlisted read-only). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
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

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const planTools = getPlanModeTools();
			const planToolsList = planTools.length > 0 ? planTools.join(", ") : "(none)";
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Allowed tools (read-only):
- ${planToolsList}
- edit/write are disabled
- bash is limited to allowlisted read-only commands

Context hygiene:
1. Built-in tool outputs are capped by pi (50KB / 2000 lines).
2. For large files, prefer read with offset+limit in smaller chunks.
3. Summarize findings first, then fetch more only as needed.

Do not attempt to make code changes.

Return a structured markdown plan using ALL required sections at least once:
- Goal:
- Scope:
- Assumptions:
- Plan:
- Risks:
- Validation:

Format requirements:
1. Under "Plan:", provide a numbered list (1., 2., 3., ...).
2. Keep steps concrete, actionable, and repository-specific.
3. Do not execute changes in plan mode.
4. If information is missing, ask clarifying questions in "Assumptions:".
5. Plans missing any required section or numbered Plan steps will be rejected and not saved.
6. Duplicate sections are allowed in lenient mode, but keep output tidy.

Template:
Goal:
- ...

Scope:
- In scope: ...
- Out of scope: ...

Assumptions:
- ...

Plan:
1. ...
2. ...

Risks:
- ...

Validation:
- ...`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
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
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled) return;

		// Validate and persist only structured plan output from the last assistant message
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

					const duplicateWarning =
						validation.duplicateSections.length > 0
							? `\n\n⚠ Duplicate sections detected (lenient mode): ${validation.duplicateSections.join(", ")}`
							: "";

					pi.sendMessage(
						{
							customType: saveResult.updated ? "plan-md-updated" : "plan-md-saved",
							content: `${saveResult.updated ? "Plan updated:" : "Plan saved to:"}\n\`${planMarkdownPath}\`${duplicateWarning}`,
							display: true,
						},
						{ triggerTurn: false },
					);

					if (validation.duplicateSections.length > 0 && ctx.hasUI) {
						ctx.ui.notify(
							`Duplicate sections detected (allowed): ${validation.duplicateSections.join(", ")}`,
							"warning",
						);
					}
				} catch (error) {
					const message = `Failed to save plan markdown: ${String(error)}`;
					if (ctx.hasUI) {
						ctx.ui.notify(message, "error");
					} else {
						pi.sendMessage(
							{ customType: "plan-md-save-error", content: message, display: true },
							{ triggerTurn: false },
						);
					}
				}
			} else {
				todoItems = [];
				const issues: string[] = [];
				if (validation.missingSections.length > 0) {
					issues.push(`Missing sections: ${validation.missingSections.join(", ")}`);
				}
				if (!validation.hasNumberedPlanSteps) {
					issues.push('No numbered steps found under "Plan:".');
				}
				const details = issues.length > 0 ? `\n${issues.join("\n")}` : "";
				const message =
					`Plan not saved: output must contain sections ${REQUIRED_PLAN_SECTIONS.join(", ")} and a numbered list under \"Plan:\".` +
					details;
				if (ctx.hasUI) {
					ctx.ui.notify(message, "warning");
				} else {
					pi.sendMessage({ customType: "plan-md-skipped", content: message, display: true }, { triggerTurn: false });
				}
			}
		}

		persistState();
		if (!ctx.hasUI) return;

		// Show plan steps and prompt for next action
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
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			const refinedPrompt = refinement?.trim();
			if (refinedPrompt) {
				lastPlanPrompt = refinedPrompt;
				refinementTargetPath = lastPlanPath;
				persistState();
				pi.sendUserMessage(refinedPrompt);
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeStateEntry } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			lastPlanPrompt = planModeEntry.data.lastPlanPrompt ?? lastPlanPrompt;
			lastPlanPath = planModeEntry.data.lastPlanPath ?? lastPlanPath;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
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
