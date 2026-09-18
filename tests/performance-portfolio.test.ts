import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { MetricResult } from "../scripts/bench-compare.ts";
import {
	benchmarkComparisonCompleted,
	classifyExposedImpact,
	classifyPortfolio,
	materializePortfolioBaseline,
	metricCostRatio,
	portfolioExitCode,
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
	direction: MetricResult["direction"] = "lower",
	sampleCount = 3,
): MetricResult {
	return {
		path,
		direction,
		thresholdPercent: 2,
		medianRegressionPercent,
		confidenceInterval: [medianRegressionPercent, medianRegressionPercent],
		status,
		samples: Array.from({ length: sampleCount }, () => ({
			base: 100,
			head:
				direction === "lower"
					? 100 + medianRegressionPercent
					: 100 - medianRegressionPercent,
		})),
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
	minimumAcceptancePairs: 2,
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

	it("normalizes higher-is-better throughput into a comparable cost ratio", () => {
		expect(metricCostRatio(metric("http.rps", -100, "improvement", "higher"))).toBe(0.5);
		expect(metricCostRatio(metric("http.rps", 50, "regression", "higher"))).toBe(2);
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

	it("keeps a one-pair portfolio run as screening evidence", () => {
		const singlePair = outcome("compiler-app", -40, "improvement");
		expect(
			classifyPortfolio(config, [
				{
					...singlePair,
					primary: {
						...singlePair.primary!,
						samples: singlePair.primary!.samples.slice(0, 1),
					},
				},
				outcome("app-batch", -40, "improvement"),
			]),
		).toMatchObject({ status: "inconclusive", missingFamilies: [] });
	});

	it("signals the portfolio decision without conflating regressions and incomplete evidence", () => {
		expect(portfolioExitCode(true, "improvement")).toBe(0);
		expect(portfolioExitCode(true, "regression")).toBe(1);
		expect(portfolioExitCode(false, "improvement")).toBe(2);
		expect(portfolioExitCode(true, "incomplete")).toBe(2);
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
			readonly maximumPairs: number;
			readonly benchmarkScheduling: string;
			readonly benchmarkProfiles: Readonly<Record<string, string>>;
			readonly writes: boolean;
			readonly builds: boolean;
			readonly families: ReadonlyArray<{ readonly id: string }>;
		};
		expect(plan).toMatchObject({
			completePortfolio: false,
			maximumPairs: 3,
			benchmarkScheduling: "independent",
			benchmarkProfiles: { javascript: "closed-compiled" },
			writes: false,
			builds: false,
		});
		expect(plan.families.map(({ id }) => id)).toEqual(["javascript"]);
	});

	it("materializes a baseline with its own exact Git identity", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-portfolio-baseline-"));
		try {
			const baseline = materializePortfolioBaseline("HEAD", directory);
			const expected = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: path.resolve(import.meta.dirname, ".."),
				encoding: "utf8",
			}).trim();
			expect(
				execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: baseline,
					encoding: "utf8",
				}).trim(),
			).toBe(expected);
			expect(
				execFileSync("git", ["status", "--porcelain=v1"], {
					cwd: baseline,
					encoding: "utf8",
				}),
			).toBe("");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
