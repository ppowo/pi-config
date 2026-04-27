import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Work around OpenRouter/DeepSeek thinking-mode replay errors:
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * Pi already handles this for the built-in DeepSeek provider. When routing
 * DeepSeek models through OpenRouter, the same compatibility requirement can
 * apply but may not be auto-detected from the OpenRouter URL. This hook patches
 * outgoing OpenAI-compatible chat payloads by ensuring replayed assistant
 * messages include a `reasoning_content` field.
 */
export default function openRouterReasoningContent(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "openrouter") return;

    const payload = event.payload as any;
    if (!payload || !Array.isArray(payload.messages)) return;

    let changed = false;
    const messages = payload.messages.map((message: any) => {
      if (message?.role !== "assistant") return message;
      if (Object.prototype.hasOwnProperty.call(message, "reasoning_content")) return message;

      changed = true;
      return { ...message, reasoning_content: "" };
    });

    if (!changed) return;
    return { ...payload, messages };
  });
}
