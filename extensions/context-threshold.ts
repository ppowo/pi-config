import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-threshold";
export const ORANGE_THRESHOLD = 40;
export const RED_THRESHOLD = 60;
// Smart-zone ceiling: past this many estimated tokens, attention degrades
// regardless of the advertised context window. Tweak per model if needed.
export const DUMB_ZONE_TOKENS = 100_000;

export function render(
	percent: number,
	dumbZone: boolean,
	fg: (color: ThemeColor, text: string) => string,
): string {
	if (dumbZone) {
		const label = fg("accent", "dumb");
		const pctText = `${percent.toFixed(2)}%`;
		if (percent > RED_THRESHOLD) return `${label} ${fg("error", pctText)}`;
		if (percent > ORANGE_THRESHOLD) return `${label} ${fg("warning", pctText)}`;
		return `${label} ${fg("text", pctText)}`;
	}

	const text = `cntx ${percent.toFixed(2)}%`;
	if (percent > RED_THRESHOLD) return fg("error", text);
	if (percent > ORANGE_THRESHOLD) return fg("warning", text);
	return fg("text", text);
}

function update(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const usage = ctx.getContextUsage();
	const percent = usage?.percent;
	const tokens = usage?.tokens;
	const dumbZone = typeof tokens === "number" && tokens > DUMB_ZONE_TOKENS;

	ctx.ui.setStatus(
		STATUS_KEY,
		typeof percent === "number"
			? render(percent, dumbZone, (c, t) => ctx.ui.theme.fg(c, t))
			: undefined,
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("turn_end", (_event, ctx) => update(ctx));
	pi.on("agent_end", (_event, ctx) => update(ctx));
	pi.on("session_compact", (_event, ctx) => update(ctx));
}
