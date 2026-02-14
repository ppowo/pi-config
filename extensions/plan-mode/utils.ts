/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
	/\byarn\s+(add|remove|install|publish|up|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bgit\s+branch\s+(-[dDmMcC]|--delete|--move|--copy)\b/i,
	/\bgit\s+remote\s+(add|remove|rename|set-url)\b/i,
	/\bgit\s+config\s+--(add|unset|replace-all)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Shell constructs that make "read-only" hard to guarantee
const SHELL_RISK_PATTERNS = [
	/&&/,
	/\|\|/,
	/\|/,
	/(^|[^\\]);/,
	/\s&\s/,
	/\s&\s*$/,
	/`/,
	/\$\(/,
	/<\(/,
	/\r|\n/,
	/\bfind\b[^\n]*\s-delete\b/i,
	/\bfind\b[^\n]*\s-exec\b/i,
	/\bxargs\b/i,
];

// Safe read-only commands that don't need extra argument inspection
const GENERIC_SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*ls\b/,
	/^\s*find\b/,
	/^\s*grep\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*node\s+--version\b/i,
	/^\s*python\s+--version\b/i,
	/^\s*wget\s+-O\s*-\b/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
];

function tokenizeArgs(command: string): string[] {
	return command
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

function startsWithCommand(command: string, name: string): boolean {
	return new RegExp(`^\\s*${name}\\b`, "i").test(command);
}

function isSafeGitConfig(args: string[]): boolean {
	if (args.length === 0) return false;
	const first = args[0];
	return ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(first);
}

function isSafeGitRemote(args: string[]): boolean {
	if (args.length === 0) return true;
	if (args.length === 1 && args[0] === "-v") return true;
	if (args[0] === "show" && args.length <= 2) return true;
	return false;
}

function isSafeGitBranch(args: string[]): boolean {
	if (args.length === 0) return true;

	const allowedFlags = new Set([
		"-a",
		"-r",
		"-v",
		"-vv",
		"-l",
		"--all",
		"--remotes",
		"--verbose",
		"--list",
		"--show-current",
		"--contains",
		"--no-contains",
		"--merged",
		"--no-merged",
		"--points-at",
		"--sort",
		"--format",
		"--color",
		"--ignore-case",
		"--omit-empty",
		"--column",
	]);

	let sawOption = false;
	for (const arg of args) {
		if (!arg.startsWith("-")) {
			// Creating a branch (e.g. "git branch feature") is not read-only.
			if (!sawOption) return false;
			continue;
		}

		sawOption = true;
		const flag = arg.split("=", 1)[0];
		if (!allowedFlags.has(flag)) return false;
	}

	return true;
}

function isSafeGitCommand(command: string): boolean {
	const tokens = tokenizeArgs(command).map((token) => token.toLowerCase());
	if (tokens[0] !== "git") return false;
	if (tokens.length < 2) return false;

	const subCommand = tokens[1];
	const args = tokens.slice(2);

	if (["status", "log", "diff", "show"].includes(subCommand)) return true;
	if (subCommand.startsWith("ls-")) return true;
	if (subCommand === "config") return isSafeGitConfig(args);
	if (subCommand === "remote") return isSafeGitRemote(args);
	if (subCommand === "branch") return isSafeGitBranch(args);

	return false;
}

function isSafeNpmCommand(command: string): boolean {
	const tokens = tokenizeArgs(command).map((token) => token.toLowerCase());
	if (tokens[0] !== "npm") return false;
	if (tokens.length < 2) return false;

	const subCommand = tokens[1];
	if (!["list", "ls", "view", "info", "search", "outdated", "audit"].includes(subCommand)) {
		return false;
	}
	if (subCommand === "audit" && tokens.slice(2).some((arg) => arg === "fix" || arg === "--fix")) {
		return false;
	}
	return true;
}

function isSafeYarnCommand(command: string): boolean {
	const tokens = tokenizeArgs(command).map((token) => token.toLowerCase());
	if (tokens[0] !== "yarn") return false;
	if (tokens.length < 2) return false;

	const subCommand = tokens[1];
	if (!["list", "info", "why", "audit"].includes(subCommand)) return false;
	if (subCommand === "audit" && tokens.slice(2).some((arg) => arg === "fix" || arg === "--fix")) {
		return false;
	}
	return true;
}

function isSafeCurlCommand(command: string): boolean {
	const tokens = tokenizeArgs(command);
	if (tokens.length < 2) return false;
	if (tokens[0].toLowerCase() !== "curl") return false;

	const unsafeShortFlags = new Set(["-o", "-O", "-T", "-d", "-F"]);
	const unsafeLongFlags = new Set([
		"--output",
		"--remote-name",
		"--remote-name-all",
		"--upload-file",
		"--data",
		"--data-raw",
		"--data-binary",
		"--data-urlencode",
		"--form",
		"--form-string",
	]);
	const unsafeLongPrefixFlags = [
		"--output=",
		"--upload-file=",
		"--data=",
		"--data-raw=",
		"--data-binary=",
		"--data-urlencode=",
		"--form=",
		"--form-string=",
	];

	for (let i = 1; i < tokens.length; i++) {
		const rawToken = tokens[i];
		const lowerToken = rawToken.toLowerCase();

		if (unsafeShortFlags.has(rawToken)) return false;
		if (/^-([oTdF]).+/.test(rawToken)) return false;
		if (unsafeLongFlags.has(lowerToken)) return false;
		if (unsafeLongPrefixFlags.some((prefix) => lowerToken.startsWith(prefix))) return false;

		if (rawToken === "-X" || lowerToken === "--request") {
			const method = tokens[i + 1]?.toUpperCase();
			if (!method) return false;
			if (method !== "GET" && method !== "HEAD") return false;
			i += 1;
			continue;
		}
		if (rawToken.startsWith("-X") && rawToken.length > 2) {
			const method = rawToken.slice(2).toUpperCase();
			if (method !== "GET" && method !== "HEAD") return false;
			continue;
		}
		if (lowerToken.startsWith("--request=")) {
			const method = rawToken.split("=", 2)[1]?.toUpperCase() || "";
			if (method !== "GET" && method !== "HEAD") return false;
		}
	}

	return true;
}

export function isSafeCommand(command: string): boolean {
	const normalized = command.trim();
	if (!normalized) return false;

	for (const pattern of SHELL_RISK_PATTERNS) {
		if (pattern.test(normalized)) return false;
	}
	for (const pattern of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(normalized)) return false;
	}

	if (startsWithCommand(normalized, "git")) return isSafeGitCommand(normalized);
	if (startsWithCommand(normalized, "npm")) return isSafeNpmCommand(normalized);
	if (startsWithCommand(normalized, "yarn")) return isSafeYarnCommand(normalized);
	if (startsWithCommand(normalized, "curl")) return isSafeCurlCommand(normalized);

	for (const pattern of GENERIC_SAFE_PATTERNS) {
		if (pattern.test(normalized)) return true;
	}
	return false;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

function createSectionHeaderRegex(): RegExp {
	return /^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*{1,2})?(Goal|Scope|Assumptions|Plan|Risks|Validation)(?:\*{1,2})?\s*:/gim;
}

const STEP_SECTION_HINT_REGEX =
	/^\s*(?:#{1,6}\s*)?(?:\*{1,2})?(?:plan|steps|next steps|implementation plan|execution plan|approach|task list|actions)(?:\*{1,2})?\s*:?\s*$/i;

function isLikelySectionHeader(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	return /^(?:#{1,6}\s*)?(?:\*{1,2})?[a-z][a-z0-9\s\-/]{1,50}(?:\*{1,2})?\s*:\s*$/i.test(trimmed);
}

function getPlanBlocks(message: string): string[] {
	const headers = Array.from(message.matchAll(createSectionHeaderRegex()));
	if (headers.length === 0) return [];

	const blocks: string[] = [];
	for (let i = 0; i < headers.length; i++) {
		const match = headers[i];
		const section = String(match[1] || "").toLowerCase();
		if (section !== "plan") continue;

		const startIndex = (match.index ?? 0) + match[0].length;
		const endIndex = i + 1 < headers.length ? (headers[i + 1].index ?? message.length) : message.length;
		blocks.push(message.slice(startIndex, endIndex));
	}
	return blocks;
}

function getStepHintBlocks(message: string): string[] {
	const lines = message.split(/\r?\n/);
	const blocks: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (!STEP_SECTION_HINT_REGEX.test(lines[i].trim())) continue;

		const blockLines: string[] = [];
		let seenListLine = false;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			const trimmed = line.trim();

			if (!trimmed) {
				if (seenListLine) break;
				continue;
			}
			if (isLikelySectionHeader(trimmed) && blockLines.length > 0) break;

			if (/^\s*(?:\d+[.)]|[-*])\s+/.test(line)) {
				seenListLine = true;
			}
			blockLines.push(line);
		}

		if (blockLines.length > 0) {
			blocks.push(blockLines.join("\n"));
		}
	}

	return blocks;
}

function appendPlanItems(lines: string[], items: TodoItem[], acceptBullets: boolean): void {
	for (const rawLine of lines) {
		const numberedMatch = rawLine.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/);
		const bulletMatch = !numberedMatch && acceptBullets ? rawLine.match(/^\s*[-*]\s+(.+?)\s*$/) : null;
		const candidate = numberedMatch ? numberedMatch[2] : bulletMatch?.[1];
		if (!candidate) continue;

		const text = candidate
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length < 6 || text.startsWith("`") || text.startsWith("/") || text.startsWith("-")) {
			continue;
		}

		const cleaned = cleanStepText(text);
		if (cleaned.length < 4) continue;
		items.push({ step: items.length + 1, text: cleaned, completed: false });
	}
}

function extractItemsFromText(text: string, acceptBullets: boolean): TodoItem[] {
	const items: TodoItem[] = [];
	appendPlanItems(text.split(/\r?\n/), items, acceptBullets);
	return items;
}

export function extractTodoItems(message: string): TodoItem[] {
	for (const planBlock of getPlanBlocks(message)) {
		const numberedItems = extractItemsFromText(planBlock, false);
		if (numberedItems.length !== 0) return numberedItems;

		const bulletItems = extractItemsFromText(planBlock, true);
		if (bulletItems.length !== 0) return bulletItems;
	}

	const numberedFallback = extractItemsFromText(message, false);
	if (numberedFallback.length >= 2) return numberedFallback;

	for (const hintedBlock of getStepHintBlocks(message)) {
		const hintedItems = extractItemsFromText(hintedBlock, true);
		if (hintedItems.length >= 2) return hintedItems;
	}

	const bulletFallback = extractItemsFromText(message, true);
	if (bulletFallback.length >= 3) return bulletFallback;

	return [];
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
