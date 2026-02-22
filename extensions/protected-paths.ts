/**
 * Protected Paths Extension
 *
 * Blocks write/edit operations to sensitive paths.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ProtectedRule = {
	name: string;
	pattern: RegExp;
};

const protectedRules: ProtectedRule[] = [
	{ name: ".git metadata", pattern: /(^|\/)\.git(\/|$)/ },
	{ name: "node_modules", pattern: /(^|\/)node_modules(\/|$)/ },
	{ name: ".env files", pattern: /(^|\/)\.env($|[._-])/ },
	{ name: ".envrc", pattern: /(^|\/)\.envrc$/ },
	{ name: "SSH keys", pattern: /(^|\/)\.ssh(\/|$)/ },
	{ name: "GnuPG keys", pattern: /(^|\/)\.gnupg(\/|$)/ },
	{ name: "private key files", pattern: /\.(pem|key|p12|pfx)$/ },
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const path = String(event.input.path ?? "");
		const normalizedPath = path.replaceAll("\\", "/").toLowerCase();
		const matched = [...new Set(protectedRules.filter((rule) => rule.pattern.test(normalizedPath)).map((rule) => rule.name))];

		if (matched.length === 0) {
			return undefined;
		}

		const reason = `Path "${path}" is protected (${matched.join(", ")})`;
		if (ctx.hasUI) {
			ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
		}
		return { block: true, reason };
	});
}
