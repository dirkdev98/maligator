import { describe, expect, it } from "vitest";
import { summarizeTest262Preflight } from "../src/test262/preflight.ts";
import type { Test262Output } from "../src/test262/types.ts";

type FoldedResult = Test262Output["results"][string];

function current(entries: Array<[string, FoldedResult]>) {
	return new Map(entries);
}

describe("Test262 interpreted preflight", () => {
	it("counts regressions only when a previously passing test fails", () => {
		const summary = summarizeTest262Preflight(
			current([
				["regressed", "FAILED"],
				["already-failing", "FAILED"],
				["new-test", "FAILED"],
				["passing", "PASSED"],
			]),
			{
				regressed: "PASSED",
				"already-failing": "FAILED",
				passing: "PASSED",
			},
			0.05,
		);

		expect(summary.regressions).toEqual(["regressed"]);
		expect(summary.ranTests).toBe(4);
		expect(summary.abortCompiled).toBe(true);
	});

	it("excludes skipped tests from the denominator", () => {
		const summary = summarizeTest262Preflight(
			current([
				["regressed", "FAILED"],
				["passing", "PASSED"],
				["skipped-a", "SKIPPED"],
				["skipped-b", "SKIPPED"],
			]),
			{ regressed: "PASSED", passing: "PASSED" },
			0.5,
		);

		expect(summary.ranTests).toBe(2);
		expect(summary.regressionRate).toBe(0.5);
	});

	it("continues at exactly the limit and aborts above it", () => {
		const results = current(
			Array.from(
				{ length: 20 },
				(_, index) =>
					[`test-${index}`, index === 0 ? "FAILED" : "PASSED"] satisfies [
						string,
						FoldedResult,
					],
			),
		);
		const previous = Object.fromEntries<FoldedResult>(
			[...results.keys()].map((path) => [path, "PASSED"]),
		);

		const atLimit = summarizeTest262Preflight(results, previous, 0.05);
		expect(atLimit.regressionRate).toBe(0.05);
		expect(atLimit.abortCompiled).toBe(false);

		results.set("test-1", "FAILED");
		const aboveLimit = summarizeTest262Preflight(results, previous, 0.05);
		expect(aboveLimit.regressionRate).toBe(0.1);
		expect(aboveLimit.abortCompiled).toBe(true);
	});
});
