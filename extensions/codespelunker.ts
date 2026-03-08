import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const TOOL_NAME = "codespelunker";
const TOOL_LABEL = "codespelunker";
const DEFAULT_RESULT_LIMIT = 6;
const MAX_RESULT_LIMIT = 12;
const DEFAULT_SNIPPET_LENGTH = 180;
const MAX_SNIPPET_LENGTH = 240;
const MAX_LINES_PER_RESULT = 6;
const MAX_OUTPUT_LINES = 300;
const MAX_OUTPUT_BYTES = 24 * 1024;

const searchSchema = Type.Object({
	query: Type.String({
		description:
			"Search query for codespelunker. Supports boolean logic, quoted phrases, fuzzy terms, regex via /.../, and inline filters like lang:go or path:src.",
	}),
	path: Type.Optional(
		Type.String({
			description: "Optional file or directory to narrow the search. Relative paths are resolved from the current working directory.",
		}),
	),
	mode: Type.Optional(
		Type.String({
			description: "Optional structural filter: default, code, comments, strings, declarations, or usages.",
		}),
	),
	gravity: Type.Optional(
		Type.String({
			description: "Optional complexity ranking intent: default, brain, logic, low, or off.",
		}),
	),
	includeExt: Type.Optional(
		Type.String({
			description: "Optional comma-separated file extensions, for example: ts,tsx,md",
		}),
	),
	language: Type.Optional(
		Type.String({
			description: "Optional comma-separated language names, for example: TypeScript,Go,Python",
		}),
	),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Make the query case-sensitive." })),
	dedup: Type.Optional(Type.Boolean({ description: "Collapse byte-identical matches into one result." })),
	resultLimit: Type.Optional(
		Type.Number({
			description: `Maximum results to return. Default ${DEFAULT_RESULT_LIMIT}; capped at ${MAX_RESULT_LIMIT}.`,
		}),
	),
	snippetLength: Type.Optional(
		Type.Number({
			description: `Snippet size in characters. Default ${DEFAULT_SNIPPET_LENGTH}; capped at ${MAX_SNIPPET_LENGTH}.`,
		}),
	),
});

type CodespelunkerResultLine = {
	line_number?: number;
	content?: string;
};

type CodespelunkerResult = {
	filename?: string;
	location?: string;
	score?: number;
	content?: string;
	lines?: CodespelunkerResultLine[];
	language?: string;
	complexity?: number;
};

const EXECUTABLE = "cs";

async function resolveExecutable(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const check = await pi.exec(EXECUTABLE, ["--version"], {
		cwd,
		timeout: 10_000,
	});
	return check.code === 0 ? EXECUTABLE : undefined;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}

function toDisplayPath(location: string | undefined, cwd: string): string {
	if (!location) return "<unknown>";
	const normalized = normalizePath(location);
	const normalizedCwd = normalizePath(resolve(cwd));
	if (normalized === normalizedCwd) return ".";
	if (normalized.startsWith(`${normalizedCwd}/`)) {
		return normalized.slice(normalizedCwd.length + 1);
	}
	return normalized;
}

