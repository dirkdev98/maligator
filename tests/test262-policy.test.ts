import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	parseTest262Policy,
	resolveTest262ObjectCache,
	test262BatchRegressions,
	test262FoldedRegressions,
	test262RuntimeVerdict,
	test262SkipReason,
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
	it("rejects a malformed explicit baseline before compiling or executing tests", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test262-baseline-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		const baseline = path.join(directory, "baseline.json");
		writeFileSync(baseline, "{}");
		const run = spawnSync(
			process.execPath,
			["scripts/test262.ts", "--baseline", baseline, "--filter", "unused"],
			{ encoding: "utf8" },
		);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("invalid Test262 baseline");
		expect(run.stdout).not.toContain("Revision:");
	});
	it.each([
		["--check", "--update-baseline"],
		["--canonical", "--update-baseline", "--variant", "strict"],
		["--canonical", "--update-baseline", "--manifest", "missing.txt"],
		["--canonical", "--update-baseline", "--backend", "wire"],
	])(
		"rejects ambiguous or partial baseline updates %j before running tests",
		(...args) => {
			const run = spawnSync(process.execPath, ["scripts/test262.ts", ...args], {
				encoding: "utf8",
			});
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("--update-baseline");
			expect(run.stdout).not.toContain("[test262]");
		},
	);
	it("bounds full-corpus scratch while retaining partial object caches", () => {
		expect(resolveTest262ObjectCache(undefined, false)).toBe("0");
		expect(resolveTest262ObjectCache(undefined, true)).toBe("1");
		expect(resolveTest262ObjectCache("1", false)).toBe("1");
		expect(resolveTest262ObjectCache("0", true)).toBe("0");
	});

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
		expect(test262RunsInVariant(file("raw", ["raw"]), "sloppy")).toBe(true);
		expect(test262RunsInVariant(file("raw", ["raw"]), "strict")).toBe(false);
		expect(test262RunsInVariant(file("raw-module", ["raw", "module"]), "strict")).toBe(
			true,
		);
		expect(test262RunsInVariant(file("raw-module", ["raw", "module"]), "sloppy")).toBe(
			false,
		);
	});

	it("uses native constructor evidence for runtime-negative tests", () => {
		const negative = file("runtime-negative");
		negative.frontmatter.negative = { phase: "runtime", type: "TypeError" };

		expect(
			test262RuntimeVerdict(
				negative,
				[
					"Uncaught RangeError: misleading text",
					"##COMPLETION runtime THROW 547970654572726f72",
				],
				1,
			),
		).toEqual({ passed: true, reason: "" });
		expect(
			test262RuntimeVerdict(
				negative,
				["Uncaught TypeError: spoofed string", "##COMPLETION runtime THROW -"],
				1,
			).passed,
		).toBe(false);
		expect(
			test262RuntimeVerdict(negative, ["##COMPLETION runtime NORMAL"], 0).passed,
		).toBe(false);
		expect(
			test262RuntimeVerdict(
				negative,
				["##COMPLETION harness THROW 547970654572726f72"],
				1,
			).passed,
		).toBe(false);
		expect(
			test262RuntimeVerdict(negative, ["Uncaught TypeError: no evidence"], 1).passed,
		).toBe(false);
	});

	it("requires normal completion as well as async success", () => {
		const asyncFile = file("async", ["async"]);
		expect(
			test262RuntimeVerdict(
				asyncFile,
				["Test262:AsyncTestComplete", "##COMPLETION runtime NORMAL"],
				0,
			).passed,
		).toBe(true);
		expect(
			test262RuntimeVerdict(
				asyncFile,
				["Test262:AsyncTestComplete", "##COMPLETION runtime THROW 4572726f72"],
				1,
			).passed,
		).toBe(false);
		expect(
			test262RuntimeVerdict(
				asyncFile,
				["Test262:AsyncTestComplete", "##COMPLETION runtime NORMAL"],
				1,
			).passed,
		).toBe(false);
		expect(
			test262RuntimeVerdict(
				asyncFile,
				[
					"Test262:AsyncTestFailure:Test262Error: failed",
					"Test262:AsyncTestComplete",
					"##COMPLETION runtime NORMAL",
				],
				0,
			).passed,
		).toBe(false);
		expect(
			test262RuntimeVerdict(asyncFile, ["##COMPLETION runtime NORMAL"], 0).passed,
		).toBe(false);
	});

	it("reports blocking-host tests as inapplicable", () => {
		for (const variant of ["strict", "sloppy"] as const) {
			expect(test262SkipReason(file("blocking", ["CanBlockIsTrue"]), variant)).toContain(
				"CanBlock=false",
			);
			expect(
				test262SkipReason(file("nonblocking", ["CanBlockIsFalse"]), variant),
			).toBeUndefined();
		}
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
