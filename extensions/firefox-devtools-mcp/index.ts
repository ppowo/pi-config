import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "@sinclair/typebox";
import { accessSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

const EXTENSION_NAME = "firefox-devtools-mcp";
const DEFAULT_TOOL_PREFIX = "ffx";
const DEFAULT_TOOL_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOTAL_TIMEOUT_MS = 900_000;
const DEFAULT_SERVER_NAME = "@padenot/firefox-devtools-mcp";

const FIREFOX_PATH_BINARY_CANDIDATES = [
	"firefox-developer-edition",
	"firefox-developer",
	"firefox",
] as const;

const LINUX_FIREFOX_ABSOLUTE_CANDIDATES = [
	"/usr/bin/firefox-developer-edition",
	"/usr/local/bin/firefox-developer-edition",
	"/opt/firefox/firefox",
	"/usr/bin/firefox",
	"/usr/local/bin/firefox",
	"/snap/bin/firefox",
] as const;

const MACOS_FIREFOX_ABSOLUTE_CANDIDATES = [
	"/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
	"/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
	"/Applications/Firefox.app/Contents/MacOS/firefox",
] as const;

const WINDOWS_FIREFOX_DIR_CANDIDATES = [
	"Firefox Developer Edition",
	"Nightly",
	"Mozilla Firefox",
] as const;

const forwardedToolParameters = Type.Object(
	{},
	{
		description:
			"Arguments forwarded directly to the MCP tool. Pass key/value pairs exactly as required by the tool schema.",
		additionalProperties: true,
	},
);

type LaunchConfig = {
	mode: "resolved" | "override";
	command: string;
	args: string[];
	cwd: string;
	nodePath?: string;
	entryPath?: string;
};

type McpToolInfo = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

type BridgeToolMeta = {
	mcpName: string;
	piName: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

type FormattedResult = {
	text: string;
	truncated: boolean;
	isError: boolean;
};

type BridgeState = {
	client?: Client;
	transport?: StdioClientTransport;
	connected: boolean;
	connectPromise?: Promise<void>;
	connectionId: number;
	launchConfig?: LaunchConfig;
	lastConnectedAt?: number;
	lastError?: string;
	toolsByPiName: Map<string, BridgeToolMeta>;
	piNameByMcpName: Map<string, string>;
	registeredPiToolNames: Set<string>;
	availablePiToolNames: Set<string>;
};

const state: BridgeState = {
	connected: false,
	connectionId: 0,
	toolsByPiName: new Map<string, BridgeToolMeta>(),
	piNameByMcpName: new Map<string, string>(),
	registeredPiToolNames: new Set<string>(),
	availablePiToolNames: new Set<string>(),
};

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function setLastError(error: unknown) {
	state.lastError = errorMessage(error);
}

function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info") {
	if (!ctx?.hasUI) {
		return;
	}
	ctx.ui.notify(message, type);
}

function ensureReadable(path: string, label: string) {
	try {
		accessSync(path);
	} catch {
		throw new Error(`${label} is not readable: ${path}`);
	}
}

function readPackageJson(path: string): Record<string, unknown> {
	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`Invalid package.json at ${path}`);
	}
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
	if (!value?.trim()) return fallback;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function decodeQuotedToken(token: string): string {
	if (token.startsWith('"') && token.endsWith('"')) {
		try {
			return JSON.parse(token) as string;
		} catch {
			return token.slice(1, -1);
		}
	}
	if (token.startsWith("'") && token.endsWith("'")) {
		return token.slice(1, -1);
	}
	return token;
}

function parseArgList(raw: string | undefined): string[] | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error("FIREFOX_MCP_ARGS/FIREFOX_MCP_EXTRA_ARGS JSON array is invalid");
		}
		if (!Array.isArray(parsed)) {
			throw new Error("FIREFOX_MCP_ARGS/FIREFOX_MCP_EXTRA_ARGS must be a JSON string array");
		}
		return parsed.map((value) => String(value));
	}

	const tokens = trimmed.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g);
	if (!tokens) {
		return [];
	}
	return tokens.map(decodeQuotedToken);
}

