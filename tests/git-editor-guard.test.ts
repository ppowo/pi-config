import plugin from "../extensions/git-editor-guard.ts";
import { describe, it } from "node:test";
import assert from "node:assert";

function createMockPi() {
	const handlers: Array<{
		event: string;
		handler: (...args: unknown[]) => unknown;
	}> = [];

	return {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.push({ event, handler });
		},
		fireToolCall: (event: { toolName: string; input: Record<string, unknown> }) => {
			for (const h of handlers) {
				if (h.event === "tool_call") {
					return h.handler(event);
				}
			}
		},
	};
}

void describe("git-editor-guard", () => {
	void it("prepends GIT_EDITOR=true env vars to git commands", () => {
		const pi = createMockPi();
		plugin(pi as never);

		const event = {
			toolName: "bash",
			input: { command: "git commit -m 'hello'" },
		};
		pi.fireToolCall(event);

		assert.ok(
			event.input.command.startsWith(
				"export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n",
			),
			`Expected env prefix, got: ${event.input.command}`,
		);
	});

	void it("does not modify non-git bash commands", () => {
		const pi = createMockPi();
		plugin(pi as never);

		const event = {
			toolName: "bash",
			input: { command: "ls -la" },
		};
		const original = event.input.command;
		pi.fireToolCall(event);

		assert.strictEqual(event.input.command, original);
	});

	void it("does not modify commands where git is only a substring", () => {
		const pi = createMockPi();
		plugin(pi as never);

		const event = {
			toolName: "bash",
			input: { command: "echo digital" },
		};
		const original = event.input.command;
		pi.fireToolCall(event);

		assert.strictEqual(event.input.command, original);
	});

	void it("does not modify non-bash tool calls", () => {
		const pi = createMockPi();
		plugin(pi as never);

		const event = {
			toolName: "read",
			input: { path: "foo.txt" },
		};
		const original = { ...event.input };
		pi.fireToolCall(event);

		assert.deepStrictEqual(event.input, original);
	});
});
