import { expect, test } from "vitest";
import {
	changesOnly,
	isoWeekKey,
	latestPerWeek,
	since,
	summarizeTest262,
} from "../scripts/site-data.ts";

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
