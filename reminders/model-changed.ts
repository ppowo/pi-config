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

const smallModelMarkers = ["mini", "nano"];

function isSmallModel(modelId: string) {
	const lower = modelId.toLowerCase();
	return smallModelMarkers.some((marker) => lower.includes(marker));
}

export default function (_pi: ExtensionAPI) {
	return {
		on: "model_select",
		when: ({ event }: ReminderArgs) => event.previousModel != null,
		message: ({ event }: ReminderArgs) => {
			const next = `${event.model.provider}/${event.model.id}`;
			const prev = event.previousModel
				? `${event.previousModel.provider}/${event.previousModel.id}`
				: "unknown";

			if (isSmallModel(event.model.id) && !isSmallModel(event.previousModel?.id ?? "")) {
				return `Model changed from ${prev} to ${next}. Smaller model selected — verify with tools, keep reads bounded, and use bash mainly for execution.`;
			}
			if (!event.previousModel) {
				return `Model changed to ${next}. Capabilities may differ — adjust your approach if needed.`;
			}
			return `Model changed from ${prev} to ${next}. Capabilities may differ — adjust your approach if needed.`;
		},
	};
}
