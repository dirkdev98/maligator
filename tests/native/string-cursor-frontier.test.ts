import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("traced string traversal frontiers", () => {
	it("visits rope nodes once across code-point iteration, split, materialization, and GC", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "string-cursor-frontier",
			mainFile: "tests/fixtures/string-cursor-frontier/main.c",
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(
			runToStdout(binary, { env: {
					MAL_PERF_STATS: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "8",
				} }),
		).toContain("string-cursor-frontier PASS\n");
	});
});
