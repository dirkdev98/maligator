import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

describe("compiled compact string lifetime", () => {
	it("keeps widened literal storage inside each VM when reusing one image", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/compiled-string-lifetime.js",
			name: "compiled-string-lifetime",
			compiled: true,
			mainFile: "runtime/call_cache_test_main.c",
		});
		for (const env of [{}, STRESS_ENV]) {
			expect(runToStdout(binary, { env })).toBe(
				"compiled-string-lifetime PASS\ncompiled-string-lifetime PASS\n",
			);
		}
	});
});
