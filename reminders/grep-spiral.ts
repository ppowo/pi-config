/**
 * Remind the agent to stop broad search spirals and read a hit.
 *
 * Complements pi-hashline-readmap's doom-loop detector (which catches
 * identical repeated calls) by flagging consecutive *different* searches
 * across the code-search tools.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ToolResultEvent = {
	toolName?: string;
};

/** Code-search tools that can trigger a spiral when used consecutively
 *  without reading results. find/ls/nu are exploratory and don't count. */
const SEARCH_TOOLS = ["grep", "ast_search"];

export default function (pi: ExtensionAPI) {
	let consecutiveSearchCalls = 0;

	pi.on("tool_result", async (event: ToolResultEvent) => {
		consecutiveSearchCalls = SEARCH_TOOLS.includes(event.toolName ?? "")
			? consecutiveSearchCalls + 1
			: 0;
	});

	return {
		on: "tool_execution_end",
		when: () => consecutiveSearchCalls >= 3,
		message:
			"3 consecutive search calls. Stop casting wider nets—`read` the best result. Use `grep` for exact text/regex after you know the target; `ast_search` for syntax-aware patterns. Narrow with path/glob/lang filters.",
		cooldown: 10,
	};
}
