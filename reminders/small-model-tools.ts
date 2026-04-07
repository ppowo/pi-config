/**
 * Reinforce tool-routing when switching into a smaller model.
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
		when: ({ event }: ReminderArgs) => {
			if (!isSmallModel(event.model.id)) {
				return false;
			}

			return !event.previousModel || !isSmallModel(event.previousModel.id);
		},
		message: ({ event }: ReminderArgs) => {
			const next = `${event.model.provider}/${event.model.id}`;
			return `Switched to smaller model ${next}. Verify with tools, prefer codespelunker/grep/nu/read for discovery, keep reads bounded, and reserve bash for execution.`;
		},
	};
}
