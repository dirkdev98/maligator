import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	lstatSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const BENCHMARK_LANE_RULES: ReadonlyArray<{
	pattern: RegExp;
	lanes: ReadonlyArray<string>;
}> = [
	{ pattern: /^(scripts\/bench|bench\/)/, lanes: ["*"] },
	{
		pattern: /^src\/compiler\//,
		lanes: ["javascript", "http", "self-compile"],
	},
	{
		pattern: /^runtime\/src\/runtime\/(node_http|web_)|^runtime\/src\/host\//,
		lanes: ["http"],
	},
	{
		pattern: /^runtime\//,
		lanes: ["javascript", "http"],
	},
	{
		pattern: /^src\//,
		lanes: ["javascript", "http", "self-compile"],
	},
];

function command(
	tool: string,
	args: Array<string>,
	options: {
		cwd?: string;
		input?: string | Uint8Array;
		maxBuffer?: number;
		deadline?: number;
	} = {},
): string {
	const result = spawnSync(tool, args, {
		cwd: options.cwd,
		input: options.input,
		encoding: "utf-8",
		maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
		timeout: remainingTime(options.deadline ?? Infinity),
	});
	if (result.error) {
		if ("code" in result.error && result.error.code === "ETIMEDOUT")
			throw new ComparisonInterrupted("time budget exhausted during preparation");
		throw result.error;
	}
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
	if (/(^|\.)node(?:\.|[A-Z])/.test(metricPath)) return undefined;
	if (/(^|\.)malRps$/.test(metricPath))
		return { direction: "higher", thresholdPercent: 2 };
	// HTTP publishes Maligator/Node throughput, while every other ratio in the
	// benchmark snapshot is Maligator/Node elapsed time. Their desirable
	// directions are therefore opposite despite sharing the same leaf name.
	if (/^http(?:\..+)?\.ratio$/.test(metricPath))
		return { direction: "higher", thresholdPercent: 2 };
	if (/(^|\.)(ratio|[A-Za-z]+Ratio)$/.test(metricPath))
		return { direction: "lower", thresholdPercent: 2 };
	if (/(p99|rss|Pause)/i.test(metricPath))
		return { direction: "lower", thresholdPercent: 5 };
	if (/(binaryBytes|ArchiveBytes)$/i.test(metricPath)) {
		return { direction: "lower", thresholdPercent: 0.5, minimumAbsolute: 32 * 1024 };
	}
	if (/\.phaseMs\./.test(metricPath)) return { direction: "lower", thresholdPercent: 2 };
	if (/(Ms|wallMs)$/i.test(metricPath))
		return { direction: "lower", thresholdPercent: 2 };
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
	const medianRegressionPercent = median(changes);
	let status: MetricResult["status"];
	if (policy.minimumAbsolute !== undefined && absoluteChange < policy.minimumAbsolute) {
		status = "unchanged";
	} else if (
		medianRegressionPercent > policy.thresholdPercent &&
		interval[0] > 0 &&
		(policy.minimumAbsolute === undefined || absoluteChange >= policy.minimumAbsolute)
	) {
		status = "regression";
	} else if (medianRegressionPercent < -policy.thresholdPercent && interval[1] < 0) {
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
		medianRegressionPercent,
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

function exportBase(
	baseRef: string,
	repository: string,
	destination: string,
	deadline: number,
): void {
	const currentLock = readFileSync(path.join(repository, "package-lock.json"), "utf-8");
	const baseLock = command("git", ["show", `${baseRef}:package-lock.json`], {
		cwd: repository,
		deadline,
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
			timeout: remainingTime(deadline),
		});
		if (
			result.error !== undefined &&
			"code" in result.error &&
			result.error.code === "ETIMEDOUT"
		)
			throw new ComparisonInterrupted("time budget exhausted during source export");
		if (result.status !== 0) throw new Error(`git archive failed: ${result.stderr}`);
	} finally {
		closeSync(descriptor);
	}
	const base = path.join(destination, "base");
	mkdirSync(base, { recursive: true });
	command("tar", ["-xf", archive, "-C", base], { deadline });
	if (existsSync(path.join(repository, "node_modules"))) {
		symlinkSync(
			path.join(repository, "node_modules"),
			path.join(base, "node_modules"),
			"dir",
		);
	}
}

export interface ComparisonOptions {
	baseRef: string;
	lanes: Array<string>;
	pairs: number;
	maxPairs?: number;
	extraArgs?: Array<string>;
	headExtraArgs?: Array<string>;
	repository?: string;
	budgetSeconds?: number;
	resumeDirectory?: string;
	outputDirectory?: string;
}

export function selfCompileStages(runs: number): Array<string> {
	return [
		"native build",
		"cold pair 1/3",
		"cold pair 2/3",
		"cold pair 3/3",
		"warmup pair",
		...Array.from({ length: runs }, (_, index) => `measured pair ${index + 1}/${runs}`),
		"phase instrumentation pair",
		"counter instrumentation pair",
		"owner instrumentation pair",
		"runtime resource pair",
	];
}

interface ComparisonIdentity {
	baseCommit: string;
	headCommit: string;
	headDigest: string;
	lanes: Array<string>;
	pairs: number;
	maxPairs: number;
	baseArgs: Array<string>;
	headArgs: Array<string>;
	platform: string;
	arch: string;
	node: string;
	host: string;
	toolchainEnvironment: Record<string, string>;
}

export function performanceSourceIdentity(repository: string): {
	commit: string;
	digest: string;
} {
	const commit = command("git", ["rev-parse", "HEAD"], { cwd: repository }).trim();
	const digest = createHash("sha256").update(commit);
	digest.update(command("git", ["diff", "--binary", "HEAD"], { cwd: repository }));
	const untracked = command("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
		cwd: repository,
	})
		.split("\0")
		.filter(Boolean)
		.sort();
	for (const file of untracked) {
		const absolute = path.join(repository, file);
		const contents = lstatSync(absolute).isSymbolicLink()
			? Buffer.from(readlinkSync(absolute))
			: readFileSync(absolute);
		digest.update(`${file}\0${contents.length}\0`).update(contents);
	}
	return { commit, digest: digest.digest("hex") };
}

