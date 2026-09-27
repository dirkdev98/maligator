import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("heap usage diagnostics", () => {
	it("accounts RAW ownership and currently reusable capacity through sweep", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "gc-heap-usage",
			mainFile: "tests/fixtures/gc-heap-usage/main.c",
		});
		expect(runToStdout(binary)).toBe("gc-heap-usage PASS\n");
	});
});
