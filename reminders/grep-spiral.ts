/**
 * Remind the agent to stop broad grep loops and inspect a good hit.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ToolResultEvent = {
	toolName?: string;
};

export default function (pi: ExtensionAPI) {
	let consecutiveGrepCalls = 0;

	pi.on("tool_result", async (event: ToolResultEvent) => {
		consecutiveGrepCalls = event.toolName === "grep" ? consecutiveGrepCalls + 1 : 0;
	});

	return {
		on: "tool_execution_end",
		when: () => consecutiveGrepCalls >= 3,
		message:
			"3 consecutive grep calls. Stop broad searching, pick the best hit, and `read` it. Use `grep` for exact text only; otherwise switch to `codespelunker` or `ast_search`.",
		cooldown: 10,
	};
}
