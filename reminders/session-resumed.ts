/**
 * Remind the agent when a session is resumed, as application state may have changed.
 * Mirrors Claude Code's system-reminder-session-continuation.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
type SessionStartEvent = {
	reason?: string;
};

type ReminderArgs = {
	event: SessionStartEvent;
};

export default function (_pi: ExtensionAPI) {
	return {
		on: "session_start",
		when: ({ event }: ReminderArgs) => event.reason === "resume",
		message: "This session is being resumed. Application state may have changed since last time. Re-read relevant files before making assumptions about current state.",
	};
}