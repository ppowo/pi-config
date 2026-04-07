import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const smallModelMarkers = ["mini", "nano"];

function isSmallModel(modelId: string) {
	const lower = modelId.toLowerCase();
	return smallModelMarkers.some((marker) => lower.includes(marker));
}

const smallModelToolHint =
	"Small-model mode: verify with tools (don't guess). Prefer codespelunker/ast_search/grep/read/nu for discovery, use bash for execution, and keep reads bounded.";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.model || !isSmallModel(ctx.model.id)) {
			return undefined;
		}

		const toolHint = smallModelToolHint;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${toolHint}`,
		};
	});
}
