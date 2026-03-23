/**
 * Notify the agent when the model changes mid-session.
 * Mirrors Claude Code's model awareness behavior.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ModelRef = {
	provider: string;
	id: string;
};

type ModelSelectEvent = {
	previousModel?: ModelRef | null;
	model: ModelRef;
};

type ReminderArgs = {
	event: ModelSelectEvent;
};

export default function (_pi: ExtensionAPI) {
	return {
		on: "model_select",
		when: ({ event }: ReminderArgs) => event.previousModel != null,
		message: ({ event }: ReminderArgs) => {
			const next = `${event.model.provider}/${event.model.id}`;
			if (!event.previousModel) {
				return `Model changed to ${next}. Capabilities may differ — adjust your approach if needed.`;
			}

			const prev = `${event.previousModel.provider}/${event.previousModel.id}`;
			return `Model changed from ${prev} to ${next}. Capabilities may differ — adjust your approach if needed.`;
		},
	};
}
