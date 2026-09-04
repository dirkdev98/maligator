/**
 * Maligator's benchmark contract has three deliberately different families:
 *
 * - javascript: one balanced core-language ES module under the production native
 *   plan across the complete closed/open x compiled/interpreted matrix, plus Node.
 * - http: the closed compiled bare and Express flagship servers versus Node.
 * - self-compile: the closed compiled Maligator compiler versus its Node host.
 *
 * The committed snapshot contains only stable outcome metrics. Mechanism-specific
 * counters and historical microbenchmarks are diagnostics, not baseline lanes.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { CORE_OPTIMIZATION_FAMILIES } from "../src/compiler/core/core-optimization-families.ts";
import type { CoreOptimizationFamily } from "../src/compiler/core/core-optimization-families.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import type {
	NativeBuildCommandResourceEvent,
	NativeBuildPhaseEvent,
} from "../src/native-build-context.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
} from "../src/test-harness.ts";
import { persistBenchmarkBaseline, readBenchmarkBaseline } from "./bench-baseline.ts";
import { runBenchmarkComparison, selectChangedBenchmarkLanes } from "./bench-compare.ts";
import {
	formatOhaDuration,
	parseOhaOutput,
	planExpressHttpWorkload,
} from "./bench-http.ts";
import type { ExpressHttpWorkload, OhaMetrics } from "./bench-http.ts";
import {
	digestSelfCompileOutput,
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

const BASELINE_FILE = "bench/baseline.json";
const JAVASCRIPT_FIXTURE = "bench/javascript.mjs";
const BENCHMARK_SCHEMA = 3;
const JAVASCRIPT_MODES = [
	"closed-compiled",
	"open-compiled",
	"closed-interpreted",
	"open-interpreted",
] as const;
type JavascriptMode = (typeof JAVASCRIPT_MODES)[number];
type JavascriptWorld = "closed" | "open";
type JavascriptBackend = "compiled" | "interpreted";

const progress = new CommandProgress("bench");
const CLOSED_CONFIG = resolveBuildConfig({});
const OPEN_CONFIG = resolveBuildConfig({
	engine: { primordials: "mutable", eval: true, realms: true },
});
const CLOSED_HTTP_CONFIG = resolveBuildConfig({
	surface: { webPlatform: true },
});
const CLOSED_EXPRESS_CONFIG = resolveBuildConfig({
	surface: { node: true, webPlatform: true },
});

interface PhaseOutput {
	checksum: number;
	elapsedMs: number;
}

interface JavascriptOutput {
	workload: string;
	phases: Record<string, PhaseOutput>;
}

interface JavascriptSample {
	wallMs: number;
	phases: Record<string, number>;
	checksums: Record<string, number>;
}

interface JavascriptReferenceMetrics {
	wallMs: number;
	phaseMs: Record<string, number>;
}

interface JavascriptModeMetrics extends JavascriptReferenceMetrics {
	world: JavascriptWorld;
	backend: JavascriptBackend;
	config: {
		primordials: "locked" | "mutable";
		eval: boolean;
		realms: boolean;
	};
	ratio: number;
	balancedRatio: number;
	binaryBytes: number;
	nativeBuild: NativeOutputBuildMetrics;
	collections: number;
	allocatedMb: number;
	peakLiveKb: number;
	maxPauseMs: number;
	rssMb?: number;
}

interface JavascriptMetrics {
	workload: string;
	runs: number;
	nativeBuild: {
		mode: "production";
		optimizationFlags: ReadonlyArray<string>;
		lto: boolean;
		strip: boolean;
		compiler: string;
		compilerVersion: string;
		target: string;
	};
	phaseChecksums: Record<string, number>;
	node: JavascriptReferenceMetrics;
	modes: Partial<Record<JavascriptMode, JavascriptModeMetrics>>;
}

interface HttpComparisonMetrics {
	malRps: number;
	nodeRps: number;
	ratio: number;
	malP99Ms: number;
	nodeP99Ms: number;
}

interface HttpMetrics {
	world: "closed";
	runs: number;
	bare: HttpComparisonMetrics & {
		binaryBytes: number;
		nativeBuild: NativeOutputBuildMetrics;
		runtime: NativeRuntimeMetrics;
	};
	express: {
		binaryBytes: number;
		nativeBuild: NativeOutputBuildMetrics;
		runtime: NativeRuntimeMetrics;
		workloads: Record<string, HttpComparisonMetrics>;
	};
}

interface SelfCompilePhases {
	graphMs: number;
	semanticMs: number;
	constructCoreMs: number;
	optimizeCoreMs: number;
	coreToExecutionMs: number;
	executionToImageMs: number;
	emitMs: number;
	writeMs: number;
}

interface SelfCompileMetrics {
	world: "closed";
	maligatorMs: number;
	nodeMs: number;
	maligatorPhases: SelfCompilePhases;
	nodePhases: SelfCompilePhases;
	runs: number;
	units: number;
	maligatorCodeUnits: number;
	nodeCodeUnits: number;
	platform: string;
	arch: string;
	nodeVersion: string;
	nativeBuild: NativeOutputBuildMetrics;
	runtime: {
		readonly maligator: NativeRuntimeMetrics;
		readonly nodePeakRssBytes: number;
	};
	cold: {
		readonly node: SelfCompileSample;
		readonly maligator: SelfCompileSample;
	};
	warm: {
		readonly node: ReadonlyArray<SelfCompileSample>;
		readonly maligator: ReadonlyArray<SelfCompileSample>;
	};
	phasesSample: {
		readonly node: SelfCompileSample & { readonly optimizer: CoreOptimizationReport };
		readonly maligator: SelfCompileSample & {
			readonly optimizer: CoreOptimizationReport;
		};
	};
}

interface SelfCompileCheckpoint {
	readonly schema: 1;
	readonly source: NonNullable<BenchmarkSnapshot["source"]>;
	readonly runs: number;
	readonly nativeCacheDirectory?: string;
	readonly coreOptimizationAblation?: CoreOptimizationFamily;
	readonly root: string;
	readonly binary: string;
	readonly nativeBuild: NativeOutputBuildMetrics;
	cold?: {
		readonly node: SelfCompileSample;
		readonly maligator: SelfCompileSample;
	};
	warmup?: {
		readonly node: SelfCompileSample;
		readonly maligator: SelfCompileSample;
	};
	readonly warm: {
		node: Array<SelfCompileSample>;
		maligator: Array<SelfCompileSample>;
	};
	phasesSample?: SelfCompileMetrics["phasesSample"];
	runtime?: SelfCompileMetrics["runtime"];
	complete?: true;
}

interface NativeOutputBuildMetrics {
	readonly phasesMs: Readonly<Record<string, number>>;
	readonly totalMs: number;
	readonly translationUnits: number;
	readonly generatedCBytes: number;
	readonly objectBytes: number;
	readonly cCompilationMs: number;
	readonly linkMs: number;
	readonly stripMs: number;
	readonly peakRssBytes: number;
}

interface NativeRuntimeMetrics {
	readonly collections: number;
	readonly allocatedBytes: number;
	readonly peakLiveBytes: number;
	readonly maxPauseMs: number;
	readonly rssBytes: number;
}

interface BenchmarkSnapshot {
	schema: 3;
	coreOptimizationAblation?: CoreOptimizationFamily;
	source?: {
		readonly commit: string;
		readonly dirty: boolean;
		readonly digest: string;
		readonly benchmarkDigest: string;
		readonly configurationDigest: string;
	};
	javascript?: JavascriptMetrics;
	http?: HttpMetrics;
	selfCompile?: SelfCompileMetrics;
}

function median(values: ReadonlyArray<number>): number {
	if (values.length === 0) throw new Error("median requires at least one value");
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function hashBytes(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function benchmarkSource(): NonNullable<BenchmarkSnapshot["source"]> {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const dirtyPatch = execFileSync("git", ["diff", "--binary", "HEAD"], {
		encoding: "utf8",
	});
	const benchmarkFiles = [
		"bench/javascript.mjs",
		"bench/http/express-server.cjs",
		"bench/http/server_mal.js",
		"bench/http/server_node.js",
		"bench/self-compile.mts",
		"scripts/bench.ts",
		"package-lock.json",
	];
	const benchmarkDigest = createHash("sha256");
	for (const file of benchmarkFiles) {
		benchmarkDigest.update(file);
		benchmarkDigest.update(readFileSync(file));
	}
	return Object.freeze({
		commit,
		dirty: dirtyPatch.length > 0,
		digest: hashBytes(`${commit}\0${dirtyPatch}`),
		benchmarkDigest: benchmarkDigest.digest("hex"),
		configurationDigest: hashBytes(
			JSON.stringify({
				closed: CLOSED_CONFIG,
				open: OPEN_CONFIG,
				http: CLOSED_HTTP_CONFIG,
				express: CLOSED_EXPRESS_CONFIG,
				selfCompile: SELF_COMPILE_CONFIG,
			}),
		),
	});
}

function medianRecord(
	records: ReadonlyArray<Record<string, number>>,
): Record<string, number> {
	const names = Object.keys(records[0] ?? {});
	if (names.length === 0) throw new Error("phase report is empty");
	for (const record of records) {
		if (JSON.stringify(Object.keys(record)) !== JSON.stringify(names)) {
			throw new Error("phase names changed between benchmark samples");
		}
	}
	return Object.fromEntries(
		names.map((name) => [name, median(records.map((record) => record[name]!))]),
	);
}

function geometricMean(values: ReadonlyArray<number>): number {
	if (values.length === 0 || values.some((value) => value <= 0)) {
		throw new Error("balanced ratio requires positive phase timings");
	}
	return Math.exp(
		values.reduce((total, value) => total + Math.log(value), 0) / values.length,
	);
}

function fileBytes(file: string): number {
	return statSync(file).size;
}

function nativeBuildRecorder(): {
	readonly observe: (event: NativeBuildPhaseEvent) => void;
	readonly observeResource: (
		event: NativeBuildCommandResourceEvent & { readonly subject: string },
	) => void;
	readonly metrics: (subject: string) => NativeOutputBuildMetrics;
} {
	const bySubject = new Map<string, Array<NativeBuildPhaseEvent>>();
	const peakRssBySubject = new Map<string, number>();
	return {
		observe(event) {
			if (event.subject === undefined) return;
			const events = bySubject.get(event.subject) ?? [];
			events.push(event);
			bySubject.set(event.subject, events);
		},
		observeResource(event) {
			peakRssBySubject.set(
				event.subject,
				Math.max(peakRssBySubject.get(event.subject) ?? 0, event.peakRssBytes),
			);
		},
		metrics(subject) {
			const events = bySubject.get(subject) ?? [];
			const phase = (name: NativeBuildPhaseEvent["phase"]): number =>
				events
					.filter((event) => event.phase === name)
					.reduce((total, event) => total + event.durationMs, 0);
			const generated = events.find((event) => event.phase === "write generated C");
			const objects = events.find((event) => event.phase === "generated C objects");
			const peakRssBytes = peakRssBySubject.get(subject);
			if (peakRssBytes === undefined) {
				throw new Error(`native build RSS was not measured for ${subject}`);
			}
			return Object.freeze({
				phasesMs: Object.freeze(
					Object.fromEntries(events.map((event) => [event.phase, phase(event.phase)])),
				),
				totalMs: events.reduce((total, event) => total + event.durationMs, 0),
				translationUnits: generated?.units ?? 0,
				generatedCBytes: generated?.bytes ?? 0,
				objectBytes: objects?.bytes ?? 0,
				cCompilationMs: phase("generated C objects"),
				linkMs: phase("link"),
				stripMs: phase("strip"),
				peakRssBytes,
			});
		},
	};
}

function parseGcStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[gc-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9.]+)`));
	if (match === undefined || match === null)
		throw new Error(`GC report omitted ${field}`);
	return Number(match[1]);
}

function parsePeakRssBytes(stderr: string): number | undefined {
	const mac = stderr.match(/([0-9]+)\s+maximum resident set size/);
	if (mac !== null) return Number(mac[1]);
	const linux = stderr.match(/Maximum resident set size \(kbytes\):\s*([0-9]+)/);
	return linux === null ? undefined : Number(linux[1]) * 1024;
}

function parseJavascriptOutput(stdout: string, label: string): JavascriptOutput {
	const line = stdout.trim().split("\n").filter(Boolean).at(-1);
	if (line === undefined) throw new Error(`${label} produced no workload report`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`${label} produced invalid JSON: ${line}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { workload?: unknown }).workload !== "javascript-v1" ||
		typeof (parsed as { phases?: unknown }).phases !== "object" ||
		(parsed as { phases?: unknown }).phases === null
	) {
		throw new Error(`${label} produced an invalid JavaScript workload report`);
	}
	const result = parsed as JavascriptOutput;
	for (const [name, phase] of Object.entries(result.phases)) {
		if (
			typeof phase.checksum !== "number" ||
			!Number.isFinite(phase.checksum) ||
			typeof phase.elapsedMs !== "number" ||
			!Number.isFinite(phase.elapsedMs) ||
			phase.elapsedMs <= 0
		) {
			throw new Error(`${label} produced invalid phase ${name}`);
		}
	}
	return result;
}

function runJavascriptSample(
	command: string,
	args: ReadonlyArray<string>,
	label: string,
): JavascriptSample {
	const startedAt = process.hrtime.bigint();
	const invocation = resolveHarnessExecutionInvocation(command);
	const result = spawnSync(invocation.executable, [...invocation.args, ...args], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	}
	const output = parseJavascriptOutput(result.stdout, label);
	return {
		wallMs,
		phases: Object.fromEntries(
			Object.entries(output.phases).map(([name, phase]) => [name, phase.elapsedMs]),
		),
		checksums: Object.fromEntries(
			Object.entries(output.phases).map(([name, phase]) => [name, phase.checksum]),
		),
	};
}

function assertSameChecksums(
	reference: Record<string, number>,
	actual: Record<string, number>,
	label: string,
): void {
	if (JSON.stringify(actual) !== JSON.stringify(reference)) {
		throw new Error(
			`${label} checksum mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(reference)}`,
		);
	}
}

function worldConfig(config: ResolvedBuildConfig): JavascriptModeMetrics["config"] {
	return {
		primordials: config.engine.primordials,
		eval: config.engine.eval === true,
		realms: config.engine.realms,
	};
}

function modeParts(mode: JavascriptMode): {
	world: JavascriptWorld;
	backend: JavascriptBackend;
} {
	const [world, backend] = mode.split("-") as [JavascriptWorld, JavascriptBackend];
	return { world, backend };
}

function javascriptGcMetrics(
	binary: string,
	label: string,
): Pick<
	JavascriptModeMetrics,
	"collections" | "allocatedMb" | "peakLiveKb" | "maxPauseMs"
> {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(invocation.executable, invocation.args, {
		env: { ...process.env, MAL_GC_STATS: "1" },
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${label} GC probe failed (${result.status}):\n${result.stderr}`);
	}
	parseJavascriptOutput(result.stdout, `${label} GC probe`);
	return {
		collections: parseGcStat(result.stderr, "collections"),
		allocatedMb: parseGcStat(result.stderr, "allocated_bytes") / (1024 * 1024),
		peakLiveKb: parseGcStat(result.stderr, "peak_live_bytes") / 1024,
		maxPauseMs: parseGcStat(result.stderr, "max_pause_ms"),
	};
}

function javascriptRssMb(binary: string): number | undefined {
	if (process.platform !== "darwin") return undefined;
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(
		"/usr/bin/time",
		["-l", invocation.executable, ...invocation.args],
		{
			encoding: "utf8",
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	if (result.status !== 0)
		throw new Error(`RSS probe failed for ${binary}: ${result.stderr}`);
	const bytes = parsePeakRssBytes(result.stderr);
	return bytes === undefined ? undefined : bytes / (1024 * 1024);
}

function benchJavascript(
	runs: number,
	selectedModes: ReadonlyArray<JavascriptMode>,
	nativeCacheDirectory?: string,
	coreOptimizationAblation?: CoreOptimizationFamily,
): JavascriptMetrics {
	const nativeBuild = nativeBuildRecorder();
	const binaries: Partial<Record<JavascriptMode, string>> = {};
	let nativeBuildContext:
		| ReturnType<typeof buildBackendPairFromOneProgramImage>["context"]
		| undefined;
	if (selectedModes.some((mode) => mode.startsWith("closed-"))) {
		const closed = buildBackendPairFromOneProgramImage({
			fixture: JAVASCRIPT_FIXTURE,
			name: "bench-javascript-closed",
			config: CLOSED_CONFIG,
			production: true,
			cacheDirectory: nativeCacheDirectory,
			onNativeBuildPhase: nativeBuild.observe,
			measureNativeBuildResources: true,
			onNativeCommandResource: nativeBuild.observeResource,
			coreOptimizationBenchmarkAblation:
				coreOptimizationAblation === undefined
					? undefined
					: { family: coreOptimizationAblation },
		});
		binaries["closed-compiled"] = closed.compiled;
		binaries["closed-interpreted"] = closed.interpreted;
		nativeBuildContext = closed.context;
	}
	if (selectedModes.some((mode) => mode.startsWith("open-"))) {
		const open = buildBackendPairFromOneProgramImage({
			fixture: JAVASCRIPT_FIXTURE,
			name: "bench-javascript-open",
			config: OPEN_CONFIG,
			production: true,
			cacheDirectory: nativeCacheDirectory,
			onNativeBuildPhase: nativeBuild.observe,
			measureNativeBuildResources: true,
			onNativeCommandResource: nativeBuild.observeResource,
			coreOptimizationBenchmarkAblation:
				coreOptimizationAblation === undefined
					? undefined
					: { family: coreOptimizationAblation },
		});
		binaries["open-compiled"] = open.compiled;
		binaries["open-interpreted"] = open.interpreted;
		nativeBuildContext ??= open.context;
	}
	if (nativeBuildContext === undefined) {
		throw new Error("JavaScript benchmark selected no native backend");
	}
	if (nativeBuildContext.plan.mode !== "production") {
		throw new Error("JavaScript benchmark requires a production native build");
	}
	const binaryFor = (mode: JavascriptMode): string => {
		const binary = binaries[mode];
		if (binary === undefined) throw new Error(`JavaScript mode ${mode} was not built`);
		return binary;
	};
	const subjects = [
		{ label: "node", command: process.execPath, args: [JAVASCRIPT_FIXTURE] },
		...selectedModes.map((mode) => ({ label: mode, command: binaryFor(mode), args: [] })),
	];
	const samples = new Map<string, Array<JavascriptSample>>(
		subjects.map(({ label }) => [label, []]),
	);

	progress.detail("javascript warmup");
	const warmReference = runJavascriptSample(
		process.execPath,
		[JAVASCRIPT_FIXTURE],
		"node warmup",
	);
	for (const mode of selectedModes) {
		const warm = runJavascriptSample(binaryFor(mode), [], `${mode} warmup`);
		assertSameChecksums(warmReference.checksums, warm.checksums, `${mode} warmup`);
	}

	for (let sample = 0; sample < runs; sample++) {
		const offset = sample % subjects.length;
		const order = [...subjects.slice(offset), ...subjects.slice(0, offset)];
		for (const subject of order) {
			progress.detail(`javascript sample ${sample + 1}/${runs}: ${subject.label}`);
			const result = runJavascriptSample(subject.command, subject.args, subject.label);
			assertSameChecksums(warmReference.checksums, result.checksums, subject.label);
			samples.get(subject.label)!.push(result);
		}
	}

	const summarize = (label: string): JavascriptReferenceMetrics => {
		const subjectSamples = samples.get(label)!;
		return {
			wallMs: median(subjectSamples.map(({ wallMs }) => wallMs)),
			phaseMs: medianRecord(subjectSamples.map(({ phases }) => phases)),
		};
	};
	const node = summarize("node");
	const modes: Partial<Record<JavascriptMode, JavascriptModeMetrics>> = {};
	for (const mode of selectedModes) {
		const summary = summarize(mode);
		const { world, backend } = modeParts(mode);
		const config = world === "closed" ? CLOSED_CONFIG : OPEN_CONFIG;
		const phaseNames = Object.keys(node.phaseMs);
		const binary = binaryFor(mode);
		const executable = resolveHarnessExecutionInvocation(binary).executable;
		const rssMb = javascriptRssMb(binary);
		modes[mode] = {
			...summary,
			world,
			backend,
			config: worldConfig(config),
			ratio: summary.wallMs / node.wallMs,
			balancedRatio: geometricMean(
				phaseNames.map((name) => summary.phaseMs[name]! / node.phaseMs[name]!),
			),
			binaryBytes: fileBytes(executable),
			nativeBuild: nativeBuild.metrics(`bench-javascript-${world}-${backend}`),
			...javascriptGcMetrics(binary, mode),
			...(rssMb === undefined ? {} : { rssMb }),
		};
	}
	return {
		workload: "javascript-v1",
		runs,
		nativeBuild: {
			mode: "production",
			optimizationFlags: ["-O2", "-g0", ...nativeBuildContext.plan.ltoFlags],
			lto: nativeBuildContext.plan.lto,
			strip: nativeBuildContext.plan.strip,
			compiler: nativeBuildContext.toolchain.tools.cc.path,
			compilerVersion: nativeBuildContext.toolchain.tools.cc.version,
			target: nativeBuildContext.toolchain.rustTarget,
		},
		phaseChecksums: warmReference.checksums,
		node,
		modes,
	};
}

interface SelfCompileRun {
	wallMs: number;
	units: number;
	codeUnits: number;
	digest: string;
	phases: SelfCompilePhases;
	optimizer: CoreOptimizationReport;
}

type SelfCompileSample = Omit<SelfCompileRun, "optimizer">;

function selfCompileSample(run: SelfCompileRun): SelfCompileSample {
	return {
		wallMs: run.wallMs,
		units: run.units,
		codeUnits: run.codeUnits,
		digest: run.digest,
		phases: run.phases,
	};
}

function runSelfCompile(
	command: string,
	args: Array<string>,
	output: string,
	instrumentation: "off" | "phases" = "off",
): SelfCompileRun {
	const start = process.hrtime.bigint();
	const result = spawnSync(command, [...args, output], {
		env: { ...process.env, MAL_CORE_INSTRUMENTATION: instrumentation },
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 900_000,
	});
	const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`self-compile failed (${result.status}): ${command} ${args.join(" ")}\n${result.stderr}`,
		);
	}
	const summary = JSON.parse(result.stdout.trim()) as {
		units: number;
		codeUnits: number;
		phases: SelfCompilePhases;
		optimizer: CoreOptimizationReport;
	};
	return {
		wallMs,
		units: summary.units,
		codeUnits: summary.codeUnits,
		digest: digestSelfCompileOutput(output),
		phases: summary.phases,
		optimizer: summary.optimizer,
	};
}

function runSelfCompileResourceSample(
	command: string,
	args: ReadonlyArray<string>,
	output: string,
	gcStatistics: boolean,
): { readonly run: SelfCompileRun; readonly stderr: string; readonly rssBytes: number } {
	const timeFlag = process.platform === "darwin" ? "-l" : "-v";
	const startedAt = process.hrtime.bigint();
	const result = spawnSync("/usr/bin/time", [timeFlag, command, ...args, output], {
		env: {
			...process.env,
			MAL_CORE_INSTRUMENTATION: "off",
			...(gcStatistics ? { MAL_GC_STATS: "1" } : {}),
		},
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: 900_000,
	});
	const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`self-compile resource probe failed (${String(result.status)}): ${result.stderr}`,
		);
	}
	const summary = JSON.parse(result.stdout.trim()) as {
		units: number;
		codeUnits: number;
		phases: SelfCompilePhases;
		optimizer: CoreOptimizationReport;
	};
	const rssBytes = parsePeakRssBytes(result.stderr);
	if (rssBytes === undefined) throw new Error("self-compile resource probe omitted RSS");
	return {
		run: {
			wallMs,
			units: summary.units,
			codeUnits: summary.codeUnits,
			digest: digestSelfCompileOutput(output),
			phases: summary.phases,
			optimizer: summary.optimizer,
		},
		stderr: result.stderr,
		rssBytes,
	};
}

function nativeRuntimeMetrics(stderr: string, rssBytes: number): NativeRuntimeMetrics {
	return {
		collections: parseGcStat(stderr, "collections"),
		allocatedBytes: parseGcStat(stderr, "allocated_bytes"),
		peakLiveBytes: parseGcStat(stderr, "peak_live_bytes"),
		maxPauseMs: parseGcStat(stderr, "max_pause_ms"),
		rssBytes,
	};
}

function assertSameSelfCompile(reference: SelfCompileRun, actual: SelfCompileRun): void {
	if (
		actual.units !== reference.units ||
		actual.codeUnits !== reference.codeUnits ||
		actual.digest !== reference.digest
	) {
		throw new Error(
			`self-compile output mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(reference)}`,
		);
	}
}

function assertComparableSelfCompile(
	node: SelfCompileRun,
	maligator: SelfCompileRun,
): void {
	if (
		node.units !== maligator.units ||
		node.codeUnits !== maligator.codeUnits ||
		node.digest !== maligator.digest
	) {
		throw new Error(
			`self-compile workloads diverged: ${JSON.stringify(maligator)} != ${JSON.stringify(node)}`,
		);
	}
}

function medianPhases(values: ReadonlyArray<SelfCompilePhases>): SelfCompilePhases {
	const field = (name: keyof SelfCompilePhases): number =>
		median(values.map((value) => value[name]));
	return {
		graphMs: field("graphMs"),
		semanticMs: field("semanticMs"),
		constructCoreMs: field("constructCoreMs"),
		optimizeCoreMs: field("optimizeCoreMs"),
		coreToExecutionMs: field("coreToExecutionMs"),
		executionToImageMs: field("executionToImageMs"),
		emitMs: field("emitMs"),
		writeMs: field("writeMs"),
	};
}

function assembleSelfCompileMetrics(input: {
	readonly runs: number;
	readonly nativeBuild: NativeOutputBuildMetrics;
	readonly cold: SelfCompileMetrics["cold"];
	readonly warm: SelfCompileMetrics["warm"];
	readonly phasesSample: SelfCompileMetrics["phasesSample"];
	readonly runtime: SelfCompileMetrics["runtime"];
}): SelfCompileMetrics {
	const firstNode = input.warm.node[0];
	const firstMaligator = input.warm.maligator[0];
	if (firstNode === undefined || firstMaligator === undefined) {
		throw new Error("self-compile metrics require at least one paired sample");
	}
	return {
		world: "closed",
		maligatorMs: median(input.warm.maligator.map(({ wallMs }) => wallMs)),
		nodeMs: median(input.warm.node.map(({ wallMs }) => wallMs)),
		maligatorPhases: medianPhases(input.warm.maligator.map(({ phases }) => phases)),
		nodePhases: medianPhases(input.warm.node.map(({ phases }) => phases)),
		runs: input.runs,
		units: firstNode.units,
		maligatorCodeUnits: firstMaligator.codeUnits,
		nodeCodeUnits: firstNode.codeUnits,
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.version,
		nativeBuild: input.nativeBuild,
		runtime: input.runtime,
		cold: input.cold,
		warm: input.warm,
		phasesSample: input.phasesSample,
	};
}

function benchSelfCompile(
	runs: number,
	nativeCacheDirectory?: string,
): SelfCompileMetrics {
	const nativeBuild = nativeBuildRecorder();
	const fixture = path.resolve("bench/self-compile.mts");
	const binary = buildNativeBinary({
		fixture,
		name: "bench-self-compile",
		config: SELF_COMPILE_CONFIG,
		cacheDirectory: nativeCacheDirectory,
		onNativeBuildPhase: nativeBuild.observe,
		measureNativeBuildResources: true,
		onNativeCommandResource: nativeBuild.observeResource,
	});
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-self-compile-"));
	const maligatorRuns: Array<SelfCompileRun> = [];
	const nodeRuns: Array<SelfCompileRun> = [];
	try {
		progress.detail("self-compile cold samples");
		const coldTarget = prepareSelfCompileSource(path.join(root, "cold-source"));
		const coldMaligator = runSelfCompile(
			binary,
			[coldTarget],
			path.join(root, "cold-maligator"),
		);
		const coldNode = runSelfCompile(
			process.execPath,
			[fixture, coldTarget],
			path.join(root, "cold-node"),
		);
		assertComparableSelfCompile(coldNode, coldMaligator);
		const target = prepareSelfCompileSource(path.join(root, "source"));
		progress.detail("self-compile warmup");
		const warmupNode = runSelfCompile(
			process.execPath,
			[fixture, target],
			path.join(root, "warmup-node"),
		);
		const warmupMaligator = runSelfCompile(
			binary,
			[target],
			path.join(root, "warmup-maligator"),
		);
		assertComparableSelfCompile(warmupNode, warmupMaligator);
		for (let index = 0; index < runs; index++) {
			progress.detail(`self-compile paired sample ${index + 1}/${runs}`);
			const nodeOutput = path.join(root, `node-${index}`);
			const maligatorOutput = path.join(root, `maligator-${index}`);
			let node: SelfCompileRun;
			let maligator: SelfCompileRun;
			if (index % 2 === 0) {
				maligator = runSelfCompile(binary, [target], maligatorOutput);
				node = runSelfCompile(process.execPath, [fixture, target], nodeOutput);
			} else {
				node = runSelfCompile(process.execPath, [fixture, target], nodeOutput);
				maligator = runSelfCompile(binary, [target], maligatorOutput);
			}
			assertComparableSelfCompile(node, maligator);
			if (nodeRuns[0] !== undefined) assertSameSelfCompile(nodeRuns[0], node);
			if (maligatorRuns[0] !== undefined)
				assertSameSelfCompile(maligatorRuns[0], maligator);
			nodeRuns.push(node);
			maligatorRuns.push(maligator);
		}
		progress.detail("self-compile phase instrumentation sample");
		const phasesNode = runSelfCompile(
			process.execPath,
			[fixture, target],
			path.join(root, "phases-node"),
			"phases",
		);
		const phasesMaligator = runSelfCompile(
			binary,
			[target],
			path.join(root, "phases-maligator"),
			"phases",
		);
		assertComparableSelfCompile(phasesNode, phasesMaligator);
		if (
			phasesNode.optimizer.instrumentation !== "phases" ||
			phasesMaligator.optimizer.instrumentation !== "phases"
		) {
			throw new Error("self-compile phase sample did not enable phase instrumentation");
		}
		progress.detail("self-compile runtime resource samples");
		const resourceMaligator = runSelfCompileResourceSample(
			binary,
			[target],
			path.join(root, "resource-maligator"),
			true,
		);
		const resourceNode = runSelfCompileResourceSample(
			process.execPath,
			[fixture, target],
			path.join(root, "resource-node"),
			false,
		);
		assertComparableSelfCompile(resourceNode.run, resourceMaligator.run);
		return assembleSelfCompileMetrics({
			runs,
			nativeBuild: nativeBuild.metrics("bench-self-compile"),
			cold: {
				node: selfCompileSample(coldNode),
				maligator: selfCompileSample(coldMaligator),
			},
			warm: {
				node: Object.freeze(nodeRuns.map(selfCompileSample)),
				maligator: Object.freeze(maligatorRuns.map(selfCompileSample)),
			},
			phasesSample: {
				node: { ...selfCompileSample(phasesNode), optimizer: phasesNode.optimizer },
				maligator: {
					...selfCompileSample(phasesMaligator),
					optimizer: phasesMaligator.optimizer,
				},
			},
			runtime: {
				maligator: nativeRuntimeMetrics(
					resourceMaligator.stderr,
					resourceMaligator.rssBytes,
				),
				nodePeakRssBytes: resourceNode.rssBytes,
			},
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeSelfCompileCheckpoint(
	checkpointPath: string,
	checkpoint: SelfCompileCheckpoint,
): void {
	const temporaryPath = `${checkpointPath}.tmp-${process.pid}`;
	writeFileSync(temporaryPath, `${JSON.stringify(checkpoint)}\n`);
	renameSync(temporaryPath, checkpointPath);
}

function assertSameSelfCompileSample(
	reference: SelfCompileSample,
	actual: SelfCompileRun,
): void {
	if (
		actual.units !== reference.units ||
		actual.codeUnits !== reference.codeUnits ||
		actual.digest !== reference.digest
	) {
		throw new Error(
			`self-compile output changed between samples: ${JSON.stringify(actual)} != ${JSON.stringify(reference)}`,
		);
	}
}

function preparedCheckpointTarget(root: string, name: string): string {
	const sourceRoot = path.join(root, name);
	const target = path.join(sourceRoot, "bench/self-compile.mts");
	return existsSync(target) ? target : prepareSelfCompileSource(sourceRoot);
}

function runCheckpointSelfCompilePair(
	checkpoint: SelfCompileCheckpoint,
	target: string,
	label: string,
	instrumentation: "off" | "phases" = "off",
): { readonly node: SelfCompileRun; readonly maligator: SelfCompileRun } {
	const nodeOutput = path.join(checkpoint.root, `${label}-node`);
	const maligatorOutput = path.join(checkpoint.root, `${label}-maligator`);
	rmSync(nodeOutput, { recursive: true, force: true });
	rmSync(maligatorOutput, { recursive: true, force: true });
	try {
		const maligator = runSelfCompile(
			checkpoint.binary,
			[target],
			maligatorOutput,
			instrumentation,
		);
		const node = runSelfCompile(
			process.execPath,
			[path.resolve("bench/self-compile.mts"), target],
			nodeOutput,
			instrumentation,
		);
		assertComparableSelfCompile(node, maligator);
		return { node, maligator };
	} finally {
		rmSync(nodeOutput, { recursive: true, force: true });
		rmSync(maligatorOutput, { recursive: true, force: true });
	}
}

function checkpointSelfCompileMetrics(
	checkpoint: SelfCompileCheckpoint,
): SelfCompileMetrics {
	if (
		checkpoint.cold === undefined ||
		checkpoint.phasesSample === undefined ||
		checkpoint.runtime === undefined ||
		checkpoint.warm.node.length !== checkpoint.runs ||
		checkpoint.warm.maligator.length !== checkpoint.runs
	) {
		throw new Error("self-compile checkpoint is not complete");
	}
	return assembleSelfCompileMetrics({
		runs: checkpoint.runs,
		nativeBuild: checkpoint.nativeBuild,
		cold: checkpoint.cold,
		warm: checkpoint.warm,
		phasesSample: checkpoint.phasesSample,
		runtime: checkpoint.runtime,
	});
}

function benchSelfCompileCheckpoint(
	runs: number,
	nativeCacheDirectory: string | undefined,
	checkpointPath: string,
	source: NonNullable<BenchmarkSnapshot["source"]>,
	coreOptimizationAblation?: CoreOptimizationFamily,
): SelfCompileMetrics | undefined {
	let checkpoint: SelfCompileCheckpoint;
	if (!existsSync(checkpointPath)) {
		progress.detail("self-compile checkpoint stage: native build");
		const nativeBuild = nativeBuildRecorder();
		const binary = buildNativeBinary({
			fixture: path.resolve("bench/self-compile.mts"),
			name: "bench-self-compile",
			config: SELF_COMPILE_CONFIG,
			cacheDirectory: nativeCacheDirectory,
			onNativeBuildPhase: nativeBuild.observe,
			measureNativeBuildResources: true,
			onNativeCommandResource: nativeBuild.observeResource,
		});
		checkpoint = {
			schema: 1,
			source,
			runs,
			nativeCacheDirectory,
			root: mkdtempSync(path.join(os.tmpdir(), "mal-self-compile-checkpoint-")),
			binary,
			nativeBuild: nativeBuild.metrics("bench-self-compile"),
			coreOptimizationAblation,
			warm: { node: [], maligator: [] },
		};
		writeSelfCompileCheckpoint(checkpointPath, checkpoint);
		return undefined;
	}

	checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as SelfCompileCheckpoint;
	if (checkpoint.schema !== 1) {
		throw new Error("unsupported self-compile checkpoint schema");
	}
	if (JSON.stringify(checkpoint.source) !== JSON.stringify(source)) {
		throw new Error("self-compile checkpoint source identity no longer matches");
	}
	if (
		checkpoint.runs !== runs ||
		checkpoint.nativeCacheDirectory !== nativeCacheDirectory ||
		checkpoint.coreOptimizationAblation !== coreOptimizationAblation
	) {
		throw new Error("self-compile checkpoint options no longer match");
	}
	if (checkpoint.complete) return checkpointSelfCompileMetrics(checkpoint);
	if (!existsSync(checkpoint.binary)) {
		throw new Error(`self-compile checkpoint binary is missing: ${checkpoint.binary}`);
	}

	if (checkpoint.cold === undefined) {
		progress.detail("self-compile checkpoint stage: cold pair");
		const target = preparedCheckpointTarget(checkpoint.root, "cold-source");
		const pair = runCheckpointSelfCompilePair(checkpoint, target, "cold");
		checkpoint.cold = {
			node: selfCompileSample(pair.node),
			maligator: selfCompileSample(pair.maligator),
		};
	} else if (checkpoint.warmup === undefined) {
		progress.detail("self-compile checkpoint stage: warmup pair");
		const target = preparedCheckpointTarget(checkpoint.root, "source");
		const pair = runCheckpointSelfCompilePair(checkpoint, target, "warmup");
		checkpoint.warmup = {
			node: selfCompileSample(pair.node),
			maligator: selfCompileSample(pair.maligator),
		};
	} else if (checkpoint.warm.node.length < runs) {
		const index = checkpoint.warm.node.length;
		progress.detail(`self-compile checkpoint stage: paired sample ${index + 1}/${runs}`);
		const target = preparedCheckpointTarget(checkpoint.root, "source");
		const pair = runCheckpointSelfCompilePair(checkpoint, target, `sample-${index}`);
		const referenceNode = checkpoint.warm.node[0];
		const referenceMaligator = checkpoint.warm.maligator[0];
		if (referenceNode !== undefined)
			assertSameSelfCompileSample(referenceNode, pair.node);
		if (referenceMaligator !== undefined)
			assertSameSelfCompileSample(referenceMaligator, pair.maligator);
		checkpoint.warm.node.push(selfCompileSample(pair.node));
		checkpoint.warm.maligator.push(selfCompileSample(pair.maligator));
	} else if (checkpoint.phasesSample === undefined) {
		progress.detail("self-compile checkpoint stage: phase pair");
		const target = preparedCheckpointTarget(checkpoint.root, "source");
		const pair = runCheckpointSelfCompilePair(checkpoint, target, "phases", "phases");
		if (
			pair.node.optimizer.instrumentation !== "phases" ||
			pair.maligator.optimizer.instrumentation !== "phases"
		) {
			throw new Error("self-compile phase sample did not enable phase instrumentation");
		}
		checkpoint.phasesSample = {
			node: { ...selfCompileSample(pair.node), optimizer: pair.node.optimizer },
			maligator: {
				...selfCompileSample(pair.maligator),
				optimizer: pair.maligator.optimizer,
			},
		};
	} else if (checkpoint.runtime === undefined) {
		progress.detail("self-compile checkpoint stage: runtime resource pair");
		const target = preparedCheckpointTarget(checkpoint.root, "source");
		const maligatorOutput = path.join(checkpoint.root, "resource-maligator");
		const nodeOutput = path.join(checkpoint.root, "resource-node");
		rmSync(maligatorOutput, { recursive: true, force: true });
		rmSync(nodeOutput, { recursive: true, force: true });
		try {
			const maligator = runSelfCompileResourceSample(
				checkpoint.binary,
				[target],
				maligatorOutput,
				true,
			);
			const node = runSelfCompileResourceSample(
				process.execPath,
				[path.resolve("bench/self-compile.mts"), target],
				nodeOutput,
				false,
			);
			assertComparableSelfCompile(node.run, maligator.run);
			checkpoint.runtime = {
				maligator: nativeRuntimeMetrics(maligator.stderr, maligator.rssBytes),
				nodePeakRssBytes: node.rssBytes,
			};
		} finally {
			rmSync(maligatorOutput, { recursive: true, force: true });
			rmSync(nodeOutput, { recursive: true, force: true });
		}
	}

	if (
		checkpoint.runtime !== undefined &&
		checkpoint.phasesSample !== undefined &&
		checkpoint.warm.node.length === runs
	) {
		checkpoint.complete = true;
		rmSync(checkpoint.root, { recursive: true, force: true });
	}
	writeSelfCompileCheckpoint(checkpointPath, checkpoint);
	return checkpoint.complete ? checkpointSelfCompileMetrics(checkpoint) : undefined;
}

function ohaAvailable(): boolean {
	return spawnSync("oha", ["--version"], { stdio: "ignore" }).status === 0;
}

function waitReachable(url: string): void {
	for (let index = 0; index < 100; index++) {
		if (spawnSync("curl", ["-s", "-o", "/dev/null", url]).status === 0) return;
		execFileSync("sleep", ["0.05"]);
	}
	throw new Error(`server never came up: ${url}`);
}

function ohaRun(
	target: string,
	duration: string,
	concurrency: number,
	extraArgs: Array<string> = [],
): OhaMetrics {
	return parseOhaOutput(
		execFileSync(
			"oha",
			[
				"-z",
				duration,
				"-c",
				String(concurrency),
				"--no-tui",
				"--output-format",
				"json",
				"--redirect",
				"0",
				...extraArgs,
				target,
			],
			{ encoding: "utf8", env: { ...process.env, NO_COLOR: "false" } },
		),
	);
}

function compareHttpSamples(
	malTarget: string,
	nodeTarget: string,
	duration: string,
	concurrency: number,
	runs: number,
	extraArgs: Array<string> = [],
): HttpComparisonMetrics {
	const malSamples: Array<OhaMetrics> = [];
	const nodeSamples: Array<OhaMetrics> = [];
	for (let index = 0; index < runs; index++) {
		progress.detail(`HTTP paired sample ${index + 1}/${runs}`);
		if (index % 2 === 0) {
			malSamples.push(ohaRun(malTarget, duration, concurrency, extraArgs));
			nodeSamples.push(ohaRun(nodeTarget, duration, concurrency, extraArgs));
		} else {
			nodeSamples.push(ohaRun(nodeTarget, duration, concurrency, extraArgs));
			malSamples.push(ohaRun(malTarget, duration, concurrency, extraArgs));
		}
	}
	const malRps = median(malSamples.map(({ rps }) => rps));
	const nodeRps = median(nodeSamples.map(({ rps }) => rps));
	return {
		malRps,
		nodeRps,
		ratio: malRps / nodeRps,
		malP99Ms: median(malSamples.map(({ p99Ms }) => p99Ms)),
		nodeP99Ms: median(nodeSamples.map(({ p99Ms }) => p99Ms)),
	};
}

function workloadArgs(
	workload: Pick<ExpressHttpWorkload, "method" | "headers" | "body">,
): Array<string> {
	const args: Array<string> = [];
	if (workload.method !== undefined) args.push("--method", workload.method);
	for (const header of workload.headers ?? []) args.push("-H", header);
	if (workload.body !== undefined) args.push("-d", workload.body);
	return args;
}

interface MeasuredRuntimeProcess {
	readonly process: ReturnType<typeof spawn>;
	readonly stderr: Array<Buffer>;
}

function startMeasuredRuntimeProcess(
	command: string,
	args: ReadonlyArray<string>,
	environment: NodeJS.ProcessEnv,
): MeasuredRuntimeProcess {
	const child = spawn(command, [...args], {
		env: {
			...environment,
			MAL_BENCH_CONTROL: "1",
			MAL_GC_CONTROL: "1",
			MAL_GC_STATS: "1",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr: Array<Buffer> = [];
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	return { process: child, stderr };
}

function processRssBytes(child: ReturnType<typeof spawn>): number {
	if (child.pid === undefined) throw new Error("runtime process has no pid");
	const value = execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], {
		encoding: "utf8",
	}).trim();
	const kilobytes = Number(value);
	if (!Number.isSafeInteger(kilobytes) || kilobytes <= 0) {
		throw new Error(`runtime process ${child.pid} omitted RSS`);
	}
	return kilobytes * 1024;
}

async function terminateProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await once(child, "exit");
}

async function stopMeasuredRuntimeProcess(
	measured: MeasuredRuntimeProcess,
	wakeUrl: string,
): Promise<NativeRuntimeMetrics> {
	const rssBytes = processRssBytes(measured.process);
	measured.process.kill("SIGUSR1");
	execFileSync("curl", ["-s", "-o", "/dev/null", wakeUrl]);
	await terminateProcess(measured.process);
	return nativeRuntimeMetrics(Buffer.concat(measured.stderr).toString(), rssBytes);
}

async function benchHttp(
	runs: number,
	durationSeconds: number,
	concurrency: number,
	nativeCacheDirectory?: string,
	coreOptimizationAblation?: CoreOptimizationFamily,
): Promise<HttpMetrics> {
	if (!ohaAvailable()) throw new Error("HTTP benchmark requires `oha`");
	const nativeBuild = nativeBuildRecorder();
	const bareBinary = buildNativeBinary({
		fixture: "bench/http/server_mal.js",
		name: "bench-http-bare-closed",
		mainFile: HOST_MAIN,
		config: CLOSED_HTTP_CONFIG,
		cacheDirectory: nativeCacheDirectory,
		onNativeBuildPhase: nativeBuild.observe,
		measureNativeBuildResources: true,
		onNativeCommandResource: nativeBuild.observeResource,
		coreOptimizationBenchmarkAblation:
			coreOptimizationAblation === undefined
				? undefined
				: { family: coreOptimizationAblation },
	});
	const expressBinary = buildNativeBinary({
		fixture: "bench/http/express-server.cjs",
		name: "bench-http-express-closed",
		mainFile: HOST_MAIN,
		config: CLOSED_EXPRESS_CONFIG,
		cacheDirectory: nativeCacheDirectory,
		onNativeBuildPhase: nativeBuild.observe,
		measureNativeBuildResources: true,
		onNativeCommandResource: nativeBuild.observeResource,
		coreOptimizationBenchmarkAblation:
			coreOptimizationAblation === undefined
				? undefined
				: { family: coreOptimizationAblation },
	});
	const bareMal = startMeasuredRuntimeProcess(bareBinary, [], process.env);
	const bareNode = spawn(process.execPath, ["bench/http/server_node.js"], {
		stdio: ["ignore", "ignore", "inherit"],
	});
	let bare: HttpComparisonMetrics;
	let bareRuntime: NativeRuntimeMetrics;
	try {
		waitReachable("http://127.0.0.1:3111/");
		waitReachable("http://127.0.0.1:3112/");
		ohaRun("http://127.0.0.1:3111/", "2s", concurrency);
		ohaRun("http://127.0.0.1:3112/", "2s", concurrency);
		bare = compareHttpSamples(
			"http://127.0.0.1:3111/",
			"http://127.0.0.1:3112/",
			formatOhaDuration(durationSeconds),
			concurrency,
			runs,
		);
	} finally {
		bareRuntime = await stopMeasuredRuntimeProcess(bareMal, "http://127.0.0.1:3111/");
		await terminateProcess(bareNode);
	}

	const expressMal = startMeasuredRuntimeProcess(expressBinary, [], {
		...process.env,
		PORT: "3113",
	});
	const expressNode = spawn(process.execPath, ["bench/http/express-server.cjs"], {
		env: { ...process.env, PORT: "3114" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	const temporary = mkdtempSync(path.join(os.tmpdir(), "mal-bench-http-"));
	let workloads: Record<string, HttpComparisonMetrics>;
	let expressRuntime: NativeRuntimeMetrics;
	try {
		waitReachable("http://127.0.0.1:3113/middleware");
		waitReachable("http://127.0.0.1:3114/middleware");
		ohaRun("http://127.0.0.1:3113/middleware", "2s", concurrency);
		ohaRun("http://127.0.0.1:3114/middleware", "2s", concurrency);
		workloads = {};
		for (const workload of planExpressHttpWorkload(durationSeconds)) {
			const malUrls = path.join(temporary, `${workload.name}-mal.txt`);
			const nodeUrls = path.join(temporary, `${workload.name}-node.txt`);
			writeFileSync(
				malUrls,
				`${workload.paths.map((value) => `http://127.0.0.1:3113${value}`).join("\n")}\n`,
			);
			writeFileSync(
				nodeUrls,
				`${workload.paths.map((value) => `http://127.0.0.1:3114${value}`).join("\n")}\n`,
			);
			workloads[workload.name] = compareHttpSamples(
				malUrls,
				nodeUrls,
				formatOhaDuration(workload.durationSeconds),
				concurrency,
				runs,
				["--urls-from-file", ...workloadArgs(workload)],
			);
		}
	} finally {
		expressRuntime = await stopMeasuredRuntimeProcess(
			expressMal,
			"http://127.0.0.1:3113/middleware",
		);
		await terminateProcess(expressNode);
		rmSync(temporary, { recursive: true, force: true });
	}
	return {
		world: "closed",
		runs,
		bare: {
			...bare,
			binaryBytes: fileBytes(bareBinary),
			nativeBuild: nativeBuild.metrics("bench-http-bare-closed"),
			runtime: bareRuntime,
		},
		express: {
			binaryBytes: fileBytes(expressBinary),
			nativeBuild: nativeBuild.metrics("bench-http-express-closed"),
			runtime: expressRuntime,
			workloads,
		},
	};
}

function delta(current: number, previous: number | undefined): string {
	if (previous === undefined || previous === 0) return "";
	const percent = ((current - previous) / Math.abs(previous)) * 100;
	const arrow = percent < 0 ? "↓" : percent === 0 ? "=" : "↑";
	return ` (${percent >= 0 ? "+" : ""}${percent.toFixed(1)}% ${arrow})`;
}

function humanBytes(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
		: `${(bytes / 1024).toFixed(1)}KB`;
}

function reportJavascript(
	current: JavascriptMetrics,
	previous: JavascriptMetrics | undefined,
): void {
	console.log("javascript (balanced core-language matrix):");
	console.log(`  node               ${current.node.wallMs.toFixed(1)}ms`);
	for (const mode of JAVASCRIPT_MODES) {
		const value = current.modes[mode];
		if (value === undefined) continue;
		const prior = previous?.modes[mode];
		console.log(
			`  ${mode.padEnd(19)} ${value.wallMs.toFixed(1)}ms${delta(value.wallMs, prior?.wallMs)}  ${value.ratio.toFixed(2)}x Node  balanced ${value.balancedRatio.toFixed(2)}x`,
		);
		console.log(
			`    ${value.collections} collections, ${value.allocatedMb.toFixed(1)}MB allocated, ${value.peakLiveKb.toFixed(1)}KB peak live, ${value.maxPauseMs.toFixed(3)}ms max pause, ${humanBytes(value.binaryBytes)} binary${value.rssMb === undefined ? "" : `, ${value.rssMb.toFixed(1)}MB RSS`}`,
		);
		console.log(
			`    ${Object.entries(value.phaseMs)
				.map(([name, elapsed]) => `${name} ${elapsed.toFixed(1)}ms`)
				.join(", ")}`,
		);
	}
}

function reportHttp(current: HttpMetrics, previous: HttpMetrics | undefined): void {
	console.log("http (fully closed compiled):");
	console.log(
		`  bare       ${current.bare.malRps.toFixed(0)} req/s${delta(current.bare.malRps, previous?.bare.malRps)} vs Node ${current.bare.nodeRps.toFixed(0)}, p99 ${current.bare.malP99Ms.toFixed(2)}ms, ${humanBytes(current.bare.binaryBytes)}`,
	);
	for (const [name, value] of Object.entries(current.express.workloads)) {
		const prior = previous?.express.workloads[name];
		console.log(
			`  express/${name.padEnd(6)} ${value.malRps.toFixed(0)} req/s${delta(value.malRps, prior?.malRps)} vs Node ${value.nodeRps.toFixed(0)}, p99 ${value.malP99Ms.toFixed(2)}ms`,
		);
	}
	console.log(`  Express binary ${humanBytes(current.express.binaryBytes)}`);
}

function reportSelfCompile(
	current: SelfCompileMetrics,
	previous: SelfCompileMetrics | undefined,
): void {
	console.log("self-compile (fully closed compiled):");
	console.log(
		`  Maligator ${(current.maligatorMs / 1000).toFixed(1)}s${delta(current.maligatorMs, previous?.maligatorMs)} vs Node ${(current.nodeMs / 1000).toFixed(1)}s`,
	);
	console.log(
		`  Core ${current.maligatorPhases.constructCoreMs}ms construct, ${current.maligatorPhases.optimizeCoreMs}ms optimize, ${current.maligatorPhases.coreToExecutionMs}ms execution, ${current.maligatorPhases.executionToImageMs}ms image`,
	);
	console.log(
		`  emit ${(current.maligatorPhases.emitMs / 1000).toFixed(1)}s, ${current.units} units, ${current.runs} paired samples`,
	);
}

function report(
	current: BenchmarkSnapshot,
	previous: BenchmarkSnapshot | undefined,
): void {
	console.log("\n=== benchmark run ===");
	if (current.javascript !== undefined) {
		reportJavascript(current.javascript, previous?.javascript);
	}
	if (current.http !== undefined) reportHttp(current.http, previous?.http);
	if (current.selfCompile !== undefined) {
		reportSelfCompile(current.selfCompile, previous?.selfCompile);
	}
}

const HELP = `Usage: node scripts/bench.ts [javascript|http|self-compile] [options]

Benchmark families:
  javascript    One balanced ES-module workload under the production native plan
                across closed/open x compiled/interpreted, plus a Node reference.
  http          Fully closed compiled bare HTTP and Express versus Node.
  self-compile  Fully closed compiled Maligator compiler versus its Node host.

Default: javascript and http. --full adds self-compile.

Options:
  --full              Run all three benchmark families
  --mode MODE         Limit javascript to closed-compiled, closed-interpreted,
                      open-compiled, or open-interpreted
  --runs N            Paired/rotated sample count (default: 5)
  --http-seconds N    Total duration per HTTP scenario and subject (default: 5)
  --changed           Select families affected by files changed from a Git ref
  --compare REF       Run paired base/head comparisons against REF
  --max-pairs N       Cap adaptive paired comparison samples
  --json-out PATH     Write the measured snapshot as JSON
  --native-cache-dir PATH
                      Isolate native artifacts for build-cost measurements
  --checkpoint PATH   Run one resumable self-compile stage and save its state
  --ablate-core-family FAMILY
                      Omit one Core optimization family for output attribution
  --update            Update selected sections in bench/baseline.json
  -h, --help          Show this help and exit
`;

interface Options {
	update: boolean;
	changed: boolean;
	full: boolean;
	runs: number;
	httpSeconds: number;
	compareRef?: string;
	maxPairs?: number;
	jsonOut?: string;
	nativeCacheDirectory?: string;
	checkpointPath?: string;
	coreOptimizationAblation?: CoreOptimizationFamily;
	mode?: JavascriptMode;
	lanes: Array<string>;
}

function requiredValue(args: Array<string>, index: number, option: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function parsePositiveNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive number`);
	}
	return parsed;
}

function parseOptions(args: Array<string>): Options | undefined {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return undefined;
	}
	const options: Options = {
		update: false,
		changed: false,
		full: false,
		runs: 5,
		httpSeconds: 5,
		lanes: [],
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--update") options.update = true;
		else if (arg === "--changed") options.changed = true;
		else if (arg === "--full") options.full = true;
		else if (arg === "--runs") {
			options.runs = parsePositiveNumber(requiredValue(args, index, arg), arg);
			index++;
		} else if (arg === "--http-seconds") {
			options.httpSeconds = parsePositiveNumber(requiredValue(args, index, arg), arg);
			index++;
		} else if (arg === "--compare") {
			options.compareRef = requiredValue(args, index, arg);
			index++;
		} else if (arg === "--max-pairs") {
			options.maxPairs = parsePositiveNumber(requiredValue(args, index, arg), arg);
			index++;
		} else if (arg === "--json-out") {
			options.jsonOut = requiredValue(args, index, arg);
			index++;
		} else if (arg === "--native-cache-dir") {
			options.nativeCacheDirectory = path.resolve(requiredValue(args, index, arg));
			index++;
		} else if (arg === "--checkpoint") {
			options.checkpointPath = path.resolve(requiredValue(args, index, arg));
			index++;
		} else if (arg === "--ablate-core-family") {
			const family = requiredValue(args, index, arg);
			if (!CORE_OPTIMIZATION_FAMILIES.includes(family as CoreOptimizationFamily)) {
				throw new Error(`unknown Core optimization family: ${family}`);
			}
			options.coreOptimizationAblation = family as CoreOptimizationFamily;
			index++;
		} else if (arg === "--mode") {
			const mode = requiredValue(args, index, arg);
			if (!JAVASCRIPT_MODES.includes(mode as JavascriptMode)) {
				throw new Error(`unknown JavaScript mode: ${mode}`);
			}
			options.mode = mode as JavascriptMode;
			index++;
		} else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		else options.lanes.push(arg);
	}
	if (!Number.isInteger(options.runs)) throw new Error("--runs must be an integer");
	if (options.maxPairs !== undefined && !Number.isInteger(options.maxPairs)) {
		throw new Error("--max-pairs must be an integer");
	}
	if (options.update && options.compareRef !== undefined) {
		throw new Error("--compare cannot update the committed benchmark baseline");
	}
	if (options.update && options.mode !== undefined) {
		throw new Error("a single --mode cannot replace the complete JavaScript baseline");
	}
	if (options.update && options.coreOptimizationAblation !== undefined) {
		throw new Error("a Core optimization ablation cannot replace the benchmark baseline");
	}
	return options;
}

const options = parseOptions(process.argv.slice(2));
if (options === undefined) process.exit(0);
if (options.coreOptimizationAblation === undefined) {
	delete process.env.MAL_CORE_BENCHMARK_ABLATION;
} else {
	process.env.MAL_CORE_BENCHMARK_ABLATION = options.coreOptimizationAblation;
}

const allLanes = ["javascript", "http", "self-compile"];
const changedSelection = options.changed
	? selectChangedBenchmarkLanes(options.compareRef ?? "HEAD", allLanes)
	: undefined;
const requestedLanes =
	options.lanes.length > 0
		? options.lanes
		: changedSelection !== undefined
			? changedSelection.lanes
			: options.full
				? allLanes
				: ["javascript", "http"];
const unknown = requestedLanes.filter((lane) => !allLanes.includes(lane));
if (unknown.length > 0)
	throw new Error(`unknown benchmark family: ${unknown.join(", ")}`);
if (options.mode !== undefined && !requestedLanes.includes("javascript")) {
	throw new Error("--mode requires the javascript benchmark family");
}
if (
	options.checkpointPath !== undefined &&
	(requestedLanes.length !== 1 || requestedLanes[0] !== "self-compile")
) {
	throw new Error("--checkpoint requires only the self-compile benchmark family");
}
if (options.checkpointPath !== undefined && options.jsonOut === undefined) {
	throw new Error("--checkpoint requires --json-out for the completed snapshot");
}
if (options.checkpointPath !== undefined && options.compareRef !== undefined) {
	throw new Error("--checkpoint cannot be combined with --compare");
}
if (changedSelection !== undefined) {
	console.log(
		`changed benchmark selection: ${changedSelection.files.length} files -> ${requestedLanes.length === 0 ? "no families" : requestedLanes.join(", ")}`,
	);
}

if (options.compareRef !== undefined) {
	if (requestedLanes.length === 0) {
		console.log("No benchmark families correspond to the changed files.");
		process.exit(0);
	}
	const comparison = runBenchmarkComparison({
		baseRef: options.compareRef,
		lanes: requestedLanes,
		pairs: options.runs,
		maxPairs: options.maxPairs,
		extraArgs: [
			"--http-seconds",
			String(options.httpSeconds),
			...(options.mode === undefined ? [] : ["--mode", options.mode]),
		],
		headExtraArgs:
			options.coreOptimizationAblation === undefined
				? undefined
				: ["--ablate-core-family", options.coreOptimizationAblation],
	});
	process.exit(options.coreOptimizationAblation === undefined ? comparison.exitCode : 0);
}

if (requestedLanes.length === 0) {
	console.log("No benchmark families selected.");
	process.exit(0);
}

const savedBaseline = readBenchmarkBaseline<
	{ schema?: unknown } & Record<string, unknown>
>(BASELINE_FILE);
if (savedBaseline !== undefined && savedBaseline.schema !== BENCHMARK_SCHEMA) {
	throw new Error(
		`benchmark baseline schema ${String(savedBaseline.schema)} is not ${BENCHMARK_SCHEMA}`,
	);
}
const baseline = savedBaseline as BenchmarkSnapshot | undefined;

const entry: BenchmarkSnapshot = {
	schema: BENCHMARK_SCHEMA,
	source: benchmarkSource(),
	...(options.coreOptimizationAblation === undefined
		? {}
		: { coreOptimizationAblation: options.coreOptimizationAblation }),
};
let checkpointPending = false;
const implementations: Record<string, () => void | Promise<void>> = {
	javascript: () => {
		entry.javascript = benchJavascript(
			options.runs,
			options.mode === undefined ? JAVASCRIPT_MODES : [options.mode],
			options.nativeCacheDirectory,
			options.coreOptimizationAblation,
		);
	},
	http: async () => {
		entry.http = await benchHttp(
			options.runs,
			options.httpSeconds,
			50,
			options.nativeCacheDirectory,
			options.coreOptimizationAblation,
		);
	},
	"self-compile": () => {
		const measured =
			options.checkpointPath === undefined
				? benchSelfCompile(options.runs, options.nativeCacheDirectory)
				: benchSelfCompileCheckpoint(
						options.runs,
						options.nativeCacheDirectory,
						options.checkpointPath,
						entry.source!,
						options.coreOptimizationAblation,
					);
		if (measured === undefined) checkpointPending = true;
		else entry.selfCompile = measured;
	},
};

progress.start(`${requestedLanes.length} families · ${options.runs} samples`);
for (const [index, lane] of requestedLanes.entries()) {
	progress.stage(index + 1, requestedLanes.length, lane);
	try {
		await implementations[lane]!();
		progress.stagePassed(index + 1, requestedLanes.length, lane);
	} catch (error) {
		progress.stageFailed(index + 1, requestedLanes.length, lane);
		progress.failed();
		throw error;
	}
}

if (checkpointPending) {
	console.log(`self-compile checkpoint saved to ${options.checkpointPath}`);
	console.log("rerun the same command for the next stage");
	progress.complete();
	process.exit(0);
}
if (options.jsonOut !== undefined)
	writeFileSync(options.jsonOut, `${JSON.stringify(entry)}\n`);
report(entry, baseline);
persistBenchmarkBaseline(BASELINE_FILE, baseline, entry, options.update);
if (options.update) console.log(`\nUpdated selected sections in ${BASELINE_FILE}.`);
else console.log("\n(run with --update to replace the selected baseline sections)");
progress.complete();
