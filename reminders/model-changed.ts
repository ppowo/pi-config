/**
 * Notify the agent when the model changes mid-session.
 * Mirrors Claude Code's model awareness behavior.
 *
 * Rapid model switching can emit several `model_select` events in a row.
 * We coalesce those into one reminder and deliver it on the next turn.
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

const smallModelMarkers = ["mini", "nano"];

function isSmallModel(modelId: string) {
	const lower = modelId.toLowerCase();
	return smallModelMarkers.some((marker) => lower.includes(marker));
}

function toModelName(model: ModelRef) {
	return `${model.provider}/${model.id}`;
}

export default function (pi: ExtensionAPI) {
	let pendingChange: ModelSelectEvent | null = null;

	pi.on("model_select", async (event: ModelSelectEvent) => {
		if (!event.previousModel) return;

		const sameModel =
			event.previousModel.provider === event.model.provider &&
			event.previousModel.id === event.model.id;
		if (sameModel) return;

		// Keep only the latest switch in a rapid burst.
		pendingChange = event;
	});

	return {
		on: "turn_start",
		when: () => pendingChange != null,
		message: () => {
			const event = pendingChange;
			pendingChange = null;

			if (!event?.previousModel) {
				return "Model changed. Capabilities may differ — adjust your approach if needed.";
			}

			const next = toModelName(event.model);
			const prev = toModelName(event.previousModel);

			if (isSmallModel(event.model.id) && !isSmallModel(event.previousModel.id)) {
				return `Model changed from ${prev} to ${next}. Smaller model selected — verify with tools, keep reads bounded, and use bash mainly for execution.`;
			}

			return `Model changed from ${prev} to ${next}. Capabilities may differ — adjust your approach if needed.`;
		},
	};
}