function writeJson(file: string, value: unknown): void {
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, file);
}

class ComparisonInterrupted extends Error {}

function remainingTime(deadline: number): number | undefined {
	if (!Number.isFinite(deadline)) return undefined;
	const remaining = Math.ceil(deadline - performance.now());
	if (remaining <= 0) throw new ComparisonInterrupted("time budget exhausted");
	return remaining;
}

async function runLoggedCommand(
	repository: string,
	args: Array<string>,
	log: string,
	deadline: number,
	scratchDirectory: string,
	sourceCommit?: string,
): Promise<void> {
	if (performance.now() >= deadline)
		throw new ComparisonInterrupted("time budget exhausted");
	mkdirSync(scratchDirectory, { recursive: true });
	const descriptor = openSync(log, "a");
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, args, {
				cwd: repository,
				env: {
					...process.env,
					TMPDIR: scratchDirectory,
					TMP: scratchDirectory,
					TEMP: scratchDirectory,
					NO_COLOR: "true",
					...(sourceCommit === undefined
						? {}
						: { MAL_INTERNAL_BENCH_SOURCE_COMMIT: sourceCommit }),
				},
				stdio: ["ignore", descriptor, descriptor],
				detached: process.platform !== "win32",
			});
			let interrupted: string | undefined;
			let forceTimer: ReturnType<typeof setTimeout> | undefined;
			const kill = (force: boolean) => {
				if (child.pid === undefined) return;
				if (process.platform === "win32") {
					spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
						timeout: 5000,
					});
				} else {
					try {
						process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
			};
			const stop = (reason: string) => {
				if (interrupted !== undefined) return;
				interrupted = reason;
				kill(false);
				forceTimer = setTimeout(() => kill(true), 1000);
			};
			const onInterrupt = () => stop("interrupted by SIGINT");
			const onTerminate = () => stop("interrupted by SIGTERM");
			process.once("SIGINT", onInterrupt);
			process.once("SIGTERM", onTerminate);
			const timer = Number.isFinite(deadline)
				? setTimeout(
						() => stop("time budget exhausted"),
						Math.max(1, deadline - performance.now()),
					)
				: undefined;
			const cleanup = () => {
				clearTimeout(timer);
				clearTimeout(forceTimer);
				process.removeListener("SIGINT", onInterrupt);
				process.removeListener("SIGTERM", onTerminate);
				// A shell can exit before its compiler descendants acknowledge termination.
				if (interrupted !== undefined) kill(true);
			};
			child.once("error", (error) => {
				cleanup();
				reject(error);
			});
			child.once("close", (code, signal) => {
				cleanup();
				if (interrupted !== undefined) reject(new ComparisonInterrupted(interrupted));
				else if (code !== 0)
					reject(new Error(`benchmark failed (${code ?? signal}); see ${log}`));
				else resolve();
			});
		});
	} finally {
		closeSync(descriptor);
	}
}

