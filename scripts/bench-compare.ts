import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BENCHMARK_LANE_RULES: ReadonlyArray<{
	pattern: RegExp;
	lanes: ReadonlyArray<string>;
}> = [
	{ pattern: /^(scripts\/bench|bench\/)/, lanes: ["*"] },
	{
		pattern: /^src\/(ir|ir-opt|inline|escape|liveness|register-alloc|emit-c|lower-vm)/,
		lanes: ["compiler", "language", "module", "stack-object"],
	},
	{
		pattern: /^runtime\/src\/(gc|heap)/,
		lanes: [
			"gc",
			"language",
			"module",
			"string",
			"promise",
			"coroutine",
			"stack-object",
			"http",
		],
	},
	{ pattern: /^runtime\/src\/builtin_string/, lanes: ["string", "language", "http"] },
	{
		pattern: /^runtime\/src\/(builtin_promise|microtask|async_function)/,
		lanes: ["promise", "coroutine", "http"],
	},
	{
		pattern: /^runtime\/src\/(object|shape|property|table|key)/,
		lanes: ["language", "module", "stack-object", "prototype-cache", "http"],
	},
	{
		pattern: /^runtime\/src\/(runtime\/node_http|host\/|runtime\/web_)/,
		lanes: ["http"],
	},
	{
		pattern: /^(src\/|runtime\/)/,
		lanes: [
			"language",
			"module",
			"string",
			"promise",
			"coroutine",
			"arguments",
			"stack-object",
			"interpreter",
		],
	},
];

function command(
	tool: string,
	args: Array<string>,
	options: { cwd?: string; input?: string | Uint8Array; maxBuffer?: number } = {},
): string {
	const result = spawnSync(tool, args, {
		cwd: options.cwd,
		input: options.input,
		encoding: "utf-8",
		maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${tool} ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
	}
	return result.stdout ?? "";
}

export function changedFiles(baseRef: string, cwd = process.cwd()): Array<string> {
	const tracked = command("git", ["diff", "--name-only", baseRef, "--"], { cwd })
		.split("\n")
		.filter(Boolean);
	const untracked = command("git", ["ls-files", "--others", "--exclude-standard"], {
		cwd,
	})
		.split("\n")
		.filter(Boolean);
	return [...new Set([...tracked, ...untracked])].sort();
}

export function selectChangedBenchmarkLanes(
	baseRef: string,
	allLanes: ReadonlyArray<string>,
	cwd = process.cwd(),
): { files: Array<string>; lanes: Array<string> } {
	const files = changedFiles(baseRef, cwd);
	return { files, lanes: lanesForChangedFiles(files, allLanes) };
}

export function lanesForChangedFiles(
	files: ReadonlyArray<string>,
	allLanes: ReadonlyArray<string>,
): Array<string> {
	const selected = new Set<string>();
	for (const file of files) {
		for (const rule of BENCHMARK_LANE_RULES) {
			if (!rule.pattern.test(file)) continue;
			for (const lane of rule.lanes) {
				if (lane === "*") for (const value of allLanes) selected.add(value);
				else if (allLanes.includes(lane)) selected.add(lane);
			}
			break;
		}
	}
	return allLanes.filter((lane) => selected.has(lane));
}

export interface MetricSample {
	base: number;
	head: number;
}

export interface MetricResult {
	path: string;
	direction: "higher" | "lower";
	thresholdPercent: number;
	medianRegressionPercent: number;
	confidenceInterval: [number, number];
	status: "improvement" | "regression" | "unchanged" | "inconclusive";
	samples: Array<MetricSample>;
}

function flatten(value: unknown, prefix = ""): Map<string, number> {
	const result = new Map<string, number>();
	if (typeof value === "number" && Number.isFinite(value)) {
		result.set(prefix, value);
	} else if (typeof value === "object" && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			for (const [childPath, number] of flatten(
				child,
				prefix === "" ? key : `${prefix}.${key}`,
			)) {
				result.set(childPath, number);
			}
		}
	}
	return result;
}

