import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const expected = "true Out of memory\nobject true\ntrue Out of memory\n";

describe("recoverable allocation failure", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("catches one-shot CELL failure in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/allocation_failure.js",
			name: `allocation-failure-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(
			runToStdout(binary, {
				env: {
					MAL_ALLOC_FAIL_TEST: "1",
					MAL_GC_AT_EXIT: "1",
				},
			}),
		).toBe(expected);
	});
});
