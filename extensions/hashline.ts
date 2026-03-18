import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

/**
 * Hashline tools for precise line-addressed edits.
 *
 * This keeps built-in `read` available for discovery/read-map and adds a separate
 * prepare/edit pair for surgical anchored changes.
 *
 * Inspired by oh-my-pi hashline edit mode (MIT), but implemented here as a
 * standalone single-file extension with no extra npm dependencies.
 */

const HASHLINE_PREPARE = "hashline_prepare"
const HASHLINE_EDIT = "hashline_edit"
const DEFAULT_PREPARE_LIMIT = 200
const MAX_PREPARE_LIMIT = 500
const TAG_LENGTH = 6
const MISMATCH_CONTEXT = 2
const RESULT_PREVIEW_CONTEXT = 2
const RESULT_PREVIEW_MAX_LINES = 24

const HASHLINE_SYSTEM_PROMPT_NOTE = `Hashline workflow: use read for general exploration and read-map output; use ${HASHLINE_PREPARE} only immediately before ${HASHLINE_EDIT}. Prefer edit for simple exact unique-text replacements, use ${HASHLINE_PREPARE} + ${HASHLINE_EDIT} for surgical regional edits or repeated content, and use write for new files or full rewrites. Treat every LINE#HASH anchor as snapshot-bound: once a file changes for any reason, including a successful ${HASHLINE_EDIT}, write, formatter run, or manual edit, all older anchors for that file are stale and must not be reused. Re-run ${HASHLINE_PREPARE} to get fresh anchors before the next hashline edit.`

const VALID_OPS = new Set(["replace", "append", "prepend"])
const TAGGED_LINE_RE = new RegExp(`^\\s*(?:>>>|>>)?\\s*\\d+\\s*#\\s*[a-f0-9]{${TAG_LENGTH}}:`, "i")
const TAG_RE = new RegExp(`^\\s*(?:>>>|>>|[+\\-])?\\s*(\\d+)\\s*#\\s*([a-f0-9]{${TAG_LENGTH}})(?::.*)?$`, "i")

const prepareSchema = Type.Object(
	{
		path: Type.String({ description: "File path (relative or absolute, leading @ allowed)" }),
		offset: Type.Optional(Type.Number({ description: "1-indexed first line to include (default 1)" })),
		limit: Type.Optional(
			Type.Number({ description: `Maximum lines to include (default ${DEFAULT_PREPARE_LIMIT}, capped at ${MAX_PREPARE_LIMIT})` }),
		),
	},
	{ additionalProperties: false },
)

const editItemSchema = Type.Object(
	{
		op: Type.String({ description: "replace, append, or prepend" }),
		pos: Type.Optional(Type.String({ description: 'Anchor in the form "LINE#HASH" from hashline_prepare' })),
		end: Type.Optional(Type.String({ description: 'Inclusive end anchor for range replace, also "LINE#HASH"' })),
		lines: Type.Union([
			Type.Array(Type.String(), { description: "Replacement lines (preferred)" }),
			Type.String({ description: "Replacement text; split on newlines" }),
			Type.Null({ description: "Delete for replace" }),
		]),
	},
	{ additionalProperties: false },
)

const editSchema = Type.Object(
	{
		path: Type.String({ description: "File path (relative or absolute, leading @ allowed)" }),
		edits: Type.Array(editItemSchema, { minItems: 1, description: "Hashline edit operations for this file" }),
	},
	{ additionalProperties: false },
)

type Anchor = {
	line: number
	hash: string
}

type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] }

type ParsedFile = {
	bom: string
	newline: string
	hadFinalNewline: boolean
	lines: string[]
}

type PrepareParams = {
	path: string
	offset?: number
	limit?: number
}

type EditParams = {
	path: string
	edits: Array<{
		op?: unknown
		pos?: unknown
		end?: unknown
		lines?: unknown
	}>
}

function stripAtPrefix(path: string): string {
	return path.trim().replace(/^@+/, "")
}

function resolveToolPath(cwd: string, rawPath: string): { absolutePath: string; displayPath: string } {
	const cleaned = stripAtPrefix(String(rawPath ?? ""))
	if (!cleaned) {
		throw new Error("path is required")
	}
	const absolutePath = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned)
	const relativePath = relative(cwd, absolutePath)
	const displayPath = relativePath && !relativePath.startsWith("..") && relativePath !== ".." ? relativePath : absolutePath
	return { absolutePath, displayPath }
}

