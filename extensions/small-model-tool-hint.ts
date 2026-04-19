import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const smallModelMarkers = ["mini", "nano"];

function isSmallModel(modelId: string) {
	const lower = modelId.toLowerCase();
	return smallModelMarkers.some((marker) => lower.includes(marker));
}

const smallModelToolHint =
	"Small-model mode: verify with tools. For code discovery, start with codespelunker or ast_search; use grep only for exact text after you know the target. Search once, then read the best file or symbol. Keep reads bounded. Use bash mainly for execution.";

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
