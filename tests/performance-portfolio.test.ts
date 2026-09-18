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
	aggregateUncertainty: {
		method: "independent-within-family-paired-bootstrap",
		confidenceLevel: 0.95,
		iterations: 2_000,
		seed: 1,
	},
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

function measuredOutcome(
	id: PortfolioOutcome["id"],
	path: string,
	direction: MetricResult["direction"],
	medianRegressionPercent: number,
	status: MetricResult["status"],
	samples: MetricResult["samples"],
): PortfolioOutcome {
	return {
		id,
		status: "complete",
		primary: {
			path,
			direction,
			thresholdPercent: 2,
			medianRegressionPercent,
			confidenceInterval: [medianRegressionPercent, medianRegressionPercent],
			status,
			samples,
		},
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

	it("uses aggregate uncertainty instead of vetoing an inconclusive family", () => {
		const decision = classifyPortfolio(config, [
			outcome("compiler-app", -20, "inconclusive"),
			outcome("app-batch", 0, "unchanged"),
		]);
		expect(decision.status).toBe("improvement");
		expect(decision.confidenceInterval?.[0]).toBeGreaterThan(0);
	});

	it("is invariant to family and outcome ordering", () => {
		const outcomes = [
			outcome("compiler-app", -20, "inconclusive"),
			outcome("app-batch", 5, "inconclusive"),
		];
		expect(classifyPortfolio(config, outcomes)).toEqual(
			classifyPortfolio(
				{ ...config, families: [...config.families].reverse() },
				[...outcomes].reverse(),
			),
		);
	});

	it("does not turn bootstrap resamples into family weights", () => {
		const compiler = outcome("compiler-app", -20, "improvement");
		const batch = outcome("app-batch", 0, "unchanged");
		const decision = classifyPortfolio(config, [
			{
				...compiler,
				primary: { ...compiler.primary!, samples: compiler.primary!.samples.slice(0, 2) },
			},
			batch,
		]);
		expect(decision.netImprovementPercent).toBeCloseTo(10.56, 1);
		expect(decision.familyContributions.map(({ weight }) => weight)).toEqual([1, 1]);
		expect(decision.familyContributions.map(({ sampleCount }) => sampleCount)).toEqual([
			3, 2,
		]);
	});

	it("keeps an aggregate whose interval crosses zero inconclusive", () => {
		const noisy = outcome("compiler-app", 0, "inconclusive");
		const steady = outcome("app-batch", 0, "unchanged");
		const decision = classifyPortfolio(config, [
			{
				...noisy,
				primary: {
					...noisy.primary!,
					samples: [
						{ base: 100, head: 80 },
						{ base: 100, head: 120 },
					],
				},
			},
			steady,
		]);
		expect(decision.status).toBe("inconclusive");
		expect(decision.confidenceInterval?.[0]).toBeLessThan(0);
		expect(decision.confidenceInterval?.[1]).toBeGreaterThan(0);
	});

	it("lets a family hard guardrail veto an aggregate gain", () => {
		const decision = classifyPortfolio(config, [
			outcome("compiler-app", -50, "improvement"),
			outcome("app-batch", 20, "regression"),
		]);
		expect(decision.status).toBe("regression");
		expect(decision.hardRegressions).toEqual(["app-batch"]);
	});

	it("classifies the completed five-family evidence through the aggregate", () => {
		const primaryMetrics = {
			"compiler-app": "compiler-app.wallMs",
			"app-batch": "app-batch.wallMs",
			javascript: "javascript.modes.closed-compiled.wallMs",
			http: "http.express.workloads.routes.malRps",
			"self-compile": "self-compile.wallMs",
		} as const;
		const completeConfig: PortfolioConfig = {
			...config,
			families: Object.entries(primaryMetrics).map(([id, primaryMetric]) => ({
				id: id as PortfolioFamily["id"],
				runner: id === "javascript" || id === "http" ? "benchmark" : "quick",
				weight: 1,
				primaryMetric,
				maxRegressionPercent: 15,
				budgetSeconds: 60,
			})),
		};
		const decision = classifyPortfolio(completeConfig, [
			measuredOutcome(
				"compiler-app",
				primaryMetrics["compiler-app"],
				"lower",
				1.0435720413669451,
				"inconclusive",
				[
					{ base: 6802.006982000003, head: 6940.628947999998 },
					{ base: 6914.5722650000025, head: 6917.973353000001 },
				],
			),
			measuredOutcome(
				"app-batch",
				primaryMetrics["app-batch"],
				"lower",
				-0.7252408761081766,
				"unchanged",
				[
					{ base: 739.3974770000059, head: 743.4237330000033 },
					{ base: 754.0470260000002, head: 739.0036839999957 },
				],
			),
			measuredOutcome(
				"javascript",
				primaryMetrics.javascript,
				"lower",
				-11.003039855416375,
				"improvement",
				[
					{ base: 2399.970431, head: 2169.171146 },
					{ base: 2426.172069, head: 2125.585742 },
				],
			),
			measuredOutcome(
				"http",
				primaryMetrics.http,
				"higher",
				-4.908286368000231,
				"improvement",
				[
					{ base: 9129.009051780326, head: 9970.692336234493 },
					{ base: 10122.026176290765, head: 10182.42400953002 },
				],
			),
			measuredOutcome(
				"self-compile",
				primaryMetrics["self-compile"],
				"lower",
				1.330729857903346,
				"inconclusive",
				[
					{ base: 447392.2236879999, head: 458418.32346400013 },
					{ base: 454459.41125799995, head: 455354.3929290003 },
				],
			),
		]);
		expect(decision.status).toBe("improvement");
		expect(decision.netImprovementPercent).toBeCloseTo(2.8869, 3);
		expect(decision.confidenceInterval?.[0]).toBeGreaterThan(1.5);
		expect(decision.confidenceInterval?.[1]).toBeLessThan(4.3);
		expect(decision.warnings).toHaveLength(1);
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
