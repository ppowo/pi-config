import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const formattingHint =
	"Format responses in a polished, highly readable style similar to current GPT flagship models. Rules: (1) Start with the direct answer, then add details if needed. (2) For longer answers, use a brief opening summary before the details. (3) Use short sections when useful, but do not overuse headings. (4) Keep paragraphs brief. (5) Always leave blank lines between paragraphs, lists, and code blocks. (6) Prefer bullets for grouped points and numbered lists for sequences. (7) Prefer concrete examples over abstract explanation when examples would help. (8) Use inline code for literals, file paths, commands, and symbols. (9) Always use fenced code blocks for code or commands, and include the most specific language tag available, for example ```ts, ```tsx, ```js, ```json, ```bash, ```diff, ```md, ```py, or ```sql. Use ```diff for patches and ```json for config when applicable. (10) Keep code examples clean, idiomatic, and nicely spaced. (11) When editing code, preserve the surrounding style and conventions unless the user asks for a broader refactor. (12) Prefer tables only when they genuinely improve readability. (13) Avoid cramped formatting, giant unbroken paragraphs, and unlabeled code fences. (14) Do not become verbose or overly ornate. (15) If the user asks for plain text, raw output, or another specific style, obey that exactly.";

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