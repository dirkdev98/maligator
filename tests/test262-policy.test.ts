import { describe, expect, it } from "vitest";
import {
	parseTest262Policy,
	test262BatchRegressions,
	test262FoldedRegressions,
	test262RunsInVariant,
	test262WorkerCount,
} from "../src/test262/policy.ts";
import type { Test262File, Test262Result } from "../src/test262/types.ts";

function file(path: string, flags: Array<string> = []): Test262File {
	return {
		path,
		frontmatter: { flags },
		content: "",
		result: "UNKNOWN",
	};
}

describe("Test262 runner policy", () => {
	it("defaults to complete and validates explicit policies", () => {
		expect(parseTest262Policy(undefined)).toBe("complete");
		expect(parseTest262Policy("complete")).toBe("complete");
		expect(parseTest262Policy("bail")).toBe("bail");
		expect(() => parseTest262Policy("fast")).toThrow(/only supports/);
	});

	it("caps workers to the actual number of batches", () => {
		expect(test262WorkerCount(8, 20)).toBe(8);
		expect(test262WorkerCount(8, 2)).toBe(2);
		expect(test262WorkerCount(8, 0)).toBe(0);
	});

	it("models strict and sloppy Test262 flag eligibility", () => {
		expect(test262RunsInVariant(file("default"), "strict")).toBe(true);
		expect(test262RunsInVariant(file("default"), "sloppy")).toBe(true);
		expect(test262RunsInVariant(file("no-strict", ["noStrict"]), "strict")).toBe(false);
		expect(test262RunsInVariant(file("only-strict", ["onlyStrict"]), "sloppy")).toBe(
			false,
		);
		expect(test262RunsInVariant(file("module", ["module"]), "sloppy")).toBe(false);
		expect(test262RunsInVariant(file("raw", ["raw"]), "sloppy")).toBe(false);
	});

	it("treats every non-pass result for a previous pass as a regression", () => {
		const results: Array<{ path: string; result: Test262Result }> = [
			{ path: "failed", result: "FAILED" },
			{ path: "skipped", result: "SKIPPED" },
			{ path: "crashed", result: "CRASHED" },
			{ path: "timeout", result: "TIMEOUT" },
			{ path: "compile", result: "COMPILE_FAILED" },
			{ path: "passed", result: "PASSED" },
		];
		const files = new Map(results.map(({ path }) => [path, file(path)]));
		const previous = Object.fromEntries(
			results.map(({ path }) => [path, "PASSED"] as const),
		);

		expect(test262BatchRegressions(results, files, previous, "strict")).toEqual([
			"failed",
			"skipped",
			"crashed",
			"timeout",
			"compile",
		]);
	});

	it("ignores intentional variant skips and tests without a passing baseline", () => {
		const noStrict = file("no-strict", ["noStrict"]);
		const newFailure = file("new-failure");
		const files = new Map([
			[noStrict.path, noStrict],
			[newFailure.path, newFailure],
		]);

		expect(
			test262BatchRegressions(
				[
					{ path: noStrict.path, result: "SKIPPED" },
					{ path: newFailure.path, result: "FAILED" },
				],
				files,
				{ "no-strict": "PASSED", "new-failure": "FAILED" },
				"strict",
			),
		).toEqual([]);
	});

	it("detects folded regressions after strict and sloppy passes", () => {
		expect(
			test262FoldedRegressions(
				new Map([
					["passed", "PASSED"],
					["failed", "FAILED"],
					["skipped", "SKIPPED"],
				]),
				{ passed: "PASSED", failed: "PASSED", skipped: "PASSED" },
			),
		).toEqual(["failed", "skipped"]);
	});
});
