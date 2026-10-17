import { describe, expect, it } from "vitest";
import { test262BaselineFromReport } from "../scripts/test262-baseline.ts";
import { mergeTest262ShardReports } from "../scripts/test262-merge.ts";
import type { Test262Output } from "../src/test262/types.ts";

const previous: Test262Output = {
	sha: "pinned-revision",
	summary: { PASSED: 1, FAILED: 2, SKIPPED: 1 },
	results: {
		"test/a.js": "PASSED",
		"test/b.js": "FAILED",
		"test/c.js": "SKIPPED",
		"test/d.js": "FAILED",
	},
};

function shardReport(
	index: number,
	results: Record<string, "PASSED" | "FAILED" | "SKIPPED">,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const improvements = Object.entries(results)
		.filter(
			([file, verdict]) => previous.results[file] === "FAILED" && verdict === "PASSED",
		)
		.map(([file]) => file);
	return {
		schemaVersion: 2,
		backend: "compiled",
		mode: "normal",
		policy: "complete",
		complete: true,
		selectedTests: Object.keys(results).length,
		shard: { index, count: 2, selectedTests: 4 },
		baseline: { digest: "head-baseline-digest" },
		summary: {},
		skips: Object.fromEntries(
			Object.entries(results)
				.filter(([, verdict]) => verdict === "SKIPPED")
				.map(([file]) => [file, "requires CanBlock=true"]),
		),
		code: { compiledFiles: 2, functionCount: 5, instructionCount: 11 },
		regressions: [],
		improvements,
		results,
		...overrides,
	};
}

const first = shardReport(1, { "test/a.js": "PASSED", "test/c.js": "SKIPPED" });
const second = shardReport(2, { "test/b.js": "PASSED", "test/d.js": "FAILED" });

describe("Test262 shard report merge", () => {
	it("builds the complete report the baseline import accepts", () => {
		const merged = mergeTest262ShardReports([second, first]);

		expect(merged).toMatchObject({
			selectedTests: 4,
			summary: { PASSED: 2, SKIPPED: 1, FAILED: 1 },
			code: { compiledFiles: 4, functionCount: 10, instructionCount: 22 },
			regressions: [],
			improvements: ["test/b.js"],
		});
		expect(
			test262BaselineFromReport(
				merged,
				{ revision: "pinned-revision", paths: new Set(Object.keys(previous.results)) },
				previous,
				"head-baseline-digest",
			).results,
		).toEqual({
			"test/a.js": "PASSED",
			"test/b.js": "PASSED",
			"test/c.js": "SKIPPED",
			"test/d.js": "FAILED",
		});
	});

	it("keeps every shard's regressions", () => {
		const regressed = shardReport(
			1,
			{ "test/a.js": "FAILED", "test/c.js": "SKIPPED" },
			{
				regressions: ["test/a.js"],
			},
		);

		expect(mergeTest262ShardReports([regressed, second]).regressions).toEqual([
			"test/a.js",
		]);
	});

	it.each([
		["a missing shard", [first]],
		["a repeated shard", [first, first]],
		[
			"overlapping shards",
			[first, shardReport(2, { "test/a.js": "PASSED", "test/d.js": "FAILED" })],
		],
		[
			"a different baseline",
			[first, { ...second, baseline: { digest: "older-baseline-digest" } }],
		],
		["an incomplete shard", [first, { ...second, complete: false }]],
	])("rejects %s", (_name, reports) => {
		expect(() => mergeTest262ShardReports(reports)).toThrow();
	});
});
