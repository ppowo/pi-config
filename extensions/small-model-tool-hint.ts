import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const smallModelMarkers = ["mini", "nano"];

function isSmallModel(modelId: string) {
	const lower = modelId.toLowerCase();
	return smallModelMarkers.some((marker) => lower.includes(marker));
}

function buildToolHint(activeTools: string[]) {
	const tools = new Set(activeTools);
	const lines = [
		"Tooling hint for smaller models: Use tools to verify facts instead of guessing. Prefer the most specific available tool and keep reads bounded.",
	];

	const guidance: string[] = [];
	if (tools.has("codespelunker")) {
		guidance.push("- Use `codespelunker` for ranked structural code discovery, declarations/usages, and likely implementations.");
	}
	if (tools.has("ast_search")) {
		guidance.push("- Use `ast_search` for syntax-aware code patterns like calls, imports, JSX, and structural matches.");
	}
	if (tools.has("grep")) {
		guidance.push("- Use `grep` for exact text, literals, raw regex scans, and pipelines.");
	}
	if (tools.has("nu") && tools.has("bash")) {
		guidance.push("- Use `nu` for structured inspection/exploration (JSON, CSV, TOML, YAML, file listings, system state). Use `bash` for tests, builds, installs, and git.");
	} else if (tools.has("nu")) {
		guidance.push("- Use `nu` for structured inspection/exploration (JSON, CSV, TOML, YAML, file listings, system state).");
	} else if (tools.has("bash")) {
		guidance.push("- Use `bash` for execution tasks like tests, builds, installs, and git.");
	}
	if (tools.has("read")) {
		guidance.push("- Use `read` with `offset`/`limit`, `symbol`, or `map` instead of dumping whole files.");
	}
	if (tools.has("edit") || tools.has("write")) {
		guidance.push("- Use `edit` for surgical changes and `write` for new files or full rewrites.");
	}
	if (tools.has("resolve_library_id") && tools.has("get_library_docs")) {
		guidance.push("- When current library docs are needed, use Context7: `resolve_library_id` first, then `get_library_docs`.");
	}
	if (guidance.length > 0) {
		lines.push("", ...guidance);
	}

	const avoid: string[] = [];
	if (tools.has("bash") && (tools.has("codespelunker") || tools.has("grep") || tools.has("nu") || tools.has("read"))) {
		avoid.push("- Do not use `bash` for routine file exploration when a more specific tool can do it.");
	}
	if (tools.has("read")) {
		avoid.push("- Do not dump huge files into context when bounded `read` calls will do.");
	}
	avoid.push("- Do not answer from memory when an available tool can verify the claim.");
	lines.push("", "Avoid:", ...avoid);

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.model || !isSmallModel(ctx.model.id)) {
			return undefined;
		}

		const toolHint = buildToolHint(pi.getActiveTools());
		return {
			systemPrompt: `${event.systemPrompt}\n\n${toolHint}`,
		};
	});
}