function truncateInline(value: string, maxChars: number): string {
	const normalized = value.replace(/\r/g, "").replace(/\t/g, "    ");
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeMode(value: unknown): { mode: string; flag?: string } {
	const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
	switch (raw) {
		case "":
		case "default":
			return { mode: "default" };
		case "code":
		case "only-code":
			return { mode: "code", flag: "--only-code" };
		case "comments":
		case "only-comments":
			return { mode: "comments", flag: "--only-comments" };
		case "strings":
		case "only-strings":
			return { mode: "strings", flag: "--only-strings" };
		case "declarations":
		case "only-declarations":
			return { mode: "declarations", flag: "--only-declarations" };
		case "usages":
		case "only-usages":
			return { mode: "usages", flag: "--only-usages" };
		default:
			return { mode: "default" };
	}
}

function normalizeGravity(value: unknown): string {
	const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (["brain", "logic", "default", "low", "off"].includes(raw)) {
		return raw;
	}
	return "default";
}

function resolveScope(cwd: string, inputPath?: string): { searchDir: string; scopeQuery?: string; scopeLabel: string } {
	const raw = typeof inputPath === "string" ? inputPath.trim() : "";
	if (!raw) {
		return { searchDir: cwd, scopeLabel: "." };
	}

	const resolvedPath = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
	if (existsSync(resolvedPath)) {
		try {
			const stat = statSync(resolvedPath);
			if (stat.isDirectory()) {
				return {
					searchDir: resolvedPath,
					scopeLabel: toDisplayPath(resolvedPath, cwd),
				};
			}

			if (stat.isFile()) {
				const relToCwd = normalizePath(relative(cwd, resolvedPath));
				const insideCwd = relToCwd !== "" && !relToCwd.startsWith("../") && relToCwd !== "..";
				if (insideCwd) {
					return {
						searchDir: cwd,
						scopeQuery: `path:${relToCwd}`,
						scopeLabel: relToCwd,
					};
				}

				return {
					searchDir: dirname(resolvedPath),
					scopeQuery: `path:${basename(resolvedPath)}`,
					scopeLabel: resolvedPath,
				};
			}
		} catch {
			// Fall through to query-based scoping.
		}
	}

	return {
		searchDir: cwd,
		scopeQuery: `path:${normalizePath(raw)}`,
		scopeLabel: normalizePath(raw),
	};
}

function parseResults(stdout: string): CodespelunkerResult[] {
	const trimmed = stdout.trim();
	if (!trimmed || trimmed === "null") return [];
	const parsed = JSON.parse(trimmed) as unknown;
	if (parsed == null) return [];
	if (!Array.isArray(parsed)) {
		throw new Error("codespelunker returned unexpected JSON output");
	}
	return parsed as CodespelunkerResult[];
}

function formatResult(result: CodespelunkerResult, index: number, cwd: string): string[] {
	const shownPath = toDisplayPath(result.location ?? result.filename, cwd);
	const firstLineNumber = result.lines?.find((line) => typeof line.line_number === "number")?.line_number;
	const score = typeof result.score === "number" ? result.score.toFixed(2) : "?";
	const language = result.language ? ` · ${result.language}` : "";
	const complexity = typeof result.complexity === "number" ? ` · complexity ${result.complexity}` : "";
	const header = `${index + 1}. ${shownPath}${firstLineNumber ? `:${firstLineNumber}` : ""} [score ${score}${language}${complexity}]`;

	const lines = [header];
	if (Array.isArray(result.lines) && result.lines.length > 0) {
		const visibleLines = result.lines.slice(0, MAX_LINES_PER_RESULT);
		for (const line of visibleLines) {
			const lineNumber = typeof line.line_number === "number" ? String(line.line_number).padStart(5, " ") : "    ?";
			const content = truncateInline(String(line.content ?? ""), 160);
			lines.push(`   ${lineNumber} | ${content}`);
		}
		if (result.lines.length > visibleLines.length) {
			lines.push(`   … ${result.lines.length - visibleLines.length} more snippet lines omitted`);
		}
		return lines;
	}

	if (typeof result.content === "string" && result.content.trim()) {
		const snippetLines = result.content
			.split("\n")
			.map((line) => truncateInline(line, 160))
			.filter((line) => line.trim().length > 0)
			.slice(0, 3);
		for (const line of snippetLines) {
			lines.push(`     | ${line}`);
		}
	}

	return lines;
}

function formatResults(
	results: CodespelunkerResult[],
	cwd: string,
	query: string,
	scopeLabel: string,
	notes: string[],
): string {
	if (results.length === 0) {
		return "No matches found.";
	}

	const lines = [`${results.length} ranked matches for ${JSON.stringify(query)} in ${scopeLabel}`];
	for (const note of notes) {
		lines.push(`[limit] ${note}`);
	}
	lines.push("");

	for (const [index, result] of results.entries()) {
		lines.push(...formatResult(result, index, cwd));
		if (index < results.length - 1) {
			lines.push("");
		}
	}

	return lines.join("\n");
}

export default function codespelunkerExtension(pi: ExtensionAPI) {
	let executablePath = EXECUTABLE;
	let available = false;

	pi.on("session_start", async (_event, ctx) => {
		const resolvedExecutable = await resolveExecutable(pi, ctx.cwd);
		executablePath = resolvedExecutable ?? EXECUTABLE;
		available = Boolean(resolvedExecutable);

		const activeTools = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
		if (available) {
			const grepIndex = activeTools.indexOf("grep");
			if (grepIndex >= 0) activeTools.splice(grepIndex, 0, TOOL_NAME);
			else activeTools.push(TOOL_NAME);
			pi.setActiveTools(activeTools);
			return;
		}

		pi.setActiveTools(activeTools);
		ctx.ui.notify(
			`codespelunker tool inactive: could not execute ${executablePath}. Install cs and ensure it is in PATH.`,
			"warning",
		);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: `Ranked structural code search using codespelunker (cs). Use it for declarations/usages, comments/strings, and likely implementations; use grep for exact regex/literal scans. Defaults stay small: ${DEFAULT_RESULT_LIMIT} results, hard cap ${MAX_RESULT_LIMIT}; total output truncated to ${MAX_OUTPUT_LINES} lines or ${formatSize(MAX_OUTPUT_BYTES)}.`,
		promptSnippet: "Ranked structural code search via cs; grep remains available for exact scans.",
		promptGuidelines: [
			"Choose between codespelunker and grep by task: codespelunker for ranked structural discovery, grep for exact regex/literal scans, raw output, or pipelines.",
			"Keep codespelunker searches narrow with path/language filters and small result limits before broadening.",
		],
		parameters: searchSchema,

		renderCall(args: any, theme: any) {
			const query = truncateInline(String(args.query ?? ""), 60);
			const scope = args.path ? ` in ${truncateInline(String(args.path), 32)}` : "";
			const mode = args.mode ? ` ${String(args.mode)}` : "";
			const limit = clampInt(args.resultLimit, DEFAULT_RESULT_LIMIT, 1, MAX_RESULT_LIMIT);
			let text = theme.fg("toolTitle", theme.bold("codespelunker"));
			text += ` ${theme.fg("accent", JSON.stringify(query))}`;
			text += theme.fg("muted", `${scope} limit ${limit}${mode}`);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded, isPartial }: any, theme: any) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			const details = (result.details ?? {}) as {
				resultCount?: number;
				commandLine?: string;
				fullOutputPath?: string;
			};
			const count = typeof details.resultCount === "number" ? details.resultCount : 0;
			const headline = count === 0 ? "No matches found" : `${count} ranked matches`;
			if (!expanded) {
				return new Text(
					`${theme.fg(count > 0 ? "success" : "muted", headline)} ${theme.fg("dim", "(ctrl+o to expand)")}`,
					0,
					0,
				);
			}

			let text = theme.fg(count > 0 ? "success" : "muted", headline);
			if (details.commandLine) text += `\n${theme.fg("dim", details.commandLine)}`;
			if (result.content?.[0]?.type === "text") text += `\n${theme.fg("muted", result.content[0].text)}`;
			if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId: any, params: any, signal: any, _onUpdate: any, ctx: any) {
			const resolvedExecutable = available ? executablePath : await resolveExecutable(pi, ctx.cwd);
			if (resolvedExecutable) {
				executablePath = resolvedExecutable;
				available = true;
			}
			if (!available) {
				throw new Error(`codespelunker is not available. Expected ${executablePath} in PATH.`);
			}

			const rawQuery = String(params.query ?? "").replace(/\s+/g, " ").trim();
			if (!rawQuery) {
				throw new Error("codespelunker requires a non-empty query");
			}

			const notes: string[] = [];
			const requestedResultLimit = params.resultLimit;
			const requestedSnippetLength = params.snippetLength;
			const resultLimit = clampInt(requestedResultLimit, DEFAULT_RESULT_LIMIT, 1, MAX_RESULT_LIMIT);
			const snippetLength = clampInt(requestedSnippetLength, DEFAULT_SNIPPET_LENGTH, 80, MAX_SNIPPET_LENGTH);
			if (typeof requestedResultLimit === "number" && Number.isFinite(requestedResultLimit) && requestedResultLimit > MAX_RESULT_LIMIT) {
				notes.push(`resultLimit capped at ${MAX_RESULT_LIMIT}`);
			}
			if (typeof requestedSnippetLength === "number" && Number.isFinite(requestedSnippetLength) && requestedSnippetLength > MAX_SNIPPET_LENGTH) {
				notes.push(`snippetLength capped at ${MAX_SNIPPET_LENGTH}`);
			}

			const { mode, flag: modeFlag } = normalizeMode(params.mode);
			const gravity = normalizeGravity(params.gravity);
			const { searchDir, scopeQuery, scopeLabel } = resolveScope(ctx.cwd, params.path);
			const scopedQuery = scopeQuery ? `(${rawQuery}) ${scopeQuery}` : rawQuery;

			const args = [
				"--dir",
				searchDir,
				"--format",
				"json",
				"--color",
				"never",
				"--ranker",
				"structural",
				"--gravity",
				gravity,
				"--snippet-mode",
				"lines",
				"--snippet-count",
				"1",
				"--snippet-length",
				String(snippetLength),
				"--result-limit",
				String(resultLimit),
			];

			if (modeFlag) args.push(modeFlag);
			if (params.caseSensitive) args.push("--case-sensitive");
			if (params.dedup) args.push("--dedup");
			if (typeof params.includeExt === "string" && params.includeExt.trim()) {
				args.push("--include-ext", params.includeExt.trim());
			}
			if (typeof params.language === "string" && params.language.trim()) {
				args.push("--type", params.language.trim());
			}
			args.push(scopedQuery);

			const commandLine = `${shellQuote(executablePath)} ${args.map((arg) => shellQuote(String(arg))).join(" ")}`;
			const result = await pi.exec(executablePath, args, {
				signal,
				cwd: ctx.cwd,
				timeout: 90_000,
			});

			if (result.code !== 0) {
				throw new Error(result.stderr || result.stdout || "codespelunker command failed");
			}

			let text: string;
			let resultCount = 0;
			try {
				const parsedResults = parseResults(result.stdout);
				resultCount = parsedResults.length;
				text = formatResults(parsedResults, ctx.cwd, rawQuery, scopeLabel, notes);
			} catch {
				text = result.stdout.trim() || "No matches found.";
			}

			const truncation = truncateHead(text, {
				maxLines: MAX_OUTPUT_LINES,
				maxBytes: MAX_OUTPUT_BYTES,
			});
			let outputText = truncation.content;
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-codespelunker-"));
				fullOutputPath = join(tempDir, "codespelunker-output.txt");
				writeFileSync(fullOutputPath, text, "utf-8");
				outputText += `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details: {
					commandLine,
					gravity,
					mode,
					notes,
					query: rawQuery,
					resultCount,
					resultLimit,
					scopeLabel,
					searchDir,
					snippetLength,
					truncation,
					fullOutputPath,
				},
			};
		},
		// promptSnippet/promptGuidelines are supported by pi at runtime; cast because the local type package lags the docs.
	} as any);
}
