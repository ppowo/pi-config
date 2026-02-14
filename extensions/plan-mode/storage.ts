import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PlanSaveResult {
	path: string;
	updated: boolean;
}

export function getPlanDir(): string {
	return path.join(os.homedir(), "Plans");
}

function getPlanDirResolved(): string {
	return path.resolve(getPlanDir());
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
	const relative = path.relative(directoryPath, filePath);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function sanitizePlanPath(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	const resolvedFilePath = path.resolve(filePath);
	const plansDir = getPlanDirResolved();
	if (!isPathInsideDirectory(resolvedFilePath, plansDir)) return undefined;
	if (path.extname(resolvedFilePath).toLowerCase() !== ".md") return undefined;
	return resolvedFilePath;
}

function assertSafePlanPath(filePath: string): string {
	const safePath = sanitizePlanPath(filePath);
	if (!safePath) {
		throw new Error(`Plan file path must be a markdown file inside ${getPlanDir()}`);
	}
	return safePath;
}

const PLAN_SECTION_NAMES = ["Goal", "Scope", "Assumptions", "Plan", "Risks", "Validation"] as const;
const MAX_FILENAME_WORDS = 4;

function createSectionHeaderRegex(): RegExp {
	return new RegExp(
		`^\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?(?:\\*{1,2})?(${PLAN_SECTION_NAMES.join("|")})(?:\\*{1,2})?\\s*:`,
		"gim",
	);
}

function stripMarkdownSyntax(value: string): string {
	return value
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/^>\s*/g, "")
		.trim();
}

