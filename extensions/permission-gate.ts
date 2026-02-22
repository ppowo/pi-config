/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * In headless mode (no UI), dangerous commands are blocked.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type DangerRule = {
	name: string;
	test: (command: string) => boolean;
};

const dangerRules: DangerRule[] = [
	{
		name: "recursive force delete",
		test: (command) =>
			/\brm\b/i.test(command) &&
			(/\s-(?=[^\n]*r)(?=[^\n]*f)[a-z-]*/i.test(command) || (/\s--recursive\b/i.test(command) && /\s--force\b/i.test(command))),
	},
	{ name: "sudo command", test: (command) => /\bsudo\b/i.test(command) },
	{ name: "chmod/chown 777", test: (command) => /\b(?:chmod|chown)\b[^\n]*\b777\b/i.test(command) },
	{ name: "git reset --hard", test: (command) => /\bgit\s+reset\b[^\n]*\s--hard\b/i.test(command) },
	{
		name: "git clean with force",
		test: (command) =>
			/\bgit\s+clean\b/i.test(command) && (/\s--force\b/i.test(command) || /\s-(?=[^\n]*f)[a-z-]*/i.test(command)),
	},
	{ name: "discard tracked changes", test: (command) => /\bgit\s+checkout\s+--\s+\.(?:\s|$)/i.test(command) },
	{ name: "discard tracked changes", test: (command) => /\bgit\s+restore\b[^\n]*\s\.(?:\s|$)/i.test(command) },
	{ name: "force push", test: (command) => /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i.test(command) },
	{ name: "force push (-f)", test: (command) => /\bgit\s+push\b[^\n]*\s-(?=[^\n]*f)[a-z-]+\b/i.test(command) },
	{ name: "disk format", test: (command) => /\bmkfs(?:\.[a-z0-9]+)?\b/i.test(command) },
	{ name: "raw disk overwrite", test: (command) => /\bdd\b/i.test(command) && /\bof=\/dev\//i.test(command) },
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "").trim();
		if (!command) return undefined;

		const matched = [...new Set(dangerRules.filter((rule) => rule.test(command)).map((rule) => rule.name))];
		if (matched.length === 0) return undefined;

		const matchedSummary = matched.join(", ");

		if (!ctx.hasUI) {
			return { block: true, reason: `Dangerous command blocked (no UI): ${matchedSummary}` };
		}

		const choice = await ctx.ui.select(
			`⚠️ Potentially destructive command (${matchedSummary}):\n\n  ${command}\n\nAllow?`,
			["No, block it", "Yes, run it"],
		);

		if (choice !== "Yes, run it") {
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}
