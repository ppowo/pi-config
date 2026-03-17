import net from "node:net";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const firefox = require("selenium-webdriver/firefox");

const packageJsonPath = require.resolve("@padenot/firefox-devtools-mcp/package.json");
const packageJson = require(packageJsonPath);
const mainEntry = typeof packageJson.main === "string" && packageJson.main.trim().length > 0 ? packageJson.main.trim() : "dist/index.js";
const upstreamEntryPath = resolve(dirname(packageJsonPath), mainEntry);

const attachHost = process.env.FIREFOX_MCP_ATTACH_HOST?.trim() || "127.0.0.1";
const attachPortRaw = process.env.FIREFOX_MCP_ATTACH_PORT?.trim() || "2828";
if (!/^\d+$/.test(attachPortRaw)) {
	console.error(`[firefox-devtools-mcp] FIREFOX_MCP_ATTACH_PORT must be a number. Received: ${attachPortRaw}`);
	process.exit(1);
}
const attachPort = Number(attachPortRaw);

function sanitizeServerArgv(argv) {
	const sanitized = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (index < 2) {
			sanitized.push(arg);
			continue;
		}

		if (arg === "--headless") {
			const next = argv[index + 1];
			if (next === "true" || next === "false") {
				index += 1;
			}
			continue;
		}
		if (arg.startsWith("--headless=")) {
			continue;
		}

		if (arg === "--start-url") {
			index += 1;
			continue;
		}
		if (arg.startsWith("--start-url=")) {
			continue;
		}

		sanitized.push(arg);
	}

	return sanitized;
}

async function assertAttachable(host, port) {
	await new Promise((resolvePromise, rejectPromise) => {
		const socket = net.createConnection({ host, port });
		const finish = (error) => {
			socket.removeAllListeners();
			socket.destroy();
			if (error) {
				rejectPromise(error);
			} else {
				resolvePromise();
			}
		};

		socket.setTimeout(1500);
		socket.once("connect", () => finish());
		socket.once("timeout", () => finish(new Error(`Timed out connecting to Marionette on ${host}:${port}`)));
		socket.once("error", (error) => finish(error));
	});
}

const OriginalServiceBuilder = firefox.ServiceBuilder;
class AttachOnlyServiceBuilder extends OriginalServiceBuilder {
	constructor(...args) {
		super(...args);
		this.addArguments("--connect-existing", "--marionette-port", String(attachPort));
		if (attachHost) {
			this.addArguments("--marionette-host", attachHost);
		}
	}
}

firefox.ServiceBuilder = AttachOnlyServiceBuilder;
process.env.FIREFOX_HEADLESS = "false";
process.env.START_URL = "";
process.argv = sanitizeServerArgv(process.argv);
process.argv[1] = upstreamEntryPath;

try {
	await assertAttachable(attachHost, attachPort);
	await import(pathToFileURL(upstreamEntryPath).href);
} catch (error) {
	const detail = error instanceof Error ? error.message : String(error);
	console.error(
		`[firefox-devtools-mcp] Attach-only mode requires an existing Firefox with Marionette listening on ${attachHost}:${attachPort}. Start Firefox with --marionette and try again. ${detail}`,
	);
	process.exit(1);
}
