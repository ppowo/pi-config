import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Use the same bundled class/extension-loader identity as the shipped CLI.
// Importing the SDK does not launch pi or start terminal I/O.
const sdkUrl = new URL("./bundle/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createAgentSession, DefaultResourceLoader, InteractiveMode, FooterComponent, SettingsManager, SessionManager, initTheme } = await import(sdkUrl.href);
const temp = mkdtempSync(join(tmpdir(), "footer-veil-ui-"));
const cwd = join(temp, "project");
const agentDir = join(temp, "agent");
mkdirSync(cwd);
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({
	"app.model.cycleForward": [], "app.session.togglePath": [], "app.models.toggleProvider": [],
}));
globalThis.fetch = async () => { throw new Error("Network prohibited in footer veil regression"); };
// These are published widgets, not a simulation of provider activity gating.
const fixture = join(temp, "usage.ts");
writeFileSync(fixture, `export default function(pi) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget("hypercharm", ["HC_WIDGET"], { placement: "belowEditor" });
		ctx.ui.setWidget("zro", ["ZRO_WIDGET"], { placement: "belowEditor" });
		ctx.ui.setWidget("unrelated", ["KEEP_WIDGET"]);
		ctx.ui.setWidget("skill-guide", (_tui, theme) => ({
			render: () => [theme.fg("dim", "SKILL_GUIDE")], invalidate() {},
		}));
		ctx.ui.setStatus("hypercharm-session", "HC_STATUS");
		ctx.ui.setStatus("zro-session", "ZRO_STATUS");
		ctx.ui.setStatus("unrelated", "KEEP_STATUS");
	});
}`);
const veilPath = fileURLToPath(new URL("../../extensions/footer-veil.ts", import.meta.url));
const originals = { footer: FooterComponent.prototype.render, widget: InteractiveMode.prototype.renderWidgetContainer };
const model = {
	id: "MODEL_PRIVATE_" + "long-name-".repeat(8), name: "Fixture model", provider: "fixture-provider",
	api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1000,
};
const settingsManager = SettingsManager.inMemory({ packages: [], theme: "dark", compaction: { enabled: false } });
const paths = process.argv[2] === "provider-first" ? [fixture, veilPath] : [veilPath, fixture];
const resourceLoader = new DefaultResourceLoader({
	cwd, agentDir, settingsManager, additionalExtensionPaths: paths,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
const errors = [];
const notices = [];
let session, mode;
try {
	await resourceLoader.reload();
	const created = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, model, sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
	assert.deepEqual(created.extensionsResult.errors, []);
	session = created.session;
	initTheme("dark");
	mode = new InteractiveMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {} });
	// Suppress terminal scheduling only; retain real containers, factories and rendering.
	mode.renderer.requestRender = () => {};
	mode.showExtensionNotify = (message) => notices.push(message);
	mode.showError = (message) => errors.push(message);
	mode.renderWidgets(); // init builds widget containers before session_start.
	await session.bindExtensions({ uiContext: mode.createExtensionUIContext(), mode: "tui", onError: e => errors.push(e.message) });
	mode.setupExtensionShortcuts(session.extensionRunner);
	const lines = () => [...mode.widgetContainerAbove.render(140), ...mode.widgetContainerBelow.render(140), ...mode.footer.render(140)].join("\n");
	const assertVisibility = (shown, stage, guideVisible = true) => {
		const text = lines();
		// Provider rows represent data already published after provider activity.
		for (const marker of ["HC_WIDGET", "ZRO_WIDGET", "HC_STATUS", "ZRO_STATUS", "KEEP_WIDGET", "KEEP_STATUS"]) {
			assert.equal(text.includes(marker), shown, `${stage}: ${marker} shown=${shown}; notices=${JSON.stringify(notices)}; errors=${JSON.stringify(errors)}`);
		}
		assert.equal(text.includes("SKILL_GUIDE"), guideVisible, `${stage}: skill guide is independent of the veil`);
		assert.equal(mode.extensionWidgetsBelow.size, 2 + Number(mode.extensionWidgetsBelow.has("skill-guide")), `${stage}: provider widgets retained`);
		for (const width of [35, 60, 140]) {
			const stats = mode.footer.render(width)[1];
			assert.equal(stats.includes("MODEL_PRIVATE"), shown, `${stage}: model visibility at width ${width}`);
			assert.ok(stats.includes("/1.0M"), `${stage}: built-in context stats retained`);
		}
	};
	const press = async (key = "\x10") => {
		mode.defaultEditor.handleInput(key);
		await new Promise(resolve => setImmediate(resolve));
	};
	assertVisibility(false, "startup hidden");
	await press(); assertVisibility(true, "Ctrl+P reveals without a provider update");
	await press(); assertVisibility(false, "Ctrl+P hides without a provider update");
	mode.setExtensionWidget("hypercharm", ["HC_WIDGET_UPDATED"], { placement: "belowEditor" });
	assertVisibility(false, "provider update remains hidden");
	await press("\x1b[112;5u"); assertVisibility(true, "Kitty Ctrl+P reveals latest widget");
	assert.ok(lines().includes("HC_WIDGET_UPDATED"));
	mode.resetExtensionUI();
	await session.reload(); // real shutdown, module reload, session_start, resources_discover
	mode.setupExtensionShortcuts(session.extensionRunner);
	assertVisibility(false, "reload hidden");
	await press(); assertVisibility(true, "Ctrl+P after reload reveals");
	await press(); assertVisibility(false, "Ctrl+P after reload hides");
	mode.setExtensionWidget("skill-guide", ["SKILL_GUIDE_UPDATED"], { placement: "belowEditor" });
	assertVisibility(false, "skill guide stays visible below the editor");
	await press(); assertVisibility(true, "Ctrl+P keeps the relocated guide");
	mode.setExtensionWidget("skill-guide", undefined);
	assertVisibility(true, "skill guide can hide itself", false);
	await press(); assertVisibility(false, "Ctrl+P does not resurrect a hidden guide", false);
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
	assert.equal(FooterComponent.prototype.render, originals.footer);
	assert.equal(InteractiveMode.prototype.renderWidgetContainer, originals.widget);
	assert.deepEqual(errors, []);
	console.log(`PASS ${process.argv[2]}: startup, toggles, provider update, Kitty key, reload, restoration`);
} finally {
	mode?.footerDataProvider.dispose();
	session?.dispose();
	rmSync(temp, { recursive: true, force: true });
}
