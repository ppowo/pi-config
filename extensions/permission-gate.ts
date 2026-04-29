/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * In headless mode (no UI), dangerous commands are blocked.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Rule = [name: string, test: (command: string) => boolean];

const hasShortFlags = (command: string, ...flags: string[]) => {
	const shortFlagGroups = command.matchAll(/\s-([a-z-]+)/gi);
	return [...shortFlagGroups].some(([, group]) => flags.every((flag) => group.includes(flag)));
};

const dangerRules: Rule[] = [
	["recursive force delete", (cmd) => /\brm\b/i.test(cmd) && (hasShortFlags(cmd, "r", "f") || (/\s--recursive\b/i.test(cmd) && /\s--force\b/i.test(cmd)))],
	["sudo command", (cmd) => /\bsudo\b/i.test(cmd)],
	["chmod/chown 777", (cmd) => /\b(?:chmod|chown)\b[^\n]*\b777\b/i.test(cmd)],
	["git reset --hard", (cmd) => /\bgit\s+reset\b[^\n]*\s--hard\b/i.test(cmd)],
	["git clean with force", (cmd) => /\bgit\s+clean\b/i.test(cmd) && (/\s--force\b/i.test(cmd) || hasShortFlags(cmd, "f"))],
	["discard tracked changes", (cmd) => /\bgit\s+(checkout\s+--|restore\b[^\n]*\s)\s*\.(?:\s|$)/i.test(cmd)],
	["force push", (cmd) => /\bgit\s+push\b[^\n]*(\s--force(?:-with-lease)?\b|\s-f\b)/i.test(cmd)],
	["disk format", (cmd) => /\bmkfs(?:\.[a-z0-9]+)?\b/i.test(cmd)],
	["raw disk overwrite", (cmd) => /\bdd\b/i.test(cmd) && /\bof=\/dev\//i.test(cmd)],
];

const matchingRuleNames = (command: string) => [...new Set(dangerRules.filter(([, test]) => test(command)).map(([name]) => name))];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "").trim();
		const matched = command ? matchingRuleNames(command) : [];
		if (matched.length === 0) return undefined;

		const summary = matched.join(", ");
		if (!ctx.hasUI) return { block: true, reason: `Dangerous command blocked (no UI): ${summary}` };

		const allow = "Yes, run it";
		const choice = await ctx.ui.select(`⚠️ Potentially destructive command (${summary}):\n\n  ${command}\n\nAllow?`, ["No, block it", allow]);
		return choice === allow ? undefined : { block: true, reason: "Blocked by user" };
	});
}
