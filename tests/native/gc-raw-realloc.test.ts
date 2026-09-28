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
});