async function runSnapshot(
	repository: string,
	lanes: Array<string>,
	extraArgs: Array<string>,
	runDirectory: string,
	label: string,
	deadline: number,
	sourceCommit?: string,
): Promise<unknown> {
	const output = path.join(runDirectory, `${label}.json`);
	if (existsSync(output)) return JSON.parse(readFileSync(output, "utf8")) as unknown;
	const pendingDirectory = path.join(runDirectory, "pending");
	mkdirSync(pendingDirectory, { recursive: true });
	const pendingOutput = path.join(pendingDirectory, `${label}.json`);
	rmSync(pendingOutput, { force: true });
	const selfCompile = lanes.length === 1 && lanes[0] === "self-compile";
	const checkpoint = path.join(runDirectory, `${label}.checkpoint.json`);
	const scratchDirectory = path.join(runDirectory, "scratch", label);
	do {
		const previousCheckpoint = existsSync(checkpoint)
			? readFileSync(checkpoint, "utf8")
			: undefined;
		console.log(
			`[bench-compare] ${label}${selfCompile ? " advance checkpoint" : ""}; log: ${label}.log`,
		);
		await runLoggedCommand(
			repository,
			[
				"scripts/bench.ts",
				...lanes,
				"--runs",
				"1",
				"--json-out",
				pendingOutput,
				...extraArgs,
				...(selfCompile ? ["--checkpoint", checkpoint] : []),
			],
			path.join(runDirectory, `${label}.log`),
			deadline,
			scratchDirectory,
			sourceCommit,
		);
		if (existsSync(pendingOutput)) {
			JSON.parse(readFileSync(pendingOutput, "utf8"));
			renameSync(pendingOutput, output);
		} else if (!selfCompile) {
			throw new Error(`benchmark did not write ${output}`);
		} else if (
			!existsSync(checkpoint) ||
			readFileSync(checkpoint, "utf8") === previousCheckpoint
		) {
			throw new Error(`benchmark made no checkpoint progress; see ${label}.log`);
		}
	} while (!existsSync(output));
	rmSync(scratchDirectory, { recursive: true, force: true });
	return JSON.parse(readFileSync(output, "utf8")) as unknown;
}

function comparisonMetrics(
	samples: ReadonlyMap<string, Array<MetricSample>>,
): Array<MetricResult> {
	return [...samples]
		.map(([name, values]) => classify(name, values)!)
		.sort((left, right) => left.path.localeCompare(right.path));
}

function assertComparableSnapshots(base: unknown, head: unknown): void {
	const left = base as { javascript?: { workload: string; phaseChecksums: unknown } };
	const right = head as typeof left;
	if (left.javascript !== undefined || right.javascript !== undefined) {
		if (
			left.javascript?.workload !== right.javascript?.workload ||
			!isDeepStrictEqual(
				left.javascript?.phaseChecksums,
				right.javascript?.phaseChecksums,
			)
		) {
			throw new Error("base/head JavaScript workload or checksums differ");
		}
	}
}

