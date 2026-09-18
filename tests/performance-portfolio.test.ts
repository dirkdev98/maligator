import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { MetricResult } from "../scripts/bench-compare.ts";
import {
	benchmarkComparisonCompleted,
	classifyExposedImpact,
	classifyPortfolio,
} from "../scripts/performance-portfolio.ts";
import type {
	PortfolioConfig,
	PortfolioFamily,
	PortfolioOutcome,
} from "../scripts/performance-portfolio.ts";

function metric(
	path: string,
	medianRegressionPercent: number,
	status: MetricResult["status"],
): MetricResult {
	return {
		path,
		direction: "lower",
		thresholdPercent: 2,
		medianRegressionPercent,
		confidenceInterval: [medianRegressionPercent, medianRegressionPercent],
		status,
		samples: [{ base: 100, head: 100 + medianRegressionPercent }],
	};
}

const families = [
	{
		id: "compiler-app",
		runner: "quick",
		weight: 1,
		primaryMetric: "compiler-app.wallMs",
		maxRegressionPercent: 15,
		budgetSeconds: 60,
	},
	{
		id: "app-batch",
		runner: "quick",
		weight: 1,
		primaryMetric: "app-batch.wallMs",
		maxRegressionPercent: 15,
		budgetSeconds: 60,
	},
] satisfies ReadonlyArray<PortfolioFamily>;

const config: PortfolioConfig = {
	schema: 1,
	version: "test",
	decisionThresholdPercent: 2,
	families,
};

function outcome(
	id: PortfolioOutcome["id"],
	regression: number,
	status: MetricResult["status"],
): PortfolioOutcome {
	return {
		id,
		status: "complete",
		primary: metric(`${id}.wallMs`, regression, status),
	};
}

describe("performance portfolio decisions", () => {
	it("allows a large portfolio win to outweigh a smaller related regression", () => {
		const decision = classifyPortfolio(config, [
			outcome("compiler-app", -40, "improvement"),
			outcome("app-batch", 10, "regression"),
		]);
		expect(decision.status).toBe("improvement");
		expect(decision.netImprovementPercent).toBeGreaterThan(15);
		expect(decision.hardRegressions).toEqual([]);
	});

	it("does not reweight a partial portfolio", () => {
		const decision = classifyPortfolio(config, [
			outcome("compiler-app", -40, "improvement"),
		]);
		expect(decision).toMatchObject({
			status: "incomplete",
			netImprovementPercent: null,
			missingFamilies: ["app-batch"],
		});
	});

	it("keeps impact inconclusive when exposure is unknown", () => {
		expect(
			classifyExposedImpact([
				{ baselineNs: 100, candidateNs: 50, executions: 1000 },
				{ baselineNs: 10, candidateNs: 12 },
			]),
		).toEqual({ status: "inconclusive" });
	});

	it("treats a child regression exit as completed evidence", () => {
		expect(benchmarkComparisonCompleted(0)).toBe(true);
		expect(benchmarkComparisonCompleted(1)).toBe(true);
		expect(benchmarkComparisonCompleted(2)).toBe(false);
	});

	it("plans a selected family without writing or claiming full coverage", () => {
		const plan = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"scripts/performance.ts",
					"portfolio",
					"--baseline",
					"HEAD",
					"--family",
					"javascript",
					"--plan=json",
				],
				{ encoding: "utf8" },
			),
		) as {
			readonly completePortfolio: boolean;
			readonly writes: boolean;
			readonly builds: boolean;
			readonly families: ReadonlyArray<{ readonly id: string }>;
		};
		expect(plan).toMatchObject({
			completePortfolio: false,
			writes: false,
			builds: false,
		});
		expect(plan.families.map(({ id }) => id)).toEqual(["javascript"]);
	});
});
