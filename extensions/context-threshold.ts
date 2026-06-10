import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-threshold";
const ORANGE_THRESHOLD = 40;
const RED_THRESHOLD = 60;

function render(percent: number, fg: (color: ThemeColor, text: string) => string): string {
	const text = `cntx ${percent.toFixed(2)}%`;
	if (percent > RED_THRESHOLD) return fg("error", text);
	if (percent > ORANGE_THRESHOLD) return fg("warning", text);
	return fg("text", text);
}

function update(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const usage = ctx.getContextUsage();
	const percent = usage?.percent;

	ctx.ui.setStatus(
		STATUS_KEY,
		typeof percent === "number" ? render(percent, (c, t) => ctx.ui.theme.fg(c, t)) : undefined,
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("turn_end", (_event, ctx) => update(ctx));
	pi.on("agent_end", (_event, ctx) => update(ctx));
	pi.on("session_compact", (_event, ctx) => update(ctx));
}