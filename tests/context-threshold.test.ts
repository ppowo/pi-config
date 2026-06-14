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
	void it("shows cntx in text color under warning threshold", () => {
		assert.strictEqual(
			render(LOW_PERCENT, false, mockFg),
			`[text:cntx ${LOW_PERCENT.toFixed(2)}%]`,
		);
	});

	void it("shows cntx in warning color between thresholds", () => {
		assert.strictEqual(
			render(MID_PERCENT, false, mockFg),
			`[warning:cntx ${MID_PERCENT.toFixed(2)}%]`,
		);
	});

	void it("shows cntx in error color above red threshold", () => {
		assert.strictEqual(
			render(HIGH_PERCENT, false, mockFg),
			`[error:cntx ${HIGH_PERCENT.toFixed(2)}%]`,
		);
	});
});

void describe("context-threshold render — dumb zone", () => {
	void it("shows dumb label in accent, percent in text color under warning threshold", () => {
		assert.strictEqual(
			render(LOW_PERCENT, true, mockFg),
			`[accent:dumb] [text:${LOW_PERCENT.toFixed(2)}%]`,
		);
	});

	void it("shows dumb label in accent, percent in warning color between thresholds", () => {
		assert.strictEqual(
			render(MID_PERCENT, true, mockFg),
			`[accent:dumb] [warning:${MID_PERCENT.toFixed(2)}%]`,
		);
	});

	void it("shows dumb label in accent, percent in error color above red threshold", () => {
		assert.strictEqual(
			render(HIGH_PERCENT, true, mockFg),
			`[accent:dumb] [error:${HIGH_PERCENT.toFixed(2)}%]`,
		);
	});
});
