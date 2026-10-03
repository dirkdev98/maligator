import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

it("matches the independent heap walk across allocation, reuse, sweep and buffer ownership", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "gc-current-usage",
		mainFile: "tests/fixtures/gc-current-usage/main.c",
	});
	expect(runToStdout(binary)).toBe("gc-current-usage PASS\n");
	expect(runToStdout(binary, { env: { MAL_GC_VERIFY: "1" } })).toBe(
		"gc-current-usage PASS\n",
	);
});
