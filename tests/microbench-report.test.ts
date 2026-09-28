import { describe, expect, it } from "vitest";
import {
	formatMicrobenchReport,
	isCompleteMicrobenchReport,
} from "../scripts/microbench-report.ts";

const context = {
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	jobStatus: "success",
};
const report = {
	baseline: { commit: context.baseSha },
	candidate: { commit: context.headSha },
	status: "complete",
	complete: true,
	timingComplete: true,
	options: { pairs: 7 },
	cases: [
		{
			id: "direct-calls",
			timingComplete: true,
			summary: {
				pairs: 7,
				baselineMedianMs: 300,
				candidateMedianMs: 330,
				medianReductionPercent: -10,
				madPercentagePoints: 0.8,
				fasterPairs: 0,
			},
		},
	],
};

describe("microbench Actions summary", () => {
	it("requires completed matching evidence for a successful comparison step", () => {
		expect(isCompleteMicrobenchReport(report, context)).toBe(true);
		expect(isCompleteMicrobenchReport(undefined, context)).toBe(false);
		expect(isCompleteMicrobenchReport({ ...report, complete: false }, context)).toBe(
			false,
		);
		expect(
			isCompleteMicrobenchReport({ ...report, timingComplete: false }, context),
		).toBe(false);
		expect(
			isCompleteMicrobenchReport(report, { ...context, headSha: "c".repeat(40) }),
		).toBe(false);
		expect(isCompleteMicrobenchReport(report, { ...context, jobStatus: "failure" })).toBe(
			false,
		);
	});
	it("reports regressions and paired variability without declaring acceptance", () => {
		const result = formatMicrobenchReport(report, context);
		expect(result).toContain("Completion does not establish a performance improvement");
		expect(result).toContain(
			"| direct-calls | 7/7 | 300.000 | 330.000 | -10.00% | 0.80 | 0 |",
		);
	});

	it("distinguishes completed timing pairs from failed diagnostics", () => {
		const result = formatMicrobenchReport(
			{ ...report, status: "failed", complete: false },
			{ ...context, jobStatus: "failure" },
		);
		expect(result).toContain("failed or is incomplete");
		expect(result).toContain("All timing pairs finished");
	});

	it("does not present a different revision as the authorized comparison", () => {
		const result = formatMicrobenchReport(
			{ ...report, candidate: { commit: "c".repeat(40) } },
			context,
		);
		expect(result).toContain("Revision mismatch");
		expect(result).not.toContain("The requested comparison completed");
	});

	it("handles missing reports and partial cases explicitly", () => {
		expect(formatMicrobenchReport(undefined, context)).toContain(
			"No benchmark report was produced",
		);
		expect(
			formatMicrobenchReport(
				{
					...report,
					complete: false,
					timingComplete: false,
					cases: [{ id: "direct-calls" }],
				},
				context,
			),
		).toContain("| direct-calls | 0/7 (partial) |");
	});

	it("does not render arbitrary artifact strings as Markdown or numeric results", () => {
		const result = formatMicrobenchReport(
			{
				...report,
				cases: [
					{
						id: "[click](https://bad.example)",
						summary: {
							baselineMedianMs: "300 | injected",
							medianReductionPercent: Infinity,
						},
					},
				],
			},
			context,
		);
		expect(result).toContain("invalid-case-id");
		expect(result).not.toContain("bad.example");
		expect(result).not.toContain("injected");
		expect(result).not.toContain("Infinity");
	});
});