function metricPolicy(
	metricPath: string,
):
	| { direction: "higher" | "lower"; thresholdPercent: number; minimumAbsolute?: number }
	| undefined {
	if (/(^|\.)(malRps|ratio)$/.test(metricPath))
		return { direction: "higher", thresholdPercent: 3 };
	if (/(p99|rss|Pause)/i.test(metricPath))
		return { direction: "lower", thresholdPercent: 5 };
	if (/(binaryBytes|ArchiveBytes)$/i.test(metricPath)) {
		return { direction: "lower", thresholdPercent: 0.5, minimumAbsolute: 32 * 1024 };
	}
	if (/(Ms|wallMs)$/i.test(metricPath))
		return { direction: "lower", thresholdPercent: 3 };
	return undefined;
}

function median(values: Array<number>): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function regressionPercent(sample: MetricSample, direction: "higher" | "lower"): number {
	if (sample.base === 0) return 0;
	return direction === "lower"
		? ((sample.head - sample.base) / Math.abs(sample.base)) * 100
		: ((sample.base - sample.head) / Math.abs(sample.base)) * 100;
}

function bootstrapInterval(values: Array<number>): [number, number] {
	let state = 0x9e3779b9;
	const random = (): number => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const medians: Array<number> = [];
	for (let iteration = 0; iteration < 2000; iteration++) {
		const sample: Array<number> = [];
		for (let index = 0; index < values.length; index++) {
			sample.push(values[Math.floor(random() * values.length)]!);
		}
		medians.push(median(sample));
	}
	medians.sort((left, right) => left - right);
	return [
		medians[Math.floor(medians.length * 0.025)]!,
		medians[Math.floor(medians.length * 0.975)]!,
	];
}

function classify(
	metricPath: string,
	samples: Array<MetricSample>,
): MetricResult | undefined {
	const policy = metricPolicy(metricPath);
	if (policy === undefined || samples.length === 0) return undefined;
	const changes = samples.map((sample) => regressionPercent(sample, policy.direction));
	const interval = bootstrapInterval(changes);
	const absoluteChange = median(
		samples.map((sample) => Math.abs(sample.head - sample.base)),
	);
	let status: MetricResult["status"];
	if (policy.minimumAbsolute !== undefined && absoluteChange < policy.minimumAbsolute) {
		status = "unchanged";
	} else if (
		interval[0] > policy.thresholdPercent &&
		(policy.minimumAbsolute === undefined || absoluteChange >= policy.minimumAbsolute)
	) {
		status = "regression";
	} else if (interval[1] < -policy.thresholdPercent) {
		status = "improvement";
	} else if (
		interval[0] >= -policy.thresholdPercent &&
		interval[1] <= policy.thresholdPercent
	) {
		status = "unchanged";
	} else {
		status = "inconclusive";
	}
	return {
		path: metricPath,
		direction: policy.direction,
		thresholdPercent: policy.thresholdPercent,
		medianRegressionPercent: median(changes),
		confidenceInterval: interval,
		status,
		samples,
	};
}

export function classifyMetricSamples(
	metricPath: string,
	samples: Array<MetricSample>,
): MetricResult | undefined {
	return classify(metricPath, samples);
}

function exportBase(baseRef: string, repository: string, destination: string): void {
	const currentLock = readFileSync(path.join(repository, "package-lock.json"), "utf-8");
	const baseLock = command("git", ["show", `${baseRef}:package-lock.json`], {
		cwd: repository,
	});
	if (currentLock !== baseLock) {
		throw new Error(
			"base and head package-lock.json differ; installable dependency identity is not comparable",
		);
	}
	const archive = path.join(destination, "base.tar");
	const descriptor = openSync(archive, "w");
	try {
		const result = spawnSync("git", ["archive", "--format=tar", baseRef], {
			cwd: repository,
			stdio: ["ignore", descriptor, "pipe"],
			encoding: "utf-8",
		});
		if (result.status !== 0) throw new Error(`git archive failed: ${result.stderr}`);
	} finally {
		closeSync(descriptor);
	}
	const base = path.join(destination, "base");
	mkdirSync(base, { recursive: true });
	command("tar", ["-xf", archive, "-C", base]);
	if (existsSync(path.join(repository, "node_modules"))) {
		symlinkSync(
			path.join(repository, "node_modules"),
			path.join(base, "node_modules"),
			"dir",
		);
	}
}

