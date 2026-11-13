import { describe, expect, it } from "vitest";
import { test262BaselineFromReport } from "../scripts/test262-baseline.ts";
import type { Test262Output } from "../src/test262/types.ts";

const corpus = {
	revision: "pinned-revision",
	tree: "pinned-tree",
	paths: new Set(["test/pass.js", "test/fail.js", "test/skip.js"]),
};
const previous: Test262Output = {
	sha: corpus.revision,
	summary: { PASSED: 1, FAILED: 1, SKIPPED: 1 },
	results: {
		"test/pass.js": "PASSED",
		"test/fail.js": "FAILED",
		"test/skip.js": "SKIPPED",
	},
};

function combinedReport(): Record<string, unknown> {
	return {
		schemaVersion: 3,
		corpus: { revision: corpus.revision, tree: corpus.tree },
		backend: "compiled",
		mode: "normal",
		policy: "complete",
		complete: true,
		selectedTests: 3,
		baseline: {
			path: "/remote/tmp/baseline.json",
			digest: "head-baseline-digest",
		},
		summary: { PASSED: 2, SKIPPED: 1 },
		skips: { "test/skip.js": "requires CanBlock=true" },
		code: { compiledFiles: 4, functionCount: 10, instructionCount: 25 },
		regressions: [],
		results: {
			"test/pass.js": "PASSED",
			"test/fail.js": "PASSED",
			"test/skip.js": "SKIPPED",
		},
	};
}

function importReport(report: unknown, accepted: ReadonlyArray<string> = []) {
	return test262BaselineFromReport(
		report,
		corpus,
		previous,
		"head-baseline-digest",
		new Set(accepted),
	);
}

function regressedReport(): Record<string, unknown> {
	const results = { ...previous.results, "test/pass.js": "FAILED" };
	const summary = Object.values(results).reduce<Record<string, number>>(
		(counts, value) => {
			counts[value] = (counts[value] ?? 0) + 1;
			return counts;
		},
		{},
	);
	return { ...combinedReport(), results, summary };
}

describe("Test262 baseline report import", () => {
	it("imports the complete queue result against the matching HEAD baseline content", () => {
		expect(importReport(combinedReport())).toEqual({
			sha: "pinned-revision",
			summary: { PASSED: 2, SKIPPED: 1 },
			skips: { "test/skip.js": "requires CanBlock=true" },
			code: { compiledFiles: 4, functionCount: 10, instructionCount: 25 },
			results: {
				"test/pass.js": "PASSED",
				"test/fail.js": "PASSED",
				"test/skip.js": "SKIPPED",
			},
		});
	});

	it.each([
		{ schemaVersion: 2, variant: "strict" },
		{ backend: "wire" },
		{ mode: "gc-stress" },
		{ policy: "bail" },
		{ complete: false },
	])("rejects incompatible or unfinished execution dimensions %j", (change) => {
		expect(() => importReport({ ...combinedReport(), ...change })).toThrow(
			"complete compiled/normal combined",
		);
	});

	it("rejects a report compared against a different baseline", () => {
		const report = {
			...combinedReport(),
			baseline: { digest: "old-baseline" },
		};
		expect(() => importReport(report)).toThrow("current HEAD baseline");
		expect(() =>
			test262BaselineFromReport(
				combinedReport(),
				{ ...corpus, revision: "different-corpus" },
				previous,
				"head-baseline-digest",
			),
		).toThrow("pinned corpus");
	});

	it("migrates a complete candidate report while preserving the old baseline comparison", () => {
		const candidate = { ...corpus, revision: "next-revision", tree: "next-tree" };
		const report = { ...combinedReport(), corpus: candidate };
		const imported = test262BaselineFromReport(
			report,
			candidate,
			previous,
			"head-baseline-digest",
		);
		expect(imported.sha).toBe(candidate.revision);
		expect(imported.results).toEqual(combinedReport().results);
		expect(() =>
			test262BaselineFromReport(
				{ ...report, corpus: { ...candidate, tree: "substituted-tree" } },
				candidate,
				previous,
				"head-baseline-digest",
			),
		).toThrow("pinned corpus revision and tree");
	});

	it.each([
		{ selectedTests: 2 },
		{ results: { "test/pass.js": "PASSED" } },
		{
			results: {
				"test/pass.js": "PASSED",
				"test/fail.js": "PASSED",
				"test/other-corpus.js": "SKIPPED",
			},
		},
	])("rejects partial or substituted corpus coverage %j", (change) => {
		expect(() => importReport({ ...combinedReport(), ...change })).toThrow(
			"every test in the pinned corpus",
		);
	});

	it.each(["FAILED", "SKIPPED"])(
		"detects a passing test becoming %s even when the report claims no regressions",
		(result) => {
			const results = { ...previous.results, "test/pass.js": result };
			const summary = Object.values(results).reduce<Record<string, number>>(
				(counts, value) => {
					counts[value] = (counts[value] ?? 0) + 1;
					return counts;
				},
				{},
			);
			expect(() => importReport({ ...combinedReport(), results, summary })).toThrow(
				"1 unresolved regression(s): test/pass.js",
			);
		},
	);

	it("imports an explicitly accepted regression as a failure", () => {
		expect(
			importReport(regressedReport(), ["test/pass.js"]).results["test/pass.js"],
		).toBe("FAILED");
	});

	it("rejects an accepted regression the report does not contain", () => {
		expect(() => importReport(combinedReport(), ["test/pass.js"])).toThrow(
			"accepted regression(s) not regressed in this report: test/pass.js",
		);
	});

	it.each([
		{ summary: { PASSED: 3 } },
		{ skips: {} },
		{ skips: { "test/pass.js": "unexpected skip" } },
		{ code: { compiledFiles: 4, functionCount: -1, instructionCount: 25 } },
		{ code: { compiledFiles: 4, functionCount: 10 } },
		{ results: { ...previous.results, "test/fail.js": "UNKNOWN" } },
	])("rejects corrupt result metadata %j", (change) => {
		expect(() => importReport({ ...combinedReport(), ...change })).toThrow();
	});
});
