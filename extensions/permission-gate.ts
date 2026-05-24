/**
 * Permission Gate Extension
 *
 * Runtime note:
 * - This file is intentionally written as plain-Node-runnable, erasable TypeScript.
 * - Keep TypeScript syntax to forms Node can strip directly: `type`, `import type`,
 *   const assertions, etc.
 * - Avoid enums, namespaces, decorators, parameter properties, or other TS constructs
 *   requiring transpilation.
 * - Same-file self-tests can be run with:
 *     PERMISSION_GATE_SELF_TEST=1 node extensions/permission-gate.ts
 *
 * Purpose:
 * - This is a behavior-shaping guardrail, not a sandbox.
 * - It allows normal agent work, including reads/writes outside the workspace and /tmp.
 * - It interrupts dangerous shell/tool calls with explicit rule-based decisions.
 * - It does not use risk scoring. Rules either allow, ask, or block.
 * - Block rules always win over ask rules.
 *
 * BLOCKS:
 * 1. Credential/private material reads or writes:
 *    - real .env files and .envrc; env templates are allowed
 *    - SSH private keys and known credential files
 *    - GPG material
 *    - private key/cert files: .pem, .key, .p12, .pfx
 *    - cloud/container credential files such as AWS, gcloud, Azure, Docker auth
 * 2. Catastrophic disk/system commands:
 *    - mkfs
 *    - dd writing to /dev/*
 *    - sudo rm
 *    - chmod -R 777 / or equivalent root-wide permission changes
 *    - curl/wget piped into sudo shell execution
 * 3. Writes to pseudo-filesystems:
 *    - /dev, /proc, /sys
 *
 * ASKS:
 * 1. Any rm command.
 * 2. Any shell-side file mutation:
 *    - redirection, tee, touch, mkdir, mv, cp, chmod, chown
 *    - inline script writes through python/perl/node/ruby
 * 3. Sudo/elevated commands unless already blocked.
 * 4. Destructive Git commands:
 *    - reset --hard, clean -f, checkout -- ., restore ., force push
 * 5. Mutating or remote-executing package manager commands:
 *    - install/add/remove/update/upgrade/audit fix/exec/dlx/npx/bunx
 * 6. Network upload, push, remote execution, or credentialed network calls:
 *    - git push, ssh, scp, rsync
 *    - curl/wget output to file, upload/data flags, auth headers
 *    - curl/wget piped into a shell
 *
 * ALLOWS:
 * 1. Normal structured reads/writes, including outside the workspace and /tmp.
 * 2. Tests, builds, lints, typechecks.
 * 3. Plain network fetches/searches.
 * 4. Reading documentation, dependencies, and generated scratch files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

// ─── policy surface ──────────────────────────────────────────────────────────

type Decision = "allow" | "ask" | "block";
type ToolInput = Record<string, unknown>;

type ToolCall = {
	toolName: string;
	input: ToolInput;
};

type Match = {
	id: string;
	decision: Exclude<Decision, "allow">;
	description: string;
	guidance: string;
};

type Rule = {
	id: string;
	decision: Exclude<Decision, "allow">;
	description: string;
	guidance: string;
	matches: (call: ToolCall) => boolean;
};

type Assessment = {
	decision: Decision;
	matches: Match[];
	target: string;
};


const GUIDANCE = {
	credentials: "Credential material is blocked. Ask the user for a redacted snippet or explicit value instead.",
	catastrophic: "This looks system-destroying or very high blast-radius. Do not try to bypass this with another shell form.",
	pseudoFs: "Writing to /dev, /proc, or /sys is blocked. Ask the user to perform this manually if truly required.",
	rm: "This deletes files. Confirm only if deletion is intentional.",
	shellWrite: "This uses shell to modify files. Prefer the edit/write tools for auditable file changes.",
	sudo: "This uses elevated privileges. Confirm only if absolutely necessary.",
	gitDestructive: "This can discard work or rewrite remote history. Confirm only if intentional.",
	packageManager: "This mutates dependencies or executes downloaded package code. Confirm before changing the supply chain.",
	networkRisk: "This transfers data, writes downloaded content, pushes remotely, or executes network content. Confirm before proceeding.",
} as const;

// Keep these lists near the policy/guidance so duplicates are easy to tune.
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "ast_search"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "nu"]);

// ─── helpers ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ? resolve(process.env.HOME) : undefined;

const shellCommand = (input: ToolInput) => String(input.command ?? "").trim();
const toolPath = (input: ToolInput) => String(input.path ?? "").trim();
const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();

const expandPath = (path: string) => path.replace(/^~(?=\/|$)/, HOME ?? "~");
const normalizedPath = (path: string) => normalize(resolve(expandPath(path)));

const pathFromCall = (call: ToolCall) => toolPath(call.input);
const commandFromCall = (call: ToolCall) => shellCommand(call.input);

const pathMentionPattern = /(?:~|\.\.?|\/)[^\s'";&|)]+/g;
const extractPathMentions = (command: string): string[] => command.match(pathMentionPattern) ?? [];

const hasShortFlag = (command: string, flag: string) => {
	const shortFlagGroups = command.matchAll(/\s-([a-z]+)/gi);
	return [...shortFlagGroups].some(([, group]) => group.includes(flag));
};

const mentionsCredentialPath = (value: string) => {
	const normalized = normalize(value);
	const mentionedPaths = value.includes("/") || value.includes("~") || value.includes(".")
		? [normalized, ...extractPathMentions(value).map((path) => normalize(path)), ...extractPathMentions(value).map((path) => normalizedPath(path))]
		: [normalized];

	return mentionedPaths.some((path) => isCredentialPath(path));
};

const isEnvTemplatePath = (path: string) => /(^|\/)\.env\.(example|sample|template|defaults|dist)$/i.test(path);

const isCredentialPath = (path: string) => {
	const normalized = normalize(path);
	if (isEnvTemplatePath(normalized)) return false;

	return [
		/(^|\/)\.env($|[._-])/,
		/(^|\/)\.envrc$/,
		/(^|\/)\.npmrc$/,
		/(^|\/)\.netrc$/,
		/(^|\/)\.ssh\/[^/]*(?:_key|id_[a-z0-9]+)$/,
		/(^|\/)\.gnupg(\/|$)/,
		/\.(pem|key|p12|pfx)$/,
		/(^|\/)\.aws\/credentials$/,
		/(^|\/)\.config\/gcloud(\/|$)/,
		/(^|\/)\.azure(\/|$)/,
		/(^|\/)\.docker\/config\.json$/,
	].some((pattern) => pattern.test(normalized));
};

const isPseudoFsPath = (path: string) => {
	const normalized = normalizedPath(path);
	return normalized === "/dev" || normalized.startsWith("/dev/") || normalized === "/proc" || normalized.startsWith("/proc/") || normalized === "/sys" || normalized.startsWith("/sys/");
};

const shellMentionsPseudoFsWrite = (command: string) =>
	/(?:^|[\s;|&])(?:\d?>{1,2})(?!&|\d)\s*\/?(?:proc\/|sys\/|dev\/(?!null(?:\s|$|[;&|)])))/i.test(command) ||
	/\b(?:tee|dd|cp|mv|touch|mkdir|chmod|chown)\b[^\n]*(?:\s|=)\/?(?:proc\/|sys\/|dev\/(?!null(?:\s|$|[;&|)])))/i.test(command);

const hasFileRedirectionWrite = (command: string) => {
	const redirections = command.matchAll(/(?:^|[\s;|&])(?:\d?>{1,2})(?!&|\d)\s*([^\s&|;]+)/g);
	return [...redirections].some(([, target]) => normalize(target) !== "/dev/null");
};

const hasShellWrite = (command: string) =>
	hasFileRedirectionWrite(command) ||
	/\b(?:tee|touch|mkdir|mv|cp|chmod|chown)\b/i.test(command) ||
	/\bperl\b[^\n]*(?:\s-[a-z]*i|\s-[a-z]*p[a-z]*i)/i.test(command) ||
	/\bpython3?\b[^\n]*\s-c\s+['"][^'"]*(?:open\s*\(|write\s*\(|unlink\s*\(|remove\s*\()/i.test(command) ||
	/\bnode\b[^\n]*\s-e\s+['"][^'"]*(?:writeFile|rmSync|unlinkSync|appendFile|createWriteStream)/i.test(command) ||
	/\bruby\b[^\n]*\s-e\s+['"][^'"]*(?:File\.write|File\.delete|FileUtils\.rm)/i.test(command);

const hasRm = (command: string) => /(^|[\s;|&])rm(?:\s|$)/i.test(command);
const hasSudo = (command: string) => /(^|[\s;|&])sudo(?:\s|$)/i.test(command);

const isCatastrophicCommand = (command: string) =>
	/\bmkfs(?:\.[a-z0-9]+)?\b/i.test(command) ||
	/\bdd\b[^\n]*\bof=\/dev\//i.test(command) ||
	(hasSudo(command) && hasRm(command)) ||
	/\bchmod\b[^\n]*(?:-r|--recursive)[^\n]*\b777\b[^\n]*(?:\s\/\s*$|\s\/\s|\s~(?:\s|\/|$)|\$HOME)/i.test(command) ||
	/\b(?:curl|wget)\b[^\n]*\|[^\n]*\bsudo\b[^\n]*\b(?:sh|bash|zsh)\b/i.test(command);

const isDestructiveGit = (command: string) =>
	/\bgit\s+reset\b[^\n]*\s--hard\b/i.test(command) ||
	(/\bgit\s+clean\b/i.test(command) && (/\s--force\b/i.test(command) || hasShortFlag(command, "f"))) ||
	/\bgit\s+checkout\s+--\s*\.(?:\s|$)/i.test(command) ||
	/\bgit\s+restore\b[^\n]*\s\.(?:\s|$)/i.test(command) ||
	/\bgit\s+push\b[^\n]*(\s--force(?:-with-lease)?\b|\s-f\b)/i.test(command);

const isMutatingPackageManager = (command: string) =>
	/\bnpx\b/i.test(command) ||
	/\bbunx\b/i.test(command) ||
	/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|rm|uninstall|update|upgrade|audit\s+fix|exec|dlx)\b/i.test(command);

const isRiskyNetwork = (command: string) =>
	/\bgit\s+push\b/i.test(command) ||
	/\b(?:ssh|scp|rsync)\b/i.test(command) ||
	/\b(?:curl|wget)\b[^\n]*\|[^\n]*\b(?:sh|bash|zsh)\b/i.test(command) ||
	/\bcurl\b[^\n]*(?:\s-o\s|\s-O\b|\s--output\b|\s--remote-name\b|\s-d\s|\s--data(?:-raw|-binary|-urlencode)?\b|\s-F\s|\s--form\b|authorization:|\s-H\s+['"][^'"]*authorization:)/i.test(command) ||
	/\bwget\b[^\n]*(?:\s-O\s|\s--output-document\b|authorization:|\s--header\s+['"][^'"]*authorization:)/i.test(command);

const targetForCall = (call: ToolCall) => {
	if (SHELL_TOOLS.has(call.toolName)) return commandFromCall(call);
	const path = pathFromCall(call);
	return path ? `${call.toolName}: ${path}` : call.toolName;
};

// ─── rules ───────────────────────────────────────────────────────────────────

const rules: Rule[] = [
	// Block credential material no matter how it is accessed. If the agent needs a
	// secret-adjacent value, the user should provide a redacted snippet explicitly.
	{
		id: "block.credential-structured-access",
		decision: "block",
		description: "credential/private material path accessed by structured tool",
		guidance: GUIDANCE.credentials,
		matches: (call) => (READ_TOOLS.has(call.toolName) || WRITE_TOOLS.has(call.toolName)) && isCredentialPath(pathFromCall(call)),
	},
	{
		id: "block.credential-shell-access",
		decision: "block",
		description: "shell command references credential/private material",
		guidance: GUIDANCE.credentials,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && mentionsCredentialPath(commandFromCall(call)),
	},

	// Block commands with huge blast radius. These are not confirmation-worthy;
	// the right next step is to stop and ask the user to handle it manually.
	{
		id: "block.catastrophic-command",
		decision: "block",
		description: "catastrophic disk/system command",
		guidance: GUIDANCE.catastrophic,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && isCatastrophicCommand(commandFromCall(call)),
	},

	// Block writes to pseudo-filesystems. Reading them may be diagnostic; writing
	// them changes kernel/device state and should not be agent-driven.
	{
		id: "block.pseudo-fs-structured-write",
		decision: "block",
		description: "structured write to /dev, /proc, or /sys",
		guidance: GUIDANCE.pseudoFs,
		matches: (call) => WRITE_TOOLS.has(call.toolName) && isPseudoFsPath(pathFromCall(call)),
	},
	{
		id: "block.pseudo-fs-shell-write",
		decision: "block",
		description: "shell write to /dev, /proc, or /sys",
		guidance: GUIDANCE.pseudoFs,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && shellMentionsPseudoFsWrite(commandFromCall(call)),
	},

	// Ask on any rm. This is intentionally blunt: deletion should be conscious,
	// even when it looks small or local.
	{
		id: "ask.rm",
		decision: "ask",
		description: "rm command deletes files",
		guidance: GUIDANCE.rm,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && hasRm(commandFromCall(call)),
	},

	// Ask when shell is used as a file editor. This nudges the agent toward the
	// structured edit/write tools, where the path and diff are easier to inspect.
	{
		id: "ask.shell-write",
		decision: "ask",
		description: "shell command writes or mutates files",
		guidance: GUIDANCE.shellWrite,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && hasShellWrite(commandFromCall(call)),
	},

	// Ask for elevated privileges. Sudo is sometimes legitimate, but it should
	// never happen accidentally or as a workaround for a failed command.
	{
		id: "ask.sudo",
		decision: "ask",
		description: "sudo/elevated command",
		guidance: GUIDANCE.sudo,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && hasSudo(commandFromCall(call)),
	},

	// Ask before discarding local work or rewriting remote history.
	{
		id: "ask.git-destructive",
		decision: "ask",
		description: "destructive Git command",
		guidance: GUIDANCE.gitDestructive,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && isDestructiveGit(commandFromCall(call)),
	},

	// Ask before changing the dependency graph or executing package-manager-fetched
	// code. Tests/builds/lints are deliberately not included here.
	{
		id: "ask.package-manager-mutate",
		decision: "ask",
		description: "mutating or remote-executing package-manager command",
		guidance: GUIDANCE.packageManager,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && isMutatingPackageManager(commandFromCall(call)),
	},

	// Ask when a network command uploads, pushes, writes downloaded bytes to disk,
	// includes auth material, or pipes remote content into an interpreter.
	{
		id: "ask.network-risk",
		decision: "ask",
		description: "network upload, push, remote execution, or credentialed network call",
		guidance: GUIDANCE.networkRisk,
		matches: (call) => SHELL_TOOLS.has(call.toolName) && isRiskyNetwork(commandFromCall(call)),
	},
];

// ─── assessment ──────────────────────────────────────────────────────────────

const matchingRules = (call: ToolCall, decision: Exclude<Decision, "allow">): Match[] =>
	rules
		.filter((rule) => rule.decision === decision && rule.matches(call))
		.map(({ id, decision, description, guidance }) => ({ id, decision, description, guidance }));

const assessToolCall = (toolName: string, input: ToolInput): Assessment => {
	const call = { toolName, input };
	const blockMatches = matchingRules(call, "block");
	if (blockMatches.length > 0) return { decision: "block", matches: blockMatches, target: targetForCall(call) };

	const askMatches = matchingRules(call, "ask");
	if (askMatches.length > 0) return { decision: "ask", matches: askMatches, target: targetForCall(call) };

	return { decision: "allow", matches: [], target: targetForCall(call) };
};

const unique = <T>(values: T[]) => [...new Set(values)];
const formatList = (values: string[]) => values.map((value) => `- ${value}`).join("\n");

const formatReason = (assessment: Assessment) => {
	const descriptions = unique(assessment.matches.map((match) => `${match.id}: ${match.description}`));
	const guidance = unique(assessment.matches.map((match) => match.guidance));
	return [
		`Permission gate ${assessment.decision}:`,
		formatList(descriptions),
		"",
		"Guidance:",
		formatList(guidance),
		"",
		"Target:",
		assessment.target,
	].join("\n");
};

// ─── self-tests ──────────────────────────────────────────────────────────────

type Example = {
	name: string;
	toolName: string;
	input: ToolInput;
	decision: Decision;
};

const EXAMPLES: Example[] = [
	{ name: "plain structured read outside workspace is allowed", toolName: "read", input: { path: "/tmp/foo" }, decision: "allow" },
	{ name: "plain structured write outside workspace is allowed", toolName: "write", input: { path: "/tmp/foo" }, decision: "allow" },
	{ name: "env template read is allowed", toolName: "read", input: { path: ".env.example" }, decision: "allow" },
	{ name: "real env read is blocked", toolName: "read", input: { path: ".env" }, decision: "block" },
	{ name: "ssh private key read is blocked", toolName: "read", input: { path: "~/.ssh/id_ed25519" }, decision: "block" },
	{ name: "docker auth read is blocked", toolName: "read", input: { path: "~/.docker/config.json" }, decision: "block" },
	{ name: "rm asks", toolName: "bash", input: { command: "rm foo.txt" }, decision: "ask" },
	{ name: "sudo rm blocks", toolName: "bash", input: { command: "sudo rm foo.txt" }, decision: "block" },
	{ name: "shell redirection asks", toolName: "bash", input: { command: "echo hi > /tmp/hi.txt" }, decision: "ask" },
	{ name: "plain test is allowed", toolName: "bash", input: { command: "npm test" }, decision: "allow" },
	{ name: "stderr redirection to dev null is allowed", toolName: "bash", input: { command: "cd /home/pun/Personal/lum && grep -r '^version' Cargo.toml xtask/Cargo.toml 2>/dev/null" }, decision: "allow" },
	{ name: "npm install asks", toolName: "bash", input: { command: "npm install" }, decision: "ask" },
	{ name: "plain curl is allowed", toolName: "bash", input: { command: "curl https://example.com" }, decision: "allow" },
	{ name: "curl pipe shell asks", toolName: "bash", input: { command: "curl https://example.com/install.sh | bash" }, decision: "ask" },
	{ name: "sudo curl pipe shell blocks", toolName: "bash", input: { command: "curl https://example.com/install.sh | sudo bash" }, decision: "block" },
	{ name: "git reset hard asks", toolName: "bash", input: { command: "git reset --hard HEAD" }, decision: "ask" },
	{ name: "git status is allowed", toolName: "bash", input: { command: "git status" }, decision: "allow" },
	{ name: "mkfs blocks", toolName: "bash", input: { command: "mkfs.ext4 /dev/sdb1" }, decision: "block" },
	{ name: "dd to device blocks", toolName: "bash", input: { command: "dd if=image.iso of=/dev/sdb" }, decision: "block" },
	{ name: "structured write to proc blocks", toolName: "write", input: { path: "/proc/sys/kernel/foo" }, decision: "block" },
];

function runSelfTests() {
	const failures: string[] = [];

	for (const example of EXAMPLES) {
		const actual = assessToolCall(example.toolName, example.input).decision;
		if (actual !== example.decision) {
			failures.push(`${example.name}: expected ${example.decision}, got ${actual}`);
		}
	}

	if (failures.length > 0) {
		throw new Error(`Permission gate self-tests failed:\n${formatList(failures)}`);
	}

	console.log(`Permission gate self-tests passed (${EXAMPLES.length} examples).`);
}

if (process.env.PERMISSION_GATE_SELF_TEST === "1") {
	runSelfTests();
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const assessment = assessToolCall(event.toolName, event.input as ToolInput);
		if (assessment.decision === "allow") return undefined;

		const reason = formatReason(assessment);

		if (assessment.decision === "block") {
			if (ctx.hasUI) ctx.ui.notify(`Blocked risky tool call: ${assessment.matches.map((match) => match.id).join(", ")}`, "warning");
			return { block: true, reason };
		}

		if (!ctx.hasUI) return { block: true, reason: `${reason}\n\nConfirmation requires UI.` };

		const allow = "Yes, allow once";
		const choice = await ctx.ui.select(
			`⚠️ Permission gate ask\n\n${reason}\n\nAllow?`,
			["No, block it", allow],
		);

		return choice === allow ? undefined : { block: true, reason: "Blocked by user" };
	});
}
