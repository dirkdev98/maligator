import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("UTF-8 string storage and decoded-unit limits", () => {
	it("preserves compact decoding, replacement counts, maximum lengths and adopted backing", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "utf8-string-storage",
			mainFile: "tests/fixtures/utf8-string-storage/main.c",
			nodeEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(runToStdout(binary, { env: { MAL_GC_VERIFY: "1" } })).toBe(
			"utf8-string-storage PASS\n",
		);
	});
});