function sanitizeSegment(value: string | undefined, fallback: string): string {
	const normalized = (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");

	const candidate = normalized.length > 0 ? normalized : fallback;
	if (/^[0-9]/.test(candidate)) {
		return `_${candidate}`;
	}
	return candidate;
}

function toolPrefix(): string {
	return sanitizeSegment(process.env.FIREFOX_MCP_TOOL_PREFIX, DEFAULT_TOOL_PREFIX);
}

function resolveServerEntryFromPackage(): string {
	let packageJsonPath = "";
	try {
		packageJsonPath = require.resolve(`${DEFAULT_SERVER_NAME}/package.json`);
	} catch {
		throw new Error(
			`Cannot resolve ${DEFAULT_SERVER_NAME}. Run \`node bootstrap.mjs\` (or \`npm install\` in extensions/firefox-devtools-mcp) to install the local extension dependencies.`,
		);
	}

	const packageJson = readPackageJson(packageJsonPath);
	const main = typeof packageJson.main === "string" && packageJson.main.trim().length > 0 ? packageJson.main.trim() : "dist/index.js";
	const entryPath = resolve(dirname(packageJsonPath), main);
	ensureReadable(entryPath, `${DEFAULT_SERVER_NAME} entry`);
	return entryPath;
}

function pushUnique(list: string[], value: string | undefined) {
	const trimmed = value?.trim();
	if (!trimmed) {
		return;
	}
	if (!list.includes(trimmed)) {
		list.push(trimmed);
	}
}

function platformAbsoluteFirefoxCandidates(): string[] {
	const candidates: string[] = [];

	if (process.platform === "darwin") {
		for (const path of MACOS_FIREFOX_ABSOLUTE_CANDIDATES) {
			pushUnique(candidates, path);
		}

		const home = process.env.HOME?.trim();
		if (home) {
			pushUnique(candidates, join(home, "Applications", "Firefox Developer Edition.app", "Contents", "MacOS", "firefox"));
			pushUnique(candidates, join(home, "Applications", "Firefox Nightly.app", "Contents", "MacOS", "firefox"));
			pushUnique(candidates, join(home, "Applications", "Firefox.app", "Contents", "MacOS", "firefox"));
		}
		return candidates;
	}

	if (process.platform === "win32") {
		const roots = [
			process.env["PROGRAMFILES"],
			process.env["PROGRAMFILES(X86)"],
			process.env.LOCALAPPDATA,
		].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

		for (const root of roots) {
			for (const folder of WINDOWS_FIREFOX_DIR_CANDIDATES) {
				pushUnique(candidates, join(root, folder, "firefox.exe"));
			}

			// Some installations live under vendor subdirectories.
			pushUnique(candidates, join(root, "Mozilla Firefox", "firefox.exe"));
			pushUnique(candidates, join(root, "Mozilla", "Firefox Developer Edition", "firefox.exe"));
		}

		return candidates;
	}

	for (const path of LINUX_FIREFOX_ABSOLUTE_CANDIDATES) {
		pushUnique(candidates, path);
	}
	return candidates;
}

function firefoxPathCandidatesFromPath(): string[] {
	const candidates: string[] = [];
	const pathValue = process.env.PATH ?? "";
	if (!pathValue.trim()) {
		return candidates;
	}

	const dirs = pathValue.split(delimiter).map((value) => value.trim()).filter((value) => value.length > 0);
	const isWindows = process.platform === "win32";

	for (const dir of dirs) {
		for (const binary of FIREFOX_PATH_BINARY_CANDIDATES) {
			if (isWindows) {
				pushUnique(candidates, join(dir, `${binary}.exe`));
				pushUnique(candidates, join(dir, binary));
			} else {
				pushUnique(candidates, join(dir, binary));
			}
		}
	}

	return candidates;
}

function resolveFirefoxPath(): string | undefined {
	const envPath = process.env.FIREFOX_PATH?.trim();
	if (envPath) {
		return envPath;
	}

	const candidates = [
		...platformAbsoluteFirefoxCandidates(),
		...firefoxPathCandidatesFromPath(),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

function buildDefaultServerArgs(): string[] {
	const args: string[] = [];

	if (parseBoolean(process.env.FIREFOX_MCP_HEADLESS, true)) {
		args.push("--headless");
	}

	const firefoxPath = resolveFirefoxPath();
	if (firefoxPath) {
		args.push("--firefox-path", firefoxPath);
	}

	const startUrl = process.env.FIREFOX_MCP_START_URL?.trim();
	if (startUrl) {
		args.push("--start-url", startUrl);
	}

	const extraArgs = parseArgList(process.env.FIREFOX_MCP_EXTRA_ARGS);
	if (extraArgs?.length) {
		args.push(...extraArgs);
	}

	return args;
}

function buildLaunchConfig(cwd: string): LaunchConfig {
	const overrideCommand = process.env.FIREFOX_MCP_COMMAND?.trim();
	const launchCwd = process.env.FIREFOX_MCP_CWD?.trim() || cwd;

	if (overrideCommand) {
		const overrideArgs = parseArgList(process.env.FIREFOX_MCP_ARGS) ?? [];
		return {
			mode: "override",
			command: overrideCommand,
			args: overrideArgs,
			cwd: launchCwd,
		};
	}

	const entryOverride = process.env.FIREFOX_MCP_ENTRY?.trim();
	const entryPath = entryOverride ? resolve(entryOverride) : resolveServerEntryFromPackage();
	ensureReadable(entryPath, "Firefox MCP entry");

	const argsOverride = parseArgList(process.env.FIREFOX_MCP_ARGS);
	const serverArgs = argsOverride ?? buildDefaultServerArgs();

	return {
		mode: "resolved",
		command: process.execPath,
		args: [entryPath, ...serverArgs],
		cwd: launchCwd,
		nodePath: process.execPath,
		entryPath,
	};
}

function toShellSnippet(command: string, args: string[]): string {
	const quote = (value: string) => {
		if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
			return value;
		}
		return JSON.stringify(value);
	};
	return [quote(command), ...args.map(quote)].join(" ");
}

function coerceToolArgs(params: unknown): Record<string, unknown> {
	if (!isRecord(params)) {
		return {};
	}
	try {
		return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
	} catch {
		return { ...params };
	}
}

function compactJson(value: unknown, maxChars: number): string {
	let raw = "";
	try {
		raw = JSON.stringify(value);
	} catch {
		raw = String(value);
	}
	if (raw.length <= maxChars) {
		return raw;
	}
	return `${raw.slice(0, maxChars)}...`;
}

function describeInputSchema(schema: Record<string, unknown> | undefined): string {
	if (!schema) {
		return "Input schema unavailable. Pass an object with the arguments expected by the upstream MCP tool.";
	}

	const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
	const required = Array.isArray(schema.required) ? schema.required.map((value) => String(value)) : [];

	const propertySummary = properties.length > 0 ? `Known keys: ${properties.join(", ")}.` : "No explicit keys listed in schema.";
	const requiredSummary = required.length > 0 ? ` Required: ${required.join(", ")}.` : "";
	const schemaPreview = compactJson(schema, 900);
	return `${propertySummary}${requiredSummary} Schema: ${schemaPreview}`;
}

function buildBridgeToolDescription(meta: BridgeToolMeta): string {
	const description = meta.description?.trim() || `Forwarded MCP tool \"${meta.mcpName}\".`;
	return `${description}\n\nForwarded from ${DEFAULT_SERVER_NAME}. ${describeInputSchema(meta.inputSchema)}`;
}

function formatStructuredContent(value: unknown): string {
	if (value === undefined) {
		return "";
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function formatContentItem(item: Record<string, unknown>, index: number): string {
	const type = typeof item.type === "string" ? item.type : "unknown";

	if (type === "text") {
		const text = typeof item.text === "string" ? item.text : "";
		if (text.trim().length === 0) {
			return `[content ${index}] (empty text block)`;
		}
		return text;
	}

	if (type === "image") {
		const mimeType = typeof item.mimeType === "string" ? item.mimeType : "unknown";
		const dataLength = typeof item.data === "string" ? item.data.length : 0;
		return `[content ${index}] image (${mimeType}, base64 length ${dataLength})`;
	}

	if (type === "audio") {
		const mimeType = typeof item.mimeType === "string" ? item.mimeType : "unknown";
		const dataLength = typeof item.data === "string" ? item.data.length : 0;
		return `[content ${index}] audio (${mimeType}, base64 length ${dataLength})`;
	}

	if (type === "resource") {
		const resource = isRecord(item.resource) ? item.resource : undefined;
		if (resource) {
			const uri = typeof resource.uri === "string" ? resource.uri : "<unknown-uri>";
			if (typeof resource.text === "string") {
				return `[content ${index}] resource ${uri}\n${resource.text}`;
			}
			if (typeof resource.blob === "string") {
				return `[content ${index}] resource ${uri} (blob, base64 length ${resource.blob.length})`;
			}
			return `[content ${index}] resource ${uri}`;
		}
		return `[content ${index}] resource (unrecognized payload)`;
	}

	if (type === "resource_link") {
		const uri = typeof item.uri === "string" ? item.uri : "<unknown-uri>";
		const name = typeof item.name === "string" ? item.name : "resource";
		return `[content ${index}] resource link ${name}: ${uri}`;
	}

	return `[content ${index}] ${compactJson(item, 500)}`;
}

function formatToolResult(toolName: string, result: unknown): FormattedResult {
	const lines: string[] = [];
	const resultRecord = isRecord(result) ? result : undefined;
	const isError = resultRecord?.isError === true;

	if (isError) {
		lines.push(`MCP tool \"${toolName}\" reported an error.`);
	}

	const content = resultRecord?.content;
	if (Array.isArray(content) && content.length > 0) {
		for (let i = 0; i < content.length; i++) {
			const block = content[i];
			if (isRecord(block)) {
				lines.push(formatContentItem(block, i + 1));
			} else {
				lines.push(`[content ${i + 1}] ${String(block)}`);
			}
		}
	}

	if (resultRecord?.structuredContent !== undefined) {
		const structured = formatStructuredContent(resultRecord.structuredContent);
		lines.push(`Structured content:\n${structured}`);
	}

	if (resultRecord?.toolResult !== undefined) {
		const compatibilityPayload = formatStructuredContent(resultRecord.toolResult);
		lines.push(`toolResult:\n${compatibilityPayload}`);
	}

	if (lines.length === 0) {
		lines.push(formatStructuredContent(result));
	}

	const combined = lines.join("\n\n");
	const truncation = truncateHead(combined, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let text = truncation.content;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(
			truncation.outputBytes,
		)}/${formatSize(truncation.totalBytes)}]`;
	}

	return {
		text,
		truncated: truncation.truncated,
		isError,
	};
}

function isConnectionError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	return (
		message.includes("connection closed") ||
		message.includes("not connected") ||
		message.includes("econn") ||
		message.includes("broken pipe") ||
		message.includes("transport")
	);
}

async function closeClientAndTransport(client: Client | undefined, transport: StdioClientTransport | undefined) {
	if (client) {
		try {
			await client.close();
			return;
		} catch (error) {
			console.warn(`[${EXTENSION_NAME}] Failed to close client cleanly: ${errorMessage(error)}`);
		}
	}

	if (transport) {
		try {
			await transport.close();
		} catch (error) {
			console.warn(`[${EXTENSION_NAME}] Failed to close transport cleanly: ${errorMessage(error)}`);
		}
	}
}

async function listAllMcpTools(client: Client): Promise<McpToolInfo[]> {
	const tools: McpToolInfo[] = [];
	const seen = new Set<string>();

	let cursor: string | undefined;
	do {
		const response = await client.listTools(cursor ? { cursor } : undefined);
		const page = Array.isArray(response.tools) ? response.tools : [];
		for (const candidate of page) {
			if (!isRecord(candidate)) continue;
			const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
			if (!name || seen.has(name)) continue;
			seen.add(name);
			tools.push({
				name,
				description: typeof candidate.description === "string" ? candidate.description : undefined,
				inputSchema: isRecord(candidate.inputSchema) ? candidate.inputSchema : undefined,
			});
		}
		cursor = typeof response.nextCursor === "string" && response.nextCursor.length > 0 ? response.nextCursor : undefined;
	} while (cursor);

	return tools;
}

function getToolTimeoutMs(): number {
	return parseNumber(process.env.FIREFOX_MCP_TOOL_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS);
}

function getToolMaxTotalTimeoutMs(): number {
	return parseNumber(process.env.FIREFOX_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS, DEFAULT_MAX_TOTAL_TIMEOUT_MS);
}

function getOrCreatePiToolName(mcpName: string): string {
	const existing = state.piNameByMcpName.get(mcpName);
	if (existing) {
		return existing;
	}

	const prefix = toolPrefix();
	const safeName = sanitizeSegment(mcpName, "tool");
	const baseName = `${prefix}_${safeName}`;

	let candidate = baseName;
	let suffix = 2;
	while (state.registeredPiToolNames.has(candidate) && state.piNameByMcpName.get(mcpName) !== candidate) {
		candidate = `${baseName}_${suffix}`;
		suffix += 1;
	}

	state.piNameByMcpName.set(mcpName, candidate);
	return candidate;
}

function statusSummary(): string {
	const status = state.connected ? "connected" : "disconnected";
	const launch = state.launchConfig;
	const lines = [
		`status: ${status}`,
		`known MCP tools: ${state.toolsByPiName.size}`,
		`registered pi tools: ${state.registeredPiToolNames.size}`,
		`available now: ${state.availablePiToolNames.size}`,
	];

	if (launch) {
		lines.push(`launch mode: ${launch.mode}`);
		lines.push(`command: ${launch.command}`);
		lines.push(`args: ${launch.args.join(" ")}`);
		lines.push(`cwd: ${launch.cwd}`);
		if (launch.nodePath) lines.push(`node path: ${launch.nodePath}`);
		if (launch.entryPath) lines.push(`entry path: ${launch.entryPath}`);
		lines.push(`shell: ${toShellSnippet(launch.command, launch.args)}`);
	}

	if (state.lastConnectedAt) {
		lines.push(`last connected: ${new Date(state.lastConnectedAt).toISOString()}`);
	}

	if (state.lastError) {
		lines.push(`last error: ${state.lastError}`);
	}

	return lines.join("\n");
}

function registerBridgeTool(pi: ExtensionAPI, meta: BridgeToolMeta) {
	if (state.registeredPiToolNames.has(meta.piName)) {
		return;
	}

	pi.registerTool({
		name: meta.piName,
		label: `Firefox ${meta.mcpName}`,
		description: buildBridgeToolDescription(meta),
		promptSnippet: `Forward call to Firefox MCP tool \"${meta.mcpName}\"`,
		promptGuidelines: [
			`Use this when you need Firefox browser automation from MCP tool \"${meta.mcpName}\".`,
			"Pass arguments as an object matching the tool schema from the description.",
		],
		parameters: forwardedToolParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureConnected(pi, ctx, false);

			const latestMeta = state.toolsByPiName.get(meta.piName);
			if (!latestMeta) {
				throw new Error(`No metadata for bridge tool ${meta.piName}. Run /ffx-reconnect.`);
			}

			if (!state.availablePiToolNames.has(meta.piName)) {
				throw new Error(
					`Tool ${meta.piName} (${latestMeta.mcpName}) is not currently advertised by the MCP server. Run /ffx-reconnect.`,
				);
			}

			const callArgs = coerceToolArgs(params);
			const timeout = getToolTimeoutMs();
			const maxTotalTimeout = getToolMaxTotalTimeoutMs();

			const call = async () => {
				if (!state.client) {
					throw new Error("Firefox MCP client is not connected.");
				}
				return state.client.callTool(
					{
						name: latestMeta.mcpName,
						arguments: callArgs,
					},
					undefined,
					{
						signal,
						timeout,
						maxTotalTimeout,
						resetTimeoutOnProgress: true,
					},
				);
			};

			let result: unknown;
			try {
				result = await call();
			} catch (firstError) {
				if (!isConnectionError(firstError)) {
					throw firstError;
				}

				await ensureConnected(pi, ctx, true);
				result = await call();
			}

			const formatted = formatToolResult(latestMeta.mcpName, result);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					piTool: meta.piName,
					mcpTool: latestMeta.mcpName,
					truncated: formatted.truncated,
					isError: formatted.isError,
				},
			};
		},
	});

	state.registeredPiToolNames.add(meta.piName);
}

