import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMetricSamples, runBenchmarkComparison } from "./bench-compare.ts";
import type { MetricResult, MetricSample } from "./bench-compare.ts";
import { runBoundedProcess } from "./performance-process.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORTFOLIO_FILE = path.join(REPOSITORY_ROOT, "bench/performance-portfolio.json");

type PortfolioFamilyId =
	| "compiler-app"
	| "app-batch"
	| "javascript"
	| "http"
	| "self-compile";

export interface PortfolioFamily {
	readonly id: PortfolioFamilyId;
	readonly runner: "quick" | "benchmark";
	readonly weight: number;
	readonly primaryMetric: string;
	readonly maxRegressionPercent: number;
	readonly budgetSeconds: number;
}

export interface PortfolioConfig {
	readonly schema: 1;
	readonly version: string;
	readonly decisionThresholdPercent: number;
	readonly families: ReadonlyArray<PortfolioFamily>;
}

export interface PortfolioOutcome {
	readonly id: PortfolioFamilyId;
	readonly status: "complete" | "incomplete" | "failed";
	readonly evidence?: string;
	readonly primary?: MetricResult;
	readonly metrics?: ReadonlyArray<MetricResult>;
	readonly error?: string;
}

export interface PortfolioDecision {
	readonly status:
		| "improvement"
		| "regression"
		| "unchanged"
		| "inconclusive"
		| "incomplete";
	readonly netImprovementPercent: number | null;
	readonly hardRegressions: ReadonlyArray<string>;
	readonly missingFamilies: ReadonlyArray<string>;
}

interface Options {
	readonly baseline: string;
	readonly families: ReadonlyArray<PortfolioFamilyId>;
	readonly pairs: number;
	readonly budgetSeconds: number;
	readonly output: string;
	readonly plan: boolean;
}

const HELP = `Usage: npm run bench:performance -- portfolio --baseline REF [options]

Options:
  --family ID              select a family; repeatable (default: complete portfolio)
  --pairs N                alternating baseline/candidate pairs (default: 3)
  --budget-seconds N       whole portfolio budget (default: 1800)
  --output DIRECTORY       evidence directory
  --plan=json              print fixed weights and planned runners without writing
`;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Readonly<Record<string, unknown>>;
}

function loadPortfolio(): PortfolioConfig {
	const raw: unknown = JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8"));
	const config = record(raw, "performance portfolio");
	if (
		config.schema !== 1 ||
		typeof config.version !== "string" ||
		typeof config.decisionThresholdPercent !== "number" ||
		!Array.isArray(config.families)
	) {
		throw new Error("performance portfolio schema is not supported");
	}
	const ids = new Set<string>();
	const families = config.families.map((value) => {
		const family = record(value, "performance portfolio family");
		if (
			(family.id !== "compiler-app" &&
				family.id !== "app-batch" &&
				family.id !== "javascript" &&
				family.id !== "http" &&
				family.id !== "self-compile") ||
			(family.runner !== "quick" && family.runner !== "benchmark") ||
			typeof family.weight !== "number" ||
			family.weight <= 0 ||
			typeof family.primaryMetric !== "string" ||
			typeof family.maxRegressionPercent !== "number" ||
			typeof family.budgetSeconds !== "number"
		) {
			throw new Error("performance portfolio contains an invalid family");
		}
		if (ids.has(family.id)) throw new Error(`portfolio repeats family: ${family.id}`);
		ids.add(family.id);
		return family as unknown as PortfolioFamily;
	});
	return {
		schema: 1,
		version: config.version,
		decisionThresholdPercent: config.decisionThresholdPercent,
		families,
	};
}

function required(args: ReadonlyArray<string>, index: number, option: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`${option} requires a positive integer`);
	}
	return parsed;
}

