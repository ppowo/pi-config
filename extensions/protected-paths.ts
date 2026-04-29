/**
 * Protected Paths Extension
 *
 * Blocks writes to sensitive paths. Env templates are allowed; real .env files ask first.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Action = "allow" | "ask" | "block";
type Rule = [name: string, action: Action, pattern: RegExp];

const rules: Rule[] = [
	["env template", "allow", /(^|\/)\.env\.(example|sample|template)$/],
	[".env file", "ask", /(^|\/)\.env($|[._-])/],
	[".envrc", "block", /(^|\/)\.envrc$/],
	[".git metadata", "block", /(^|\/)\.git(\/|$)/],
	["node_modules", "block", /(^|\/)node_modules(\/|$)/],
	["SSH keys", "block", /(^|\/)\.ssh(\/|$)/],
	["GnuPG keys", "block", /(^|\/)\.gnupg(\/|$)/],
	["private key files", "block", /\.(pem|key|p12|pfx)$/],
];

const classify = (path: string) => {
	const matches = rules.filter(([, , pattern]) => pattern.test(path));
	const has = (action: Action) => matches.some(([, candidate]) => candidate === action);
	const action: Action = has("allow") ? "allow" : has("block") ? "block" : has("ask") ? "ask" : "allow";
	return { action, names: matches.map(([name]) => name).filter((name) => name !== "env template") };
};

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const path = String(event.input.path ?? "");
		const { action, names } = classify(path.replaceAll("\\", "/").toLowerCase());
		if (action === "allow") return undefined;

		const summary = names.join(", ");
		const reason = `Path "${path}" is protected (${summary})`;

		if (action === "block") {
			if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			return { block: true, reason };
		}

		if (!ctx.hasUI) return { block: true, reason: `${reason}; confirmation requires UI` };

		const allow = `Yes, allow ${event.toolName}`;
		const choice = await ctx.ui.select(`⚠️ Protected file (${summary}):\n\n  ${path}\n\nAllow this ${event.toolName}?`, ["No, block it", allow]);
		return choice === allow ? undefined : { block: true, reason: "Blocked by user" };
	});
}
