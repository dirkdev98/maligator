import { expect, test } from "vitest";
import {
	collectJavascriptHistory,
	collectSelfCompileHistory,
	changesOnly,
	isoWeekKey,
	javascriptMetricsForSite,
	latestPerWeek,
	since,
	summarizeTest262,
} from "../scripts/site-data.ts";
import type { SelfCompileMetrics } from "../scripts/site-data.ts";

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

test("JavaScript v2 snapshots do not replace website v1 metrics", () => {
	const baseline = javascriptBaseline(1_300);
	const v2 = { ...baseline.javascript, workload: "javascript-v2" };
	expect(javascriptMetricsForSite({ schema: 3, javascriptV2: v2 })).toBeUndefined();
	expect(javascriptMetricsForSite({ ...baseline, javascriptV2: v2 })).toEqual(
		javascriptMetricsForSite(baseline),
	);
	expect(javascriptMetricsForSite({ ...baseline, javascript: v2 })).toBeUndefined();
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

test("JavaScript history distinguishes measured sources from baseline records without moving unchanged points", () => {
	const source = { commit: "1".repeat(40), dirty: false };
	const first = javascriptBaseline(1_300);
	const measured = javascriptBaseline(1_100, { source });
	const revisions = [
		{ commit: "aaaaaaaa1111", date: "2026-08-25T10:00:00Z", value: first },
		{
			commit: "bbbbbbbb2222",
			date: "2026-08-26T10:00:00Z",
			value: javascriptBaseline(1_300, { source }),
		},
		{ commit: "cccccccc3333", date: "2026-08-27T10:00:00Z", value: measured },
	];
	const points = collectJavascriptHistory(
		revisions,
		javascriptBaseline(1_100, { source: { commit: "2".repeat(40), dirty: true } }),
		"dddddddd",
		new Date("2026-08-28T10:00:00Z"),
	);
	expect(
		points.map(({ commit, date, source, preview }) => ({
			commit,
			date,
			source,
			preview,
		})),
	).toEqual([
		{
			commit: "aaaaaaaa",
			date: "2026-08-25T10:00:00Z",
			source: undefined,
			preview: undefined,
		},
		{ commit: "cccccccc", date: "2026-08-27T10:00:00Z", source, preview: undefined },
	]);
	const preview = collectJavascriptHistory(
		revisions,
		javascriptBaseline(1_050, { source: { commit: "2".repeat(40), dirty: true } }),
		"dddddddd",
		new Date("2026-08-28T10:00:00Z"),
	).at(-1);
	expect(preview).toMatchObject({
		commit: "dddddddd",
		source: { commit: "2".repeat(40), dirty: true },
		preview: true,
		closedCompiledMs: 1_050,
	});
});

test("benchmark history does not infer measured source or clean state from incomplete provenance", () => {
	for (const [source, expected] of [
		[undefined, undefined],
		[{ commit: null, dirty: false }, undefined],
		[{ commit: "not-a-commit" }, undefined],
		[{ commit: "1".repeat(40) }, { commit: "1".repeat(40) }],
	] as const) {
		const points = collectJavascriptHistory(
			[],
			javascriptBaseline(1_300, { source }),
			"aaaaaaaa",
			new Date("2026-08-25T10:00:00Z"),
		);
		expect(points[0]?.source).toEqual(expected);
	}
});

test("self-compile history carries measured source only on its unchanged metric identity", () => {
	const metrics: SelfCompileMetrics = {
		world: "closed",
		maligatorMs: 1_000,
		nodeMs: 800,
		maligatorPhases: { graphMs: 10, semanticMs: 20, emitMs: 30, writeMs: 40 },
		nodePhases: { graphMs: 5, semanticMs: 10, emitMs: 15, writeMs: 20 },
		runs: 5,
		units: 3,
		maligatorCodeUnits: 100,
		nodeCodeUnits: 100,
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "v26.10.0",
	};
	const source = { commit: "1".repeat(40), dirty: false };
	const measured = { selfCompile: { ...metrics, maligatorMs: 900 }, source };
	const revisions = [
		{
			commit: "aaaaaaaa1111",
			date: "2026-08-25T10:00:00Z",
			value: { selfCompile: metrics },
		},
		{
			commit: "bbbbbbbb2222",
			date: "2026-08-26T10:00:00Z",
			value: { selfCompile: metrics, source },
		},
		{ commit: "cccccccc3333", date: "2026-08-27T10:00:00Z", value: measured },
	];
	const points = collectSelfCompileHistory(
		revisions,
		{ ...measured, source: { commit: "2".repeat(40), dirty: true } },
		"dddddddd",
		new Date("2026-08-28T10:00:00Z"),
	);
	expect(
		points.map(({ commit, date, source, preview }) => ({
			commit,
			date,
			source,
			preview,
		})),
	).toEqual([
		{
			commit: "aaaaaaaa",
			date: "2026-08-25T10:00:00Z",
			source: undefined,
			preview: undefined,
		},
		{ commit: "cccccccc", date: "2026-08-27T10:00:00Z", source, preview: undefined },
	]);
	expect(
		collectSelfCompileHistory(
			revisions,
			{ selfCompile: { ...metrics, maligatorMs: 850 }, source },
			"dddddddd",
			new Date("2026-08-28T10:00:00Z"),
		).at(-1),
	).toMatchObject({
		commit: "dddddddd",
		date: "2026-08-28T10:00:00.000Z",
		preview: true,
		source,
		maligatorMs: 850,
	});
});

test("benchmark history leaves out baselines measured on CI runners", () => {
	const workstation = { commit: "1".repeat(40), dirty: false };
	const runner = { ...workstation, recorder: "github-actions" };
	const legacyRunner = {
		...workstation,
		digest: "4449052bf96a94e355771ec49fc4318ea42393aaea1e2eb4f4429a8dc1d4c391",
	};
	const revisions = [
		{
			commit: "aaaaaaaa1111",
			date: "2026-08-25T10:00:00Z",
			value: javascriptBaseline(1_300, { source: workstation }),
		},
		{
			commit: "bbbbbbbb2222",
			date: "2026-08-26T10:00:00Z",
			value: javascriptBaseline(900, { source: legacyRunner }),
		},
		{
			commit: "cccccccc3333",
			date: "2026-08-27T10:00:00Z",
			value: javascriptBaseline(1_100, { source: workstation }),
		},
	];
	const points = collectJavascriptHistory(
		revisions,
		javascriptBaseline(800, { source: runner }),
		"dddddddd",
		new Date("2026-08-28T10:00:00Z"),
	);
	expect(
		points.map(({ commit, closedCompiledMs }) => [commit, closedCompiledMs]),
	).toEqual([
		["aaaaaaaa", 1_300],
		["cccccccc", 1_100],
	]);
	const selfCompile: SelfCompileMetrics = {
		world: "closed",
		maligatorMs: 1_000,
		nodeMs: 800,
		maligatorPhases: { graphMs: 10, semanticMs: 20, emitMs: 30, writeMs: 40 },
		nodePhases: { graphMs: 5, semanticMs: 10, emitMs: 15, writeMs: 20 },
		runs: 5,
		units: 3,
		maligatorCodeUnits: 100,
		nodeCodeUnits: 100,
		platform: "linux",
		arch: "x64",
		nodeVersion: "v26.12.0",
	};
	expect(
		collectSelfCompileHistory(
			[
				{
					commit: "eeeeeeee4444",
					date: "2026-08-29T10:00:00Z",
					value: { selfCompile, source: runner },
				},
			],
			{ selfCompile, source: runner },
			"ffffffff",
			new Date("2026-08-30T10:00:00Z"),
		),
	).toEqual([]);
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
