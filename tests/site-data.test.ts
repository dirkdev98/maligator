import { expect, test } from "vitest";
import { isoWeekKey, latestPerWeek, summarizeTest262 } from "../scripts/site-data.ts";

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
