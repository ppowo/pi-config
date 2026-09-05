import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	FooterComponent,
	InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const TOGGLE_MODEL_INFO_SHORTCUT = "ctrl+p";
const DUMB_ZONE_TOKEN_THRESHOLD = 128_000;
const DUMB_ZONE_LABEL = "dumb";
const REFRESH_WIDGET_KEY = "footer-veil";
const OPENAI_PRESENTATION_COMMAND = "openai-usage-presentation";

// Hidden mode keeps built-in footer stats and explicitly allowlisted widgets.
// Providers remain hidden by default; their source maps are never modified.
const NO_EXTENSION_STATUSES: ReadonlyMap<string, string> = new Map();
const ALWAYS_VISIBLE_WIDGETS: ReadonlySet<string> = new Set(["skill-guide"]);

// These private Pi surfaces have no public visibility hook. Keep their shape
// assumptions here, and cover them through the bundled-UI integration test.
interface VeilableFooterData {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

interface FooterDataHost {
	footerData?: VeilableFooterData | null;
}

function asFooterData(host: unknown): VeilableFooterData | undefined {
	if (typeof host !== "object" || host === null) return undefined;
	const data = (host as FooterDataHost).footerData;
	if (typeof data !== "object" || data === null) return undefined;
	if (typeof data.getExtensionStatuses !== "function") return undefined;
	return data;
}

export function withVeiledExtensionStatuses<T>(
	host: unknown,
	hidden: boolean,
	run: () => T,
	onShapeWarning?: () => void,
): T {
	const footerData = asFooterData(host);
	if (!hidden || !footerData) {
		if (hidden) onShapeWarning?.();
		return run();
	}
	const original = footerData.getExtensionStatuses;
	footerData.getExtensionStatuses = () => NO_EXTENSION_STATUSES;
	try {
		return run();
	} finally {
		footerData.getExtensionStatuses = original;
	}
}

interface WidgetContainer {
	clear(): void;
	addChild(child: unknown): void;
}

type RenderWidgetContainerFn = (
	this: InteractiveMode,
	container: WidgetContainer,
	widgets: ReadonlyMap<string, unknown>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
) => void;

interface FooterSessionHost {
	session?: Pick<AgentSession, "getContextUsage">;
}

export function formatFooterTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function shouldShowDumbZone(
	usage: { tokens: number | null } | undefined,
	threshold = DUMB_ZONE_TOKEN_THRESHOLD,
): boolean {
	return typeof usage?.tokens === "number" && usage.tokens > threshold;
}

export function injectDumbZoneIntoFooterLine(
	line: string,
	contextWindow: number | undefined,
	label: string,
	width: number,
): string {
	if (!contextWindow || width <= 0) return line;

	const contextWindowMarker = `/${formatFooterTokenCount(contextWindow)}`;
	const markerStart = line.indexOf(contextWindowMarker);
	if (markerStart === -1) return line;
	const insertAt = markerStart + contextWindowMarker.length;

	const insertText = ` ${label}`;
	const suffix = line.slice(insertAt);
	const removableSpaces = suffix.match(/^ */)?.[0].length ?? 0;
	// Consume padding, but retain the separator before an adjacent (auto) tag.
	const spacesToRemove = Math.min(Math.max(0, removableSpaces - 1), visibleWidth(insertText));

	return truncateToWidth(`${line.slice(0, insertAt)}${insertText}${suffix.slice(spacesToRemove)}`, width, "");
}

export function stripModelInfoFromFooterLine(line: string): string {
	// Pi joins stats with single spaces, then pads the model with at least two.
	// Cut at that boundary, not at a model name that Pi may have truncated.
	const paddingStart = line.search(/ {2,}/);
	return paddingStart < 0 ? line : truncateToWidth(line, visibleWidth(line.slice(0, paddingStart)), "");
}

const WARNING_MESSAGES = {
	footer: "Footer veil: unexpected footer shape; usage statuses left visible.",
	widget: "Footer veil: unexpected widget surface; usage widgets left visible.",
	openai: "Footer veil: OpenAI presentation unavailable; load Better OpenAI with /openai-usage-presentation support.",
};
type VeilWarningKind = keyof typeof WARNING_MESSAGES;

interface VeilSessionBindings {
	formatDumbZoneLabel(): string;
	reportWarning(message: string): void;
}

function defaultSessionBindings(): VeilSessionBindings {
	return { formatDumbZoneLabel: () => DUMB_ZONE_LABEL, reportWarning: () => {} };
}

// Own patches and current UI bindings together. Pi emits session_shutdown
// before replacing extension modules; no render-host tracking is needed.
const veil = {
	shown: false,
	session: defaultSessionBindings(),
	warnings: new Set<VeilWarningKind>(),
	originalFooterRender: undefined as FooterComponent["render"] | undefined,
	originalRenderWidgetContainer: undefined as RenderWidgetContainerFn | undefined,

	beginSession(bindings: VeilSessionBindings): void {
		this.shown = false;
		this.warnings.clear();
		this.session = bindings;
	},

	warn(kind: VeilWarningKind): void {
		if (this.warnings.has(kind)) return;
		this.warnings.add(kind);
		this.session.reportWarning(WARNING_MESSAGES[kind]);
	},

	install(): void {
		if (!this.originalFooterRender) {
			const original = FooterComponent.prototype.render;
			FooterComponent.prototype.render = function renderWithFooterVeil(width: number): string[] {
				const lines = withVeiledExtensionStatuses(
					this,
					!veil.shown,
					() => original.call(this, width),
					() => veil.warn("footer"),
				);
				if (lines.length < 2) return lines;

				let footerLine = veil.shown ? lines[1] : stripModelInfoFromFooterLine(lines[1]);
				const session = (this as unknown as FooterSessionHost).session;
				const usage = session?.getContextUsage();
				if (shouldShowDumbZone(usage)) {
					footerLine = injectDumbZoneIntoFooterLine(
						footerLine,
						usage?.contextWindow,
						veil.session.formatDumbZoneLabel(),
						width,
					);
				}

				const nextLines = [...lines];
				nextLines[1] = footerLine;
				return nextLines;
			};
			this.originalFooterRender = original;
		}

		if (!this.originalRenderWidgetContainer) {
			const proto = InteractiveMode.prototype as unknown as {
				renderWidgetContainer?: RenderWidgetContainerFn;
			};
			if (typeof proto.renderWidgetContainer !== "function") {
				this.warn("widget");
			} else {
				const original = proto.renderWidgetContainer;
				proto.renderWidgetContainer = function renderWidgetContainerWithFooterVeil(
					this: InteractiveMode,
					container: WidgetContainer,
					widgets: ReadonlyMap<string, unknown>,
					spacerWhenEmpty: boolean,
					leadingSpacer: boolean,
				): void {
					const visible = veil.shown
						? widgets
						: new Map([...widgets].filter(([key]) => ALWAYS_VISIBLE_WIDGETS.has(key)));
					original.call(this, container, visible, spacerWhenEmpty, leadingSpacer);
				};
				this.originalRenderWidgetContainer = original;
			}
		}
	},

	uninstall(): void {
		if (this.originalFooterRender) FooterComponent.prototype.render = this.originalFooterRender;
		this.originalFooterRender = undefined;
		if (this.originalRenderWidgetContainer) {
			(InteractiveMode.prototype as unknown as { renderWidgetContainer: RenderWidgetContainerFn })
				.renderWidgetContainer = this.originalRenderWidgetContainer;
		}
		this.originalRenderWidgetContainer = undefined;
		this.session = defaultSessionBindings();
	},

	refresh(ctx: ExtensionContext): void {
		if (!this.originalRenderWidgetContainer || !ctx.hasUI) return;
		// Removing our unused widget through the public UI API rebuilds both
		// containers, including widgets populated before the patch ran.
		// A paint request alone leaves cached children unchanged.
		ctx.ui.setWidget(REFRESH_WIDGET_KEY, undefined);
	},
};

/** Restore prototypes and clear session bindings between isolated unit tests. */
export function resetFooterVeilForTests(): void {
	veil.uninstall();
	veil.beginSession(defaultSessionBindings());
}

export default function footerVeilExtension(pi: ExtensionAPI): void {
	function synchronizeOpenAI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const available = pi.getCommands().some(
			(command) => command.source === "extension" && command.name === OPENAI_PRESENTATION_COMMAND,
		);
		if (!available) {
			veil.warn("openai");
			return;
		}
		// Pi dispatches recognized extension commands before prompting, even while streaming.
		pi.sendUserMessage(`/${OPENAI_PRESENTATION_COMMAND} ${veil.shown ? "show" : "hide"}`, {
			expandPromptTemplates: true,
		});
	}

	pi.registerShortcut(TOGGLE_MODEL_INFO_SHORTCUT, {
		description: "Toggle footer details (skill guide stays visible)",
		handler: async (ctx) => {
			veil.shown = !veil.shown;
			veil.refresh(ctx);
			if (ctx.hasUI) {
				synchronizeOpenAI(ctx);
				ctx.ui.notify(`Model info and usage ${veil.shown ? "shown" : "hidden"}.`, "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		veil.beginSession({
			formatDumbZoneLabel: () => ctx.ui.theme.fg("warning", DUMB_ZONE_LABEL),
			reportWarning: (message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			},
		});
		veil.install();
		veil.refresh(ctx);
	});

	pi.on("resources_discover", (_event, ctx) => {
		// Runs after all session_start handlers, including Better OpenAI's visibility reset.
		synchronizeOpenAI(ctx);
	});

	pi.on("session_shutdown", async () => {
		veil.uninstall();
	});
}
