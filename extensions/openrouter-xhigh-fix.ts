/**
 * Fixes xhigh reasoning effort for DeepSeek V4 models on OpenRouter.
 *
 * OpenRouter's normalized `reasoning.effort` API accepts `xhigh` directly,
 * but pi-mono's compat for OpenRouter DeepSeek models maps xhigh to `max`
 * (which is the native DeepSeek API value). OpenRouter doesn't accept `max`
 * in its reasoning effort enum, so the request silently falls back to default.
 *
 * This extension intercepts the provider request and rewrites `"max"`
 * back to `"xhigh"` for OpenRouter-hosted DeepSeek models.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const OPENROUTER_DEEPSEEK_V4 = /deepseek\/deepseek-v4-(pro|flash)/;

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as Record<string, unknown>;
		const modelId = String(payload.model ?? "");

		if (!OPENROUTER_DEEPSEEK_V4.test(modelId)) return undefined;

		const reasoning = payload.reasoning as Record<string, unknown> | undefined;
		if (!reasoning || reasoning.effort !== "max") return undefined;

		// OpenRouter accepts "xhigh" natively, but pi-mono's compat maps it
		// to the native DeepSeek value "max". Rewrite it back.
		return {
			...payload,
			reasoning: { ...reasoning, effort: "xhigh" },
		};
	});
}