function runSnapshot(
	repository: string,
	lanes: Array<string>,
	extraArgs: Array<string>,
	temporaryRoot: string,
	label: string,
): unknown {
	const output = path.join(temporaryRoot, `${label}.json`);
	const result = spawnSync(
		process.execPath,
		["scripts/bench.ts", ...lanes, "--runs", "1", "--json-out", output, ...extraArgs],
		{
			cwd: repository,
			env: { ...process.env, NO_COLOR: "true" },
			encoding: "utf-8",
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${label} benchmark failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	}
	return JSON.parse(readFileSync(output, "utf-8")) as unknown;
}

export function runBenchmarkComparison(options: {
	baseRef: string;
	lanes: Array<string>;
	pairs: number;
	maxPairs?: number;
	extraArgs?: Array<string>;
	repository?: string;
}): { exitCode: number; reportPath: string; metrics: Array<MetricResult> } {
	const repository = path.resolve(options.repository ?? process.cwd());
	const temporary = mkdtempSync(path.join(os.tmpdir(), "mal-bench-compare-"));
	const base = path.join(temporary, "base");
	const extraArgs = options.extraArgs ?? [];
	try {
		exportBase(options.baseRef, repository, temporary);
		// Warm both exact source trees before collecting an interleaved pair.
		runSnapshot(base, options.lanes, extraArgs, temporary, "warm-base");
		runSnapshot(repository, options.lanes, extraArgs, temporary, "warm-head");
		const samples = new Map<string, Array<MetricSample>>();
		const maxPairs = Math.max(options.pairs, options.maxPairs ?? 15);
		let pairCount = 0;
		while (pairCount < maxPairs) {
			const baseFirst = pairCount % 2 === 0;
			const first = runSnapshot(
				baseFirst ? base : repository,
				options.lanes,
				extraArgs,
				temporary,
				`pair-${pairCount}-${baseFirst ? "base" : "head"}`,
			);
			const second = runSnapshot(
				baseFirst ? repository : base,
				options.lanes,
				extraArgs,
				temporary,
				`pair-${pairCount}-${baseFirst ? "head" : "base"}`,
			);
			const baseValues = flatten(baseFirst ? first : second);
			const headValues = flatten(baseFirst ? second : first);
			for (const [metricPath, baseValue] of baseValues) {
				const headValue = headValues.get(metricPath);
				if (headValue === undefined || metricPolicy(metricPath) === undefined) continue;
				const values = samples.get(metricPath) ?? [];
				values.push({ base: baseValue, head: headValue });
				samples.set(metricPath, values);
			}
			pairCount++;
			if (pairCount < options.pairs) continue;
			const interim = [...samples].map(([name, values]) => classify(name, values)!);
			if (interim.every((metric) => metric.status !== "inconclusive")) break;
		}
		const metrics = [...samples]
			.map(([name, values]) => classify(name, values))
			.filter((value): value is MetricResult => value !== undefined)
			.sort((left, right) => left.path.localeCompare(right.path));
		const comparisonRoot = path.join(repository, ".cache", "bench-comparisons");
		mkdirSync(comparisonRoot, { recursive: true });
		const reportPath = path.join(
			comparisonRoot,
			`${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`,
		);
		writeFileSync(
			reportPath,
			`${JSON.stringify(
				{
					schema: 1,
					baseRef: options.baseRef,
					lanes: options.lanes,
					environment: {
						platform: process.platform,
						arch: process.arch,
						node: process.version,
					},
					metrics,
				},
				undefined,
				2,
			)}\n`,
		);
		console.log(
			`\npaired comparison against ${options.baseRef} (${options.lanes.join(", ")}):`,
		);
		for (const metric of metrics) {
			console.log(
				`  ${metric.status.padEnd(12)} ${metric.path} ${metric.medianRegressionPercent >= 0 ? "+" : ""}${metric.medianRegressionPercent.toFixed(2)}% ` +
					`[${metric.confidenceInterval[0].toFixed(2)}, ${metric.confidenceInterval[1].toFixed(2)}]`,
			);
		}
		console.log(`raw paired samples: ${reportPath}`);
		return {
			exitCode: metrics.some((metric) => metric.status === "regression") ? 1 : 0,
			reportPath,
			metrics,
		};
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