function parseOptions(
	args: ReadonlyArray<string>,
	config: PortfolioConfig,
): Options | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return undefined;
	}
	let baseline: string | undefined;
	let pairs = 3;
	let budgetSeconds = 1800;
	let output = path.join(
		REPOSITORY_ROOT,
		".cache/performance/portfolio",
		`${Date.now()}-${process.pid}`,
	);
	let plan = false;
	const selected: Array<PortfolioFamilyId> = [];
	for (let index = 0; index < args.length; index++) {
		const option = args[index]!;
		if (option === "--baseline") {
			baseline = required(args, index, option);
			index++;
		} else if (option === "--family") {
			const id = required(args, index, option) as PortfolioFamilyId;
			if (!config.families.some((family) => family.id === id)) {
				throw new Error(`unknown portfolio family: ${id}`);
			}
			selected.push(id);
			index++;
		} else if (option === "--pairs") {
			pairs = positiveInteger(required(args, index, option), option);
			index++;
		} else if (option === "--budget-seconds") {
			budgetSeconds = positiveInteger(required(args, index, option), option);
			index++;
		} else if (option === "--output") {
			output = path.resolve(required(args, index, option));
			index++;
		} else if (option === "--plan=json") {
			plan = true;
		} else {
			throw new Error(`unknown portfolio option: ${option}`);
		}
	}
	if (baseline === undefined) throw new Error("--baseline REF is required");
	const families =
		selected.length === 0 ? config.families.map(({ id }) => id) : [...new Set(selected)];
	return { baseline, families, pairs, budgetSeconds, output, plan };
}

export function classifyPortfolio(
	config: PortfolioConfig,
	outcomes: ReadonlyArray<PortfolioOutcome>,
): PortfolioDecision {
	const outcomeById = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
	const missingFamilies = config.families
		.filter((family) => {
			const outcome = outcomeById.get(family.id);
			return outcome?.status !== "complete" || outcome.primary === undefined;
		})
		.map(({ id }) => id);
	if (missingFamilies.length > 0) {
		return {
			status: "incomplete",
			netImprovementPercent: null,
			hardRegressions: [],
			missingFamilies,
		};
	}
	const hardRegressions = config.families
		.filter(
			(family) =>
				outcomeById.get(family.id)!.primary!.medianRegressionPercent >
				family.maxRegressionPercent,
		)
		.map(({ id }) => id);
	let weightedLogRatio = 0;
	let totalWeight = 0;
	for (const family of config.families) {
		const regression = outcomeById.get(family.id)!.primary!.medianRegressionPercent;
		const candidateToBaseline = 1 + regression / 100;
		if (!(candidateToBaseline > 0)) {
			return {
				status: "inconclusive",
				netImprovementPercent: null,
				hardRegressions,
				missingFamilies: [],
			};
		}
		weightedLogRatio += family.weight * Math.log(candidateToBaseline);
		totalWeight += family.weight;
	}
	const netImprovementPercent = (1 - Math.exp(weightedLogRatio / totalWeight)) * 100;
	if (hardRegressions.length > 0) {
		return {
			status: "regression",
			netImprovementPercent,
			hardRegressions,
			missingFamilies: [],
		};
	}
	if (
		config.families.some(
			(family) => outcomeById.get(family.id)!.primary!.status === "inconclusive",
		)
	) {
		return {
			status: "inconclusive",
			netImprovementPercent,
			hardRegressions: [],
			missingFamilies: [],
		};
	}
	const status =
		netImprovementPercent >= config.decisionThresholdPercent
			? "improvement"
			: netImprovementPercent <= -config.decisionThresholdPercent
				? "regression"
				: "unchanged";
	return { status, netImprovementPercent, hardRegressions: [], missingFamilies: [] };
}

export function classifyExposedImpact(
	items: ReadonlyArray<{
		readonly baselineNs: number;
		readonly candidateNs: number;
		readonly executions?: number;
	}>,
): { readonly status: "measured" | "inconclusive"; readonly savedNs?: number } {
	if (items.some(({ executions }) => executions === undefined)) {
		return { status: "inconclusive" };
	}
	return {
		status: "measured",
		savedNs: items.reduce(
			(sum, item) => sum + item.executions! * (item.baselineNs - item.candidateNs),
			0,
		),
	};
}

