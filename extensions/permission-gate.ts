/**
 * Permission Gate Extension
 *
 * Heuristic risk gate for tool calls. This is a safety net, not a sandbox:
 * structured tools expose reliable paths, while shell tools are opaque text and
 * can route around regex checks. Risky calls ask in interactive mode and block
 * in headless mode; catastrophic calls always block.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Decision = "allow" | "ask" | "block";
type Signal = {
	name: string;
	score: number;
	force?: Decision;
};
type Assessment = {
	target: string;
	score: number;
	decision: Decision;
	signals: Signal[];
};

type PathRule = [name: string, score: number, pattern: RegExp, force?: Decision];
type CommandRule = [name: string, score: number, test: (command: string) => boolean, force?: Decision];

const ASK_THRESHOLD = 20;
const BLOCK_THRESHOLD = 100;

const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();

const hasShortFlags = (command: string, ...flags: string[]) => {
	const shortFlagGroups = command.matchAll(/\s-([a-z-]+)/gi);
	return [...shortFlagGroups].some(([, group]) => flags.every((flag) => group.includes(flag)));
};

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

const commandRules: CommandRule[] = [
	["recursive force delete", 40, (cmd) => /\brm\b/i.test(cmd) && (hasShortFlags(cmd, "r", "f") || (/\s--recursive\b/i.test(cmd) && /\s--force\b/i.test(cmd)))],
	["home/root recursive delete", 100, (cmd) => /\brm\b[^\n]*(?:-[a-z-]*r[a-z-]*f|-[-\w\s]*recursive[-\w\s]*force)[^\n]*(?:\s\/\s*$|\s~(?:\s|\/|$)|\$HOME)/i.test(cmd), "block"],
	["sudo command", 25, (cmd) => /\bsudo\b/i.test(cmd)],
	["chmod/chown 777", 35, (cmd) => /\b(?:chmod|chown)\b[^\n]*\b777\b/i.test(cmd)],
	["git reset --hard", 35, (cmd) => /\bgit\s+reset\b[^\n]*\s--hard\b/i.test(cmd)],
	["git clean with force", 35, (cmd) => /\bgit\s+clean\b/i.test(cmd) && (/\s--force\b/i.test(cmd) || hasShortFlags(cmd, "f"))],
	["discard tracked changes", 30, (cmd) => /\bgit\s+(checkout\s+--|restore\b[^\n]*\s)\s*\.(?:\s|$)/i.test(cmd)],
	["force push", 35, (cmd) => /\bgit\s+push\b[^\n]*(\s--force(?:-with-lease)?\b|\s-f\b)/i.test(cmd)],
	["disk format", 100, (cmd) => /\bmkfs(?:\.[a-z0-9]+)?\b/i.test(cmd), "block"],
	["raw disk overwrite", 100, (cmd) => /\bdd\b/i.test(cmd) && /\bof=\/dev\//i.test(cmd), "block"],
	["shell file write/delete", 20, (cmd) => /\b(rm|mv|cp|save|tee|chmod|chown|perl|python|python3|node)\b|>|>>/i.test(cmd)],
];

const scoreToDecision = (score: number, signals: Signal[]): Decision => {
	if (signals.some((signal) => signal.force === "block") || score >= BLOCK_THRESHOLD) return "block";
	if (signals.some((signal) => signal.force === "ask") || score >= ASK_THRESHOLD) return "ask";
	return "allow";
};

const assessPath = (path: string, target: string): Assessment => {
	const normalized = normalize(path);
	const signals = pathRules
		.filter(([, , pattern]) => pattern.test(normalized))
		.map(([name, score, , force]) => ({ name, score, force }));
	const score = signals.reduce((total, signal) => total + signal.score, 0);
	return { target, score, decision: scoreToDecision(score, signals), signals };
};

const assessCommand = (command: string, target: string): Assessment => {
	const normalized = normalize(command);
	const commandSignals = commandRules
		.filter(([, , test]) => test(command))
		.map(([name, score, , force]) => ({ name, score, force }));
	const pathSignals = pathRules
		.filter(([name, , pattern]) => name !== "env template" && pattern.test(normalized))
		.map(([name, score, , force]) => ({ name: `mentions ${name}`, score, force }));
	const signals = [...commandSignals, ...pathSignals];
	const score = signals.reduce((total, signal) => total + signal.score, 0);
	return { target, score, decision: scoreToDecision(score, signals), signals };
};

const assessToolCall = (toolName: string, input: Record<string, unknown>): Assessment | undefined => {
	if (toolName === "edit" || toolName === "write") {
		const path = String(input.path ?? "").trim();
		return path ? assessPath(path, `${toolName}: ${path}`) : undefined;
	}

	if (toolName === "bash" || toolName === "nu") {
		const command = String(input.command ?? "").trim();
		return command ? assessCommand(command, `${toolName}: ${command}`) : undefined;
	}

	return undefined;
};

const formatSignals = (signals: Signal[]) => [...new Set(signals.map((signal) => signal.name))].join(", ");

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const assessment = assessToolCall(event.toolName, event.input as Record<string, unknown>);
		if (!assessment || assessment.decision === "allow") return undefined;

		const summary = formatSignals(assessment.signals);
		const reason = `Permission gate ${assessment.decision}: ${summary}`;

		if (assessment.decision === "block") {
			if (ctx.hasUI) ctx.ui.notify(`Blocked risky tool call: ${summary}`, "warning");
			return { block: true, reason };
		}

		if (!ctx.hasUI) return { block: true, reason: `${reason}; confirmation requires UI` };

		const allow = "Yes, allow once";
		const choice = await ctx.ui.select(
			`⚠️ Risky tool call (${summary}; score ${assessment.score}):\n\n  ${assessment.target}\n\nAllow?`,
			["No, block it", allow],
		);
		return choice === allow ? undefined : { block: true, reason: "Blocked by user" };
	});
}
