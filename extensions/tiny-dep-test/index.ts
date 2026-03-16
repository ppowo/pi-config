/**
 * Placeholder extension-local package used to validate bootstrap-managed npm dependencies.
 * Replace this file and its package.json dependencies with the real Firefox MCP extension.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import ms from "ms";

export default function tinyDepTest(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tiny_dep_test",
		label: "Tiny Dep Test",
		description: "Parse a human-readable duration string using the tiny npm package 'ms'.",
		parameters: Type.Object({
			value: Type.String({ description: "Duration string such as '5m', '2 hours', or '1d'" }),
		}),
		async execute(_toolCallId, params) {
			const parsed = ms(params.value as ms.StringValue);
			if (parsed === undefined) {
				throw new Error(`Could not parse duration: ${params.value}`);
			}

			return {
				content: [{ type: "text", text: `${params.value} = ${parsed} milliseconds` }],
				details: { parsedMilliseconds: parsed },
			};
		},
	});
}