export function benchmarkComparisonCompleted(exitCode: number): boolean {
	return exitCode === 0 || exitCode === 1;
}

function writeJson(file: string, value: unknown): void {
	writeFileSync(`${file}.tmp`, `${JSON.stringify(value, undefined, "\t")}\n`);
	renameSync(`${file}.tmp`, file);
}

function git(args: ReadonlyArray<string>): string {
	const result = spawnSync("git", [...args], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(String(result.stderr));
	return String(result.stdout).trim();
}

function materializeBaseline(ref: string, directory: string): string {
	const currentLock = readFileSync(
		path.join(REPOSITORY_ROOT, "package-lock.json"),
		"utf8",
	);
	if (git(["show", `${ref}:package-lock.json`]) !== currentLock.trimEnd()) {
		throw new Error("baseline and candidate dependency lockfiles differ");
	}
	const archive = path.join(directory, "baseline.tar");
	const baseline = path.join(directory, "baseline");
	const descriptor = openSync(archive, "w");
	try {
		const result = spawnSync("git", ["archive", "--format=tar", ref], {
			cwd: REPOSITORY_ROOT,
			stdio: ["ignore", descriptor, "pipe"],
			encoding: "utf8",
		});
		if (result.error !== undefined) throw result.error;
		if (result.status !== 0) throw new Error(String(result.stderr));
	} finally {
		closeSync(descriptor);
	}
	mkdirSync(baseline, { recursive: true });
	const extracted = spawnSync("tar", ["-xf", archive, "-C", baseline], {
		encoding: "utf8",
	});
	if (extracted.error !== undefined) throw extracted.error;
	if (extracted.status !== 0) throw new Error(String(extracted.stderr));
	if (existsSync(path.join(REPOSITORY_ROOT, "node_modules"))) {
		symlinkSync(
			path.join(REPOSITORY_ROOT, "node_modules"),
			path.join(baseline, "node_modules"),
		);
	}
	rmSync(archive);
	return baseline;
}

function remainingSeconds(deadline: number): number {
	return Math.max(1, Math.floor((deadline - performance.now()) / 1000));
}

async function quickOutcome(
	family: PortfolioFamily,
	options: Options,
	baseline: string,
	deadline: number,
): Promise<PortfolioOutcome> {
	const output = path.join(options.output, "families", family.id);
	const budget = Math.min(family.budgetSeconds, remainingSeconds(deadline));
	try {
		const completed = await runBoundedProcess(
			process.execPath,
			[
				path.join(REPOSITORY_ROOT, "scripts/bench-quick.ts"),
				"--baseline",
				baseline,
				"--candidate",
				REPOSITORY_ROOT,
				"--workload",
				family.id,
				"--pairs",
				String(options.pairs),
				"--budget-seconds",
				String(budget),
				"--output",
				output,
			],
			{
				cwd: REPOSITORY_ROOT,
				environment: cleanTestEnvironment(),
				timeoutMs: budget * 1_000 + 5_000,
			},
		);
		const reportPath = path.join(output, "report.json");
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
			readonly complete: boolean;
			readonly status: string;
			readonly error?: string;
			readonly pairs: ReadonlyArray<{
				readonly baseline: { readonly wallMs: number };
				readonly candidate: { readonly wallMs: number };
			}>;
		};
		if (completed.exitCode !== 0 || !report.complete) {
			return {
				id: family.id,
				status: report.status === "failed" ? "failed" : "incomplete",
				evidence: reportPath,
				error: report.error ?? completed.stderr,
			};
		}
		const samples: Array<MetricSample> = report.pairs.map((pair) => ({
			base: pair.baseline.wallMs,
			head: pair.candidate.wallMs,
		}));
		const primary = classifyMetricSamples(family.primaryMetric, samples);
		if (primary === undefined) throw new Error("quick family has no primary metric");
		return {
			id: family.id,
			status: "complete",
			evidence: reportPath,
			primary,
			metrics: [primary],
		};
	} catch (error) {
		return {
			id: family.id,
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runPortfolio(args: ReadonlyArray<string>): Promise<void> {
	const config = loadPortfolio();
	const options = parseOptions(args, config);
	if (options === undefined) return;
	const selected = config.families.filter((family) =>
		options.families.includes(family.id),
	);
	if (options.plan) {
		console.log(
			JSON.stringify(
				{
					schema: 1,
					portfolioVersion: config.version,
					baseline: options.baseline,
					families: selected,
					completePortfolio: selected.length === config.families.length,
					pairs: options.pairs,
					budgetSeconds: options.budgetSeconds,
					writes: false,
					builds: false,
				},
				undefined,
				"\t",
			),
		);
		return;
	}
	if (existsSync(options.output))
		throw new Error(`output already exists: ${options.output}`);
	mkdirSync(path.join(options.output, "families"), { recursive: true });
	const startedAt = performance.now();
	const deadline = startedAt + options.budgetSeconds * 1_000;
	const outcomes: Array<PortfolioOutcome> = [];
	const persist = (status: string) => {
		writeJson(path.join(options.output, "report.json"), {
			schema: 1,
			status,
			complete:
				selected.length === config.families.length &&
				outcomes.length === selected.length &&
				outcomes.every((outcome) => outcome.status === "complete"),
			portfolioVersion: config.version,
			configuration: config,
			selection: selected.map(({ id }) => id),
			baseline: options.baseline,
			pairs: options.pairs,
			budgetSeconds: options.budgetSeconds,
			elapsedMs: performance.now() - startedAt,
			outcomes,
			decision: classifyPortfolio(config, outcomes),
		});
	};
	persist("running");
	let baselineDirectory: string | undefined;
	try {
		const quick = selected.filter((family) => family.runner === "quick");
		if (quick.length > 0) {
			baselineDirectory = materializeBaseline(options.baseline, options.output);
			for (const family of quick) {
				if (performance.now() >= deadline) {
					outcomes.push({
						id: family.id,
						status: "incomplete",
						error: "budget exhausted",
					});
				} else {
					outcomes.push(await quickOutcome(family, options, baselineDirectory, deadline));
				}
				persist("running");
			}
		}
		const benchmark = selected.filter((family) => family.runner === "benchmark");
		if (benchmark.length > 0) {
			if (performance.now() >= deadline) {
				for (const family of benchmark) {
					outcomes.push({
						id: family.id,
						status: "incomplete",
						error: "budget exhausted",
					});
				}
			} else {
				const comparison = await runBenchmarkComparison({
					baseRef: options.baseline,
					lanes: benchmark.map(({ id }) => id),
					pairs: options.pairs,
					budgetSeconds: remainingSeconds(deadline),
					outputDirectory: path.join(options.output, "families", "benchmark"),
				});
				const completed = benchmarkComparisonCompleted(comparison.exitCode);
				for (const family of benchmark) {
					const primary = comparison.metrics.find(
						(metric) => metric.path === family.primaryMetric,
					);
					outcomes.push({
						id: family.id,
						status: completed && primary !== undefined ? "complete" : "incomplete",
						evidence: comparison.reportPath,
						...(primary === undefined ? {} : { primary }),
						metrics: comparison.metrics.filter((metric) =>
							metric.path.startsWith(
								family.id === "self-compile" ? "selfCompile." : `${family.id}.`,
							),
						),
						...(completed ? {} : { error: "benchmark comparison incomplete" }),
					});
				}
			}
		}
	} finally {
		if (baselineDirectory !== undefined) {
			rmSync(baselineDirectory, { recursive: true, force: true });
		}
	}
	const decision = classifyPortfolio(config, outcomes);
	const complete =
		selected.length === config.families.length &&
		outcomes.length === selected.length &&
		outcomes.every((outcome) => outcome.status === "complete");
	persist(complete ? "complete" : "incomplete");
	console.log(`report: ${path.join(options.output, "report.json")}`);
	if (!complete || decision.status === "incomplete") process.exitCode = 2;
}
