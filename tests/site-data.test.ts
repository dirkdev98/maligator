import { expect, test } from "vitest";
import {
	collectJavascriptHistory,
	changesOnly,
	isoWeekKey,
	javascriptMetricsForSite,
	latestPerWeek,
	since,
	summarizeTest262,
} from "../scripts/site-data.ts";

function javascriptBaseline(
	closedCompiledMs: number,
	overrides: Record<string, unknown> = {},
) {
	return {
		schema: 3,
		javascript: {
			workload: "javascript-v1",
			runs: 7,
			nativeBuild: {
				mode: "production",
				optimizationFlags: ["-O2", "-g0", "-flto=thin"],
				lto: true,
				strip: true,
				compiler: "/usr/bin/cc",
				compilerVersion: "Apple clang 17",
				target: "aarch64-apple-darwin",
			},
			node: { wallMs: 400 },
			modes: {
				"closed-compiled": {
					wallMs: closedCompiledMs,
					world: "closed",
					backend: "compiled",
					ratio: 3,
				},
				"open-compiled": {
					wallMs: 2_000,
					world: "open",
					backend: "compiled",
					ratio: 5,
				},
				"closed-interpreted": {
					wallMs: 4_000,
					world: "closed",
					backend: "interpreted",
					ratio: 10,
				},
				"open-interpreted": {
					wallMs: 6_000,
					world: "open",
					backend: "interpreted",
					ratio: 15,
				},
			},
		},
		...overrides,
	};
}

test("benchmark history retains each changed commit and skips unrelated snapshots", () => {
	const points = changesOnly(
		[
			{ commit: "a", value: 100 },
			{ commit: "b", value: 100 },
			{ commit: "c", value: 90 },
			{ commit: "d", value: 90 },
			{ commit: "e", value: 100 },
		],
		(point) => point.value,
	);
	expect(points.map((point) => point.commit)).toEqual(["a", "c", "e"]);
});

test("JavaScript site metrics accept only the complete production benchmark contract", () => {
	const metrics = javascriptMetricsForSite(javascriptBaseline(1_300));
	expect(metrics).toMatchObject({
		workload: "javascript-v1",
		runs: 7,
		closedCompiledMs: 1_300,
		openCompiledMs: 2_000,
		closedInterpretedMs: 4_000,
		openInterpretedMs: 6_000,
	});
	expect(JSON.stringify(metrics)).not.toMatch(/node|ratio/i);
	expect(
		javascriptMetricsForSite(javascriptBaseline(1_300, { schema: 2 })),
	).toBeUndefined();
	expect(
		javascriptMetricsForSite({
			...javascriptBaseline(1_300),
			javascript: {
				...javascriptBaseline(1_300).javascript,
				modes: {},
			},
		}),
	).toBeUndefined();
});

test("JavaScript history skips unchanged snapshots and appends a changed preview", () => {
	const first = javascriptBaseline(1_300);
	const faster = javascriptBaseline(1_100);
	const preview = javascriptBaseline(1_050);
	const points = collectJavascriptHistory(
		[
			{ commit: "aaaaaaaa1111", date: "2026-08-25T10:00:00Z", value: first },
			{ commit: "bbbbbbbb2222", date: "2026-08-26T10:00:00Z", value: first },
			{ commit: "cccccccc3333", date: "2026-08-27T10:00:00Z", value: faster },
		],
		preview,
		"dddddddd",
		new Date("2026-08-28T10:00:00Z"),
	);
	expect(points.map(({ commit }) => commit)).toEqual([
		"aaaaaaaa",
		"cccccccc",
		"dddddddd",
	]);
	expect(points.at(-1)).toMatchObject({
		closedCompiledMs: 1_050,
		date: "2026-08-28T10:00:00.000Z",
		preview: true,
	});
});

test("Test262 site summary keeps skips separate and folds all failure modes", () => {
	expect(
		summarizeTest262({
			PASSED: 80,
			FAILED: 4,
			SKIPPED: 5,
			UNSUPPORTED: 6,
			COMPILE_FAILED: 3,
			CRASHED: 2,
		}),
	).toEqual({ passed: 80, failed: 15, skipped: 5, percent: 80 });
});

test("site history retains the latest authoritative point in each ISO week", () => {
	const points = latestPerWeek([
		{ date: "2026-01-04T23:00:00Z", value: "old-week" },
		{ date: "2026-01-05T08:00:00Z", value: "monday" },
		{ date: "2026-01-11T19:00:00Z", value: "sunday-latest" },
		{ date: "2026-01-12T08:00:00Z", value: "next-week" },
	]);
	expect(points.map((point) => point.value)).toEqual([
		"old-week",
		"sunday-latest",
		"next-week",
	]);
	expect(isoWeekKey("2026-01-05T08:00:00Z")).toBe("2026-W02");
	expect(isoWeekKey("2026-01-11T19:00:00Z")).toBe("2026-W02");
});

test("site history can start at an explicit measurement", () => {
	const points = [
		{ date: "2026-06-06T23:59:59Z", value: "before" },
		{ date: "2026-06-07T00:00:00Z", value: "start" },
		{ date: "2026-06-14T00:00:00Z", value: "after" },
	];
	expect(since(points, "2026-06-07T00:00:00Z").map((point) => point.value)).toEqual([
		"start",
		"after",
	]);
});