export async function runBenchmarkComparison(options: ComparisonOptions): Promise<{
	exitCode: number;
	reportPath: string;
	metrics: Array<MetricResult>;
}> {
	const started = performance.now();
	const deadline =
		options.budgetSeconds === undefined
			? Infinity
			: started + options.budgetSeconds * 1000;
	const repository = path.resolve(options.repository ?? process.cwd());
	const head = performanceSourceIdentity(repository);
	const identity: ComparisonIdentity = {
		baseCommit: command("git", ["rev-parse", options.baseRef], {
			cwd: repository,
		}).trim(),
		headCommit: head.commit,
		headDigest: head.digest,
		lanes: options.lanes,
		pairs: options.pairs,
		maxPairs: options.maxPairs ?? Math.max(options.pairs, 15),
		baseArgs: options.extraArgs ?? [],
		headArgs: [...(options.extraArgs ?? []), ...(options.headExtraArgs ?? [])],
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		host: createHash("sha256")
			.update(`${os.hostname()}\0${os.cpus()[0]?.model}\0${os.cpus().length}`)
			.digest("hex"),
		toolchainEnvironment: Object.fromEntries(
			[
				"CC",
				"CXX",
				"CFLAGS",
				"LDFLAGS",
				"RUSTFLAGS",
				"MAL_ASAN",
				"MAL_UBSAN",
				"MAL_GC_STRESS",
				"MAL_GC_VERIFY",
				"MAL_GC_GENERATIONAL",
				"MAL_GC_CONCURRENT",
				"MAL_PERF_STATS",
			].flatMap((name) =>
				process.env[name] === undefined ? [] : [[name, process.env[name]]],
			),
		),
	};
	const comparisonRoot = path.resolve(
		options.outputDirectory ?? path.join(repository, ".cache", "bench-comparisons"),
	);
	mkdirSync(comparisonRoot, { recursive: true });
	const runDirectory =
		options.resumeDirectory === undefined
			? mkdtempSync(
					path.join(
						comparisonRoot,
						`${new Date().toISOString().replaceAll(/[:.]/g, "-")}-`,
					),
				)
			: path.resolve(options.resumeDirectory);
	const reportPath = path.join(runDirectory, "report.json");
	if (options.resumeDirectory !== undefined) {
		const previous = JSON.parse(readFileSync(reportPath, "utf8")) as {
			identity?: ComparisonIdentity;
			resumeAllowed?: boolean;
		};
		if (
			previous.resumeAllowed === false ||
			JSON.stringify(previous.identity) !== JSON.stringify(identity)
		) {
			throw new Error(
				`comparison source, options, or host changed; start a new run instead of resuming ${reportPath}`,
			);
		}
	}
	const base = path.join(runDirectory, "base");
	const samples = new Map<string, Array<MetricSample>>();
	const unpairedMetrics = new Set<string>();
	let pairCount = 0;
	let activeSnapshot: string | undefined;
	let resumeAllowed = true;
	const persist = (
		status: "running" | "complete" | "incomplete" | "failed",
		error?: string,
	) => {
		writeJson(reportPath, {
			schema: 2,
			status,
			complete: status === "complete",
			identity,
			baseRef: options.baseRef,
			lanes: options.lanes,
			budgetSeconds: options.budgetSeconds,
			invocationDurationMs: performance.now() - started,
			completedPairs: pairCount,
			unpairedMetrics: [...unpairedMetrics].sort(),
			activeSnapshot,
			resumeAllowed,
			error,
			metrics: comparisonMetrics(samples),
		});
	};
	const assertSource = () => {
		if (performanceSourceIdentity(repository).digest !== head.digest) {
			resumeAllowed = false;
			throw new Error(
				"working source changed during comparison; results cannot be combined",
			);
		}
	};
	const snapshot = async (label: string, isBase: boolean) => {
		activeSnapshot = label;
		persist("running");
		assertSource();
		const result = await runSnapshot(
			isBase ? base : repository,
			options.lanes,
			isBase ? identity.baseArgs : identity.headArgs,
			runDirectory,
			label,
			deadline,
			isBase ? identity.baseCommit : undefined,
		);
		assertSource();
		activeSnapshot = undefined;
		return result;
	};
	persist("running");
	console.log(`[bench-compare] evidence: ${reportPath}`);
	try {
		if (performance.now() >= deadline)
			throw new ComparisonInterrupted("time budget exhausted");
		const baseReady = path.join(runDirectory, "base-ready.json");
		if (!existsSync(baseReady)) {
			rmSync(base, { recursive: true, force: true });
			exportBase(identity.baseCommit, repository, runDirectory, deadline);
			writeJson(baseReady, { commit: identity.baseCommit });
		}
		await snapshot("warm-base", true);
		await snapshot("warm-head", false);
		while (pairCount < identity.maxPairs) {
			const baseFirst = pairCount % 2 === 0;
			const first = await snapshot(
				`pair-${pairCount}-${baseFirst ? "base" : "head"}`,
				baseFirst,
			);
			const second = await snapshot(
				`pair-${pairCount}-${baseFirst ? "head" : "base"}`,
				!baseFirst,
			);
			assertComparableSnapshots(baseFirst ? first : second, baseFirst ? second : first);
			const baseValues = flatten(baseFirst ? first : second);
			const headValues = flatten(baseFirst ? second : first);
			const paths = [...baseValues.keys()].filter(
				(key) => metricPolicy(key) !== undefined,
			);
			const headPaths = [...headValues.keys()].filter(
				(key) => metricPolicy(key) !== undefined,
			);
			for (const metricPath of new Set([...paths, ...headPaths, ...samples.keys()])) {
				if (
					!baseValues.has(metricPath) ||
					!headValues.has(metricPath) ||
					(pairCount > 0 && !samples.has(metricPath))
				) {
					unpairedMetrics.add(metricPath);
					samples.delete(metricPath);
				}
			}
			if (!paths.some((key) => !unpairedMetrics.has(key))) {
				throw new Error("base/head snapshots contain no consistently paired metrics");
			}
			for (const metricPath of paths) {
				if (unpairedMetrics.has(metricPath)) continue;
				const values = samples.get(metricPath) ?? [];
				values.push({
					base: baseValues.get(metricPath)!,
					head: headValues.get(metricPath)!,
				});
				samples.set(metricPath, values);
			}
			pairCount++;
			persist("running");
			if (
				pairCount >= identity.pairs &&
				comparisonMetrics(samples).every((metric) => metric.status !== "inconclusive")
			)
				break;
		}
		persist("complete");
		rmSync(base, { recursive: true, force: true });
		rmSync(path.join(runDirectory, "base.tar"), { force: true });
		rmSync(baseReady, { force: true });
		const metrics = comparisonMetrics(samples);
		for (const metric of metrics) {
			console.log(
				`  ${metric.status.padEnd(12)} ${metric.path} ${metric.medianRegressionPercent.toFixed(2)}% [${metric.confidenceInterval[0].toFixed(2)}, ${metric.confidenceInterval[1].toFixed(2)}]`,
			);
		}
		return {
			exitCode: metrics.some((metric) => metric.status === "regression") ? 1 : 0,
			reportPath,
			metrics,
		};
	} catch (error) {
		persist(
			error instanceof ComparisonInterrupted ? "incomplete" : "failed",
			error instanceof Error ? error.message : String(error),
		);
		console.error(
			`[bench-compare] ${error instanceof Error ? error.message : String(error)}; evidence retained: ${reportPath}`,
		);
		return { exitCode: 2, reportPath, metrics: comparisonMetrics(samples) };
	}
}
