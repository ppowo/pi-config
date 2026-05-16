/**
 * Remind the agent to read a companion Hibernate .hbm.xml mapping when
 * reading a Java entity/POJO that has one.
 *
 * Some Hibernate codebases keep persistence metadata in XML instead of, or in
 * addition to, Java annotations. The .hbm.xml file is often the authoritative
 * mapping for table names, relationships, fetch strategy, cascade/orphan
 * behavior, filters, ordering, and column details.
 *
 * This reminder is intentionally project-agnostic: it looks for .hbm.xml files
 * with the same basename as the Java file under the current workspace, without
 * assuming any Java source/resource directory layout.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

type ToolResultEvent = {
	toolName?: string;
	isError?: boolean;
	input?: {
		path?: string;
	};
};

type ReminderArgs = {
	event: ToolResultEvent;
	ctx?: {
		cwd?: string;
	};
};

type Companion = {
	javaPath: string;
	hbmPaths: string[];
};

const HBM_SUFFIX = ".hbm.xml";
const MAX_INDEXED_ENTRIES = 100_000;
const IGNORED_JAVA_FILES = new Set(["abean.java", "basic.java", "loggable.java"]);
const SKIPPED_DIR_NAMES = new Set([
	".git",
	".hg",
	".svn",
	".gradle",
	".idea",
	".mvn",
	".vscode",
	"build",
	"dist",
	"node_modules",
	"out",
	"target",
]);

const hbmIndexByRoot = new Map<string, Map<string, string[]>>();

const toAbsolutePath = (filePath: string, cwd?: string) =>
	path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd ?? process.cwd(), filePath);

const toDisplayPath = (filePath: string, cwd?: string) => {
	const base = cwd ?? process.cwd();
	const relative = path.relative(base, filePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
};

const pathIsInside = (root: string, targetPath: string) => {
	const relative = path.relative(root, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const findAncestorWithEntry = (startPath: string, entryName: string) => {
	let dir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
		? startPath
		: path.dirname(startPath);

	while (true) {
		if (fs.existsSync(path.join(dir, entryName))) return dir;

		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};

const searchRootForJavaPath = (javaPath: string, cwd?: string) => {
	const gitRoot = findAncestorWithEntry(javaPath, ".git");
	if (gitRoot) return gitRoot;

	const cwdPath = toAbsolutePath(cwd ?? process.cwd());
	return pathIsInside(cwdPath, javaPath) ? cwdPath : path.dirname(javaPath);
};

const addHbmPathToIndex = (index: Map<string, string[]>, hbmPath: string) => {
	const fileName = path.basename(hbmPath);
	const stem = fileName.slice(0, -HBM_SUFFIX.length).toLowerCase();
	const existing = index.get(stem) ?? [];
	existing.push(hbmPath);
	index.set(stem, existing);
};

const buildHbmIndex = (searchRoot: string) => {
	const cached = hbmIndexByRoot.get(searchRoot);
	if (cached) return cached;

	const index = new Map<string, string[]>();
	const stack = [searchRoot];
	let indexedEntries = 0;

	while (stack.length > 0 && indexedEntries < MAX_INDEXED_ENTRIES) {
		const dir = stack.pop();
		if (!dir) continue;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			indexedEntries += 1;
			if (indexedEntries > MAX_INDEXED_ENTRIES) break;

			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIR_NAMES.has(entry.name)) stack.push(entryPath);
				continue;
			}

			if (entry.isFile() && entry.name.toLowerCase().endsWith(HBM_SUFFIX)) {
				addHbmPathToIndex(index, entryPath);
			}
		}
	}

	for (const hbmPaths of index.values()) {
		hbmPaths.sort();
	}

	hbmIndexByRoot.set(searchRoot, index);
	return index;
};

const companionForJavaRead = (event: ToolResultEvent, cwd?: string): Companion | null => {
	if (event.toolName !== "read" || event.isError) return null;

	const rawPath = event.input?.path;
	if (!rawPath || !rawPath.endsWith(".java")) return null;

	const javaFileName = path.basename(rawPath).toLowerCase();
	if (IGNORED_JAVA_FILES.has(javaFileName)) return null;

	const javaStem = path.basename(rawPath, ".java").toLowerCase();
	const javaPath = toAbsolutePath(rawPath, cwd);
	const searchRoot = searchRootForJavaPath(javaPath, cwd);
	const hbmPaths = buildHbmIndex(searchRoot).get(javaStem) ?? [];

	return hbmPaths.length > 0 ? { javaPath, hbmPaths } : null;
};

const formatHbmPaths = (hbmPaths: string[], cwd?: string) =>
	hbmPaths.map((hbmPath) => `\`${toDisplayPath(hbmPath, cwd)}\``).join(", ");

export default function (_pi: ExtensionAPI) {
	const reminded = new Set<string>();

	return {
		on: "tool_result",
		when: ({ event, ctx }: ReminderArgs) => {
			const companion = companionForJavaRead(event, ctx?.cwd);
			if (!companion) return false;

			const unseenHbmPaths = companion.hbmPaths.filter((hbmPath) => !reminded.has(hbmPath));
			if (unseenHbmPaths.length === 0) return false;

			for (const hbmPath of unseenHbmPaths) {
				reminded.add(hbmPath);
			}

			return true;
		},
		message: ({ event, ctx }: ReminderArgs) => {
			const companion = companionForJavaRead(event, ctx?.cwd);
			const hbmPaths = companion ? formatHbmPaths(companion.hbmPaths, ctx?.cwd) : "the companion .hbm.xml file";
			const plural = companion && companion.hbmPaths.length > 1 ? "s" : "";

			return `This Java file has companion Hibernate HBM mapping${plural}: ${hbmPaths}. In Hibernate codebases that use XML mapping, the HBM file often contains the authoritative table/column mapping, relationships, fetch/lazy behavior, cascade/orphan rules, filters, and ordering. Read it before reasoning about persistence behavior.`;
		},
	};
}
