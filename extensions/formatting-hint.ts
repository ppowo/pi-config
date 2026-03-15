import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const formattingHint =
	"Format responses in a polished, highly readable style similar to current GPT flagship models. Rules: (1) Use short sections when useful. (2) Keep paragraphs brief. (3) Always leave blank lines between paragraphs, lists, and code blocks. (4) Prefer bullets for grouped points and numbered lists for sequences. (5) Use inline code for literals, file paths, commands, and symbols. (6) Always use fenced code blocks for code or commands, and include the most specific language tag available, for example ```ts, ```tsx, ```js, ```json, ```bash, ```diff, ```md, ```py, or ```sql. (7) Keep code examples clean, idiomatic, and nicely spaced. (8) Avoid cramped formatting, giant unbroken paragraphs, and unlabeled code fences. (9) Do not become verbose or overly ornate. (10) If the user asks for plain text, raw output, or another specific style, obey that exactly.";

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