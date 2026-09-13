import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import {
	TRANSLATION_UNIT_HARD_MAXIMUM_CODE_UNITS,
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import type {
	GeneratedTranslationUnit,
	TranslationUnitPolicy,
} from "../src/compiler/target/emit-program-image.ts";
import { generatedCCompileArguments } from "../src/local-build.ts";
import type {
	GeneratedObjectMeasurement,
	LocalBuildMeasurements,
} from "../src/local-build.ts";
import type { NativeBuildContext } from "../src/native-build-context.ts";
import { nativeSourcePath } from "../src/native-source-path.ts";
import { buildNativeBinaryResult } from "../src/test-harness.ts";
import type { BuildNativeBinaryResult } from "../src/test-harness.ts";
import { toolArguments } from "../src/toolchain.ts";
import {
	digestSelfCompileOutput,
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

const HARD_MAXIMUM_CODE_UNITS = TRANSLATION_UNIT_HARD_MAXIMUM_CODE_UNITS;
const DEFAULT_TARGETS = [512, 1024, 2048, 4096, 8192].map(
	(kibibytes) => kibibytes * 1024,
);
const DEFAULT_OUTPUT = path.resolve(".cache/translation-units/report.json");
const JAVASCRIPT_FIXTURE = path.resolve("bench/javascript.mjs");
const SELF_COMPILE_FIXTURE = path.resolve("bench/self-compile.mts");
const CLOSED_CONFIG = resolveBuildConfig({});
const WORKLOADS = ["javascript", "self-compile"] as const;

type Workload = (typeof WORKLOADS)[number];

interface Options {
	readonly targets: ReadonlyArray<number>;
	readonly coldRuns: number;
	readonly runtimeRuns: number;
	readonly output: string;
	readonly phase: "all" | "cold" | "sweep" | "validation";
	readonly validationPart: "all" | "lto" | "incremental" | "giant";
	readonly validationTargetCodeUnits?: number;
}

interface SanitizedObjectMeasurement {
	readonly unit: string;
	readonly role: "generated" | "driver";
	readonly generatedKind?: "runtime-image" | "data" | "code";
	readonly definitions?: GeneratedObjectMeasurement["definitions"];
	readonly cache: "hit" | "miss";
	readonly sourceBytes: number;
	readonly objectBytes: number;
	readonly compileDurationMs: number | null;
	readonly userCpuMs: number | null;
	readonly systemCpuMs: number | null;
	readonly peakRssBytes?: number;
	readonly scheduledCompileDurationMs?: number;
}

interface EmissionInvariants {
	readonly emittedProgramDigest: string;
	readonly compiledFunctionSymbols: ReadonlyArray<string>;
	readonly typedEntrySymbols: ReadonlyArray<string>;
	readonly dataDefinitions: ReadonlyArray<string>;
	readonly runtimeImageDigest: string;
}

interface BuildSample {
	readonly workload: Workload | "incremental";
	readonly targetCodeUnits: number;
	readonly mode: "development" | "production";
	readonly sample: number;
	readonly objects: ReadonlyArray<SanitizedObjectMeasurement>;
	readonly slowestGeneratedUnits: ReadonlyArray<SanitizedObjectMeasurement>;
	readonly cToObjectWallMs: number;
	readonly generatedCpuMs: number;
	readonly generatedPeakRssBytes: number;
	readonly linkMs: number;
	readonly linkCache: "hit" | "miss";
	readonly binaryBytes: number;
	readonly classes: Record<
		"runtime-image" | "data" | "code",
		{
			readonly units: number;
			readonly sourceBytes: number;
			readonly objectBytes: number;
			readonly compileMs: number;
			readonly cpuMs: number;
			readonly peakRssBytes: number;
		}
	>;
	readonly invariants?: EmissionInvariants;
	readonly nativePlan: BuildNativeBinaryResult["context"]["plan"];
}

interface RuntimeSample {
	readonly workload: Workload | "incremental";
	readonly targetCodeUnits: number;
	readonly sample: number;
	readonly wallMs: number;
	readonly workloadMs: number;
	readonly startupAndExitMs: number;
	readonly peakRssBytes: number;
	readonly checksum: string;
}

interface TimeMeasurement {
	readonly wallMs: number;
	readonly userCpuMs: number;
	readonly systemCpuMs: number;
	readonly peakRssBytes: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface TargetSummary {
	readonly targetCodeUnits: number;
	readonly cToObjectWallMs: number;
	readonly generatedCpuMs: number;
	readonly generatedPeakRssBytes: number;
	readonly linkMs: number;
	readonly binaryBytes: number;
	readonly runtimeWallMs: number;
	readonly startupAndExitMs: number;
	readonly correctness: boolean;
	readonly ratiosToEightMiB: {
		readonly cToObjectWall: number;
		readonly generatedCpu: number;
		readonly generatedPeakRss: number;
		readonly link: number;
		readonly binary: number;
		readonly runtimeWall: number;
		readonly startupAndExit: number;
	};
	readonly gates: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>;
	readonly accepted: boolean;
}

interface BuiltSample {
	readonly result: BuildNativeBinaryResult;
	readonly report: BuildSample;
}

interface RuntimeReference {
	readonly checksum: string;
	run(binary: string, sample: number): RuntimeSample;
}

const GATE_THRESHOLDS = Object.freeze({
	cToObjectWallRatio: 1.05,
	generatedCpuRatio: 1.1,
	generatedPeakRssRatio: 1.1,
	generatedPeakRssSlackBytes: 16 * 1024 * 1024,
	linkRatio: 1.1,
	linkSlackMs: 250,
	binaryRatio: 1.01,
	runtimeWallRatio: 1.05,
	runtimeWallSlackMs: 10,
	startupAndExitRatio: 1.15,
	startupAndExitSlackMs: 5,
});

function positiveInteger(value: string | undefined, option: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive integer`);
	}
	return parsed;
}

function parseOptions(args: ReadonlyArray<string>): Options {
	let coldRuns = 3;
	let runtimeRuns = 3;
	let output = DEFAULT_OUTPUT;
	let targets = DEFAULT_TARGETS;
	let phase: Options["phase"] = "all";
	let validationPart: Options["validationPart"] = "all";
	let validationTargetCodeUnits: number | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--cold-runs") {
			coldRuns = positiveInteger(args[++index], argument);
		} else if (argument === "--runtime-runs") {
			runtimeRuns = positiveInteger(args[++index], argument);
		} else if (argument === "--output") {
			const value = args[++index];
			if (value === undefined) throw new Error("--output requires a path");
			output = path.resolve(value);
		} else if (argument === "--targets-kib") {
			const value = args[++index];
			if (value === undefined) throw new Error("--targets-kib requires a list");
			targets = value
				.split(",")
				.map((item) => positiveInteger(item, "--targets-kib") * 1024);
		} else if (argument === "--quick") {
			coldRuns = 1;
			runtimeRuns = 1;
		} else if (argument === "--cold-only") {
			if (phase !== "all") throw new Error("benchmark phases are mutually exclusive");
			phase = "cold";
		} else if (argument === "--sweep-only") {
			if (phase !== "all") throw new Error("benchmark phases are mutually exclusive");
			phase = "sweep";
		} else if (argument === "--validate-target-kib") {
			if (phase !== "all") throw new Error("benchmark phases are mutually exclusive");
			phase = "validation";
			validationTargetCodeUnits = positiveInteger(args[++index], argument) * 1024;
		} else if (argument === "--validation-part") {
			const value = args[++index];
			if (value !== "lto" && value !== "incremental" && value !== "giant") {
				throw new Error("--validation-part requires lto, incremental, or giant");
			}
			validationPart = value;
		} else if (argument === "--help") {
			console.log(`Usage: node scripts/bench-translation-units.ts [options]

  --cold-runs N       cold generated-object samples per target/workload (default 3)
  --runtime-runs N    runtime samples per target/workload (default 3)
  --targets-kib LIST  comma-separated soft targets (default 512,1024,2048,4096,8192)
  --output PATH       report destination (default .cache/translation-units/report.json)
  --quick             one cold and runtime sample for harness smoke testing
  --cold-only         stop after cold generated-object samples
  --sweep-only        stop after target selection and runtime gates
  --validate-target-kib N
                      skip the sweep; measure LTO, locality, and giant functions
  --validation-part PART
                      run only lto, incremental, or giant validation`);
			process.exit(0);
		} else {
			throw new Error(`unknown option ${argument}`);
		}
	}
	if (phase !== "validation" && !targets.includes(HARD_MAXIMUM_CODE_UNITS)) {
		throw new Error("the target sweep must include the current 8192 KiB control");
	}
	if (targets.some((target) => target > HARD_MAXIMUM_CODE_UNITS)) {
		throw new Error("a soft target cannot exceed the 8192 KiB hard maximum");
	}
	if (
		validationTargetCodeUnits !== undefined &&
		validationTargetCodeUnits > HARD_MAXIMUM_CODE_UNITS
	) {
		throw new Error("the validation target cannot exceed the 8192 KiB hard maximum");
	}
	if (validationPart !== "all" && phase !== "validation") {
		throw new Error("--validation-part requires --validate-target-kib");
	}
	return {
		targets: [...new Set(targets)].sort((a, b) => a - b),
		coldRuns,
		runtimeRuns,
		output,
		phase,
		validationPart,
		...(validationTargetCodeUnits === undefined ? {} : { validationTargetCodeUnits }),
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function median(values: ReadonlyArray<number>): number {
	if (values.length === 0) throw new Error("cannot take the median of no samples");
	const ordered = [...values].sort((a, b) => a - b);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 0
		? (ordered[middle - 1]! + ordered[middle]!) / 2
		: ordered[middle]!;
}

function safeRatio(value: number, control: number): number {
	return control === 0 ? (value === 0 ? 1 : Number.POSITIVE_INFINITY) : value / control;
}

function sanitizeObject(
	measurement: GeneratedObjectMeasurement,
): SanitizedObjectMeasurement {
	return {
		unit: measurement.unit,
		role: measurement.role,
		...(measurement.generatedKind === undefined
			? {}
			: { generatedKind: measurement.generatedKind }),
		...(measurement.definitions === undefined
			? {}
			: { definitions: measurement.definitions }),
		cache: measurement.cache,
		sourceBytes: measurement.sourceBytes,
		objectBytes: measurement.objectBytes,
		compileDurationMs: measurement.compileDurationMs,
		userCpuMs: measurement.userCpuMs,
		systemCpuMs: measurement.systemCpuMs,
		...(measurement.peakRssBytes === undefined
			? {}
			: { peakRssBytes: measurement.peakRssBytes }),
		...(measurement.scheduledCompileDurationMs === undefined
			? {}
			: { scheduledCompileDurationMs: measurement.scheduledCompileDurationMs }),
	};
}

function classMetrics(
	objects: ReadonlyArray<SanitizedObjectMeasurement>,
): BuildSample["classes"] {
	const summarize = (kind: "runtime-image" | "data" | "code") => {
		const selected = objects.filter((object) => object.generatedKind === kind);
		return {
			units: selected.length,
			sourceBytes: selected.reduce((total, object) => total + object.sourceBytes, 0),
			objectBytes: selected.reduce((total, object) => total + object.objectBytes, 0),
			compileMs: selected.reduce(
				(total, object) => total + (object.compileDurationMs ?? 0),
				0,
			),
			cpuMs: selected.reduce(
				(total, object) => total + (object.userCpuMs ?? 0) + (object.systemCpuMs ?? 0),
				0,
			),
			peakRssBytes: Math.max(0, ...selected.map((object) => object.peakRssBytes ?? 0)),
		};
	};
	return {
		"runtime-image": summarize("runtime-image"),
		data: summarize("data"),
		code: summarize("code"),
	};
}

function emissionInvariants(
	result: BuildNativeBinaryResult,
	config: ResolvedBuildConfig,
	policy: TranslationUnitPolicy,
): EmissionInvariants {
	const emitOptions = {
		sourcePath: nativeSourcePath,
		compiled: true,
		maligatorSurface: config.surface.maligator,
	};
	const units = emitProgramTranslationUnits(result.programImage, emitOptions, policy);
	const definitions = units.flatMap((unit) => unit.definitions);
	return {
		emittedProgramDigest: sha256(emitProgramImage(result.programImage, emitOptions)),
		compiledFunctionSymbols: definitions
			.filter(
				(definition) =>
					definition.kind === "compiled function" &&
					definition.symbol.startsWith("mal_compiled_"),
			)
			.map((definition) => definition.symbol)
			.sort(),
		typedEntrySymbols: definitions
			.filter(
				(definition) =>
					definition.kind === "compiled function" &&
					definition.symbol.startsWith("mal_direct_"),
			)
			.map((definition) => definition.symbol)
			.sort(),
		dataDefinitions: definitions
			.filter((definition) => definition.kind === "data array")
			.map((definition) => `${definition.symbol}:${String(definition.sourceCodeUnits)}`)
			.sort(),
		runtimeImageDigest: sha256(
			units.find((unit) => unit.kind === "runtime-image")!.source,
		),
	};
}

function workloadFixture(workload: Workload): string {
	return workload === "javascript" ? JAVASCRIPT_FIXTURE : SELF_COMPILE_FIXTURE;
}

function workloadConfig(workload: Workload): ResolvedBuildConfig {
	return workload === "javascript" ? CLOSED_CONFIG : SELF_COMPILE_CONFIG;
}

function buildSample(options: {
	readonly workload: Workload | "incremental";
	readonly fixture: string;
	readonly config: ResolvedBuildConfig;
	readonly targetCodeUnits: number;
	readonly sample: number;
	readonly production: boolean;
	readonly cacheDirectory: string;
	readonly outputDirectory: string;
	readonly objectCacheVariant?: string;
	readonly linkCacheVariant?: string;
	readonly includeInvariants?: boolean;
}): BuiltSample {
	const policy = {
		targetCodeUnits: options.targetCodeUnits,
		hardMaximumCodeUnits: HARD_MAXIMUM_CODE_UNITS,
	};
	const result = buildNativeBinaryResult({
		fixture: options.fixture,
		name: `translation-unit-${options.workload}-${String(options.targetCodeUnits)}`,
		config: options.config,
		production: options.production,
		translationUnits: true,
		translationUnitPolicy: policy,
		cacheDirectory: options.cacheDirectory,
		outDir: options.outputDirectory,
		nativeObjectCacheVariant: options.objectCacheVariant,
		nativeLinkCacheVariant: options.linkCacheVariant,
	});
	const objects = result.measurements.objects.map(sanitizeObject);
	const generated = objects.filter((object) => object.role === "generated");
	return {
		result,
		report: {
			workload: options.workload,
			targetCodeUnits: options.targetCodeUnits,
			mode: options.production ? "production" : "development",
			sample: options.sample,
			objects,
			slowestGeneratedUnits:
				result.measurements.slowestGeneratedUnits.map(sanitizeObject),
			cToObjectWallMs: result.measurements.cToObjectDurationMs,
			generatedCpuMs: generated.reduce(
				(total, object) => total + (object.userCpuMs ?? 0) + (object.systemCpuMs ?? 0),
				0,
			),
			generatedPeakRssBytes: Math.max(
				0,
				...generated.map((object) => object.peakRssBytes ?? 0),
			),
			linkMs: result.measurements.linkDurationMs,
			linkCache: result.measurements.linkCache,
			binaryBytes: statSync(result.binaryPath).size,
			classes: classMetrics(generated),
			...(options.includeInvariants
				? { invariants: emissionInvariants(result, options.config, policy) }
				: {}),
			nativePlan: result.context.plan,
		},
	};
}

function parseResourceReport(
	report: string,
): Omit<TimeMeasurement, "wallMs" | "stdout" | "stderr"> {
	if (process.platform === "darwin") {
		const timing = report.match(
			/(^|\n)\s*([0-9.]+)\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys(?:\n|$)/,
		);
		const rss = report.match(/([0-9]+)\s+maximum resident set size/);
		if (timing === null || rss === null) throw new Error("time -l omitted resource data");
		return {
			userCpuMs: Number(timing[3]) * 1000,
			systemCpuMs: Number(timing[4]) * 1000,
			peakRssBytes: Number(rss[1]),
		};
	}
	const user = report.match(/User time \(seconds\):\s*([0-9.]+)/);
	const system = report.match(/System time \(seconds\):\s*([0-9.]+)/);
	const rss = report.match(/Maximum resident set size \(kbytes\):\s*([0-9]+)/);
	if (user === null || system === null || rss === null) {
		throw new Error("time -v omitted resource data");
	}
	return {
		userCpuMs: Number(user[1]) * 1000,
		systemCpuMs: Number(system[1]) * 1000,
		peakRssBytes: Number(rss[1]) * 1024,
	};
}

let timedCommandSerial = 0;

function runTimedCommand(options: {
	readonly executable: string;
	readonly args: ReadonlyArray<string>;
	readonly temporaryDirectory: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
}): TimeMeasurement {
	const reportPath = path.join(
		options.temporaryDirectory,
		`time-${String(process.pid)}-${String(timedCommandSerial++)}.txt`,
	);
	const timeArguments =
		process.platform === "darwin" ? ["-l", "-o", reportPath] : ["-v", "-o", reportPath];
	const startedAt = process.hrtime.bigint();
	const result = spawnSync(
		"/usr/bin/time",
		[...timeArguments, options.executable, ...options.args],
		{
			env: options.env ?? process.env,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			timeout: options.timeoutMs ?? 900_000,
		},
	);
	const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${options.executable} exited ${String(result.status)}:\n${result.stdout}\n${result.stderr}`,
		);
	}
	const resources = parseResourceReport(readFileSync(reportPath, "utf8"));
	rmSync(reportPath, { force: true });
	return { wallMs, stdout: result.stdout, stderr: result.stderr, ...resources };
}

function parseJavascriptRuntime(stdout: string): {
	readonly checksum: string;
	readonly workloadMs: number;
} {
	const line = stdout.trim().split("\n").filter(Boolean).at(-1);
	if (line === undefined) throw new Error("JavaScript benchmark produced no report");
	const parsed = JSON.parse(line) as {
		workload?: unknown;
		phases?: Record<string, { checksum?: unknown; elapsedMs?: unknown }>;
	};
	if (parsed.workload !== "javascript-v1" || parsed.phases === undefined) {
		throw new Error("JavaScript benchmark produced an invalid report");
	}
	const checksums: Record<string, number> = {};
	let workloadMs = 0;
	for (const [name, phase] of Object.entries(parsed.phases)) {
		if (typeof phase.checksum !== "number" || typeof phase.elapsedMs !== "number") {
			throw new Error(`JavaScript benchmark produced an invalid ${name} phase`);
		}
		checksums[name] = phase.checksum;
		workloadMs += phase.elapsedMs;
	}
	return { checksum: JSON.stringify(checksums), workloadMs };
}

function prepareRuntimeReferences(
	temporaryDirectory: string,
): Record<Workload, RuntimeReference> {
	const javascriptNode = runTimedCommand({
		executable: process.execPath,
		args: [JAVASCRIPT_FIXTURE],
		temporaryDirectory,
	});
	const javascriptReference = parseJavascriptRuntime(javascriptNode.stdout);
	const selfCompileSource = prepareSelfCompileSource(
		path.join(temporaryDirectory, "self-compile-source"),
	);
	const nodeOutput = path.join(temporaryDirectory, "self-compile-node-output");
	const selfCompileNode = runTimedCommand({
		executable: process.execPath,
		args: [SELF_COMPILE_FIXTURE, selfCompileSource, nodeOutput],
		temporaryDirectory,
	});
	const selfCompileNodeSummary = JSON.parse(selfCompileNode.stdout.trim()) as {
		units: number;
		codeUnits: number;
	};
	const selfCompileReference = sha256(
		JSON.stringify({
			output: digestSelfCompileOutput(nodeOutput, [temporaryDirectory]),
			units: selfCompileNodeSummary.units,
			codeUnits: selfCompileNodeSummary.codeUnits,
		}),
	);
	rmSync(nodeOutput, { recursive: true, force: true });
	return {
		javascript: {
			checksum: javascriptReference.checksum,
			run(binary, sample) {
				const measured = runTimedCommand({
					executable: binary,
					args: [],
					temporaryDirectory,
				});
				const runtime = parseJavascriptRuntime(measured.stdout);
				return {
					workload: "javascript",
					targetCodeUnits: 0,
					sample,
					wallMs: measured.wallMs,
					workloadMs: runtime.workloadMs,
					startupAndExitMs: Math.max(0, measured.wallMs - runtime.workloadMs),
					peakRssBytes: measured.peakRssBytes,
					checksum: runtime.checksum,
				};
			},
		},
		"self-compile": {
			checksum: selfCompileReference,
			run(binary, sample) {
				const output = path.join(
					temporaryDirectory,
					`self-compile-runtime-${String(sample)}-${String(timedCommandSerial)}`,
				);
				try {
					const measured = runTimedCommand({
						executable: binary,
						args: [selfCompileSource, output],
						temporaryDirectory,
					});
					const summary = JSON.parse(measured.stdout.trim()) as {
						units: number;
						codeUnits: number;
						phases: Record<string, number>;
					};
					const workloadMs = Object.values(summary.phases).reduce(
						(total, value) => total + value,
						0,
					);
					return {
						workload: "self-compile",
						targetCodeUnits: 0,
						sample,
						wallMs: measured.wallMs,
						workloadMs,
						startupAndExitMs: Math.max(0, measured.wallMs - workloadMs),
						peakRssBytes: measured.peakRssBytes,
						checksum: sha256(
							JSON.stringify({
								output: digestSelfCompileOutput(output, [temporaryDirectory]),
								units: summary.units,
								codeUnits: summary.codeUnits,
							}),
						),
					};
				} finally {
					rmSync(output, { recursive: true, force: true });
				}
			},
		},
	};
}

function summarizeTargets(
	targets: ReadonlyArray<number>,
	builds: ReadonlyArray<BuildSample>,
	runtimes: ReadonlyArray<RuntimeSample>,
	references: Record<Workload, RuntimeReference>,
): Array<TargetSummary> {
	const raw = targets.map((targetCodeUnits) => {
		const targetBuilds = builds.filter(
			(build) =>
				build.targetCodeUnits === targetCodeUnits && build.mode === "development",
		);
		const targetRuntimes = runtimes.filter(
			(runtime) => runtime.targetCodeUnits === targetCodeUnits,
		);
		const sumWorkloadMedian = (select: (sample: BuildSample) => number): number =>
			WORKLOADS.reduce(
				(total, workload) =>
					total +
					median(targetBuilds.filter((build) => build.workload === workload).map(select)),
				0,
			);
		const sumRuntimeMedian = (select: (sample: RuntimeSample) => number): number =>
			WORKLOADS.reduce(
				(total, workload) =>
					total +
					median(targetRuntimes.filter((run) => run.workload === workload).map(select)),
				0,
			);
		const invariantControls = new Map(
			WORKLOADS.map((workload) => [
				workload,
				builds.find(
					(build) =>
						build.workload === workload &&
						build.targetCodeUnits === HARD_MAXIMUM_CODE_UNITS &&
						build.invariants !== undefined,
				)?.invariants,
			]),
		);
		const correctness =
			WORKLOADS.every((workload) => {
				const actual = targetBuilds.find(
					(build) => build.workload === workload && build.invariants !== undefined,
				)?.invariants;
				return JSON.stringify(actual) === JSON.stringify(invariantControls.get(workload));
			}) &&
			targetRuntimes.every(
				(runtime) =>
					runtime.checksum === references[runtime.workload as Workload].checksum,
			);
		return {
			targetCodeUnits,
			cToObjectWallMs: sumWorkloadMedian((sample) => sample.cToObjectWallMs),
			generatedCpuMs: sumWorkloadMedian((sample) => sample.generatedCpuMs),
			generatedPeakRssBytes: Math.max(
				...targetBuilds.map((sample) => sample.generatedPeakRssBytes),
			),
			linkMs: sumWorkloadMedian((sample) => sample.linkMs),
			binaryBytes: sumWorkloadMedian((sample) => sample.binaryBytes),
			runtimeWallMs: sumRuntimeMedian((sample) => sample.wallMs),
			startupAndExitMs: sumRuntimeMedian((sample) => sample.startupAndExitMs),
			correctness,
		};
	});
	const control = raw.find(
		(summary) => summary.targetCodeUnits === HARD_MAXIMUM_CODE_UNITS,
	)!;
	return raw.map((summary) => {
		const ratios = {
			cToObjectWall: safeRatio(summary.cToObjectWallMs, control.cToObjectWallMs),
			generatedCpu: safeRatio(summary.generatedCpuMs, control.generatedCpuMs),
			generatedPeakRss: safeRatio(
				summary.generatedPeakRssBytes,
				control.generatedPeakRssBytes,
			),
			link: safeRatio(summary.linkMs, control.linkMs),
			binary: safeRatio(summary.binaryBytes, control.binaryBytes),
			runtimeWall: safeRatio(summary.runtimeWallMs, control.runtimeWallMs),
			startupAndExit: safeRatio(summary.startupAndExitMs, control.startupAndExitMs),
		};
		const gates = [
			{ name: "correctness and emitted coverage", passed: summary.correctness },
			{
				name: "C-to-object wall",
				passed: ratios.cToObjectWall <= GATE_THRESHOLDS.cToObjectWallRatio,
			},
			{
				name: "generated compiler CPU",
				passed: ratios.generatedCpu <= GATE_THRESHOLDS.generatedCpuRatio,
			},
			{
				name: "generated compiler peak RSS",
				passed:
					summary.generatedPeakRssBytes <=
					control.generatedPeakRssBytes * GATE_THRESHOLDS.generatedPeakRssRatio +
						GATE_THRESHOLDS.generatedPeakRssSlackBytes,
			},
			{
				name: "link wall",
				passed:
					summary.linkMs <=
					control.linkMs * GATE_THRESHOLDS.linkRatio + GATE_THRESHOLDS.linkSlackMs,
			},
			{ name: "binary size", passed: ratios.binary <= GATE_THRESHOLDS.binaryRatio },
			{
				name: "runtime wall",
				passed:
					summary.runtimeWallMs <=
					control.runtimeWallMs * GATE_THRESHOLDS.runtimeWallRatio +
						GATE_THRESHOLDS.runtimeWallSlackMs,
			},
			{
				name: "startup and exit",
				passed:
					summary.startupAndExitMs <=
					control.startupAndExitMs * GATE_THRESHOLDS.startupAndExitRatio +
						GATE_THRESHOLDS.startupAndExitSlackMs,
			},
		];
		return {
			...summary,
			ratiosToEightMiB: ratios,
			gates,
			accepted: gates.every((gate) => gate.passed),
		};
	});
}

function incrementalFixtureSource(functions: number, additions = ""): string {
	const declarations = Array.from({ length: functions }, (_, index) => {
		const adjustment = index === 37 ? " + TUNING" : "";
		return `function f${String(index)}(value) { let result = value + ${String(index)}${adjustment}; result = Math.imul(result ^ ${String(index * 17 + 3)}, ${String((index % 31) + 3)}); return result | 0; }`;
	});
	return `import { dependencyValue } from "./dependency.mjs";
const TUNING = 23;
${declarations.join("\n")}
const functions = [${Array.from({ length: functions }, (_, index) => `f${String(index)}`).join(",")}];
${additions}
let checksum = dependencyValue(TUNING);
for (let index = 0; index < functions.length; index++) checksum = (checksum + functions[index](index)) | 0;
console.log(checksum);
`;
}

function runIncrementalScenarios(options: {
	readonly targetCodeUnits: number;
	readonly cacheDirectory: string;
	readonly temporaryDirectory: string;
}): {
	readonly development: ReadonlyArray<{
		readonly scenario: string;
		readonly build: BuildSample;
		readonly invalidatedGeneratedObjects: ReadonlyArray<string>;
		readonly outputMatchedNode: boolean;
	}>;
	readonly production: ReadonlyArray<{
		readonly scenario: string;
		readonly build: BuildSample;
		readonly invalidatedGeneratedObjects: ReadonlyArray<string>;
	}>;
} {
	const project = path.join(options.temporaryDirectory, "incremental-project");
	const outputDirectory = path.join(options.temporaryDirectory, "incremental-output");
	mkdirSync(project, { recursive: true });
	writeFileSync(path.join(project, "package.json"), '{"type":"module"}\n');
	const entry = path.join(project, "entry.mjs");
	const dependency = path.join(project, "dependency.mjs");
	const baselineEntry = incrementalFixtureSource(384);
	const baselineDependency =
		"export function dependencyValue(value) { return Math.imul(value, 3) + 7; }\n";
	const restore = () => {
		writeFileSync(entry, baselineEntry);
		writeFileSync(dependency, baselineDependency);
	};
	restore();
	const config = resolveBuildConfig({
		engine: { eval: false, realms: false, intl: { enabled: false }, temporal: false },
		surface: { webPlatform: false, node: false },
	});
	const build = (
		production: boolean,
		sample: number,
		objectCacheVariant?: string,
		linkCacheVariant?: string,
	) =>
		buildSample({
			workload: "incremental",
			fixture: entry,
			config,
			targetCodeUnits: options.targetCodeUnits,
			sample,
			production,
			cacheDirectory: options.cacheDirectory,
			outputDirectory,
			objectCacheVariant,
			linkCacheVariant,
		});
	const matchesNode = (binary: string): boolean => {
		const node = spawnSync(process.execPath, [entry], { encoding: "utf8" });
		const native = spawnSync(binary, [], { encoding: "utf8" });
		if (node.error !== undefined) throw node.error;
		if (native.error !== undefined) throw native.error;
		return node.status === 0 && native.status === 0 && node.stdout === native.stdout;
	};
	const invalidated = (measurement: LocalBuildMeasurements): Array<string> =>
		measurement.objects
			.filter((object) => object.role === "generated" && object.cache === "miss")
			.map((object) => object.unit);
	const development: Array<{
		scenario: string;
		build: BuildSample;
		invalidatedGeneratedObjects: ReadonlyArray<string>;
		outputMatchedNode: boolean;
	}> = [];
	const baseline = build(false, 0);
	if (!matchesNode(baseline.result.binaryPath)) {
		throw new Error("incremental baseline output differed from Node");
	}
	const scenario = (name: string, mutate: () => void, sample: number) => {
		restore();
		build(false, -sample);
		mutate();
		const built = build(false, sample);
		const outputMatchedNode = matchesNode(built.result.binaryPath);
		if (!outputMatchedNode)
			throw new Error(`incremental ${name} output differed from Node`);
		development.push({
			scenario: name,
			build: built.report,
			invalidatedGeneratedObjects: invalidated(built.result.measurements),
			outputMatchedNode,
		});
	};
	scenario("exact rebuild", () => {}, 1);
	scenario(
		"one function-body edit",
		() => writeFileSync(entry, baselineEntry.replace("value + 101", "value + 10001")),
		2,
	);
	scenario(
		"one added function",
		() =>
			writeFileSync(
				entry,
				incrementalFixtureSource(
					384,
					"function added(value) { return value + 991; }\nfunctions.push(added);",
				),
			),
		3,
	);
	scenario(
		"one changed constant",
		() => writeFileSync(entry, baselineEntry.replace("TUNING = 23", "TUNING = 29")),
		4,
	);
	scenario(
		"one changed module",
		() => writeFileSync(dependency, baselineDependency.replace("value, 3", "value, 5")),
		5,
	);
	restore();
	const production: Array<{
		scenario: string;
		build: BuildSample;
		invalidatedGeneratedObjects: ReadonlyArray<string>;
	}> = [];
	const productionBaseline = build(true, 0);
	for (let sample = 1; sample <= 2; sample++) {
		const relink = build(
			true,
			sample,
			undefined,
			`thinlto-exact-relink-${String(sample)}`,
		);
		production.push({
			scenario: `exact relink ${String(sample)}`,
			build: relink.report,
			invalidatedGeneratedObjects: invalidated(relink.result.measurements),
		});
	}
	writeFileSync(entry, baselineEntry.replace("value + 101", "value + 10001"));
	const productionEdit = build(true, 3, undefined, "thinlto-function-edit");
	production.push({
		scenario: "one function-body edit",
		build: productionEdit.report,
		invalidatedGeneratedObjects: invalidated(productionEdit.result.measurements),
	});
	if (!productionBaseline.result.context.plan.lto) {
		production.splice(0, production.length, {
			scenario: "unsupported",
			build: productionBaseline.report,
			invalidatedGeneratedObjects: invalidated(productionBaseline.result.measurements),
		});
	}
	return { development, production };
}

function replaceOptimizationLevel(
	arguments_: ReadonlyArray<string>,
	level: "-O1" | "-O2",
): Array<string> {
	let replaced = false;
	const result = arguments_.map((argument) => {
		if (!/^-O(?:[0-3sz]|fast)$/.test(argument)) return argument;
		replaced = true;
		return level;
	});
	return replaced ? result : [...result, level];
}

function runGiantFunctionExperiment(options: {
	readonly selectedUnits: ReadonlyArray<GeneratedTranslationUnit>;
	readonly screeningUnits: ReadonlyArray<GeneratedTranslationUnit>;
	readonly measurements: ReadonlyArray<BuildSample>;
	readonly context: NativeBuildContext;
	readonly temporaryDirectory: string;
}): {
	readonly status: "not-applicable" | "measured";
	readonly reason?: string;
	readonly units?: ReadonlyArray<unknown>;
} {
	const compileMedians = new Map<string, number>();
	for (const unit of options.selectedUnits) {
		const samples = options.measurements.flatMap((sample) =>
			sample.objects
				.filter((object) => object.unit === unit.id && object.compileDurationMs !== null)
				.map((object) => object.compileDurationMs!),
		);
		if (samples.length > 0) compileMedians.set(unit.id, median(samples));
	}
	const candidates = options.selectedUnits
		.flatMap((unit) => {
			if (unit.kind !== "code") return [];
			const definitions = [...unit.definitions].sort(
				(left, right) => right.sourceCodeUnits - left.sourceCodeUnits,
			);
			const large = definitions.filter(
				(definition) => definition.sourceCodeUnits >= 1024 * 1024,
			);
			const selected =
				large.length > 0
					? large
					: unit.definitions.length === 1 && (compileMedians.get(unit.id) ?? 0) >= 5000
						? definitions
						: [];
			return selected.map((definition) => {
				const isolated = options.screeningUnits.find(
					(candidate) =>
						candidate.kind === "code" &&
						candidate.definitions.length === 1 &&
						candidate.definitions[0]?.symbol === definition.symbol,
				);
				if (isolated === undefined) {
					throw new Error(`cannot isolate giant generated function ${definition.symbol}`);
				}
				return { unit, definition, isolated };
			});
		})
		.sort(
			(left, right) =>
				(compileMedians.get(right.unit.id) ?? 0) -
					(compileMedians.get(left.unit.id) ?? 0) ||
				right.definition.sourceCodeUnits - left.definition.sourceCodeUnits,
		)
		.slice(0, 3);
	if (candidates.length === 0) {
		return {
			status: "not-applicable",
			reason:
				"No isolated function exceeded 1 MiB or five seconds at the selected partition target.",
		};
	}
	const baseArguments = generatedCCompileArguments(options.context);
	const results = candidates.map(({ unit, definition, isolated }) => {
		const sourcePath = path.join(options.temporaryDirectory, `giant-${unit.id}.c`);
		writeFileSync(sourcePath, isolated.source);
		const levels = (["-O2", "-O1"] as const).map((level) => {
			const samples = [];
			for (let sample = 0; sample < 3; sample++) {
				const objectPath = path.join(
					options.temporaryDirectory,
					`giant-${unit.id}-${level}-${String(sample)}.o`,
				);
				const measured = runTimedCommand({
					executable: options.context.toolchain.tools.cc.path,
					args: toolArguments(options.context.toolchain.tools.cc, [
						...replaceOptimizationLevel(baseArguments, level),
						`-ffile-prefix-map=${options.temporaryDirectory}=<generated>`,
						"-c",
						sourcePath,
						"-o",
						objectPath,
					]),
					env: { ...options.context.environment },
					temporaryDirectory: options.temporaryDirectory,
				});
				samples.push({
					sample,
					wallMs: measured.wallMs,
					cpuMs: measured.userCpuMs + measured.systemCpuMs,
					peakRssBytes: measured.peakRssBytes,
					objectBytes: statSync(objectPath).size,
				});
				rmSync(objectPath, { force: true });
			}
			return { level, samples };
		});
		return {
			unit: unit.id,
			isolatedUnit: isolated.id,
			definition,
			selectedTargetCompileMedianMs: compileMedians.get(unit.id),
			levels,
			conclusion:
				median(levels[1]!.samples.map((sample) => sample.wallMs)) <
				median(levels[0]!.samples.map((sample) => sample.wallMs)) * 0.8
					? "O1 is a compile-time candidate but is not adopted without linked runtime evidence."
					: "O1 did not clear the 20% compile-time screening threshold.",
		};
	});
	return { status: "measured", units: results };
}

function removeGeneratedBuildFiles(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".c")) {
			rmSync(path.join(directory, entry.name), { force: true });
		}
	}
}

