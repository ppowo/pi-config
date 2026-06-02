/**
 * Git Editor Guard
 *
 * Prevents git from spawning an interactive editor (vim, nvim, etc.) that
 * would hang the agent's bash process. Sets GIT_EDITOR, GIT_SEQUENCE_EDITOR
 * to `true` (no-op) and GIT_MERGE_AUTOEDIT to `no`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const GIT_ENV_PREFIX =
	"export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";

const invokesGit = (command: string) =>
	/(^|[\s;|&])git(?:\s|$)/i.test(command);

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!invokesGit(event.input.command)) return;

		event.input.command = GIT_ENV_PREFIX + event.input.command;
	});
}