function clampPositiveInt(value: unknown, fallback: number, max?: number): number {
	const numeric = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(numeric) || numeric < 1) return fallback
	const rounded = Math.floor(numeric)
	return typeof max === "number" ? Math.min(rounded, max) : rounded
}

function normalizeLineForHash(lineNumber: number, line: string): string {
	return `${lineNumber}\0${line.replace(/\r/g, "").trimEnd()}`
}

function computeLineHash(lineNumber: number, line: string): string {
	return createHash("sha1").update(normalizeLineForHash(lineNumber, line)).digest("hex").slice(0, TAG_LENGTH)
}

function formatLineTag(lineNumber: number, line: string): string {
	return `${lineNumber}#${computeLineHash(lineNumber, line)}`
}

function formatTaggedLines(lines: string[], startLine: number): string {
	if (lines.length === 0) return ""
	return lines.map((line, index) => `${formatLineTag(startLine + index, line)}:${line}`).join("\n")
}

function parseFileContent(rawText: string): ParsedFile {
	let text = rawText
	let bom = ""
	if (text.startsWith("\uFEFF")) {
		bom = "\uFEFF"
		text = text.slice(1)
	}

	const newline = text.includes("\r\n") ? "\r\n" : "\n"
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
	const hadFinalNewline = normalized.endsWith("\n")

	let lines: string[]
	if (normalized === "") {
		lines = []
	} else {
		lines = normalized.split("\n")
		if (hadFinalNewline) lines.pop()
	}

	return { bom, newline, hadFinalNewline, lines }
}

function serializeFileContent(file: ParsedFile): string {
	let text = file.lines.join("\n")
	if (file.hadFinalNewline && file.lines.length > 0) {
		text += "\n"
	}
	if (file.newline !== "\n") {
		text = text.replace(/\n/g, file.newline)
	}
	return file.bom + text
}

function parseTag(raw: string): Anchor {
	const match = TAG_RE.exec(raw)
	if (!match) {
		throw new Error(`Invalid anchor ${JSON.stringify(raw)}. Expected LINE#HASH from hashline_prepare.`)
	}
	const line = Number.parseInt(match[1] ?? "", 10)
	if (!Number.isFinite(line) || line < 1) {
		throw new Error(`Invalid line number in anchor ${JSON.stringify(raw)}.`)
	}
	return {
		line,
		hash: String(match[2] ?? "").toLowerCase(),
	}
}

function stripCopiedHashlinePrefixes(lines: string[]): string[] {
	const nonEmpty = lines.filter((line) => line.length > 0)
	if (nonEmpty.length === 0) return lines
	if (!nonEmpty.every((line) => TAGGED_LINE_RE.test(line))) return lines
	return lines.map((line) => line.replace(TAGGED_LINE_RE, ""))
}

function parseLinesInput(input: unknown): string[] {
	if (input === null) return []

	let lines: string[]
	if (Array.isArray(input)) {
		lines = input.map((line) => String(line))
	} else {
		const text = String(input ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
		if (text === "") {
			lines = [""]
		} else {
			lines = text.split("\n")
			if (text.endsWith("\n")) lines.pop()
		}
	}

	return stripCopiedHashlinePrefixes(lines)
}

function normalizeEdit(rawEdit: EditParams["edits"][number], index: number): HashlineEdit {
	const op = String(rawEdit.op ?? "").trim().toLowerCase()
	if (!VALID_OPS.has(op)) {
		throw new Error(`edits[${index}].op must be one of replace, append, prepend`)
	}

	const pos = typeof rawEdit.pos === "string" && rawEdit.pos.trim() ? parseTag(rawEdit.pos) : undefined
	const end = typeof rawEdit.end === "string" && rawEdit.end.trim() ? parseTag(rawEdit.end) : undefined
	const lines = parseLinesInput(rawEdit.lines)

	if (op === "replace") {
		if (!pos && !end) {
			throw new Error(`edits[${index}] replace requires pos or end`)
		}
		const start = pos ?? end!
		const finish = pos && end ? end : undefined
		if (finish && start.line > finish.line) {
			throw new Error(`edits[${index}] has pos after end (${start.line} > ${finish.line})`)
		}
		return { op: "replace", pos: start, end: finish, lines }
	}

	if (lines.length === 0) {
		throw new Error(`edits[${index}] ${op} requires at least one line; use [""] for a blank line`)
	}

	if (op === "append") return { op: "append", pos, lines }
	return { op: "prepend", pos, lines }
}

function normalizeEdits(rawEdits: EditParams["edits"]): HashlineEdit[] {
	if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
		throw new Error("hashline_edit requires at least one edit")
	}
	return rawEdits.map((edit, index) => normalizeEdit(edit, index))
}

