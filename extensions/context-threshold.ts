import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-threshold";
const THRESHOLD_PERCENT = 40;

function render(percent: number): string | undefined {
	if (percent <= THRESHOLD_PERCENT) return undefined;
	return `context > ${THRESHOLD_PERCENT}%`;
}

function update(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const usage = ctx.getContextUsage();
	const percent = usage?.percent;

	ctx.ui.setStatus(
		STATUS_KEY,
		typeof percent === "number" ? render(percent) : undefined,
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("turn_end", (_event, ctx) => update(ctx));
	pi.on("agent_end", (_event, ctx) => update(ctx));
	pi.on("session_compact", (_event, ctx) => update(ctx));
}
