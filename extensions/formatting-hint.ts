import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const formattingHint =
	"Prefer tasteful, readable Markdown in normal responses: use short headings when helpful, bullets or numbered lists for multi-part answers, bold for key takeaways, inline code for literals, and fenced code blocks only for actual code or commands. Do not over-format, and follow explicit user style requests such as plain text or raw output.";

function isMiniModel(modelId: string) {
	return modelId === "gpt-5-mini" || modelId.endsWith("/gpt-5-mini") || modelId.includes("gpt-5-mini");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.model || !isMiniModel(ctx.model.id)) {
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\nFormatting hint: ${formattingHint}`,
		};
	});
}