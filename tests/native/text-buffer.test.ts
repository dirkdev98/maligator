import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("encoding-aware text construction", () => {
	it("preserves code units, compact storage, RAW ownership, and failure rollback", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "text-buffer",
			mainFile: "tests/fixtures/text-buffer/main.c",
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(runToStdout(binary)).toBe("text-buffer PASS\n");
	});
});