function validateAnchor(anchor: Anchor, lines: string[]): { ok: true } | { ok: false; actual?: string } {
	if (anchor.line < 1 || anchor.line > lines.length) {
		throw new Error(`Line ${anchor.line} does not exist (file has ${lines.length} lines)`)
	}
	const actual = computeLineHash(anchor.line, lines[anchor.line - 1] ?? "")
	if (actual === anchor.hash) return { ok: true }
	return { ok: false, actual }
}

function formatMismatchError(mismatches: Anchor[], lines: string[]): string {
	const mismatchLines = new Set(mismatches.map((mismatch) => mismatch.line))
	const displayLines = new Set<number>()

	for (const mismatch of mismatches) {
		const start = Math.max(1, mismatch.line - MISMATCH_CONTEXT)
		const end = Math.min(lines.length, mismatch.line + MISMATCH_CONTEXT)
		for (let line = start; line <= end; line += 1) displayLines.add(line)
	}

	const sorted = [...displayLines].sort((a, b) => a - b)
	const output: string[] = []
	output.push(
		`${mismatches.length} anchor${mismatches.length === 1 ? " is" : "s are"} stale. Re-run ${HASHLINE_PREPARE} and use the updated LINE#HASH tags below (>>> marks changed lines).`,
	)
	output.push("")

	let previous = -1
	for (const lineNumber of sorted) {
		if (previous !== -1 && lineNumber > previous + 1) output.push("    ...")
		previous = lineNumber
		const line = lines[lineNumber - 1] ?? ""
		const prefix = `${formatLineTag(lineNumber, line)}:${line}`
		output.push(`${mismatchLines.has(lineNumber) ? ">>>" : "   "} ${prefix}`)
	}

	return output.join("\n")
}

function ensureFreshAnchors(lines: string[], edits: HashlineEdit[]): void {
	const mismatches: Anchor[] = []

	for (const edit of edits) {
		if (edit.op === "replace") {
			const start = validateAnchor(edit.pos, lines)
			if (!start.ok) mismatches.push(edit.pos)
			if (edit.end) {
				const finish = validateAnchor(edit.end, lines)
				if (!finish.ok) mismatches.push(edit.end)
			}
			continue
		}
		if (edit.pos) {
			const result = validateAnchor(edit.pos, lines)
			if (!result.ok) mismatches.push(edit.pos)
		}
	}

	if (mismatches.length > 0) {
		throw new Error(formatMismatchError(mismatches, lines))
	}
}

function ensureNonOverlappingReplaceRanges(edits: HashlineEdit[]): void {
	const ranges = edits
		.filter((edit): edit is Extract<HashlineEdit, { op: "replace" }> => edit.op === "replace")
		.map((edit, index) => ({
			index,
			start: edit.pos.line,
			end: edit.end?.line ?? edit.pos.line,
		}))
		.sort((a, b) => a.start - b.start || a.end - b.end)

	for (let index = 1; index < ranges.length; index += 1) {
		const previous = ranges[index - 1]
		const current = ranges[index]
		if (current.start <= previous.end) {
			throw new Error(
				`Overlapping replace ranges are not supported (${previous.start}-${previous.end} overlaps ${current.start}-${current.end}). Combine them into one wider replace.`,
			)
		}
	}
}

