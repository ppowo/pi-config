import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/footer-veil-ui.mjs", import.meta.url));

void describe("footer-veil bundled UI integration", () => {
	void it.each(["veil-first", "provider-first"])("updates actual rendered widgets with %s startup", async (order) => {
		const { stdout } = await execFileAsync(process.execPath, [fixture, order], { timeout: 20_000 });
		assert.include(stdout, `PASS ${order}`);
	}, 25_000);
});