async function syncTools(pi: ExtensionAPI, tools: McpToolInfo[]) {
	const availableNow = new Set<string>();

	for (const tool of tools) {
		const piName = getOrCreatePiToolName(tool.name);
		const meta: BridgeToolMeta = {
			mcpName: tool.name,
			piName,
			description: tool.description,
			inputSchema: tool.inputSchema,
		};

		state.toolsByPiName.set(piName, meta);
		availableNow.add(piName);
		registerBridgeTool(pi, meta);
	}

	state.availablePiToolNames = availableNow;
}

async function disconnect(reason?: string) {
	const client = state.client;
	const transport = state.transport;

	state.client = undefined;
	state.transport = undefined;
	state.connected = false;
	state.connectPromise = undefined;
	state.availablePiToolNames = new Set<string>();

	await closeClientAndTransport(client, transport);

	if (reason) {
		console.log(`[${EXTENSION_NAME}] disconnected (${reason})`);
	}
}

async function ensureConnected(pi: ExtensionAPI, ctx: ExtensionContext | undefined, forceReconnect: boolean): Promise<void> {
	if (forceReconnect) {
		await disconnect("forced reconnect");
	}

	if (state.connected && state.client && !forceReconnect) {
		return;
	}

	if (state.connectPromise) {
		await state.connectPromise;
		return;
	}

	const connectTask = (async () => {
		const launch = buildLaunchConfig(ctx?.cwd ?? process.cwd());
		state.launchConfig = launch;
		state.lastError = undefined;

		const env = Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);

		const transport = new StdioClientTransport({
			command: launch.command,
			args: launch.args,
			cwd: launch.cwd,
			env,
			stderr: "pipe",
		});

		const client = new Client({
			name: "pi-firefox-mcp-bridge",
			version: "0.1.0",
		});

		const connectionId = state.connectionId + 1;
		state.connectionId = connectionId;

		client.onerror = (error) => {
			if (state.connectionId !== connectionId) return;
			setLastError(error);
			console.error(`[${EXTENSION_NAME}] client error: ${errorMessage(error)}`);
		};

		client.onclose = () => {
			if (state.connectionId !== connectionId) return;
			state.connected = false;
			state.client = undefined;
			state.transport = undefined;
			state.availablePiToolNames = new Set<string>();
			console.warn(`[${EXTENSION_NAME}] connection closed`);
		};

		try {
			await client.connect(transport);
			const tools = await listAllMcpTools(client);

			state.client = client;
			state.transport = transport;
			state.connected = true;
			state.lastConnectedAt = Date.now();

			await syncTools(pi, tools);
			notify(
				ctx,
				`Firefox MCP connected (${tools.length} tools, prefix ${toolPrefix()}_).`,
				"info",
			);
		} catch (error) {
			setLastError(error);
			state.connected = false;
			state.client = undefined;
			state.transport = undefined;
			state.availablePiToolNames = new Set<string>();
			await closeClientAndTransport(client, transport);
			throw error;
		}
	})();

	state.connectPromise = connectTask;

	try {
		await connectTask;
	} catch (error) {
		setLastError(error);
		notify(ctx, `Firefox MCP bridge failed: ${errorMessage(error)}`, "warning");
		throw error;
	} finally {
		if (state.connectPromise === connectTask) {
			state.connectPromise = undefined;
		}
	}
}

export default function firefoxDevtoolsMcpBridge(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureConnected(pi, ctx, false);
		} catch (error) {
			console.error(`[${EXTENSION_NAME}] session_start connect failed: ${errorMessage(error)}`);
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await disconnect("session shutdown");
	});

	pi.registerCommand("ffx-status", {
		description: "Show Firefox MCP bridge status",
		handler: async (_args, ctx) => {
			const summary = statusSummary();
			console.log(`[${EXTENSION_NAME}] status\n${summary}`);
			notify(ctx, `Firefox MCP status: ${state.connected ? "connected" : "disconnected"}`, state.connected ? "info" : "warning");
		},
	});

	pi.registerCommand("ffx-reconnect", {
		description: "Reconnect Firefox MCP bridge and refresh tools",
		handler: async (_args, ctx) => {
			await ensureConnected(pi, ctx, true);
			notify(ctx, "Firefox MCP bridge reconnected.", "info");
		},
	});

	pi.registerCommand("ffx-disconnect", {
		description: "Disconnect Firefox MCP bridge",
		handler: async (_args, ctx) => {
			await disconnect("manual disconnect");
			notify(ctx, "Firefox MCP bridge disconnected.", "info");
		},
	});
}