function applyEdits(originalLines: string[], edits: HashlineEdit[]): string[] {
	const lines = [...originalLines]
	const annotated = edits
		.map((edit, index) => {
			const sortLine =
				edit.op === "replace"
					? edit.end?.line ?? edit.pos.line
					: edit.op === "append"
						? edit.pos?.line ?? originalLines.length + 1
						: edit.pos?.line ?? 0
			const precedence = edit.op === "replace" ? 0 : edit.op === "append" ? 1 : 2
			return { edit, index, sortLine, precedence }
		})
		.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.index - b.index)

	for (const item of annotated) {
		const edit = item.edit
		if (edit.op === "replace") {
			const startIndex = edit.pos.line - 1
			const endIndex = edit.end ? edit.end.line - 1 : startIndex
			const deleteCount = endIndex - startIndex + 1
			lines.splice(startIndex, deleteCount, ...edit.lines)
			continue
		}

		if (edit.op === "append") {
			const insertIndex = edit.pos ? edit.pos.line : lines.length
			lines.splice(insertIndex, 0, ...edit.lines)
			continue
		}

		const insertIndex = edit.pos ? edit.pos.line - 1 : 0
		lines.splice(insertIndex, 0, ...edit.lines)
	}

	return lines
}

function computeChangedRegion(before: string[], after: string[]) {
	let prefix = 0
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
		prefix += 1
	}

	if (prefix === before.length && prefix === after.length) {
		return {
			changed: false as const,
			addedLines: 0,
			removedLines: 0,
		}
	}

	let beforeEnd = before.length - 1
	let afterEnd = after.length - 1
	while (beforeEnd >= prefix && afterEnd >= prefix && before[beforeEnd] === after[afterEnd]) {
		beforeEnd -= 1
		afterEnd -= 1
	}

	const addedLines = Math.max(0, afterEnd - prefix + 1)
	const removedLines = Math.max(0, beforeEnd - prefix + 1)
	const previewStart = Math.max(0, prefix - RESULT_PREVIEW_CONTEXT)
	const previewEnd = Math.min(after.length, afterEnd + 1 + RESULT_PREVIEW_CONTEXT)
	const previewLines = after.slice(previewStart, previewEnd).slice(0, RESULT_PREVIEW_MAX_LINES)

	return {
		changed: true as const,
		addedLines,
		removedLines,
		previewStartLine: previewStart + 1,
		previewEndLine: previewStart + previewLines.length,
		previewText: formatTaggedLines(previewLines, previewStart + 1),
	}
}

function signalIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation cancelled")
	}
}

