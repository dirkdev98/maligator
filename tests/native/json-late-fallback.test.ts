import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("JSON late generic fallback", () => {
	let binary: string;
	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "json-late-fallback",
			mainFile: "tests/fixtures/json-late-fallback/main.c",
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});
	it("quotes and allocates the retained prefix once while calling a late getter once", () => {
		expect(
			runToStdout(binary, {
				env: { MAL_GC_VERIFY: "1", MAL_PERF_STATS: "1" },
			}),
		).toContain("json-late-fallback PASS\n");
	});
	it("writes pretty scalar records with cached layouts", () => {
		expect(
			runToStdout(binary, {
				env: { MAL_GC_VERIFY: "1", MAL_PERF_STATS: "1", MAL_TEST_JSON_PRETTY: "1" },
			}),
		).toContain("json-pretty-records PASS\n");
	});
});
