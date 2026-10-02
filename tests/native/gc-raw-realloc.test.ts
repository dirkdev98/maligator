import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("RAW buffer growth", () => {
	it("preserves bytes, allocation pressure, ownership, and large-record links", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "gc-raw-realloc",
			mainFile: "tests/fixtures/gc-raw-realloc/main.c",
		});
		expect(runToStdout(binary)).toBe("gc-raw-realloc PASS\n");
	});

	it("preserves allocation failures and reclaims warm reserves under chunk pressure", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "gc-raw-realloc-failures",
			mainFile: "tests/fixtures/gc-raw-realloc/main.c",
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(runToStdout(binary)).toBe("gc-raw-realloc PASS\n");
	});
});