function run(options: Options): void {
	const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "mal-tu-benchmark-"));
	const cacheDirectory = path.join(temporaryDirectory, "shared-cache");
	const outputDirectory = path.join(temporaryDirectory, "binaries");
	mkdirSync(outputDirectory, { recursive: true });
	mkdirSync(path.dirname(options.output), { recursive: true });
	const buildSamples: Array<BuildSample> = [];
	const runtimeSamples: Array<RuntimeSample> = [];
	const binaries = new Map<string, string>();
	const report: Record<string, unknown> = {
		schema: 1,
		status: "running",
		startedAt: new Date().toISOString(),
		host: { platform: process.platform, arch: process.arch, node: process.version },
		options,
		hardMaximumCodeUnits: HARD_MAXIMUM_CODE_UNITS,
		buildSamples,
		runtimeSamples,
	};
	const persist = () =>
		writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
	let selectedTargetCodeUnits = options.validationTargetCodeUnits;
	let diagnostic: BuiltSample | undefined;
	try {
		persist();
		if (options.phase !== "validation") {
			for (let sample = 0; sample < options.coldRuns; sample++) {
				const offset = sample % options.targets.length;
				const order = [
					...options.targets.slice(offset),
					...options.targets.slice(0, offset),
				];
				for (const targetCodeUnits of order) {
					for (const workload of sample % 2 === 0
						? WORKLOADS
						: [...WORKLOADS].reverse()) {
						console.log(
							`cold ${String(sample + 1)}/${String(options.coldRuns)} ${workload} ${String(targetCodeUnits / 1024)} KiB`,
						);
						const variant = `cold-${workload}-${String(targetCodeUnits)}-${String(sample)}`;
						const built = buildSample({
							workload,
							fixture: workloadFixture(workload),
							config: workloadConfig(workload),
							targetCodeUnits,
							sample,
							production: false,
							cacheDirectory,
							outputDirectory,
							objectCacheVariant: variant,
							linkCacheVariant: variant,
							includeInvariants: sample === 0,
						});
						if (built.report.objects.some((object) => object.cache !== "miss")) {
							throw new Error("cold build unexpectedly reused a generated object");
						}
						buildSamples.push(built.report);
						binaries.set(
							`${workload}:${String(targetCodeUnits)}`,
							built.result.binaryPath,
						);
						persist();
					}
				}
			}
			if (options.phase === "cold") {
				report.status = "passed";
				report.completedAt = new Date().toISOString();
				persist();
				console.log(options.output);
				return;
			}
			removeGeneratedBuildFiles(outputDirectory);
			const runtimeReferences = prepareRuntimeReferences(temporaryDirectory);
			report.runtimeReferences = Object.fromEntries(
				WORKLOADS.map((workload) => [workload, runtimeReferences[workload].checksum]),
			);
			for (let sample = 0; sample < options.runtimeRuns; sample++) {
				const offset = sample % options.targets.length;
				const order = [
					...options.targets.slice(offset),
					...options.targets.slice(0, offset),
				];
				for (const targetCodeUnits of order) {
					for (const workload of sample % 2 === 0
						? WORKLOADS
						: [...WORKLOADS].reverse()) {
						console.log(
							`runtime ${String(sample + 1)}/${String(options.runtimeRuns)} ${workload} ${String(targetCodeUnits / 1024)} KiB`,
						);
						const binary = binaries.get(`${workload}:${String(targetCodeUnits)}`)!;
						const measured = runtimeReferences[workload].run(binary, sample);
						runtimeSamples.push({ ...measured, targetCodeUnits });
						persist();
					}
				}
			}
			const targetSummaries = summarizeTargets(
				options.targets,
				buildSamples,
				runtimeSamples,
				runtimeReferences,
			);
			report.gateThresholds = GATE_THRESHOLDS;
			report.targetSummaries = targetSummaries;
			const selected = targetSummaries
				.filter((summary) => summary.accepted)
				.sort((left, right) => left.cToObjectWallMs - right.cToObjectWallMs)[0];
			if (selected === undefined)
				throw new Error("no translation-unit target passed the gates");
			selectedTargetCodeUnits = selected.targetCodeUnits;
			report.selectedTargetCodeUnits = selectedTargetCodeUnits;
			if (options.phase === "sweep") {
				report.status = "passed";
				report.completedAt = new Date().toISOString();
				persist();
				console.log(options.output);
				return;
			}
			persist();
		}
		if (selectedTargetCodeUnits === undefined) {
			throw new Error("validation requires a selected translation-unit target");
		}
		report.selectedTargetCodeUnits = selectedTargetCodeUnits;

		const ltoSamples: Array<BuildSample> = [];
		if (options.validationPart === "all" || options.validationPart === "lto") {
			for (let sample = 0; sample < options.coldRuns; sample++) {
				for (const workload of sample % 2 === 0 ? WORKLOADS : [...WORKLOADS].reverse()) {
					for (const production of sample % 2 === 0 ? [false, true] : [true, false]) {
						const mode = production ? "production" : "no-lto";
						console.log(
							`${mode} ${String(sample + 1)}/${String(options.coldRuns)} ${workload} ${String(selectedTargetCodeUnits / 1024)} KiB`,
						);
						const variant = `lto-${mode}-${workload}-${String(sample)}`;
						const built = buildSample({
							workload,
							fixture: workloadFixture(workload),
							config: workloadConfig(workload),
							targetCodeUnits: selectedTargetCodeUnits,
							sample,
							production,
							cacheDirectory,
							outputDirectory,
							objectCacheVariant: variant,
							linkCacheVariant: variant,
						});
						ltoSamples.push(built.report);
						if (!production && sample === 0 && workload === "self-compile") {
							diagnostic = built;
						}
						report.ltoSamples = ltoSamples;
						persist();
					}
				}
			}
		}

		if (options.validationPart === "all" || options.validationPart === "incremental") {
			console.log("incremental locality and ThinLTO relink scenarios");
			report.incremental = runIncrementalScenarios({
				targetCodeUnits: selectedTargetCodeUnits,
				cacheDirectory,
				temporaryDirectory,
			});
			persist();
		}

		if (options.validationPart === "all" || options.validationPart === "giant") {
			console.log("pathological giant-function screening");
			if (diagnostic === undefined) {
				diagnostic = buildSample({
					workload: "self-compile",
					fixture: SELF_COMPILE_FIXTURE,
					config: SELF_COMPILE_CONFIG,
					targetCodeUnits: selectedTargetCodeUnits,
					sample: 0,
					production: false,
					cacheDirectory,
					outputDirectory,
					objectCacheVariant: "giant-diagnostic",
					linkCacheVariant: "giant-diagnostic",
				});
				report.giantDiagnostic = diagnostic.report;
				persist();
			}
			const emitOptions = {
				sourcePath: nativeSourcePath,
				compiled: true,
				maligatorSurface: SELF_COMPILE_CONFIG.surface.maligator,
			};
			const selectedUnits = emitProgramTranslationUnits(
				diagnostic.result.programImage,
				emitOptions,
				{
					targetCodeUnits: selectedTargetCodeUnits,
					hardMaximumCodeUnits: HARD_MAXIMUM_CODE_UNITS,
				},
			);
			const screeningUnits = emitProgramTranslationUnits(
				diagnostic.result.programImage,
				emitOptions,
				{
					targetCodeUnits: Math.min(selectedTargetCodeUnits, 512 * 1024),
					hardMaximumCodeUnits: HARD_MAXIMUM_CODE_UNITS,
				},
			);
			const measurements = [...buildSamples, ...ltoSamples].filter(
				(sample) =>
					sample.workload === "self-compile" &&
					sample.targetCodeUnits === selectedTargetCodeUnits &&
					sample.mode === "development",
			);
			if (!measurements.includes(diagnostic.report)) measurements.push(diagnostic.report);
			report.giantFunctionExperiment = runGiantFunctionExperiment({
				selectedUnits,
				screeningUnits,
				measurements,
				context: diagnostic.result.context,
				temporaryDirectory,
			});
		}
		report.status = "passed";
		report.completedAt = new Date().toISOString();
		persist();
		console.log(options.output);
	} catch (error) {
		report.status = "failed";
		report.error =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		report.completedAt = new Date().toISOString();
		persist();
		throw error;
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

const invokedPath = process.argv[1];
if (
	invokedPath !== undefined &&
	pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
	run(parseOptions(process.argv.slice(2)));
}