function cleanLineContent(line: string): string {
	return stripMarkdownSyntax(line)
		.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
		.replace(/^\s*(?:#{1,6})\s+/, "")
		.trim();
}

function getSectionBlock(planText: string, targetSection: "Goal" | "Scope"): string {
	const headers = Array.from(planText.matchAll(createSectionHeaderRegex()));
	for (let i = 0; i < headers.length; i += 1) {
		const match = headers[i];
		if ((match[1] ?? "").toLowerCase() !== targetSection.toLowerCase()) continue;

		const start = (match.index ?? 0) + match[0].length;
		const end = i + 1 < headers.length ? (headers[i + 1].index ?? planText.length) : planText.length;
		return planText.slice(start, end).trim();
	}
	return "";
}

function getFirstMeaningfulLine(block: string): string | undefined {
	for (const rawLine of block.split(/\r?\n/)) {
		const cleaned = cleanLineContent(rawLine);
		if (!cleaned) continue;
		const withoutScopeLabel = cleaned.replace(/^(?:in scope|out of scope)\s*:\s*/i, "").trim();
		if (!withoutScopeLabel) continue;
		return withoutScopeLabel;
	}
	return undefined;
}

function extractScopeText(planText: string): string | undefined {
	const scopeBlock = getSectionBlock(planText, "Scope");
	if (!scopeBlock) return undefined;

	const lines = scopeBlock.split(/\r?\n/);
	let collectingInScopeBullets = false;

	for (const rawLine of lines) {
		const cleaned = cleanLineContent(rawLine);
		if (!cleaned) continue;

		const inScopeMatch = cleaned.match(/^in scope\s*:\s*(.+)$/i);
		if (inScopeMatch?.[1]?.trim()) {
			return inScopeMatch[1].trim();
		}
		if (/^in scope\s*:?\s*$/i.test(cleaned)) {
			collectingInScopeBullets = true;
			continue;
		}
		if (/^out of scope\b/i.test(cleaned)) {
			collectingInScopeBullets = false;
			continue;
		}
		if (collectingInScopeBullets) {
			return cleaned;
		}
	}

	for (const rawLine of lines) {
		const cleaned = cleanLineContent(rawLine);
		if (!cleaned) continue;
		if (/^out of scope\b/i.test(cleaned)) continue;
		if (/^in scope\s*:?\s*$/i.test(cleaned)) continue;
		return cleaned.replace(/^in scope\s*:\s*/i, "").trim();
	}

	return undefined;
}

function slugify(text: string, maxWords = MAX_FILENAME_WORDS): string {
	const normalized = stripMarkdownSyntax(text).toLowerCase();
	const words = normalized.match(/[a-z0-9]+/g) ?? [];
	return words.slice(0, maxWords).join("-") || "plan";
}

function derivePlanName(planText: string, promptHint?: string): string {
	const scopeText = extractScopeText(planText);
	const goalText = getFirstMeaningfulLine(getSectionBlock(planText, "Goal"));
	const fallbackHint = (promptHint ?? "").trim();
	const base = scopeText || goalText || fallbackHint || "plan";
	return slugify(base);
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
	if (!filePath) return false;
	try {
		const fileStats = await stat(filePath);
		return fileStats.isFile();
	} catch {
		return false;
	}
}

async function getUniquePlanPath(plansDir: string, baseName: string): Promise<string> {
	const now = new Date();
	const yyyy = String(now.getFullYear());
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	const hh = String(now.getHours()).padStart(2, "0");
	const dateStamp = `${yyyy}-${mm}-${dd}`;

	const candidates = [
		`${baseName}.md`,
		`${baseName}-${dateStamp}.md`,
		`${baseName}-${dateStamp}-${hh}.md`,
	];

	for (const candidate of candidates) {
		const candidatePath = path.join(plansDir, candidate);
		if (!(await fileExists(candidatePath))) return candidatePath;
	}

	let counter = 2;
	while (true) {
		const candidatePath = path.join(plansDir, `${baseName}-${dateStamp}-${hh}-${counter}.md`);
		if (!(await fileExists(candidatePath))) return candidatePath;
		counter += 1;
	}
}

export async function savePlanMarkdown(
	planText: string,
	promptHint?: string,
	preferredPath?: string,
): Promise<PlanSaveResult> {
	const normalizedPlan = `${planText.trim()}\n`;

	if (preferredPath) {
		const safePreferredPath = sanitizePlanPath(preferredPath);
		if (!safePreferredPath) {
			throw new Error(`Refinement target must be a markdown file inside ${getPlanDir()}`);
		}
		if (!(await fileExists(safePreferredPath))) {
			throw new Error(`Refinement target does not exist: ${safePreferredPath}`);
		}
		await writeFile(safePreferredPath, normalizedPlan, "utf8");
		return { path: safePreferredPath, updated: true };
	}

	const plansDir = getPlanDirResolved();
	await mkdir(plansDir, { recursive: true });

	const baseName = derivePlanName(planText, promptHint);
	const filePath = assertSafePlanPath(await getUniquePlanPath(plansDir, baseName));
	await writeFile(filePath, normalizedPlan, "utf8");
	return { path: filePath, updated: false };
}

export function truncatePlanPreview(text: string, maxLines = 120): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return "(empty file)";
	const lines = normalized.split("\n");
	if (lines.length <= maxLines) return normalized;
	return `${lines.slice(0, maxLines).join("\n")}\n\n[Preview truncated: showing ${maxLines} of ${lines.length} lines]`;
}

async function findLatestPlanPath(): Promise<string | undefined> {
	const plansDir = getPlanDirResolved();
	await mkdir(plansDir, { recursive: true });
	const entries = await readdir(plansDir, { withFileTypes: true });
	const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
	if (markdownFiles.length === 0) return undefined;

	const filesWithMtime = await Promise.all(
		markdownFiles.map(async (entry) => {
			const filePath = path.join(plansDir, entry.name);
			const fileStats = await stat(filePath);
			return { filePath, mtimeMs: fileStats.mtimeMs };
		}),
	);

	filesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return filesWithMtime[0]?.filePath;
}

export async function resolveLatestPlanPath(lastPlanPath: string): Promise<string | undefined> {
	const safeLastPlanPath = sanitizePlanPath(lastPlanPath);
	if (safeLastPlanPath && (await fileExists(safeLastPlanPath))) return safeLastPlanPath;
	return findLatestPlanPath();
}

export async function readPlanMarkdown(filePath: string): Promise<string> {
	return readFile(filePath, "utf8");
}

function runOpenCommand(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
		});
	});
}

export async function openPlanInEditor(filePath: string): Promise<void> {
	const candidates: Array<{ command: string; args: string[] }> = [{ command: "code", args: [filePath] }];

	if (process.platform === "darwin") {
		candidates.push({ command: "open", args: ["-a", "Visual Studio Code", filePath] });
	} else if (process.platform === "win32") {
		candidates.push({ command: "cmd", args: ["/c", "start", "", filePath] });
	} else if (process.platform === "linux") {
		candidates.push({ command: "xdg-open", args: [filePath] });
	}

	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			await runOpenCommand(candidate.command, candidate.args);
			return;
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unknown error"));
}
