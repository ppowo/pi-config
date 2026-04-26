export const BASH_GUARD_MAX_LINES = 400;
export const BASH_GUARD_MAX_BYTES = 16 * 1024;

export const BASH_PREVIEW_HEAD_LINES = 20;
export const BASH_PREVIEW_TAIL_LINES = 20;
export const BASH_PREVIEW_MAX_LINE_CHARS = 240;

export const BASH_COMMAND_MAX_CHARS = 160;

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

export function exceedsBashGuardBudget(text: string): boolean {
	return byteLength(text) > BASH_GUARD_MAX_BYTES || countLines(text) > BASH_GUARD_MAX_LINES;
}

export default function () {
	// No-op extension factory. This file is imported for shared bash guard constants,
	// but pi may also discover/load .ts files under extensions directly.
}
