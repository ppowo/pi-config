import assert from "node:assert";
import { describe, it } from "node:test";
import plugin, { getModelVerbosity, patchPayloadVerbosity } from "../extensions/model-info-toggle.ts";

function createMockPi() {
	const handlers: Array<{
		event: string;
		handler: (...args: unknown[]) => unknown;
	}> = [];

	return {
		registerShortcut: () => undefined,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.push({ event, handler });
		},
		fireBeforeProviderRequest: (event: unknown, ctx: unknown) => {
			for (const h of handlers) {
				if (h.event === "before_provider_request") {
					return h.handler(event, ctx);
				}
			}
		},
	};
}

void describe("model-info-toggle verbosity", () => {
	void it("uses low verbosity for current and future GPT Responses models", () => {
		assert.strictEqual(getModelVerbosity({ api: "openai-responses", id: "gpt-5.5" } as never), "low");
		assert.strictEqual(getModelVerbosity({ api: "openai-responses", id: "gpt-6" } as never), "low");
		assert.strictEqual(getModelVerbosity({ api: "openai-codex-responses", id: "gpt-6-codex" } as never), "low");
	});

	void it("does not set verbosity for unsupported APIs", () => {
		assert.strictEqual(getModelVerbosity({ api: "openai-completions", id: "gpt-6" } as never), undefined);
	});

	void it("sets Responses API text.verbosity without dropping existing text config", () => {
		const payload = patchPayloadVerbosity(
			{ model: "gpt-6", text: { format: { type: "text" } } },
			"low",
		);

		assert.deepStrictEqual(payload, {
			model: "gpt-6",
			text: {
				format: { type: "text" },
				verbosity: "low",
			},
		});
	});

	void it("injects text.verbosity via before_provider_request for future GPT models", () => {
		const pi = createMockPi();
		plugin(pi as never);

		const result = pi.fireBeforeProviderRequest(
			{ payload: { model: "gpt-6", text: { format: { type: "text" } } } },
			{ model: { api: "openai-responses", id: "gpt-6" } },
		);

		assert.deepStrictEqual(result, {
			model: "gpt-6",
			text: {
				format: { type: "text" },
				verbosity: "low",
			},
		});
	});
});
