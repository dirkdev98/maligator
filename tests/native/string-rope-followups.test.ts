import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("bounded rope algorithms and hashed shape keys", () => {
	let binary: string;
	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "string-rope-followups",
			mainFile: "tests/fixtures/string-rope-followups/main.c",
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600000);
	it("preserves content and ownership with bounded traversal, append and prepend hashing, and shape fan-out", () => {
		expect(
			runToStdout(binary, {
				env: { MAL_PERF_STATS: "1", MAL_GC_VERIFY: "1" },
			}),
		).toBe("string-rope-followups PASS\n");
	});
});