export default function hashlineExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const activeTools = new Set(pi.getActiveTools())
		if (!activeTools.has(HASHLINE_PREPARE) && !activeTools.has(HASHLINE_EDIT)) return
		if (event.systemPrompt.includes(HASHLINE_SYSTEM_PROMPT_NOTE)) return
		return {
			systemPrompt: `${event.systemPrompt}\n\n${HASHLINE_SYSTEM_PROMPT_NOTE}`,
		}
	})

	pi.registerTool({
		name: HASHLINE_PREPARE,
		label: "Hashline Prepare",
		description: `Read a bounded file slice with stable LINE#HASH anchors for ${HASHLINE_EDIT}. Keep using built-in read for exploration/read-map. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: `Prepare a bounded file slice with LINE#HASH anchors for ${HASHLINE_EDIT}; keep built-in read for discovery and read-map.`,
		promptGuidelines: [
			`Use read for general exploration and read-map output; use ${HASHLINE_PREPARE} only immediately before ${HASHLINE_EDIT}.`,
			`A LINE#HASH anchor is snapshot-bound: once the file changes, older anchors for that file are stale. Prefer narrow slices with offset/limit, and after any successful ${HASHLINE_EDIT} on a file, call ${HASHLINE_PREPARE} again before further edits to that file.`,
		],
		parameters: prepareSchema,
		async execute(_toolCallId: string, params: PrepareParams, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd: string }) {
			signalIfAborted(signal)
			const { absolutePath, displayPath } = resolveToolPath(ctx?.cwd ?? process.cwd(), params.path)
			const offset = clampPositiveInt(params.offset, 1)
			const limit = clampPositiveInt(params.limit, DEFAULT_PREPARE_LIMIT, MAX_PREPARE_LIMIT)

			const raw = await readFile(absolutePath, "utf-8")
			signalIfAborted(signal)
			const parsed = parseFileContent(raw)
			const totalLines = parsed.lines.length

			if (totalLines === 0) {
				return {
					content: [
						{
							type: "text",
							text: `${displayPath} is empty. Use ${HASHLINE_EDIT} with append/prepend and no pos to insert initial lines, or use write for full-file creation.`,
						},
					],
					details: {
						path: displayPath,
						totalLines,
						offset,
						limit,
					},
				}
			}

			if (offset > totalLines) {
				return {
					content: [
						{
							type: "text",
							text: `${displayPath} has ${totalLines} line${totalLines === 1 ? "" : "s"}; requested offset ${offset} is past EOF. Re-run ${HASHLINE_PREPARE} with a smaller offset.`,
						},
					],
					details: {
						path: displayPath,
						totalLines,
						offset,
						limit,
						lineStart: offset,
						lineEnd: offset - 1,
					},
				}
			}

			const startIndex = offset - 1
			const endIndex = Math.min(totalLines, startIndex + limit)
			const slice = parsed.lines.slice(startIndex, endIndex)
			let output = formatTaggedLines(slice, startIndex + 1)

			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			})
			output = truncation.content
			if (truncation.truncated) {
				output += `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Re-run ${HASHLINE_PREPARE} with a narrower offset/limit.]`
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					path: displayPath,
					totalLines,
					offset: startIndex + 1,
					limit,
					lineStart: startIndex + 1,
					lineEnd: endIndex,
					truncation,
				},
			}
		},
	} as any)

	pi.registerTool({
		name: HASHLINE_EDIT,
		label: "Hashline Edit",
		description: `Apply precise edits using LINE#HASH anchors from ${HASHLINE_PREPARE}. Supports replace, append, and prepend. Re-run ${HASHLINE_PREPARE} before every subsequent edit on the same file.`,
		promptSnippet: `Apply line-addressed edits using fresh LINE#HASH anchors from ${HASHLINE_PREPARE}.`,
		promptGuidelines: [
			`Before ${HASHLINE_EDIT}, obtain fresh anchors with ${HASHLINE_PREPARE} for the exact file region you want to change.`,
			`Batch one file's edits into a single ${HASHLINE_EDIT} call when possible. Copy LINE#HASH anchors exactly, and never reuse old anchors after the file has changed.`,
			`For replace, lines replaces pos..end inclusively. Use null or [] to delete. For append/prepend, lines must contain only newly inserted lines.`,
		],
		parameters: editSchema,
		async execute(_toolCallId: string, params: EditParams, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd: string }) {
			signalIfAborted(signal)
			const { absolutePath, displayPath } = resolveToolPath(ctx?.cwd ?? process.cwd(), params.path)
			const edits = normalizeEdits(params.edits)
			ensureNonOverlappingReplaceRanges(edits)

			const raw = await readFile(absolutePath, "utf-8")
			signalIfAborted(signal)
			const parsed = parseFileContent(raw)
			ensureFreshAnchors(parsed.lines, edits)

			const nextLines = applyEdits(parsed.lines, edits)
			const region = computeChangedRegion(parsed.lines, nextLines)
			if (!region.changed) {
				return {
					content: [
						{
							type: "text",
							text: `No changes made to ${displayPath}. The requested edits produced identical content.`,
						},
					],
					details: {
						path: displayPath,
						changed: false,
						operationCount: edits.length,
					},
				}
			}

			parsed.lines = nextLines
			const nextText = serializeFileContent(parsed)
			signalIfAborted(signal)
			await writeFile(absolutePath, nextText, "utf-8")

			let text = `Applied ${edits.length} hashline edit${edits.length === 1 ? "" : "s"} to ${displayPath}.`
			text += ` (+${region.addedLines} -${region.removedLines})`
			if (region.previewText) {
				text += `\n\nUpdated region (${region.previewStartLine}-${region.previewEndLine}):\n${region.previewText}`
			}
			text += `\n\nRe-run ${HASHLINE_PREPARE} before any further ${HASHLINE_EDIT} on this file.`

			return {
				content: [{ type: "text", text }],
				details: {
					path: displayPath,
					changed: true,
					operationCount: edits.length,
					addedLines: region.addedLines,
					removedLines: region.removedLines,
					previewStartLine: region.previewStartLine,
					previewEndLine: region.previewEndLine,
				},
			}
		},
	} as any)
}
