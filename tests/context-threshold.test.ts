import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ORANGE_THRESHOLD,
	RED_THRESHOLD,
	render,
} from "../extensions/context-threshold.ts";

function mockFg<T>(color: T, text: string): string {
	return `[${color}:${text}]`;
}

const MID_PERCENT = (ORANGE_THRESHOLD + RED_THRESHOLD) / 2;
const HIGH_PERCENT = RED_THRESHOLD + 10;
const LOW_PERCENT = ORANGE_THRESHOLD - 10;

void describe("context-threshold render — smart zone", () => {
	void it("shows nothing under warning threshold", () => {
		assert.strictEqual(render(LOW_PERCENT, false, mockFg), undefined);
	});

	void it("shows nothing between thresholds", () => {
		assert.strictEqual(render(MID_PERCENT, false, mockFg), undefined);
	});

	void it("shows nothing above red threshold", () => {
		assert.strictEqual(render(HIGH_PERCENT, false, mockFg), undefined);
	});
});

void describe("context-threshold render — dumb zone", () => {
	void it("shows dumb in text color under warning threshold", () => {
		assert.strictEqual(render(LOW_PERCENT, true, mockFg), `[text:dumb]`);
	});

	void it("shows dumb in warning color between thresholds", () => {
		assert.strictEqual(render(MID_PERCENT, true, mockFg), `[warning:dumb]`);
	});

	void it("shows dumb in error color above red threshold", () => {
		assert.strictEqual(render(HIGH_PERCENT, true, mockFg), `[error:dumb]`);
	});
});
