/**
 * Permission Gate Extension
 *
 * Tool-agnostic risk gate for tool calls. Tool calls are first normalized into
 * semantic operations (write/delete/network/credential access/etc.), then policy
 * is applied to operation capability + scope + destructiveness rather than the
 * raw tool name. This is a safety net, not a sandbox: shell parsing is still
 * heuristic, but the policy model stays stable as tools change.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

// ─── types ───────────────────────────────────────────────────────────────────

type Decision = "allow" | "ask" | "block";
type Scope = "workspace" | "home" | "system" | "network" | "unknown";
type OperationKind = "read" | "write" | "delete" | "execute" | "network" | "credential-access" | "privilege";
type CommandClass = "test" | "build" | "format" | "package-manager" | "git" | "shell";

type Operation = {
	kind: OperationKind;
	scope: Scope;
	detail: string;
	paths?: string[];
	commandClass?: CommandClass;
	destructive?: boolean;
};

type Signal = {
	name: string;
	score: number;
	force?: Decision;
};

type Assessment = {
	target: string;
	score: number;
	decision: Decision;
	operations: Operation[];
	signals: Signal[];
};

type PathRule = [name: string, score: number, pattern: RegExp, force?: Decision];
type CommandRule = [operation: Omit<Operation, "scope">, test: (command: string) => boolean];

// ─── constants ───────────────────────────────────────────────────────────────

const ASK_THRESHOLD = 20;
const BLOCK_THRESHOLD = 100;
const HOME = process.env.HOME ? resolve(process.env.HOME) : undefined;
const WORKSPACE = resolve(process.cwd());

const pathRules: PathRule[] = [
	["env template", -50, /(^|\/)\.env\.(example|sample|template)$/],
	[".env file", 30, /(^|\/)\.env($|[._-])/],
	[".envrc", 35, /(^|\/)\.envrc$/],
	["git metadata", 45, /(^|\/)\.git(\/|$)/],
	["git object/index", 100, /(^|\/)\.git\/(objects\/|index$)/, "block"],
	["node_modules", 100, /(^|\/)node_modules(\/|$)/, "block"],
	["SSH config", 35, /(^|\/)\.ssh\/(config|allowed_signers)$/],
	["SSH private key", 100, /(^|\/)\.ssh\/[^/]*(?:_key|id_[a-z0-9]+)$/, "block"],
	["SSH directory", 30, /(^|\/)\.ssh(\/|$)/],
	["GnuPG material", 100, /(^|\/)\.gnupg(\/|$)/, "block"],
	["private key file", 100, /\.(pem|key|p12|pfx)$/, "block"],
	["global git config", 30, /(^|\/)\.gitconfig(?:$|-)/],
	["shell startup file", 25, /(^|\/)\.(bashrc|zshrc|profile|bash_profile|zprofile|config\/fish\/config\.fish)$/],
];

// ─── helpers ─────────────────────────────────────────────────────────────────

const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
const unique = <T>(values: T[]) => [...new Set(values)];

const hasShortFlags = (command: string, ...flags: string[]) => {
	const shortFlagGroups = command.matchAll(/\s-([a-z-]+)/gi);
	return [...shortFlagGroups].some(([, group]) => flags.every((flag) => group.includes(flag)));
};

const hasFileRedirection = (command: string) => /(?:^|[\s;|&])(?:\d?>{1,2})(?!&|\d)\s*[^\s&|;]+/.test(command);
const hasInlineScriptWrite = (command: string) =>
	/\bperl\b[^\n]*(?:\s-[a-z]*i|\s-[a-z]*p[a-z]*i)/i.test(command) ||
	/\bpython3?\b[^\n]*\s-c\s+['"][^'"]*(?:open\s*\(|write\s*\(|unlink\s*\(|remove\s*\()/i.test(command) ||
	/\bnode\b[^\n]*\s-e\s+['"][^'"]*(?:writeFile|rmSync|unlinkSync|appendFile|createWriteStream)/i.test(command);

const scopeForPath = (path: string): Scope => {
	const expanded = path.replace(/^~(?=\/|$)/, HOME ?? "~");
	const absolute = resolve(expanded);
	if (absolute === WORKSPACE || absolute.startsWith(`${WORKSPACE}/`)) return "workspace";
	if (HOME && (absolute === HOME || absolute.startsWith(`${HOME}/`))) return "home";
	if (absolute.startsWith("/")) return "system";
	return "unknown";
};

const broadestScope = (scopes: Scope[]): Scope => {
	if (scopes.includes("system")) return "system";
	if (scopes.includes("home")) return "home";
	if (scopes.includes("unknown")) return "unknown";
	if (scopes.includes("network")) return "network";
	return "workspace";
};

const classifyCommand = (command: string): CommandClass => {
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test)\b|\b(?:vitest|jest|mocha|playwright\s+test)\b/i.test(command)) return "test";
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|check|lint)\b|\b(?:tsc|eslint)\b/i.test(command)) return "build";
	if (/\b(?:prettier|biome|dprint)\b/i.test(command)) return "format";
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|dlx|exec)\b/i.test(command)) return "package-manager";
	if (/\bgit\b/i.test(command)) return "git";
	return "shell";
};

const extractPathMentions = (command: string): string[] => {
	const paths = command.match(/(?:~|\.\.?|\/)[^\s'";&|)]+/g) ?? [];
	return unique(paths.map((path) => path.replace(/[,:]$/, "")));
};

const commandRules: CommandRule[] = [
	[{ kind: "delete", detail: "recursive force delete", destructive: true }, (cmd) => /\brm\b/i.test(cmd) && (hasShortFlags(cmd, "r", "f") || (/\s--recursive\b/i.test(cmd) && /\s--force\b/i.test(cmd)))],
	[{ kind: "delete", detail: "home/root recursive delete", destructive: true }, (cmd) => /\brm\b[^\n]*(?:-[a-z-]*r[a-z-]*f|-[-\w\s]*recursive[-\w\s]*force)[^\n]*(?:\s\/\s*$|\s~(?:\s|\/|$)|\$HOME)/i.test(cmd)],
	[{ kind: "privilege", detail: "sudo command" }, (cmd) => /\bsudo\b/i.test(cmd)],
	[{ kind: "write", detail: "chmod/chown 777", destructive: true }, (cmd) => /\b(?:chmod|chown)\b[^\n]*\b777\b/i.test(cmd)],
	[{ kind: "write", detail: "git reset --hard", destructive: true }, (cmd) => /\bgit\s+reset\b[^\n]*\s--hard\b/i.test(cmd)],
	[{ kind: "delete", detail: "git clean with force", destructive: true }, (cmd) => /\bgit\s+clean\b/i.test(cmd) && (/\s--force\b/i.test(cmd) || hasShortFlags(cmd, "f"))],
	[{ kind: "write", detail: "discard tracked changes", destructive: true }, (cmd) => /\bgit\s+(checkout\s+--|restore\b[^\n]*\s)\s*\.(?:\s|$)/i.test(cmd)],
	[{ kind: "network", detail: "force push", destructive: true }, (cmd) => /\bgit\s+push\b[^\n]*(\s--force(?:-with-lease)?\b|\s-f\b)/i.test(cmd)],
	[{ kind: "write", detail: "disk format", destructive: true }, (cmd) => /\bmkfs(?:\.[a-z0-9]+)?\b/i.test(cmd)],
	[{ kind: "write", detail: "raw disk overwrite", destructive: true }, (cmd) => /\bdd\b/i.test(cmd) && /\bof=\/dev\//i.test(cmd)],
	[{ kind: "write", detail: "shell file write/delete" }, (cmd) => /\b(rm|mv|cp|save|tee|chmod|chown)\b/i.test(cmd) || hasFileRedirection(cmd) || hasInlineScriptWrite(cmd)],
	[{ kind: "network", detail: "network transfer" }, (cmd) => /\b(?:curl|wget|http|scp|rsync|ssh)\b/i.test(cmd)],
	[{ kind: "credential-access", detail: "credential-adjacent path" }, (cmd) => /(?:^|\/)\.(?:ssh|gnupg)(?:\/|$)|\.(?:pem|key|p12|pfx)\b/i.test(cmd)],
];

// ─── extraction ──────────────────────────────────────────────────────────────

const operationFromPathTool = (kind: "read" | "write", toolName: string, input: Record<string, unknown>): Operation | undefined => {
	const path = String(input.path ?? "").trim();
	if (!path) return undefined;
	return { kind, scope: scopeForPath(path), detail: `${toolName}: ${path}`, paths: [path] };
};

const operationsFromCommand = (toolName: string, command: string): Operation[] => {
	const paths = extractPathMentions(command);
	const scope = paths.length ? broadestScope(paths.map(scopeForPath)) : "workspace";
	const commandClass = classifyCommand(command);
	const operations: Operation[] = [{ kind: "execute", scope, detail: `${toolName}: ${command}`, commandClass }];

	for (const [operation, test] of commandRules) {
		if (!test(command)) continue;
		operations.push({ ...operation, scope: operation.kind === "network" ? "network" : scope, paths });
	}

	return operations;
};

const extractOperations = (toolName: string, input: Record<string, unknown>): Operation[] => {
	if (["read", "grep", "find", "ls", "ast_search"].includes(toolName)) {
		const operation = operationFromPathTool("read", toolName, input);
		return operation ? [operation] : [];
	}

	if (toolName === "edit" || toolName === "write") {
		const operation = operationFromPathTool("write", toolName, input);
		return operation ? [operation] : [];
	}

	if (toolName === "bash" || toolName === "nu") {
		const command = String(input.command ?? "").trim();
		return command ? operationsFromCommand(toolName, command) : [];
	}

	return [];
};

// ─── policy ──────────────────────────────────────────────────────────────────

const scorePath = (paths: string[] | undefined): Signal[] => {
	return unique(paths ?? []).flatMap((path) => {
		const normalized = normalize(path);
		return pathRules
			.filter(([, , pattern]) => pattern.test(normalized))
			.map(([name, score, , force]) => ({ name, score, force }));
	});
};

const scoreOperation = (operation: Operation): Signal[] => {
	const signals: Signal[] = [];

	if (operation.kind === "credential-access") signals.push({ name: operation.detail, score: 100, force: "block" });
	if (operation.kind === "privilege") signals.push({ name: operation.detail, score: 25 });
	if (operation.kind === "network") signals.push({ name: operation.detail, score: operation.destructive ? 35 : 20 });
	if (operation.kind === "delete") signals.push({ name: operation.detail, score: operation.destructive ? 45 : 25 });
	if (operation.kind === "write" && operation.destructive) signals.push({ name: operation.detail, score: 35 });
	if (operation.kind === "write" && operation.scope !== "workspace") signals.push({ name: `write outside workspace (${operation.scope})`, score: operation.scope === "system" ? 40 : 25 });
	if (operation.kind === "read" && operation.scope !== "workspace") signals.push({ name: `read outside workspace (${operation.scope})`, score: 15 });
	if (operation.kind === "execute" && operation.commandClass === "package-manager") signals.push({ name: "package manager command", score: 20 });
	if (operation.scope === "system") signals.push({ name: "system scope", score: 20 });

	return [...signals, ...scorePath(operation.paths)];
};

const scoreToDecision = (score: number, signals: Signal[]): Decision => {
	if (signals.some((signal) => signal.force === "block") || score >= BLOCK_THRESHOLD) return "block";
	if (signals.some((signal) => signal.force === "ask") || score >= ASK_THRESHOLD) return "ask";
	return "allow";
};

const assessToolCall = (toolName: string, input: Record<string, unknown>): Assessment | undefined => {
	const operations = extractOperations(toolName, input);
	if (operations.length === 0) return undefined;

	const signals = operations.flatMap(scoreOperation);
	const score = signals.reduce((total, signal) => total + signal.score, 0);
	const decision = scoreToDecision(score, signals);
	const target = operations.map((operation) => operation.detail).join("\n  ");
	return { target, score, decision, operations, signals };
};

const formatSignals = (signals: Signal[]) => unique(signals.map((signal) => signal.name)).join(", ");
const formatOperations = (operations: Operation[]) =>
	operations.map((operation) => `${operation.kind}${operation.commandClass ? `:${operation.commandClass}` : ""}/${operation.scope}`).join(", ");

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const assessment = assessToolCall(event.toolName, event.input as Record<string, unknown>);
		if (!assessment || assessment.decision === "allow") return undefined;

		const summary = formatSignals(assessment.signals);
		const operations = formatOperations(assessment.operations);
		const reason = `Permission gate ${assessment.decision}: ${summary}; operations: ${operations}`;

		if (assessment.decision === "block") {
			if (ctx.hasUI) ctx.ui.notify(`Blocked risky tool call: ${summary}`, "warning");
			return { block: true, reason };
		}

		if (!ctx.hasUI) return { block: true, reason: `${reason}; confirmation requires UI` };

		const allow = "Yes, allow once";
		const choice = await ctx.ui.select(
			`⚠️ Risky operation (${summary}; score ${assessment.score})\n\nOperations: ${operations}\n\n  ${assessment.target}\n\nAllow?`,
			["No, block it", allow],
		);
		return choice === allow ? undefined : { block: true, reason: "Blocked by user" };
	});
}
