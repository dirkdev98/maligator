/**
 * Consolidated benchmark runner. One entry point drives the whole bench/ tree and
 * diffs selected lanes against their last saved values:
 *
 *   node scripts/bench.ts [size|language|stack-object|gc|http|http-profile ...]
 *     [--runs N] [--max-pairs N] [--update]
 *
 * Benches (default: all):
 *   - size      linked binary + per-archive bytes across a build-config matrix
 *               (full / no-eval / no-realms / no-intl / no-web / no-regexp /
 *               minimal) — the "small binary" goal, one row per config so each
 *               feature flag's marginal bytes are tracked. No V8 compare.
 *   - compiler  Node-hosted front-end throughput and serialized wire bytes for a
 *               deterministic, constant-heavy multi-function source corpus.
 *   - self-compile native Maligator and Node run the same pre-stripped compiler
 *               source graph to emit C translation units. Fresh-process median
 *               wall time includes startup and source loading but excludes the C
 *               compiler and linker. Explicit release lane; omitted by default.
 *   - language  bench/language.js wall time vs Node/V8 (wide instruction coverage
 *               plus an application-like object/collection/JSON pipeline).
 *   - module    bench/module-alloc.mjs: an ES module whose top-level const-bound
 *               helpers are composed in a hot allocation loop. Wall time vs V8 plus
 *               the GC collection count — the tripwire for the const/module-scope
 *               inlining + scalar-replacement class (0 collections when the loop's
 *               transients are fully eliminated), which language.js does not cover.
 *   - string    bench/string.js: broad String + RegExp tokenization, plus an
 *               adversarial tiny-slice retention phase. Wall time vs V8 and GC
 *               allocation/live-set signals.
 *   - promise   bench/promise.js: chains, pending fan-out, mixed-settlement batches,
 *               combinators, thenables, rejection/recovery, finally, and await.
 *               Wall time vs V8 plus managed and native bookkeeping signals.
 *   - coroutine bench/coroutine.js: generator delegation/send/return/finally,
 *               async calls, and manual/for-await async-generator frame churn in
 *               both backends. Wall time and native support-buffer allocations.
 *   - arguments bench/arguments.js: direct non-escaping `arguments.length` and
 *               static indexed reads over varied normal/default/generator call
 *               shapes. Backend wall time, managed allocation, coroutine-buffer
 *               churn, bytecode, and binary bytes isolate needless materialization.
 *   - stack-object bench/stack-object.js: residual fixed-shape objects whose local
 *               identity/type/prototype observations prevent scalar replacement.
 *               Compiled and interpreted wall time, managed allocation/GC signals,
 *               bytecode, and binary size establish the pre-stack-allocation floor.
 *   - interpreter bench/language.js forced through bytecode: wide dispatch wall
 *               time, RSS, and exact loaded MalInstruction footprint.
 *   - sqlite-binding bench/sqlite-binding.mjs: prepared StatementSync.run()
 *               execution with zero parameters, four numbers, and four strings.
 *               Internal monotonic timings isolate binding overhead from process
 *               startup and compare the embedded node:sqlite adapter with Node.
 *   - prototype-cache bench/prototype-cache.mjs: inherited method loads through
 *               runtime-owned and one-/two-link userland prototype chains, plus
 *               the refilled steady state after a prototype method replacement.
 *               Wall time is compared with Node; IC counters verify the mechanism.
 *   - gc        bench/gc/{cli,desktop,server}.js under the generational collector:
 *               wall, peak RSS, max GC pause (macOS: RSS/pauses via /usr/bin/time -l
 *               + MAL_GC_STATS). No V8 compare.
 *   - http      bare server and pinned Express 5 application: linked binary bytes,
 *               req/s, and p99 latency vs Node, driven by `oha` (multi-threaded, so
 *               the load generator isn't the bottleneck). Skipped if `oha` is absent.
 *   - http-profile request-window runtime counters for the Express middleware,
 *               route, JSON, and form workloads. Each runs in a fresh instrumented
 *               process and resets counters after warmup. Diagnostic only: never
 *               written to the saved benchmark baseline.
 *   - string-profile allocation/storage/flattening counters for every executable
 *               non-server benchmark workload. Diagnostic only: never written to
 *               the saved benchmark baseline. Pair with http-profile for servers.
 *
 * `bench/baseline.json` is one unattributed snapshot. A run never changes it unless
 * `--update` is present; an update atomically replaces only the selected top-level
 * lane sections and preserves every lane that was not run.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { MaligatorBuildConfig } from "../src/build-config.ts";
import { CommandProgress } from "../src/command-progress.ts";
import { compileSourceToBuffer } from "../src/compile.ts";
import {
	buildNativeBinary,
	buildNativeBinaryResult,
	HOST_MAIN,
} from "../src/test-harness.ts";
import { stripTypesWithTypeScript } from "../src/typescript-strip.ts";
import { persistBenchmarkBaseline, readBenchmarkBaseline } from "./bench-baseline.ts";
import { runBenchmarkComparison, selectChangedBenchmarkLanes } from "./bench-compare.ts";
import {
	formatOhaDuration,
	parseOhaOutput,
	planExpressHttpWorkload,
} from "./bench-http.ts";
import type { ExpressHttpWorkload, OhaMetrics } from "./bench-http.ts";

const BASELINE_FILE = "bench/baseline.json";
const MIN_NODE_COMPARISON_MS = 60;
const benchmarkProgress = new CommandProgress("bench");
let activeBenchmarkLane = "benchmark";

interface SizeMetrics {
	binaryBytes: number;
	runtimeArchiveBytes: number;
	hostArchiveBytes: number;
	engineArchiveBytes: number;
	rustArchiveBytes: number;
}
interface LanguageMetrics {
	malMs: number;
	nodeMs: number;
	ratio: number;
	collections: number;
	allocatedMb: number;
	emptyObjects: number;
	shapedObjects: number;
	stackObjects: number;
	stackMaterializations: number;
	callProbes: number;
	callMisses: number;
	loadMonoHits: number;
	loadRegionHits: number;
	loadInheritedHits: number;
	loadWatchedHits: number;
	loadMegaHits: number;
	loadMegaMisses: number;
	loadFallbacks: number;
	storeMonoHits: number;
	storeRegionHits: number;
	storeMegaHits: number;
	storeMegaMisses: number;
	storeTransitionHits: number;
	storeTransitionFills: number;
	storeFallbacks: number;
}
interface CompilerMetrics {
	wallMs: number;
	sourceBytes: number;
	wireBytes: number;
	functionCount: number;
}
interface SelfCompileMetrics {
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
}
interface ModuleMetrics {
	malMs: number;
	nodeMs: number;
	ratio: number;
	/**
	 * GC collections in the maligator run — the point of this bench. The
	 * const-helper inlining chain scalar-replaces every transient, so a healthy
	 * build reports exactly 0; a regression that breaks callee resolution or
	 * scalar replacement spikes it into the hundreds (and multiplies wall time).
	 */
	collections: number;
	/** Peak live heap (KB); tiny when the transients are eliminated. */
	peakLiveKb: number;
}
interface StringMetrics {
	malMs: number;
	nodeMs: number;
	ratio: number;
	collections: number;
	allocatedMb: number;
	peakLiveKb: number;
	freshDenseStores: number;
	freshDenseGrowths: number;
	freshDenseFallbacks: number;
	freshDenseExactReserves: number;
	freshDenseReservedSlots: number;
	freshDenseGrowthsAvoided: number;
	searchCalls: number;
	searchMultiUnitCalls: number;
	searchCandidates: number;
	searchFirstUnitRejects: number;
	searchLastUnitRejects: number;
	searchMemcmpCalls: number;
	searchMemcmpCodeUnits: number;
	reverseSearchCalls: number;
	reverseSearchCandidates: number;
	reverseSearchFirstUnitRejects: number;
	reverseSearchLastUnitRejects: number;
	reverseSearchMemcmpCalls: number;
	reverseSearchMemcmpCodeUnits: number;
	unitScanWordBlocks: number;
	unitScanCandidateBlocks: number;
	unitScanScalarCodeUnits: number;
	splitPlannedMatches: number;
	splitPlanOverflows: number;
	caseCalls: number;
	caseInputCodeUnits: number;
	caseReuses: number;
	caseChangedAllocations: number;
	regexpExecCalls: number;
	regexpFastExecCalls: number;
	regexpAsciiExecCalls: number;
	regexpAsciiCacheHits: number;
	regexpAsciiCacheFills: number;
	regexpUtf16ExecCalls: number;
	stringAllocations: number;
	inlineStringAllocations: number;
	dependentStringAllocations: number;
	consStringAllocations: number;
	stringFlattenCalls: number;
}
interface PromiseMetrics {
	malMs: number;
	nodeMs: number;
	ratio: number;
	collections: number;
	allocatedMb: number;
	jobAllocations: number;
	jobReuses: number;
	reactionAllocations: number;
	reactionReuses: number;
	directCapabilities: number;
	materializedFallbackPairs: number;
	directIntrinsicCreations: number;
	directAsyncResults: number;
	typedAwaitContinuations: number;
	typedAwaitJobs: number;
	jobSlabHits: number;
	jobSlabFreshSlots: number;
	jobSlabBlockAllocations: number;
	jobSlabBlockFrees: number;
	jobSlabPeakRetainedBytes: number;
	nativeAdoptionHits: number;
	nativeAdoptionGuardFallbacks: number;
	intrinsicSpeciesHits: number;
	discardedDependentRegistrations: number;
	guardedFallbacks: number;
	resolvingPairs: number;
	directAsyncGeneratorRequests: number;
}
interface CoroutineBackendMetrics {
	wallMs: number;
	collections: number;
	allocatedMb: number;
	frameRequests: number;
	frameAllocations: number;
	frameReuses: number;
	frameReleases: number;
	framePooled: number;
	frameDropped: number;
	framePeakRetainedBytes: number;
	frameReleaseClearSlots: number;
	frameAllocationInitSlots: number;
	requestAllocations: number;
	requestReuses: number;
}
interface CoroutineMetrics {
	compiled: CoroutineBackendMetrics;
	interpreted: CoroutineBackendMetrics;
	nodeMs: number;
}
interface ArgumentsBackendMetrics {
	wallMs: number;
	collections: number;
	allocatedMb: number;
	frameRequests: number;
	frameAllocations: number;
	frameReuses: number;
	frameReleases: number;
	framePooled: number;
	frameDropped: number;
	framePeakRetainedBytes: number;
	frameReleaseClearSlots: number;
	frameAllocationInitSlots: number;
	instructionCount: number;
	bytecodeBytes: number;
	binaryBytes: number;
	snapshotLogicalValues: number;
	snapshotDestinationWrites: number;
	snapshotTemporaryCopies: number;
}
interface ArgumentsMetrics {
	compiled: ArgumentsBackendMetrics;
	interpreted: ArgumentsBackendMetrics;
	nodeMs: number;
}
interface StackObjectBackendMetrics {
	wallMs: number;
	collections: number;
	allocatedMb: number;
	peakLiveKb: number;
	maxPauseMs: number;
	instructionCount: number;
	bytecodeBytes: number;
	binaryBytes: number;
	objectSlotCoallocations: number;
	objectSlotGrowMigrations: number;
	objectSlotDictionaryMigrations: number;
	stackObjectMaterializations: number;
}
interface StackObjectMetrics {
	compiled: StackObjectBackendMetrics;
	interpreted: StackObjectBackendMetrics;
	nodeMs: number;
	checksum: number;
}
interface InterpreterMetrics {
	malMs: number;
	nodeMs: number;
	ratio: number;
	rssMb: number;
	directLeafExecutions: number;
	boundaryDispatches: number;
	stateSyncs: number;
	stateReloads: number;
	normalHelperContinuations: number;
	strictDirectHits: number;
	strictStringFallbacks: number;
	localLoadIcHits: number;
	localStoreIcHits: number;
	loadIcSyncFallbacks: number;
	storeIcSyncFallbacks: number;
	instructionSize: number;
	instructionCount: number;
	instructionBytes: number;
	instructionDataBytes?: number;
	bytecodeBytes?: number;
}
interface SqliteBindingFixtureMetrics {
	iterations: number;
	parametersPerCall: number;
	unboundMs: number;
	numberMs: number;
	textMs: number;
}
interface SqliteBindingMetrics {
	iterations: number;
	parametersPerCall: number;
	mal: SqliteBindingFixtureMetrics;
	node: SqliteBindingFixtureMetrics;
	unboundRatio: number;
	numberRatio: number;
	textRatio: number;
	malNumberNsPerBind: number;
	nodeNumberNsPerBind: number;
	malTextNsPerBind: number;
	nodeTextNsPerBind: number;
	numberBindingRatio: number;
	textBindingRatio: number;
	collections: number;
	allocatedMb: number;
}
interface PrototypeCacheFixtureMetrics {
	iterations: number;
	measuredCalls: number;
	runtimeMs: number;
	userlandDirectMs: number;
	userlandDeepMs: number;
	userlandFourLinkMs: number;
	userlandEightLinkMs: number;
	postMutationMs: number;
}
interface PrototypeCacheMetrics {
	iterations: number;
	mal: PrototypeCacheFixtureMetrics;
	node: PrototypeCacheFixtureMetrics;
	runtimeRatio: number;
	userlandDirectRatio: number;
	userlandDeepRatio: number;
	userlandFourLinkRatio: number;
	userlandEightLinkRatio: number;
	postMutationRatio: number;
	inheritedHits: number;
	inheritedLoopSummaries: number;
	inheritedLoopIterationsElided: number;
	inheritedFills: number;
	inheritedRejectChain: number;
}
interface GcWorkload {
	wallMs: number;
	rssMb: number;
	maxPauseMs: number;
}
interface HttpMetrics {
	malRps: number;
	nodeRps: number;
	ratio: number;
	malP99Ms: number;
	nodeP99Ms: number;
	express?: {
		binaryBytes: number;
		workloads: Record<string, HttpComparisonMetrics>;
	};
}
interface HttpComparisonMetrics {
	malRps: number;
	nodeRps: number;
	ratio: number;
	malP99Ms: number;
	nodeP99Ms: number;
}
interface BenchmarkSnapshot {
	/** Per-config binary/archive bytes (keyed by SIZE_PROFILES name). */
	size?: Record<string, SizeMetrics>;
	compiler?: CompilerMetrics;
	selfCompile?: SelfCompileMetrics;
	language?: LanguageMetrics;
	module?: ModuleMetrics;
	string?: StringMetrics;
	promise?: PromiseMetrics;
	coroutine?: CoroutineMetrics;
	arguments?: ArgumentsMetrics;
	stackObject?: StackObjectMetrics;
	interpreter?: InterpreterMetrics;
	sqliteBinding?: SqliteBindingMetrics;
	prototypeCache?: PrototypeCacheMetrics;
	gc?: Record<string, GcWorkload>;
	http?: HttpMetrics;
}

function median(xs: Array<number>): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

function fileBytes(pathname: string): number {
	return existsSync(pathname) ? statSync(pathname).size : 0;
}

/** Median wall-clock (ms) of N runs of a binary/command. */
function timeCommand(
	cmd: string,
	args: Array<string>,
	runs: number,
	env?: NodeJS.ProcessEnv,
): number {
	const times: Array<number> = [];
	for (let i = 0; i < runs; i++) {
		benchmarkProgress.progress(i + 1, runs, `${activeBenchmarkLane} sample`);
		const start = process.hrtime.bigint();
		const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, stdio: "ignore" });
		if (r.status !== 0) {
			throw new Error(`command failed: ${cmd} ${args.join(" ")} (status ${r.status})`);
		}
		times.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	return median(times);
}

/** Enforce enough useful Node work that process startup does not dominate ratios. */
function timeNodeComparison(name: string, fixture: string, runs: number): number {
	const nodeMs = timeCommand("node", [fixture], runs);
	if (nodeMs < MIN_NODE_COMPARISON_MS) {
		throw new Error(
			`${name} Node median ${nodeMs.toFixed(1)}ms is below the ${MIN_NODE_COMPARISON_MS}ms process-comparison floor; increase meaningful work in ${fixture} and recalibrate with --runs 5`,
		);
	}
	return nodeMs;
}

// ---- size -----------------------------------------------------------------

/** The floor program: binary size is config-dominated, so the fixture is fixed. */
const SIZE_FIXTURE = "bench/hello-world.js";

/**
 * The build-config matrix the size bench measures. Each is a real
 * {@link MaligatorBuildConfig} resolved through the exact path a user build hits,
 * so a profile's numbers reflect what shipping that config actually costs. `full`
 * is the canonical dev build (eval + Realms + Intl on → the unsuffixed archives);
 * `minimal` is the product default (eval + Realms + Intl off). The `no-*` rows
 * isolate one axis so a feature's marginal bytes are directly readable. New
 * feature flags (RegExp, URL, …) add rows here as they land, keeping each flag's
 * win a tracked number.
 */
const SIZE_PROFILES: Array<{ name: string; config: MaligatorBuildConfig }> = [
	{
		name: "full",
		config: {
			engine: { eval: true, realms: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		},
	},
	{
		name: "no-eval",
		config: {
			engine: { eval: false, realms: true, intl: { enabled: true } },
			surface: { webPlatform: true },
		},
	},
	{
		name: "no-realms",
		config: {
			engine: { eval: true, realms: false, intl: { enabled: true } },
			surface: { webPlatform: true },
		},
	},
	{
		name: "no-intl",
		config: {
			engine: { eval: true, realms: true, intl: { enabled: false } },
			surface: { webPlatform: true },
		},
	},
	{
		// Isolates the WHATWG URL (ada C++ parser) + `-lc++`.
		name: "no-web",
		config: {
			engine: { eval: true, realms: true, intl: { enabled: true } },
			surface: { webPlatform: false },
		},
	},
	{
		// Isolates the RegExp engine (regress) + its Unicode tables. RegExp defaults
		// ON (core language), so minimal keeps it — this row shows its cost.
		name: "no-regexp",
		config: {
			engine: { eval: true, realms: true, regexp: false, intl: { enabled: true } },
			surface: { webPlatform: true },
		},
	},
	// Product defaults (eval + Realms + Intl + web off; regexp ON — core language).
	// The realistic deployed floor.
	{ name: "minimal", config: { engine: { realms: false } } },
];

function benchSize(): Record<string, SizeMetrics> {
	const result: Record<string, SizeMetrics> = {};
	for (const [index, profile] of SIZE_PROFILES.entries()) {
		benchmarkProgress.progress(
			index + 1,
			SIZE_PROFILES.length,
			`size profile ${profile.name}`,
		);
		const config = resolveBuildConfig(profile.config);
		const build = buildNativeBinaryResult({
			fixture: SIZE_FIXTURE,
			name: `bench-size-${profile.name}`,
			config,
		});
		const { binaryPath, artifacts } = build;
		result[profile.name] = {
			binaryBytes: fileBytes(binaryPath),
			runtimeArchiveBytes: fileBytes(artifacts.c.runtime),
			hostArchiveBytes: fileBytes(artifacts.c.host),
			engineArchiveBytes: fileBytes(artifacts.c.engine),
			rustArchiveBytes: fileBytes(artifacts.rust.library),
		};
	}
	return result;
}

// ---- compiler (Node-hosted front end) -------------------------------------

const COMPILER_FUNCTION_COUNT = 800;

function compilerSource(): string {
	return Array.from(
		{ length: COMPILER_FUNCTION_COUNT },
		(_, index) =>
			`function compilerBench${index}(a, b) {
	const folded = ((${index} + 17) * 9 - 11) / 2;
	const selected = (${index} & 1) === 0 ? folded + 3 : folded - 5;
	if ((${index} % 5) === 3) return a + selected;
	return b + selected;
}`,
	).join("\n");
}

function benchCompiler(runs: number): CompilerMetrics {
	const source = compilerSource();
	let wire = compileSourceToBuffer(source);
	const times: Array<number> = [];
	for (let i = 0; i < runs; i++) {
		benchmarkProgress.progress(i + 1, runs, "compiler sample");
		const start = process.hrtime.bigint();
		wire = compileSourceToBuffer(source);
		times.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	return {
		wallMs: median(times),
		sourceBytes: Buffer.byteLength(source),
		wireBytes: wire.byteLength,
		functionCount: COMPILER_FUNCTION_COUNT,
	};
}

// ---- self-compile (native compiler vs Node, through C emit) ---------------

interface SelfCompileRun {
	wallMs: number;
	units: number;
	codeUnits: number;
	digest: string;
	phases: SelfCompilePhases;
}

interface SelfCompilePhases {
	graphMs: number;
	semanticMs: number;
	compileToIrMs: number;
	optimizeMs: number;
	regallocMs: number;
	lowerMs: number;
	emitMs: number;
	writeMs: number;
}

function digestDirectory(directory: string): string {
	const digest = createHash("sha256");
	for (const name of readdirSync(directory).sort()) {
		digest.update(name);
		digest.update(readFileSync(path.join(directory, name)));
	}
	return digest.digest("hex");
}

function runSelfCompile(
	command: string,
	args: Array<string>,
	output: string,
): SelfCompileRun {
	const start = process.hrtime.bigint();
	const result = spawnSync(command, [...args, output], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 900_000,
	});
	const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`self-compile failed: ${command} ${args.join(" ")} (status ${result.status})\n${result.stderr}`,
		);
	}
	const summary = JSON.parse(result.stdout.trim()) as {
		units: number;
		codeUnits: number;
		phases: SelfCompilePhases;
	};
	return {
		wallMs,
		units: summary.units,
		codeUnits: summary.codeUnits,
		digest: digestDirectory(output),
		phases: summary.phases,
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
	// The compiler is still closing semantic gaps between its native and Node hosts.
	// Keep the workload comparable without hiding small, deterministic C differences.
	const sizeDifference = Math.abs(node.codeUnits - maligator.codeUnits) / node.codeUnits;
	if (node.units !== maligator.units || sizeDifference > 0.01) {
		throw new Error(
			`self-compile workloads diverged: ${JSON.stringify(maligator)} != ${JSON.stringify(node)}`,
		);
	}
}

function copyStrippedTree(source: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		if (entry.isDirectory()) {
			copyStrippedTree(from, to);
		} else if (/\.(?:ts|mts|cts)$/.test(entry.name)) {
			writeFileSync(to, stripTypesWithTypeScript(readFileSync(from, "utf8"), from));
		} else if (entry.isFile()) {
			copyFileSync(from, to);
		}
	}
}

function prepareSelfCompileSource(root: string): string {
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
	copyStrippedTree(path.resolve("src"), path.join(root, "src"));
	mkdirSync(path.join(root, "bench"), { recursive: true });
	const fixture = path.resolve("bench/self-compile.mts");
	writeFileSync(
		path.join(root, "bench/self-compile.mts"),
		stripTypesWithTypeScript(readFileSync(fixture, "utf8"), fixture),
	);
	symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
	return path.join(root, "bench/self-compile.mts");
}

function benchSelfCompile(runs: number): SelfCompileMetrics {
	const fixture = path.resolve("bench/self-compile.mts");
	const config = resolveBuildConfig({
		engine: { eval: false, realms: false, regexp: true, intl: { enabled: false } },
		surface: { webPlatform: false, node: true, maligator: true },
	});
	const binary = buildNativeBinary({
		fixture,
		name: "bench-self-compile",
		config,
	});
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-self-compile-"));
	const maligatorTimes: Array<number> = [];
	const nodeTimes: Array<number> = [];
	const maligatorPhases: Array<SelfCompilePhases> = [];
	const nodePhases: Array<SelfCompilePhases> = [];
	let nodeReference: SelfCompileRun | undefined;
	let maligatorReference: SelfCompileRun | undefined;
	try {
		const target = prepareSelfCompileSource(path.join(root, "source"));
		for (let index = 0; index < runs; index++) {
			benchmarkProgress.progress(index + 1, runs, "self-compile paired sample");
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
			if (nodeReference === undefined) nodeReference = node;
			else assertSameSelfCompile(nodeReference, node);
			if (maligatorReference === undefined) maligatorReference = maligator;
			else assertSameSelfCompile(maligatorReference, maligator);
			nodeTimes.push(node.wallMs);
			maligatorTimes.push(maligator.wallMs);
			nodePhases.push(node.phases);
			maligatorPhases.push(maligator.phases);
		}
		if (nodeReference === undefined || maligatorReference === undefined) {
			throw new Error("self-compile requires at least one run");
		}
		return {
			maligatorMs: median(maligatorTimes),
			nodeMs: median(nodeTimes),
			maligatorPhases: {
				graphMs: median(maligatorPhases.map((phases) => phases.graphMs)),
				semanticMs: median(maligatorPhases.map((phases) => phases.semanticMs)),
				compileToIrMs: median(maligatorPhases.map((phases) => phases.compileToIrMs)),
				optimizeMs: median(maligatorPhases.map((phases) => phases.optimizeMs)),
				regallocMs: median(maligatorPhases.map((phases) => phases.regallocMs)),
				lowerMs: median(maligatorPhases.map((phases) => phases.lowerMs)),
				emitMs: median(maligatorPhases.map((phases) => phases.emitMs)),
				writeMs: median(maligatorPhases.map((phases) => phases.writeMs)),
			},
			nodePhases: {
				graphMs: median(nodePhases.map((phases) => phases.graphMs)),
				semanticMs: median(nodePhases.map((phases) => phases.semanticMs)),
				compileToIrMs: median(nodePhases.map((phases) => phases.compileToIrMs)),
				optimizeMs: median(nodePhases.map((phases) => phases.optimizeMs)),
				regallocMs: median(nodePhases.map((phases) => phases.regallocMs)),
				lowerMs: median(nodePhases.map((phases) => phases.lowerMs)),
				emitMs: median(nodePhases.map((phases) => phases.emitMs)),
				writeMs: median(nodePhases.map((phases) => phases.writeMs)),
			},
			runs,
			units: nodeReference.units,
			maligatorCodeUnits: maligatorReference.codeUnits,
			nodeCodeUnits: nodeReference.codeUnits,
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.version,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ---- language (vs V8) -----------------------------------------------------

function benchLanguage(runs: number): LanguageMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/language.js",
		name: "bench-language",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeNodeComparison("language", "bench/language.js", runs);
	const gcResult = spawnSync(binary, [], {
		env: { ...process.env, MAL_GC_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const previousPerfStats = process.env.MAL_PERF_STATS;
	process.env.MAL_PERF_STATS = "1";
	let perfBinary: string;
	try {
		perfBinary = buildNativeBinary({
			fixture: "bench/language.js",
			name: "bench-language-perf",
		});
	} finally {
		if (previousPerfStats === undefined) delete process.env.MAL_PERF_STATS;
		else process.env.MAL_PERF_STATS = previousPerfStats;
	}
	const perfResult = spawnSync(perfBinary, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const gcStderr = gcResult.stderr ?? "";
	const perfStderr = perfResult.stderr ?? "";
	return {
		malMs,
		nodeMs,
		ratio: malMs / nodeMs,
		collections: parseGcStat(gcStderr, "collections"),
		allocatedMb: parseGcStat(gcStderr, "allocated_bytes") / (1024 * 1024),
		emptyObjects: parsePerfStat(perfStderr, "perf-allocation-stats", "empty_objects"),
		shapedObjects: parsePerfStat(perfStderr, "perf-allocation-stats", "shaped_objects"),
		stackObjects: parsePerfStat(perfStderr, "perf-allocation-stats", "stack_objects"),
		stackMaterializations: parsePerfStat(
			perfStderr,
			"perf-allocation-stats",
			"stack_materializations",
		),
		callProbes: parsePerfStat(perfStderr, "perf-call-cache-stats", "probes"),
		callMisses: parsePerfStat(perfStderr, "perf-call-cache-stats", "dispatch_misses"),
		loadMonoHits: parsePerfStat(perfStderr, "perf-ic-stats", "load_mono_hits"),
		loadRegionHits: parsePerfStat(perfStderr, "perf-ic-stats", "load_region_hits"),
		loadInheritedHits: parsePerfStat(perfStderr, "perf-ic-stats", "load_inherited_hits"),
		loadWatchedHits: parsePerfStat(perfStderr, "perf-ic-stats", "load_watched_hits"),
		loadMegaHits: parsePerfStat(perfStderr, "perf-ic-stats", "load_mega_hits"),
		loadMegaMisses: parsePerfStat(perfStderr, "perf-ic-stats", "load_mega_misses"),
		loadFallbacks: parsePerfStat(perfStderr, "perf-ic-stats", "load_fallbacks"),
		storeMonoHits: parsePerfStat(perfStderr, "perf-ic-stats", "store_mono_hits"),
		storeRegionHits: parsePerfStat(perfStderr, "perf-ic-stats", "store_region_hits"),
		storeMegaHits: parsePerfStat(perfStderr, "perf-ic-stats", "store_mega_hits"),
		storeMegaMisses: parsePerfStat(perfStderr, "perf-ic-stats", "store_mega_misses"),
		storeTransitionHits: parsePerfStat(
			perfStderr,
			"perf-ic-stats",
			"store_transition_hits",
		),
		storeTransitionFills: parsePerfStat(
			perfStderr,
			"perf-ic-stats",
			"store_transition_fills",
		),
		storeFallbacks: parsePerfStat(perfStderr, "perf-ic-stats", "store_fallbacks"),
	};
}

// ---- module (const-helper allocation; vs V8) ------------------------------

/** A `key=value` field from the single `MAL_GC_STATS=1` `[gc-stats]` line. */
function parseGcStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((l) => l.includes("[gc-stats]"));
	const m = line?.match(new RegExp(`${field}=([0-9.]+)`));
	return m ? Number(m[1]) : 0;
}

function parsePerfStat(stderr: string, group: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes(`[${group}]`));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parsePerfArrayStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[perf-array-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parsePerfStringStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[perf-string-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parsePerfStringAllocationStat(stderr: string, field: string): number {
	const line = stderr
		.split("\n")
		.find((value) => value.includes("[perf-string-allocation-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parsePerfRegexpStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[perf-regexp-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function benchModule(runs: number): ModuleMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/module-alloc.mjs",
		name: "bench-module",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeNodeComparison("module", "bench/module-alloc.mjs", runs);
	// One instrumented run for the allocation signal this bench exists to track:
	// zero collections means the const-helper inlining chain scalar-replaced every
	// transient. (Works on the default collector — no generational build needed.)
	const r = spawnSync(binary, [], {
		env: { ...process.env, MAL_GC_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr = r.stderr ?? "";
	return {
		malMs,
		nodeMs,
		ratio: malMs / nodeMs,
		collections: parseGcStat(stderr, "collections"),
		peakLiveKb: parseGcStat(stderr, "peak_live_bytes") / 1024,
	};
}

// ---- string (wide String + RegExp surface; vs V8) --------------------------

function benchString(runs: number): StringMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/string.js",
		name: "bench-string",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeNodeComparison("string", "bench/string.js", runs);
	const r = spawnSync(binary, [], {
		env: { ...process.env, MAL_GC_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr = r.stderr ?? "";
	const perfBinary = buildNativeBinary({
		fixture: "bench/string.js",
		name: "bench-string-perf",
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	});
	const perfResult = spawnSync(perfBinary, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const perfStderr = perfResult.stderr ?? "";
	return {
		malMs,
		nodeMs,
		ratio: malMs / nodeMs,
		collections: parseGcStat(stderr, "collections"),
		allocatedMb: parseGcStat(stderr, "allocated_bytes") / (1024 * 1024),
		peakLiveKb: parseGcStat(stderr, "peak_live_bytes") / 1024,
		freshDenseStores: parsePerfArrayStat(perfStderr, "fresh_dense_stores"),
		freshDenseGrowths: parsePerfArrayStat(perfStderr, "fresh_dense_growths"),
		freshDenseFallbacks: parsePerfArrayStat(perfStderr, "fresh_dense_fallbacks"),
		freshDenseExactReserves: parsePerfArrayStat(perfStderr, "fresh_dense_exact_reserves"),
		freshDenseReservedSlots: parsePerfArrayStat(perfStderr, "fresh_dense_reserved_slots"),
		freshDenseGrowthsAvoided: parsePerfArrayStat(
			perfStderr,
			"fresh_dense_growths_avoided",
		),
		searchCalls: parsePerfStringStat(perfStderr, "search_calls"),
		searchMultiUnitCalls: parsePerfStringStat(perfStderr, "search_multi_unit_calls"),
		searchCandidates: parsePerfStringStat(perfStderr, "search_candidates"),
		searchFirstUnitRejects: parsePerfStringStat(perfStderr, "search_first_unit_rejects"),
		searchLastUnitRejects: parsePerfStringStat(perfStderr, "search_last_unit_rejects"),
		searchMemcmpCalls: parsePerfStringStat(perfStderr, "search_memcmp_calls"),
		searchMemcmpCodeUnits: parsePerfStringStat(perfStderr, "search_memcmp_code_units"),
		reverseSearchCalls: parsePerfStringStat(perfStderr, "reverse_search_calls"),
		reverseSearchCandidates: parsePerfStringStat(perfStderr, "reverse_search_candidates"),
		reverseSearchFirstUnitRejects: parsePerfStringStat(
			perfStderr,
			"reverse_search_first_unit_rejects",
		),
		reverseSearchLastUnitRejects: parsePerfStringStat(
			perfStderr,
			"reverse_search_last_unit_rejects",
		),
		reverseSearchMemcmpCalls: parsePerfStringStat(
			perfStderr,
			"reverse_search_memcmp_calls",
		),
		reverseSearchMemcmpCodeUnits: parsePerfStringStat(
			perfStderr,
			"reverse_search_memcmp_code_units",
		),
		unitScanWordBlocks: parsePerfStringStat(perfStderr, "unit_scan_word_blocks"),
		unitScanCandidateBlocks: parsePerfStringStat(
			perfStderr,
			"unit_scan_candidate_blocks",
		),
		unitScanScalarCodeUnits: parsePerfStringStat(
			perfStderr,
			"unit_scan_scalar_code_units",
		),
		splitPlannedMatches: parsePerfStringStat(perfStderr, "split_planned_matches"),
		splitPlanOverflows: parsePerfStringStat(perfStderr, "split_plan_overflows"),
		caseCalls: parsePerfStringStat(perfStderr, "case_calls"),
		caseInputCodeUnits: parsePerfStringStat(perfStderr, "case_input_code_units"),
		caseReuses: parsePerfStringStat(perfStderr, "case_reuses"),
		caseChangedAllocations: parsePerfStringStat(perfStderr, "case_changed_allocations"),
		regexpExecCalls: parsePerfRegexpStat(perfStderr, "exec_calls"),
		regexpFastExecCalls: parsePerfRegexpStat(perfStderr, "fast_exec_calls"),
		regexpAsciiExecCalls: parsePerfRegexpStat(perfStderr, "ascii_exec_calls"),
		regexpAsciiCacheHits: parsePerfRegexpStat(perfStderr, "ascii_cache_hits"),
		regexpAsciiCacheFills: parsePerfRegexpStat(perfStderr, "ascii_cache_fills"),
		regexpUtf16ExecCalls: parsePerfRegexpStat(perfStderr, "utf16_exec_calls"),
		stringAllocations: parsePerfStringAllocationStat(perfStderr, "allocations"),
		inlineStringAllocations: parsePerfStringAllocationStat(
			perfStderr,
			"inline_allocations",
		),
		dependentStringAllocations: parsePerfStringAllocationStat(
			perfStderr,
			"dependent_allocations",
		),
		consStringAllocations: parsePerfStringAllocationStat(perfStderr, "cons_allocations"),
		stringFlattenCalls: parsePerfStringAllocationStat(perfStderr, "flatten_calls"),
	};
}

// ---- promise (wide Promise + microtask surface; vs V8) ---------------------

function parsePromiseStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[promise-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parsePerfPromiseStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[perf-promise-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parseCoroutineStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[coroutine-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parsePerfCoroutineStat(stderr: string, field: string): number {
	const line = stderr
		.split("\n")
		.find((value) => value.includes("[perf-coroutine-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function benchPromise(runs: number): PromiseMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/promise.js",
		name: "bench-promise",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeNodeComparison("promise", "bench/promise.js", runs);
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_GC_STATS: "1", MAL_PROMISE_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr = result.stderr ?? "";
	const previousPerfStats = process.env.MAL_PERF_STATS;
	process.env.MAL_PERF_STATS = "1";
	let perfBinary: string;
	try {
		perfBinary = buildNativeBinary({
			fixture: "bench/promise.js",
			name: "bench-promise-perf",
		});
	} finally {
		if (previousPerfStats === undefined) delete process.env.MAL_PERF_STATS;
		else process.env.MAL_PERF_STATS = previousPerfStats;
	}
	const perfResult = spawnSync(perfBinary, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const perfStderr = perfResult.stderr ?? "";
	return {
		malMs,
		nodeMs,
		ratio: malMs / nodeMs,
		collections: parseGcStat(stderr, "collections"),
		allocatedMb: parseGcStat(stderr, "allocated_bytes") / (1024 * 1024),
		jobAllocations: parsePromiseStat(stderr, "job_allocations"),
		jobReuses: parsePromiseStat(stderr, "job_reuses"),
		reactionAllocations: parsePromiseStat(stderr, "reaction_allocations"),
		reactionReuses: parsePromiseStat(stderr, "reaction_reuses"),
		directCapabilities: parsePromiseStat(stderr, "direct_capabilities"),
		materializedFallbackPairs: parsePromiseStat(stderr, "materialized_fallback_pairs"),
		directIntrinsicCreations: parsePromiseStat(stderr, "direct_intrinsic_creations"),
		directAsyncResults: parsePromiseStat(stderr, "direct_async_results"),
		typedAwaitContinuations: parsePerfPromiseStat(
			perfStderr,
			"await_typed_continuations",
		),
		typedAwaitJobs: parsePerfPromiseStat(perfStderr, "await_typed_jobs"),
		jobSlabHits: parsePerfPromiseStat(perfStderr, "job_slab_hits"),
		jobSlabFreshSlots: parsePerfPromiseStat(perfStderr, "job_slab_fresh_slots"),
		jobSlabBlockAllocations: parsePerfPromiseStat(
			perfStderr,
			"job_slab_block_allocations",
		),
		jobSlabBlockFrees: parsePerfPromiseStat(perfStderr, "job_slab_block_frees"),
		jobSlabPeakRetainedBytes: parsePerfPromiseStat(
			perfStderr,
			"job_slab_peak_retained_bytes",
		),
		nativeAdoptionHits: parsePerfPromiseStat(perfStderr, "native_adoption_hits"),
		nativeAdoptionGuardFallbacks: parsePerfPromiseStat(
			perfStderr,
			"native_adoption_guard_fallbacks",
		),
		intrinsicSpeciesHits: parsePerfPromiseStat(perfStderr, "intrinsic_species_hits"),
		discardedDependentRegistrations: parsePerfPromiseStat(
			perfStderr,
			"discarded_dependent_registrations",
		),
		guardedFallbacks: parsePerfPromiseStat(perfStderr, "guarded_fallbacks"),
		resolvingPairs: parsePerfPromiseStat(perfStderr, "resolving_pairs"),
		directAsyncGeneratorRequests: parsePerfPromiseStat(
			perfStderr,
			"async_generator_direct_requests",
		),
	};
}

// ---- coroutine (suspendable frames; compiled + interpreted) ----------------

function benchCoroutineBackend(binary: string, runs: number): CoroutineBackendMetrics {
	const wallMs = timeCommand(binary, [], runs);
	const result = spawnSync(binary, [], {
		env: {
			...process.env,
			MAL_GC_STATS: "1",
			MAL_PROMISE_STATS: "1",
			MAL_COROUTINE_STATS: "1",
		},
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr = result.stderr ?? "";
	return {
		wallMs,
		collections: parseGcStat(stderr, "collections"),
		allocatedMb: parseGcStat(stderr, "allocated_bytes") / (1024 * 1024),
		frameRequests: parseCoroutineStat(stderr, "requests"),
		frameAllocations: parsePromiseStat(stderr, "frame_allocations"),
		frameReuses: parsePromiseStat(stderr, "frame_reuses"),
		frameReleases: parseCoroutineStat(stderr, "releases"),
		framePooled: parseCoroutineStat(stderr, "pooled"),
		frameDropped: parseCoroutineStat(stderr, "dropped"),
		framePeakRetainedBytes: parseCoroutineStat(stderr, "peak_retained_bytes"),
		frameReleaseClearSlots: parsePerfCoroutineStat(stderr, "release_clear_slots"),
		frameAllocationInitSlots: parsePerfCoroutineStat(stderr, "allocation_init_slots"),
		requestAllocations: parsePromiseStat(stderr, "request_allocations"),
		requestReuses: parsePromiseStat(stderr, "request_reuses"),
	};
}

function benchCoroutine(runs: number): CoroutineMetrics {
	const compiled = buildNativeBinary({
		fixture: "bench/coroutine.js",
		name: "bench-coroutine",
		compiled: true,
	});
	const interpreted = buildNativeBinary({
		fixture: "bench/coroutine.js",
		name: "bench-coroutine-ni",
		compiled: false,
	});
	return {
		compiled: benchCoroutineBackend(compiled, runs),
		interpreted: benchCoroutineBackend(interpreted, runs),
		nodeMs: timeNodeComparison("coroutine", "bench/coroutine.js", runs),
	};
}

// ---- arguments (implicit object/slice allocation; compiled + interpreted) --

function parsePerfArgumentsStat(stderr: string, field: string): number {
	const line = stderr
		.split("\n")
		.find((value) => value.includes("[perf-arguments-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function benchArgumentsBackend(
	binary: string,
	perfBinary: string,
	runs: number,
): ArgumentsBackendMetrics {
	const wallMs = timeCommand(binary, [], runs);
	const result = spawnSync(binary, [], {
		env: {
			...process.env,
			MAL_GC_STATS: "1",
			MAL_PROMISE_STATS: "1",
			MAL_COROUTINE_STATS: "1",
			MAL_VM_STATS: "1",
		},
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr = result.stderr ?? "";
	const perfResult = spawnSync(perfBinary, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const perfStderr = perfResult.stderr ?? "";
	return {
		wallMs,
		collections: parseGcStat(stderr, "collections"),
		allocatedMb: parseGcStat(stderr, "allocated_bytes") / (1024 * 1024),
		frameRequests: parseCoroutineStat(stderr, "requests"),
		frameAllocations: parsePromiseStat(stderr, "frame_allocations"),
		frameReuses: parsePromiseStat(stderr, "frame_reuses"),
		frameReleases: parseCoroutineStat(stderr, "releases"),
		framePooled: parseCoroutineStat(stderr, "pooled"),
		frameDropped: parseCoroutineStat(stderr, "dropped"),
		framePeakRetainedBytes: parseCoroutineStat(stderr, "peak_retained_bytes"),
		frameReleaseClearSlots: parsePerfCoroutineStat(perfStderr, "release_clear_slots"),
		frameAllocationInitSlots: parsePerfCoroutineStat(perfStderr, "allocation_init_slots"),
		instructionCount: parseVmStat(stderr, "instruction_count"),
		bytecodeBytes: parseVmStat(stderr, "bytecode_bytes"),
		binaryBytes: fileBytes(binary),
		snapshotLogicalValues: parsePerfArgumentsStat(perfStderr, "logical_values"),
		snapshotDestinationWrites: parsePerfArgumentsStat(perfStderr, "destination_writes"),
		snapshotTemporaryCopies: parsePerfArgumentsStat(perfStderr, "temporary_copies"),
	};
}

function benchArguments(runs: number): ArgumentsMetrics {
	const compiled = buildNativeBinary({
		fixture: "bench/arguments.js",
		name: "bench-arguments",
		compiled: true,
	});
	const interpreted = buildNativeBinary({
		fixture: "bench/arguments.js",
		name: "bench-arguments-ni",
		compiled: false,
	});
	const previousPerfStats = process.env.MAL_PERF_STATS;
	process.env.MAL_PERF_STATS = "1";
	let compiledPerf: string;
	let interpretedPerf: string;
	try {
		compiledPerf = buildNativeBinary({
			fixture: "bench/arguments.js",
			name: "bench-arguments-perf",
			compiled: true,
		});
		interpretedPerf = buildNativeBinary({
			fixture: "bench/arguments.js",
			name: "bench-arguments-ni-perf",
			compiled: false,
		});
	} finally {
		if (previousPerfStats === undefined) delete process.env.MAL_PERF_STATS;
		else process.env.MAL_PERF_STATS = previousPerfStats;
	}
	return {
		compiled: benchArgumentsBackend(compiled, compiledPerf, runs),
		interpreted: benchArgumentsBackend(interpreted, interpretedPerf, runs),
		nodeMs: timeNodeComparison("arguments", "bench/arguments.js", runs),
	};
}

// ---- stack object (residual shaped allocation; compiled + interpreted) -----

function parseChecksum(stdout: string, command: string): number {
	const output = stdout.trim();
	if (!/^\d+$/.test(output)) {
		throw new Error(
			`${command} produced invalid checksum output: ${JSON.stringify(output)}`,
		);
	}
	return Number(output);
}

function benchStackObjectBackend(
	binary: string,
	runs: number,
): StackObjectBackendMetrics & { checksum: number } {
	const wallMs = timeCommand(binary, [], runs);
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_GC_STATS: "1", MAL_VM_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`stack-object binary failed: ${binary} (status ${result.status})`);
	}
	const stderr = result.stderr ?? "";
	return {
		wallMs,
		collections: parseGcStat(stderr, "collections"),
		allocatedMb: parseGcStat(stderr, "allocated_bytes") / (1024 * 1024),
		peakLiveKb: parseGcStat(stderr, "peak_live_bytes") / 1024,
		maxPauseMs: parseGcMaxPause(stderr),
		instructionCount: parseVmStat(stderr, "instruction_count"),
		bytecodeBytes: parseVmStat(stderr, "bytecode_bytes"),
		binaryBytes: fileBytes(binary),
		objectSlotCoallocations: parseGcStat(stderr, "object_slot_coallocations"),
		objectSlotGrowMigrations: parseGcStat(stderr, "object_slot_grow_migrations"),
		objectSlotDictionaryMigrations: parseGcStat(
			stderr,
			"object_slot_dictionary_migrations",
		),
		stackObjectMaterializations: parseGcStat(stderr, "stack_object_materializations"),
		checksum: parseChecksum(result.stdout ?? "", binary),
	};
}

function benchStackObject(runs: number): StackObjectMetrics {
	const compiledBinary = buildNativeBinary({
		fixture: "bench/stack-object.js",
		name: "bench-stack-object",
		compiled: true,
	});
	const interpretedBinary = buildNativeBinary({
		fixture: "bench/stack-object.js",
		name: "bench-stack-object-ni",
		compiled: false,
	});
	const compiled = benchStackObjectBackend(compiledBinary, runs);
	const interpreted = benchStackObjectBackend(interpretedBinary, runs);
	const nodeMs = timeNodeComparison("stack-object", "bench/stack-object.js", runs);
	const nodeResult = spawnSync("node", ["bench/stack-object.js"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (nodeResult.status !== 0) {
		throw new Error(`Node stack-object fixture failed (status ${nodeResult.status})`);
	}
	const checksum = parseChecksum(nodeResult.stdout ?? "", "node bench/stack-object.js");
	if (compiled.checksum !== checksum || interpreted.checksum !== checksum) {
		throw new Error(
			`stack-object checksum mismatch: compiled=${compiled.checksum} interpreted=${interpreted.checksum} node=${checksum}`,
		);
	}
	return { compiled, interpreted, nodeMs, checksum };
}

// ---- interpreter (wide bytecode dispatch + footprint; vs V8) --------------

function parseVmStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[vm-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function parsePerfInterpreterStat(stderr: string, field: string): number {
	const line = stderr
		.split("\n")
		.find((value) => value.includes("[perf-interpreter-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function benchInterpreter(runs: number): InterpreterMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/language.js",
		name: "bench-interpreter",
		compiled: false,
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeNodeComparison("interpreter", "bench/language.js", runs);
	const canRss = os.platform() === "darwin";
	const result = canRss
		? spawnSync("/usr/bin/time", ["-l", binary], {
				env: { ...process.env, MAL_GC_STATS: "1", MAL_VM_STATS: "1" },
				encoding: "utf-8",
				stdio: ["ignore", "ignore", "pipe"],
			})
		: spawnSync(binary, [], {
				env: { ...process.env, MAL_GC_STATS: "1", MAL_VM_STATS: "1" },
				encoding: "utf-8",
				stdio: ["ignore", "ignore", "pipe"],
			});
	const stderr = result.stderr ?? "";
	const perfBinary = buildNativeBinary({
		fixture: "bench/language.js",
		name: "bench-interpreter",
		compiled: false,
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	});
	const perfResult = spawnSync(perfBinary, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (perfResult.status !== 0) {
		throw new Error(`instrumented interpreter failed (status ${perfResult.status})`);
	}
	const perfStderr = perfResult.stderr ?? "";
	return {
		malMs,
		nodeMs,
		ratio: malMs / nodeMs,
		rssMb: parseMaxRss(stderr) / (1024 * 1024),
		instructionSize: parseVmStat(stderr, "instruction_size"),
		instructionCount: parseVmStat(stderr, "instruction_count"),
		instructionBytes: parseVmStat(stderr, "instruction_bytes"),
		instructionDataBytes: parseVmStat(stderr, "instruction_data_bytes"),
		bytecodeBytes: parseVmStat(stderr, "bytecode_bytes"),
		directLeafExecutions: parsePerfInterpreterStat(perfStderr, "direct_leaf_executions"),
		boundaryDispatches: parsePerfInterpreterStat(perfStderr, "boundary_dispatches"),
		stateSyncs: parsePerfInterpreterStat(perfStderr, "state_syncs"),
		stateReloads: parsePerfInterpreterStat(perfStderr, "state_reloads"),
		normalHelperContinuations: parsePerfInterpreterStat(
			perfStderr,
			"normal_helper_continuations",
		),
		strictDirectHits: parsePerfInterpreterStat(perfStderr, "strict_direct_hits"),
		strictStringFallbacks: parsePerfInterpreterStat(
			perfStderr,
			"strict_string_fallbacks",
		),
		localLoadIcHits: parsePerfInterpreterStat(perfStderr, "local_load_ic_hits"),
		localStoreIcHits: parsePerfInterpreterStat(perfStderr, "local_store_ic_hits"),
		loadIcSyncFallbacks: parsePerfInterpreterStat(perfStderr, "load_ic_sync_fallbacks"),
		storeIcSyncFallbacks: parsePerfInterpreterStat(perfStderr, "store_ic_sync_fallbacks"),
	};
}

// ---- sqlite binding (prepared StatementSync.run; vs Node) -----------------

function parseSqliteBindingResult(
	stdout: string,
	command: string,
): SqliteBindingFixtureMetrics {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw new Error(`invalid sqlite-binding output from ${command}: ${stdout.trim()}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("iterations" in parsed) ||
		!("measuredCalls" in parsed) ||
		!("parametersPerCall" in parsed) ||
		!("unboundMs" in parsed) ||
		!("numberMs" in parsed) ||
		!("textMs" in parsed)
	) {
		throw new Error(`incomplete sqlite-binding output from ${command}`);
	}
	const metrics = parsed as SqliteBindingFixtureMetrics;
	for (const [name, value] of Object.entries(metrics)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`invalid sqlite-binding ${name} from ${command}: ${value}`);
		}
	}
	return metrics;
}

function runSqliteBindingFixture(
	command: string,
	args: Array<string>,
	runs: number,
	env?: NodeJS.ProcessEnv,
): SqliteBindingFixtureMetrics {
	const results: Array<SqliteBindingFixtureMetrics> = [];
	for (let run = 0; run < runs; run++) {
		const result = spawnSync(command, args, {
			env: { ...process.env, ...env },
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) {
			throw new Error(
				`sqlite-binding command failed: ${command} ${args.join(" ")} (status ${result.status})\n${result.stderr ?? ""}`,
			);
		}
		results.push(
			parseSqliteBindingResult(result.stdout ?? "", `${command} ${args.join(" ")}`),
		);
	}
	const first = results[0]!;
	return {
		iterations: first.iterations,
		parametersPerCall: first.parametersPerCall,
		unboundMs: median(results.map((result) => result.unboundMs)),
		numberMs: median(results.map((result) => result.numberMs)),
		textMs: median(results.map((result) => result.textMs)),
	};
}

function bindingNsPerParameter(
	boundMs: number,
	unboundMs: number,
	iterations: number,
	parametersPerCall: number,
): number {
	return (Math.max(0, boundMs - unboundMs) * 1e6) / (iterations * parametersPerCall);
}

function benchSqliteBinding(runs: number): SqliteBindingMetrics {
	const fixture = "bench/sqlite-binding.mjs";
	const binary = buildNativeBinary({
		fixture,
		name: "bench-sqlite-binding",
		mainFile: HOST_MAIN,
		nodeEnabled: true,
	});
	const mal = runSqliteBindingFixture(binary, [], runs);
	const node = runSqliteBindingFixture("node", ["--no-warnings", fixture], runs);
	if (
		mal.iterations !== node.iterations ||
		mal.parametersPerCall !== node.parametersPerCall
	) {
		throw new Error("sqlite-binding fixture metadata differs between Maligator and Node");
	}
	const instrumented = spawnSync(binary, [], {
		env: { ...process.env, MAL_GC_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (instrumented.status !== 0) {
		throw new Error(
			`instrumented sqlite-binding run failed: ${instrumented.stderr ?? ""}`,
		);
	}
	const malNumberNsPerBind = bindingNsPerParameter(
		mal.numberMs,
		mal.unboundMs,
		mal.iterations,
		mal.parametersPerCall,
	);
	const nodeNumberNsPerBind = bindingNsPerParameter(
		node.numberMs,
		node.unboundMs,
		node.iterations,
		node.parametersPerCall,
	);
	const malTextNsPerBind = bindingNsPerParameter(
		mal.textMs,
		mal.unboundMs,
		mal.iterations,
		mal.parametersPerCall,
	);
	const nodeTextNsPerBind = bindingNsPerParameter(
		node.textMs,
		node.unboundMs,
		node.iterations,
		node.parametersPerCall,
	);
	const stderr = instrumented.stderr ?? "";
	return {
		iterations: mal.iterations,
		parametersPerCall: mal.parametersPerCall,
		mal,
		node,
		unboundRatio: mal.unboundMs / node.unboundMs,
		numberRatio: mal.numberMs / node.numberMs,
		textRatio: mal.textMs / node.textMs,
		malNumberNsPerBind,
		nodeNumberNsPerBind,
		malTextNsPerBind,
		nodeTextNsPerBind,
		numberBindingRatio: malNumberNsPerBind / nodeNumberNsPerBind,
		textBindingRatio: malTextNsPerBind / nodeTextNsPerBind,
		collections: parseGcStat(stderr, "collections"),
		allocatedMb: parseGcStat(stderr, "allocated_bytes") / (1024 * 1024),
	};
}

// ---- inherited prototype cache (vs Node) ----------------------------------

function parsePrototypeCacheResult(
	stdout: string,
	command: string,
): PrototypeCacheFixtureMetrics {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw new Error(`invalid prototype-cache output from ${command}: ${stdout.trim()}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("iterations" in parsed) ||
		!("runtimeMs" in parsed) ||
		!("userlandDirectMs" in parsed) ||
		!("userlandDeepMs" in parsed) ||
		!("userlandFourLinkMs" in parsed) ||
		!("userlandEightLinkMs" in parsed) ||
		!("postMutationMs" in parsed)
	) {
		throw new Error(`incomplete prototype-cache output from ${command}`);
	}
	const metrics = parsed as PrototypeCacheFixtureMetrics;
	for (const [name, value] of Object.entries(metrics)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`invalid prototype-cache ${name} from ${command}: ${value}`);
		}
	}
	return metrics;
}

function runPrototypeCacheFixture(
	command: string,
	args: Array<string>,
	runs: number,
): PrototypeCacheFixtureMetrics {
	const results: Array<PrototypeCacheFixtureMetrics> = [];
	for (let run = 0; run < runs; run++) {
		const result = spawnSync(command, args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) {
			throw new Error(
				`prototype-cache command failed: ${command} ${args.join(" ")} (status ${result.status})\n${result.stderr ?? ""}`,
			);
		}
		results.push(
			parsePrototypeCacheResult(result.stdout ?? "", `${command} ${args.join(" ")}`),
		);
	}
	const first = results[0]!;
	return {
		iterations: first.iterations,
		measuredCalls: first.measuredCalls,
		runtimeMs: median(results.map((result) => result.runtimeMs)),
		userlandDirectMs: median(results.map((result) => result.userlandDirectMs)),
		userlandDeepMs: median(results.map((result) => result.userlandDeepMs)),
		userlandFourLinkMs: median(results.map((result) => result.userlandFourLinkMs)),
		userlandEightLinkMs: median(results.map((result) => result.userlandEightLinkMs)),
		postMutationMs: median(results.map((result) => result.postMutationMs)),
	};
}

function parsePerfIcStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((value) => value.includes("[perf-ic-stats]"));
	const match = line?.match(new RegExp(`${field}=([0-9]+)`));
	return match ? Number(match[1]) : 0;
}

function benchPrototypeCache(runs: number): PrototypeCacheMetrics {
	const fixture = "bench/prototype-cache.mjs";
	const binary = buildNativeBinary({
		fixture,
		name: "bench-prototype-cache",
	});
	const mal = runPrototypeCacheFixture(binary, [], runs);
	const node = runPrototypeCacheFixture("node", [fixture], runs);
	if (mal.iterations !== node.iterations) {
		throw new Error(
			"prototype-cache fixture metadata differs between Maligator and Node",
		);
	}

	const instrumented = buildNativeBinary({
		fixture,
		name: "bench-prototype-cache-stats",
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	});
	const stats = spawnSync(instrumented, [], {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (stats.status !== 0) {
		throw new Error(`instrumented prototype-cache run failed: ${stats.stderr ?? ""}`);
	}
	const stderr = stats.stderr ?? "";
	const instrumentedMetrics = parsePrototypeCacheResult(
		stats.stdout ?? "",
		`${instrumented} (instrumented)`,
	);
	const inheritedLoopIterationsElided = parsePerfIcStat(
		stderr,
		"inherited_loop_iterations_elided",
	);
	const expectedElided =
		instrumentedMetrics.measuredCalls * instrumentedMetrics.iterations;
	if (inheritedLoopIterationsElided !== expectedElided) {
		throw new Error(
			`prototype-cache summarized ${inheritedLoopIterationsElided} iterations, expected ${expectedElided}`,
		);
	}
	return {
		iterations: mal.iterations,
		mal,
		node,
		runtimeRatio: mal.runtimeMs / node.runtimeMs,
		userlandDirectRatio: mal.userlandDirectMs / node.userlandDirectMs,
		userlandDeepRatio: mal.userlandDeepMs / node.userlandDeepMs,
		userlandFourLinkRatio: mal.userlandFourLinkMs / node.userlandFourLinkMs,
		userlandEightLinkRatio: mal.userlandEightLinkMs / node.userlandEightLinkMs,
		postMutationRatio: mal.postMutationMs / node.postMutationMs,
		inheritedHits: parsePerfIcStat(stderr, "load_inherited_hits"),
		inheritedLoopSummaries: parsePerfIcStat(stderr, "inherited_loop_summaries"),
		inheritedLoopIterationsElided,
		inheritedFills: parsePerfIcStat(stderr, "inherited_fills"),
		inheritedRejectChain: parsePerfIcStat(stderr, "inherited_reject_chain"),
	};
}

// ---- gc -------------------------------------------------------------------

function parseGcMaxPause(stderr: string): number {
	return parseGcStat(stderr, "max_pause_ms");
}

/** macOS `/usr/bin/time -l` peak RSS (bytes). */
function parseMaxRss(stderr: string): number {
	const m = stderr.match(/([0-9]+)\s+maximum resident set size/);
	return m ? Number(m[1]) : 0;
}

function benchGc(runs: number): Record<string, GcWorkload> {
	const result: Record<string, GcWorkload> = {};
	const canRss = os.platform() === "darwin";
	// The generational collector differs at BUILD time (header layout + barrier
	// code), so build the gen binary with the collector selected.
	const prev = process.env.MAL_GC_GENERATIONAL;
	process.env.MAL_GC_GENERATIONAL = "1";
	try {
		for (const workload of ["cli", "desktop", "server"]) {
			const binary = buildNativeBinary({
				fixture: `bench/gc/${workload}.js`,
				name: `bench-gc-${workload}`,
			});
			const walls: Array<number> = [];
			const rsss: Array<number> = [];
			let maxPause = 0;
			for (let i = 0; i < runs; i++) {
				const start = process.hrtime.bigint();
				const r = canRss
					? spawnSync("/usr/bin/time", ["-l", binary], {
							env: { ...process.env, MAL_GC_STATS: "1" },
							encoding: "utf-8",
							stdio: ["ignore", "ignore", "pipe"],
						})
					: spawnSync(binary, [], {
							env: { ...process.env, MAL_GC_STATS: "1" },
							encoding: "utf-8",
							stdio: ["ignore", "ignore", "pipe"],
						});
				walls.push(Number(process.hrtime.bigint() - start) / 1e6);
				const stderr = r.stderr ?? "";
				rsss.push(parseMaxRss(stderr));
				maxPause = Math.max(maxPause, parseGcMaxPause(stderr));
			}
			result[workload] = {
				wallMs: median(walls),
				rssMb: median(rsss) / (1024 * 1024),
				maxPauseMs: maxPause,
			};
		}
	} finally {
		if (prev === undefined) delete process.env.MAL_GC_GENERATIONAL;
		else process.env.MAL_GC_GENERATIONAL = prev;
	}
	return result;
}

// ---- cross-benchmark string allocation profile ----------------------------

interface StringProfileTarget {
	name: string;
	fixture: string;
	compiled?: boolean;
	mainFile?: string;
	nodeEnabled?: boolean;
	buildEnvironment?: NodeJS.ProcessEnv;
}

function stringProfileRow(name: string, stderr: string): void {
	const strings = perfReportFields(stderr, "[perf-string-stats]");
	const allocations = perfReportFields(stderr, "[perf-string-allocation-stats]");
	const regexp = perfReportFields(stderr, "[perf-regexp-stats]");
	const total = allocations.allocations ?? 0;
	const short =
		(allocations.length_0 ?? 0) +
		(allocations.length_1 ?? 0) +
		(allocations.length_2_4 ?? 0);
	const copied =
		(allocations.copy_code_units ?? 0) +
		(allocations.ascii_code_units ?? 0) +
		(allocations.flatten_code_units ?? 0);
	const averageLength = total === 0 ? 0 : (allocations.code_units ?? 0) / total;
	const shortPercent = total === 0 ? 0 : (short * 100) / total;
	console.log(
		`  ${name.padEnd(22)} ${String(total).padStart(10)} alloc  ${shortPercent.toFixed(1).padStart(5)}% <=4  inline ${String(allocations.inline_allocations ?? 0).padStart(10)}  avg ${averageLength.toFixed(1).padStart(6)}u  copy ${String(copied).padStart(11)}u  dep ${String(allocations.dependent_allocations ?? 0).padStart(9)}  cons ${String(allocations.cons_allocations ?? 0).padStart(9)}  flat ${String(allocations.flatten_calls ?? 0).padStart(9)}  tiny ${String(allocations.tiny_cache_hits ?? 0).padStart(9)}h/${String(allocations.tiny_cache_misses ?? 0).padStart(6)}m/${String(allocations.tiny_cache_replacements ?? 0).padStart(6)}r  uint ${String(allocations.small_uint_cache_hits ?? 0).padStart(9)}h/${String(allocations.small_uint_cache_misses ?? 0).padStart(4)}m  scan ${String(strings.unit_scan_word_blocks ?? 0).padStart(9)}x4  case ${String(strings.case_calls ?? 0).padStart(8)} / ${String(strings.case_reuses ?? 0).padStart(8)} reuse  regexp ${String(regexp.exec_calls ?? 0).padStart(8)} / ${String(regexp.fast_exec_calls ?? 0).padStart(8)} fast`,
	);
}

function runStringProfileTarget(target: StringProfileTarget): void {
	const buildEnvironment = {
		...process.env,
		...target.buildEnvironment,
		MAL_PERF_STATS: "1",
	};
	const binary = buildNativeBinary({
		fixture: target.fixture,
		name: `bench-string-profile-${target.name}`,
		compiled: target.compiled,
		mainFile: target.mainFile,
		nodeEnabled: target.nodeEnabled,
		environment: buildEnvironment,
	});
	const result = spawnSync(binary, [], {
		env: buildEnvironment,
		encoding: "utf-8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(
			`string-profile target ${target.name} failed (status ${result.status}):\n${result.stderr ?? ""}`,
		);
	}
	stringProfileRow(target.name, result.stderr ?? "");
}

function benchStringProfile(): void {
	const targets: Array<StringProfileTarget> = [
		{ name: "language-compiled", fixture: "bench/language.js", compiled: true },
		{ name: "language-interpreted", fixture: "bench/language.js", compiled: false },
		{ name: "module", fixture: "bench/module-alloc.mjs" },
		{ name: "string", fixture: "bench/string.js" },
		{ name: "promise", fixture: "bench/promise.js" },
		{ name: "coroutine-compiled", fixture: "bench/coroutine.js", compiled: true },
		{
			name: "coroutine-interpreted",
			fixture: "bench/coroutine.js",
			compiled: false,
		},
		{ name: "arguments-compiled", fixture: "bench/arguments.js", compiled: true },
		{
			name: "arguments-interpreted",
			fixture: "bench/arguments.js",
			compiled: false,
		},
		{
			name: "stack-object-compiled",
			fixture: "bench/stack-object.js",
			compiled: true,
		},
		{
			name: "stack-object-interpreted",
			fixture: "bench/stack-object.js",
			compiled: false,
		},
		{
			name: "sqlite-binding",
			fixture: "bench/sqlite-binding.mjs",
			mainFile: HOST_MAIN,
			nodeEnabled: true,
		},
		{ name: "prototype-cache", fixture: "bench/prototype-cache.mjs" },
		{
			name: "gc-cli",
			fixture: "bench/gc/cli.js",
			buildEnvironment: { MAL_GC_GENERATIONAL: "1" },
		},
		{
			name: "gc-desktop",
			fixture: "bench/gc/desktop.js",
			buildEnvironment: { MAL_GC_GENERATIONAL: "1" },
		},
		{
			name: "gc-server",
			fixture: "bench/gc/server.js",
			buildEnvironment: { MAL_GC_GENERATIONAL: "1" },
		},
	];
	console.log("string-profile (one instrumented execution per runtime workload):");
	console.log(
		"  workload                    strings   short          inline   average       copied/dependent/cons/flatten activity           case calls / reuse              regexp exec / ASCII",
	);
	for (const target of targets) runStringProfileTarget(target);
}

// ---- http (vs Node) -------------------------------------------------------

function ohaAvailable(): boolean {
	return (
		spawnSync("oha", ["--version"], {
			env: { ...process.env, NO_COLOR: "false" },
			stdio: "ignore",
		}).status === 0
	);
}

/** Wait until `url` responds, or throw after ~5s. */
function waitReachable(url: string): void {
	for (let i = 0; i < 100; i++) {
		const r = spawnSync("curl", ["-s", "-o", "/dev/null", url]);
		if (r.status === 0) return;
		execFileSync("sleep", ["0.05"]);
	}
	throw new Error(`server never came up: ${url}`);
}

/** Run oha for `duration` at `conc`, returning req/s + p99 ms. */
function ohaRun(
	target: string,
	duration: string,
	conc: number,
	extraArgs: Array<string> = [],
): OhaMetrics {
	const out = execFileSync(
		"oha",
		[
			"-z",
			duration,
			"-c",
			String(conc),
			"--no-tui",
			"--output-format",
			"json",
			"--redirect",
			"0",
			...extraArgs,
			target,
		],
		{ encoding: "utf-8", env: { ...process.env, NO_COLOR: "false" } },
	);
	return parseOhaOutput(out);
}

function compareHttp(
	malTarget: string,
	nodeTarget: string,
	duration: string,
	conc: number,
	extraArgs: Array<string> = [],
): HttpComparisonMetrics {
	const mal = ohaRun(malTarget, duration, conc, extraArgs);
	const node = ohaRun(nodeTarget, duration, conc, extraArgs);
	return {
		malRps: mal.rps,
		nodeRps: node.rps,
		ratio: mal.rps / node.rps,
		malP99Ms: mal.p99Ms,
		nodeP99Ms: node.p99Ms,
	};
}

function workloadArgs(
	workload: Pick<ExpressHttpWorkload, "method" | "headers" | "body">,
): Array<string> {
	const args: Array<string> = [];
	if (workload.method) args.push("--method", workload.method);
	for (const header of workload.headers ?? []) args.push("-H", header);
	if (workload.body !== undefined) args.push("-d", workload.body);
	return args;
}

function benchHttp(durationSeconds: number, conc: number): HttpMetrics | null {
	if (!ohaAvailable()) {
		console.log("http: `oha` not installed — skipping (install oha for the http bench).");
		return null;
	}
	const malBin = buildNativeBinary({
		fixture: "bench/http/server_mal.js",
		name: "bench-http-mal",
		mainFile: HOST_MAIN,
	});
	const mal = spawn(malBin, [], { stdio: "ignore" });
	const node = spawn("node", ["bench/http/server_node.js"], { stdio: "ignore" });
	try {
		waitReachable("http://127.0.0.1:3111/");
		waitReachable("http://127.0.0.1:3112/");
		// Warm up both before measuring.
		ohaRun("http://127.0.0.1:3111/", "3s", 50);
		ohaRun("http://127.0.0.1:3112/", "3s", 50);
		const result: HttpMetrics = compareHttp(
			"http://127.0.0.1:3111/",
			"http://127.0.0.1:3112/",
			formatOhaDuration(durationSeconds),
			conc,
		);

		const expressBin = buildNativeBinary({
			fixture: "bench/http/express-server.cjs",
			name: "bench-http-express",
			mainFile: HOST_MAIN,
			nodeEnabled: true,
		});
		const expressMal = spawn(expressBin, [], {
			env: { ...process.env, PORT: "3113" },
			stdio: "ignore",
		});
		const expressNode = spawn("node", ["bench/http/express-server.cjs"], {
			env: { ...process.env, PORT: "3114" },
			stdio: "ignore",
		});
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "mal-bench-http-"));
		try {
			waitReachable("http://127.0.0.1:3113/middleware");
			waitReachable("http://127.0.0.1:3114/middleware");
			ohaRun("http://127.0.0.1:3113/middleware", "1s", conc);
			ohaRun("http://127.0.0.1:3114/middleware", "1s", conc);
			const workloads: Record<string, HttpComparisonMetrics> = {};
			for (const workload of planExpressHttpWorkload(durationSeconds)) {
				const malUrls = path.join(tempDir, `${workload.name}-mal.txt`);
				const nodeUrls = path.join(tempDir, `${workload.name}-node.txt`);
				writeFileSync(
					malUrls,
					`${workload.paths.map((value) => `http://127.0.0.1:3113${value}`).join("\n")}\n`,
				);
				writeFileSync(
					nodeUrls,
					`${workload.paths.map((value) => `http://127.0.0.1:3114${value}`).join("\n")}\n`,
				);
				workloads[workload.name] = compareHttp(
					malUrls,
					nodeUrls,
					formatOhaDuration(workload.durationSeconds),
					conc,
					["--urls-from-file", ...workloadArgs(workload)],
				);
			}
			result.express = { binaryBytes: fileBytes(expressBin), workloads };
		} finally {
			expressMal.kill("SIGKILL");
			expressNode.kill("SIGKILL");
			rmSync(tempDir, { recursive: true, force: true });
		}
		return result;
	} finally {
		mal.kill("SIGKILL");
		node.kill("SIGKILL");
	}
}

interface HttpProfileWorkload {
	name: "middleware" | ExpressHttpWorkload["name"];
	paths: Array<string>;
	method?: "POST";
	headers?: Array<string>;
	body?: string;
}

function perfReportFields(stderr: string, prefix: string): Record<string, number> {
	const line = stderr.split("\n").find((candidate) => candidate.startsWith(prefix));
	if (line === undefined) {
		throw new Error(`instrumented HTTP server omitted ${prefix}`);
	}
	const fields: Record<string, number> = {};
	for (const match of line.matchAll(/(?:^|\s)([a-z0-9_]+)=([0-9]+)/g)) {
		const name = match[1];
		const value = match[2];
		if (name !== undefined && value !== undefined) fields[name] = Number(value);
	}
	return fields;
}

function perfNativeCallRows(stderr: string): Array<{ name: string; calls: number }> {
	return stderr
		.split("\n")
		.flatMap((line) => {
			const match = line.match(/^\[perf-native-call\] name=(.*) calls=([0-9]+)$/);
			return match?.[1] !== undefined && match[2] !== undefined
				? [{ name: match[1], calls: Number(match[2]) }]
				: [];
		})
		.sort((left, right) => right.calls - left.calls);
}

function perfPerRequest(
	fields: Record<string, number>,
	name: string,
	requests: number,
): number {
	return (fields[name] ?? 0) / requests;
}

function waitForPerfReport(file: string): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const stderr = readFileSync(file, "utf-8");
		if (stderr.includes("[perf-ic-stats]")) return stderr;
		execFileSync("sleep", ["0.05"]);
	}
	throw new Error("instrumented HTTP server did not exit with a performance report");
}

function runProfileRequests(
	target: string,
	requests: number,
	conc: number,
	extraArgs: Array<string>,
): void {
	execFileSync(
		"oha",
		[
			"-n",
			String(requests),
			"-c",
			String(conc),
			"--no-tui",
			"--output-format",
			"json",
			"--redirect",
			"0",
			...extraArgs,
			target,
		],
		{ env: { ...process.env, NO_COLOR: "false" }, stdio: "ignore" },
	);
}

/** Exact-count Express attribution, intentionally separate from the saved throughput lane. */
function benchHttpProfile(requests: number, conc: number): void {
	if (!ohaAvailable()) {
		console.log("http-profile: `oha` not installed — skipping.");
		return;
	}
	if (!Number.isInteger(requests) || requests <= 0) {
		throw new Error(`--http-requests must be a positive integer, got ${requests}`);
	}

	const perfEnvironment = { ...process.env, MAL_PERF_STATS: "1" };
	const binary = buildNativeBinary({
		fixture: "bench/http/express-server.cjs",
		name: "bench-http-express-profile",
		mainFile: HOST_MAIN,
		nodeEnabled: true,
		environment: perfEnvironment,
	});
	const workloads: Array<HttpProfileWorkload> = [
		{ name: "middleware", paths: ["/middleware"] },
		...planExpressHttpWorkload(1),
	];
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "mal-bench-http-profile-"));
	console.log(`http-profile (${requests} measured requests per workload):`);
	try {
		for (let index = 0; index < workloads.length; index++) {
			const workload = workloads[index];
			if (workload === undefined)
				throw new Error(`missing HTTP profile workload ${index}`);
			const port = 3120 + index;
			const stderrFile = path.join(tempDir, `${workload.name}.stderr`);
			const stderrFd = openSync(stderrFile, "w");
			const server = spawn(binary, [], {
				env: {
					...perfEnvironment,
					MAL_BENCH_CONTROL: "1",
					MAL_PERF_CONTROL: "1",
					PORT: String(port),
				},
				stdio: ["ignore", "ignore", stderrFd],
			});
			try {
				const origin = `http://127.0.0.1:${port}`;
				waitReachable(`${origin}/middleware`);
				const urlsFile = path.join(tempDir, `${workload.name}.urls`);
				writeFileSync(
					urlsFile,
					`${workload.paths.map((value) => `${origin}${value}`).join("\n")}\n`,
				);
				const extraArgs = ["--urls-from-file", ...workloadArgs(workload)];
				runProfileRequests(urlsFile, Math.min(requests, 5_000), conc, extraArgs);
				execFileSync("curl", [
					"-s",
					"-o",
					"/dev/null",
					"-X",
					"POST",
					`${origin}/__maligator_perf_reset`,
				]);
				runProfileRequests(urlsFile, requests, conc, extraArgs);
				execFileSync("curl", [
					"-s",
					"-o",
					"/dev/null",
					"-X",
					"POST",
					`${origin}/__maligator_bench_exit`,
				]);
				const stderr = waitForPerfReport(stderrFile);
				const strings = perfReportFields(stderr, "[perf-string-stats]");
				const stringAllocations = perfReportFields(
					stderr,
					"[perf-string-allocation-stats]",
				);
				const regexp = perfReportFields(stderr, "[perf-regexp-stats]");
				const properties = perfReportFields(stderr, "[perf-property-stats]");
				const transitions = perfReportFields(stderr, "[perf-shape-transition-stats]");
				const calls = perfReportFields(stderr, "[perf-call-cache-stats]");
				const ic = perfReportFields(stderr, "[perf-ic-stats]");
				const modes = perfReportFields(stderr, "[perf-ic-mode-stats]");
				const dependencies = perfReportFields(
					stderr,
					"[perf-prototype-dependency-stats]",
				);
				console.log(`  ${workload.name}:`);
				console.log(
					`    keys/request        ${perfPerRequest(strings, "key_equals_calls", requests).toFixed(1)} comparisons, ${perfPerRequest(strings, "key_string_fallbacks", requests).toFixed(1)} string fallbacks, ${perfPerRequest(strings, "string_memcmp_calls", requests).toFixed(1)} memcmp`,
				);
				console.log(
					`    properties/request  ${perfPerRequest(properties, "ensure_inserts", requests).toFixed(1)} inserts, ${perfPerRequest(properties, "ensure_hits", requests).toFixed(1)} ensure hits`,
				);
				console.log(
					`    transitions/request ${perfPerRequest(transitions, "calls", requests).toFixed(1)} calls, ${perfPerRequest(transitions, "creates", requests).toFixed(1)} creates, ${perfPerRequest(transitions, "comparisons", requests).toFixed(1)} comparisons`,
				);
				console.log(
					`    loads/request       ${perfPerRequest(ic, "load_mono_hits", requests).toFixed(1)} mono, ${perfPerRequest(ic, "load_inherited_hits", requests).toFixed(1)} inherited, ${perfPerRequest(ic, "load_missing_hits", requests).toFixed(1)} missing, ${perfPerRequest(ic, "load_mega_hits", requests).toFixed(1)} mega, ${perfPerRequest(ic, "load_fallbacks", requests).toFixed(1)} fallback`,
				);
				console.log(
					`    load outcomes       ${perfPerRequest(ic, "load_slow_mono_hits", requests).toFixed(1)} slow mono, ${perfPerRequest(ic, "load_shape_fills", requests).toFixed(1)} shape fills, ${perfPerRequest(ic, "inherited_fills", requests).toFixed(1)} inherited fills, ${perfPerRequest(ic, "load_missing_fills", requests).toFixed(1)} missing fills, ${perfPerRequest(ic, "load_plain_generic", requests).toFixed(1)} plain generic`,
				);
				console.log(
					`    stores/request      ${perfPerRequest(ic, "store_mono_hits", requests).toFixed(1)} mono, ${perfPerRequest(ic, "store_poly_hits", requests).toFixed(1)} poly, ${perfPerRequest(ic, "store_mega_hits", requests).toFixed(1)} mega, ${perfPerRequest(ic, "store_transition_hits", requests).toFixed(1)} transition hits, ${perfPerRequest(ic, "store_transition_fills", requests).toFixed(1)} transition fills, ${perfPerRequest(ic, "store_plain_generic", requests).toFixed(1)} generic`,
				);
				console.log(
					`    IC replacements     ${perfPerRequest(modes, "replacements", requests).toFixed(1)} total, ${perfPerRequest(modes, "cross_mode", requests).toFixed(1)} cross-mode, ${perfPerRequest(modes, "chain_to_own", requests).toFixed(1)} chain→own, ${perfPerRequest(modes, "transition_to_shape", requests).toFixed(1)} transition→shape`,
				);
				console.log(
					`    proto dependencies  ${perfPerRequest(dependencies, "register_calls", requests).toFixed(1)} registrations, ${perfPerRequest(dependencies, "register_nodes", requests).toFixed(1)} nodes, ${perfPerRequest(dependencies, "unregister_scan_steps", requests).toFixed(1)} unregister scans`,
				);
				console.log(
					`    calls/request       ${perfPerRequest(calls, "probes", requests).toFixed(1)} probes, ${perfPerRequest(calls, "compiled_exact_hits", requests).toFixed(1)} compiled exact, ${perfPerRequest(calls, "compiled_family_hits", requests).toFixed(1)} compiled family, ${perfPerRequest(calls, "native_exact_hits", requests).toFixed(1)} native, ${perfPerRequest(calls, "way_checks", requests).toFixed(1)} way checks, ${perfPerRequest(calls, "dispatch_misses", requests).toFixed(1)} misses, ${perfPerRequest(calls, "compiled_debug_frames", requests).toFixed(1)} debug frames; prototype invalidations ${ic.prototype_epoch_invalidations ?? 0}`,
				);
				console.log(
					`    direct charCodeAt   ${perfPerRequest(strings, "char_code_at_direct_hits", requests).toFixed(1)} hits, ${perfPerRequest(strings, "char_code_at_direct_fallbacks", requests).toFixed(1)} fallbacks/request`,
				);
				console.log(
					`    string unit scan    ${perfPerRequest(strings, "unit_scan_word_blocks", requests).toFixed(1)} word blocks, ${perfPerRequest(strings, "unit_scan_candidate_blocks", requests).toFixed(1)} candidate blocks, ${perfPerRequest(strings, "unit_scan_scalar_code_units", requests).toFixed(1)} scalar tail units/request`,
				);
				console.log(
					`    strings/request     ${perfPerRequest(stringAllocations, "allocations", requests).toFixed(1)} allocations, ${perfPerRequest(stringAllocations, "code_units", requests).toFixed(1)} logical units, ${perfPerRequest(stringAllocations, "copy_code_units", requests).toFixed(1)} copied, ${perfPerRequest(stringAllocations, "ascii_code_units", requests).toFixed(1)} widened`,
				);
				console.log(
					`    tiny concat cache   ${perfPerRequest(stringAllocations, "tiny_cache_hits", requests).toFixed(1)} hits, ${perfPerRequest(stringAllocations, "tiny_cache_misses", requests).toFixed(1)} misses, ${perfPerRequest(stringAllocations, "tiny_cache_replacements", requests).toFixed(1)} replacements, ${perfPerRequest(stringAllocations, "tiny_cache_promotions", requests).toFixed(1)} atom promotions/request`,
				);
				console.log(
					`    small uint cache    ${perfPerRequest(stringAllocations, "small_uint_cache_hits", requests).toFixed(1)} hits, ${perfPerRequest(stringAllocations, "small_uint_cache_misses", requests).toFixed(1)} misses/request`,
				);
				console.log(
					`    case/request        ${perfPerRequest(strings, "case_calls", requests).toFixed(1)} calls, ${perfPerRequest(strings, "case_reuses", requests).toFixed(1)} reused, ${perfPerRequest(strings, "case_changed_allocations", requests).toFixed(1)} changed allocations`,
				);
				console.log(
					`    regexp/request      ${perfPerRequest(regexp, "exec_calls", requests).toFixed(1)} exec, ${perfPerRequest(regexp, "fast_exec_calls", requests).toFixed(1)} fast, ${perfPerRequest(regexp, "ascii_exec_calls", requests).toFixed(1)} ASCII, ${perfPerRequest(regexp, "ascii_cache_hits", requests).toFixed(1)} ASCII cache hits`,
				);
				console.log(
					`    string storage      ${perfPerRequest(stringAllocations, "inline_allocations", requests).toFixed(1)} inline, ${perfPerRequest(stringAllocations, "dependent_allocations", requests).toFixed(1)} dependent, ${perfPerRequest(stringAllocations, "cons_allocations", requests).toFixed(1)} cons, ${perfPerRequest(stringAllocations, "flatten_calls", requests).toFixed(1)} flatten calls/request`,
				);
				console.log(
					`    native call leaders ${perfNativeCallRows(stderr)
						.slice(0, 8)
						.map((row) => `${(row.calls / requests).toFixed(1)} ${row.name}`)
						.join(", ")}`,
				);
			} finally {
				if (server.exitCode === null) server.kill("SIGKILL");
				closeSync(stderrFd);
			}
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

// ---- baseline reporting ---------------------------------------------------

function humanBytes(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(2)}MB`
		: `${(bytes / 1024).toFixed(1)}KB`;
}

function delta(
	current: number,
	previous: number | undefined,
	lowerIsBetter = true,
): string {
	if (previous === undefined || previous === 0) return "";
	const pct = ((current - previous) / previous) * 100;
	const sign = pct >= 0 ? "+" : "";
	const better = lowerIsBetter ? pct < 0 : pct > 0;
	const mark = Math.abs(pct) < 0.5 ? "  " : better ? " ↓" : " ↑";
	return ` (${sign}${pct.toFixed(1)}% vs ${previous.toFixed(0)}${mark})`;
}

function report(entry: BenchmarkSnapshot, previous: BenchmarkSnapshot | undefined): void {
	const phaseTime = (ms: number): string =>
		ms < 0.1 ? `${(ms * 1000).toFixed(3)}us` : `${ms.toFixed(1)}ms`;
	const phaseRatio = (ratio: number): string =>
		ratio < 0.01 ? ratio.toFixed(6) : ratio.toFixed(2);
	console.log("\n=== benchmark run ===");
	if (entry.size) {
		console.log("size (per build-config profile):");
		for (const [name, m] of Object.entries(entry.size)) {
			// Diff against the same profile in the saved snapshot (undefined the first
			// run after the metric reshaped, which just shows no delta).
			const p = previous?.size?.[name];
			console.log(`  ${name}`);
			console.log(
				`    binary   ${humanBytes(m.binaryBytes)}${delta(m.binaryBytes, p?.binaryBytes)}`,
			);
			console.log(
				`    runtime  ${humanBytes(m.runtimeArchiveBytes)}${delta(m.runtimeArchiveBytes, p?.runtimeArchiveBytes)}`,
			);
			console.log(
				`    host     ${humanBytes(m.hostArchiveBytes)}${delta(m.hostArchiveBytes, p?.hostArchiveBytes)}`,
			);
			console.log(
				`    engine   ${humanBytes(m.engineArchiveBytes)}${delta(m.engineArchiveBytes, p?.engineArchiveBytes)}`,
			);
			console.log(
				`    rust     ${humanBytes(m.rustArchiveBytes)}${delta(m.rustArchiveBytes, p?.rustArchiveBytes)}`,
			);
		}
	}
	if (entry.language) {
		const p = previous?.language;
		console.log("language (vs V8):");
		console.log(
			`  maligator ${entry.language.malMs.toFixed(1)}ms${delta(entry.language.malMs, p?.malMs)}`,
		);
		console.log(`  node      ${entry.language.nodeMs.toFixed(1)}ms`);
		console.log(
			`  ratio     ${entry.language.ratio.toFixed(2)}x${delta(entry.language.ratio, p?.ratio)}`,
		);
		console.log(
			`  managed   ${entry.language.collections} collections, ${entry.language.allocatedMb.toFixed(1)}MB allocated${delta(entry.language.allocatedMb, p?.allocatedMb)}`,
		);
		console.log(
			`  objects   ${entry.language.emptyObjects} empty, ${entry.language.shapedObjects} shaped, ${entry.language.stackObjects} stack, ${entry.language.stackMaterializations} materialized`,
		);
		console.log(
			`  calls     ${entry.language.callProbes} cache probes, ${entry.language.callMisses} misses`,
		);
		console.log(
			`  loads     ${entry.language.loadMonoHits} mono, ${entry.language.loadRegionHits} region, ${entry.language.loadInheritedHits} inherited, ${entry.language.loadWatchedHits} watched, ${entry.language.loadMegaHits} mega hits/${entry.language.loadMegaMisses} misses, ${entry.language.loadFallbacks} fallback`,
		);
		console.log(
			`  stores    ${entry.language.storeMonoHits} mono, ${entry.language.storeRegionHits} region, ${entry.language.storeMegaHits} mega hits/${entry.language.storeMegaMisses} misses, ${entry.language.storeTransitionHits} transition hits, ${entry.language.storeTransitionFills} transition fills, ${entry.language.storeFallbacks} fallback`,
		);
	}
	if (entry.module) {
		const p = previous?.module;
		console.log("module (const-helper allocation; vs V8):");
		console.log(
			`  maligator ${entry.module.malMs.toFixed(1)}ms${delta(entry.module.malMs, p?.malMs)}`,
		);
		console.log(`  node      ${entry.module.nodeMs.toFixed(1)}ms`);
		console.log(
			`  ratio     ${entry.module.ratio.toFixed(2)}x${delta(entry.module.ratio, p?.ratio)}`,
		);
		// Primary signal: 0 = every transient scalar-replaced. Nonzero is a
		// regression in const-bound-callee inlining, so flag it rather than rely on
		// a percent delta off a zero baseline.
		const regressed = entry.module.collections > 0 ? " ↑ REGRESSED" : "";
		console.log(
			`  gc        ${entry.module.collections} collections${regressed}, ${entry.module.peakLiveKb.toFixed(1)}KB peak live`,
		);
	}
	if (entry.compiler) {
		const p = previous?.compiler;
		console.log("compiler (Node-hosted front end):");
		console.log(
			`  wall      ${entry.compiler.wallMs.toFixed(1)}ms${delta(entry.compiler.wallMs, p?.wallMs)}`,
		);
		console.log(
			`  corpus    ${entry.compiler.functionCount} functions, ${humanBytes(entry.compiler.sourceBytes)} source`,
		);
		console.log(
			`  wire      ${humanBytes(entry.compiler.wireBytes)}${delta(entry.compiler.wireBytes, p?.wireBytes)}`,
		);
	}
	if (entry.selfCompile) {
		const p = previous?.selfCompile;
		console.log("self-compile to C (fresh process; Node is reference):");
		console.log(
			`  maligator ${entry.selfCompile.maligatorMs.toFixed(1)}ms${delta(entry.selfCompile.maligatorMs, p?.maligatorMs)}`,
		);
		console.log(`  node      ${entry.selfCompile.nodeMs.toFixed(1)}ms`);
		console.log(
			`  front end maligator graph ${entry.selfCompile.maligatorPhases.graphMs.toFixed(0)}ms, semantic ${entry.selfCompile.maligatorPhases.semanticMs.toFixed(0)}ms, IR ${entry.selfCompile.maligatorPhases.compileToIrMs.toFixed(0)}ms`,
		);
		console.log(
			`            node      graph ${entry.selfCompile.nodePhases.graphMs.toFixed(0)}ms, semantic ${entry.selfCompile.nodePhases.semanticMs.toFixed(0)}ms, IR ${entry.selfCompile.nodePhases.compileToIrMs.toFixed(0)}ms`,
		);
		console.log(
			`  back end  maligator optimize ${entry.selfCompile.maligatorPhases.optimizeMs.toFixed(0)}ms, regalloc ${entry.selfCompile.maligatorPhases.regallocMs.toFixed(0)}ms, lower ${entry.selfCompile.maligatorPhases.lowerMs.toFixed(0)}ms, emit ${entry.selfCompile.maligatorPhases.emitMs.toFixed(0)}ms, write ${entry.selfCompile.maligatorPhases.writeMs.toFixed(0)}ms`,
		);
		console.log(
			`            node      optimize ${entry.selfCompile.nodePhases.optimizeMs.toFixed(0)}ms, regalloc ${entry.selfCompile.nodePhases.regallocMs.toFixed(0)}ms, lower ${entry.selfCompile.nodePhases.lowerMs.toFixed(0)}ms, emit ${entry.selfCompile.nodePhases.emitMs.toFixed(0)}ms, write ${entry.selfCompile.nodePhases.writeMs.toFixed(0)}ms`,
		);
		console.log(`  output    ${entry.selfCompile.units} units`);
		console.log(
			`  C bytes   ${humanBytes(entry.selfCompile.maligatorCodeUnits)} Maligator, ${humanBytes(entry.selfCompile.nodeCodeUnits)} Node`,
		);
		console.log(
			`  context   median of ${entry.selfCompile.runs}, ${entry.selfCompile.platform}-${entry.selfCompile.arch}, ${entry.selfCompile.nodeVersion}`,
		);
	}
	if (entry.string) {
		const p = previous?.string;
		console.log("string (String + RegExp; vs V8):");
		console.log(
			`  maligator ${entry.string.malMs.toFixed(1)}ms${delta(entry.string.malMs, p?.malMs)}`,
		);
		console.log(`  node      ${entry.string.nodeMs.toFixed(1)}ms`);
		console.log(
			`  ratio     ${entry.string.ratio.toFixed(2)}x${delta(entry.string.ratio, p?.ratio)}`,
		);
		console.log(
			`  gc        ${entry.string.collections} collections, ${entry.string.allocatedMb.toFixed(1)}MB allocated${delta(entry.string.allocatedMb, p?.allocatedMb)}, ${entry.string.peakLiveKb.toFixed(1)}KB peak live`,
		);
		console.log(
			`  arrays    ${entry.string.freshDenseStores} fresh dense stores, ${entry.string.freshDenseGrowths} growths, ${entry.string.freshDenseFallbacks} fallbacks`,
		);
		console.log(
			`  reserve   ${entry.string.freshDenseExactReserves} exact reserves, ${entry.string.freshDenseReservedSlots} slots, ${entry.string.freshDenseGrowthsAvoided} growths avoided`,
		);
		console.log(
			`  search    ${entry.string.searchCalls} calls, ${entry.string.searchMultiUnitCalls} multi-unit, ${entry.string.searchCandidates} candidates`,
		);
		console.log(
			`  filter    ${entry.string.searchFirstUnitRejects} first-unit rejects, ${entry.string.searchLastUnitRejects} last-unit rejects, ${entry.string.searchMemcmpCalls} interior compares (${entry.string.searchMemcmpCodeUnits} code units)`,
		);
		console.log(
			`  reverse   ${entry.string.reverseSearchCalls} calls, ${entry.string.reverseSearchCandidates} candidates, ${entry.string.reverseSearchFirstUnitRejects} first-unit rejects, ${entry.string.reverseSearchLastUnitRejects} last-unit rejects`,
		);
		console.log(
			`            ${entry.string.reverseSearchMemcmpCalls} interior compares (${entry.string.reverseSearchMemcmpCodeUnits} code units)`,
		);
		console.log(
			`  unit scan ${entry.string.unitScanWordBlocks} word blocks (${entry.string.unitScanCandidateBlocks} candidates), ${entry.string.unitScanScalarCodeUnits} scalar tail units`,
		);
		console.log(
			`  split     ${entry.string.splitPlannedMatches} planned matches, ${entry.string.splitPlanOverflows} overflow fallbacks`,
		);
		console.log(
			`  case      ${entry.string.caseCalls} calls over ${entry.string.caseInputCodeUnits} code units, ${entry.string.caseReuses} reused, ${entry.string.caseChangedAllocations} changed allocations`,
		);
		console.log(
			`  regexp    ${entry.string.regexpExecCalls} execs: ${entry.string.regexpFastExecCalls} fast, ${entry.string.regexpAsciiExecCalls} ASCII (${entry.string.regexpAsciiCacheHits} cache hits, ${entry.string.regexpAsciiCacheFills} fills), ${entry.string.regexpUtf16ExecCalls} UTF-16`,
		);
		console.log(
			`  strings   ${entry.string.stringAllocations} allocations: ${entry.string.inlineStringAllocations} inline, ${entry.string.dependentStringAllocations} dependent, ${entry.string.consStringAllocations} cons; ${entry.string.stringFlattenCalls} flatten calls`,
		);
	}
	if (entry.promise) {
		const p = previous?.promise;
		console.log("promise (Promise + microtasks; vs V8):");
		console.log(
			`  maligator ${entry.promise.malMs.toFixed(1)}ms${delta(entry.promise.malMs, p?.malMs)}`,
		);
		console.log(`  node      ${entry.promise.nodeMs.toFixed(1)}ms`);
		console.log(
			`  ratio     ${entry.promise.ratio.toFixed(2)}x${delta(entry.promise.ratio, p?.ratio)}`,
		);
		console.log(
			`  managed   ${entry.promise.collections} collections, ${entry.promise.allocatedMb.toFixed(1)}MB allocated${delta(entry.promise.allocatedMb, p?.allocatedMb)}`,
		);
		console.log(
			`  native    ${entry.promise.jobAllocations} fresh job slots${delta(entry.promise.jobAllocations, p?.jobAllocations)}, ${entry.promise.jobReuses} reused`,
		);
		console.log(
			`            ${entry.promise.reactionAllocations} reaction allocations${delta(entry.promise.reactionAllocations, p?.reactionAllocations)}, ${entry.promise.reactionReuses} reused`,
		);
		console.log(
			`  job slab  ${entry.promise.jobSlabBlockAllocations} blocks allocated, ${entry.promise.jobSlabBlockFrees} freed, ${humanBytes(entry.promise.jobSlabPeakRetainedBytes)} peak retained`,
		);
		console.log(
			`            ${entry.promise.jobSlabFreshSlots} fresh slots, ${entry.promise.jobSlabHits} slab hits`,
		);
		console.log(
			`  direct    ${entry.promise.directCapabilities} capabilities${delta(entry.promise.directCapabilities, p?.directCapabilities)}, ${entry.promise.materializedFallbackPairs} fallback pairs materialized${delta(entry.promise.materializedFallbackPairs, p?.materializedFallbackPairs)}`,
		);
		console.log(
			`  adoption  ${entry.promise.nativeAdoptionHits} canonical hits, ${entry.promise.nativeAdoptionGuardFallbacks} guarded fallbacks`,
		);
		console.log(
			`  kernel    ${entry.promise.intrinsicSpeciesHits} intrinsic species hits${delta(entry.promise.intrinsicSpeciesHits, p?.intrinsicSpeciesHits)}, ${entry.promise.discardedDependentRegistrations} discarded dependent registrations${delta(entry.promise.discardedDependentRegistrations, p?.discardedDependentRegistrations)}`,
		);
		console.log(`            ${entry.promise.guardedFallbacks} guarded fallbacks`);
		console.log(
			`  resolving ${entry.promise.resolvingPairs} callback pairs${delta(entry.promise.resolvingPairs, p?.resolvingPairs)}, ${entry.promise.directAsyncGeneratorRequests} direct async-generator requests${delta(entry.promise.directAsyncGeneratorRequests, p?.directAsyncGeneratorRequests)}`,
		);
		console.log(
			`            ${entry.promise.directIntrinsicCreations} intrinsic creations${delta(entry.promise.directIntrinsicCreations, p?.directIntrinsicCreations)}, ${entry.promise.directAsyncResults} async results${delta(entry.promise.directAsyncResults, p?.directAsyncResults)}`,
		);
		console.log(
			`  await     ${entry.promise.typedAwaitContinuations} typed continuations, ${entry.promise.typedAwaitJobs} typed jobs`,
		);
	}
	if (entry.coroutine) {
		const p = previous?.coroutine;
		console.log("coroutine (suspendable frames; vs V8):");
		for (const name of ["compiled", "interpreted"] as const) {
			const current = entry.coroutine[name];
			const prior = p?.[name];
			console.log(
				`  ${name.padEnd(11)} ${current.wallMs.toFixed(1)}ms${delta(current.wallMs, prior?.wallMs)}  ${current.frameAllocations} allocations${delta(current.frameAllocations, prior?.frameAllocations)}, ${current.frameReuses} reused`,
			);
			console.log(
				`               ${current.collections} collections, ${current.allocatedMb.toFixed(1)}MB managed`,
			);
			console.log(
				`               ${current.requestAllocations} request allocations${delta(current.requestAllocations, prior?.requestAllocations)}, ${current.requestReuses} reused`,
			);
			console.log(
				`               ${current.frameRequests} requested, ${current.frameReleases} released, ${current.framePooled} pooled, ${current.frameDropped} dropped, ${humanBytes(current.framePeakRetainedBytes)} peak retained`,
			);
			console.log(
				`               ${current.frameReleaseClearSlots} release clear slots, ${current.frameAllocationInitSlots} allocation init slots`,
			);
		}
		console.log(`  node        ${entry.coroutine.nodeMs.toFixed(1)}ms`);
	}
	if (entry.arguments) {
		const p = previous?.arguments;
		console.log("arguments (direct frame reads; vs V8):");
		for (const name of ["compiled", "interpreted"] as const) {
			const current = entry.arguments[name];
			const prior = p?.[name];
			console.log(
				`  ${name.padEnd(11)} ${current.wallMs.toFixed(1)}ms${delta(current.wallMs, prior?.wallMs)}  ${current.collections} collections, ${current.allocatedMb.toFixed(1)}MB managed${delta(current.allocatedMb, prior?.allocatedMb)}`,
			);
			console.log(
				`               ${current.frameAllocations} frame allocations${delta(current.frameAllocations, prior?.frameAllocations)}, ${current.frameReuses} reused`,
			);
			console.log(
				`               ${current.frameRequests} requested, ${current.frameReleases} released, ${current.framePooled} pooled, ${current.frameDropped} dropped, ${humanBytes(current.framePeakRetainedBytes)} peak retained`,
			);
			console.log(
				`               ${current.frameReleaseClearSlots} release clear slots, ${current.frameAllocationInitSlots} allocation init slots`,
			);
			console.log(
				`               ${current.instructionCount} instructions, ${humanBytes(current.bytecodeBytes)} bytecode, ${humanBytes(current.binaryBytes)} binary`,
			);
			console.log(
				`               ${current.snapshotLogicalValues} logical snapshots, ${current.snapshotDestinationWrites} destination writes, ${current.snapshotTemporaryCopies} temporary copies`,
			);
		}
		console.log(`  node        ${entry.arguments.nodeMs.toFixed(1)}ms`);
	}
	if (entry.stackObject) {
		const p = previous?.stackObject;
		console.log("stack-object (residual shaped objects; vs V8):");
		for (const name of ["compiled", "interpreted"] as const) {
			const current = entry.stackObject[name];
			const prior = p?.[name];
			console.log(
				`  ${name.padEnd(11)} ${current.wallMs.toFixed(1)}ms${delta(current.wallMs, prior?.wallMs)}  ${current.collections} collections, ${current.allocatedMb.toFixed(1)}MB managed${delta(current.allocatedMb, prior?.allocatedMb)}`,
			);
			console.log(
				`               ${current.peakLiveKb.toFixed(1)}KB peak live, ${current.maxPauseMs.toFixed(2)}ms max pause`,
			);
			console.log(
				`               ${current.instructionCount} instructions, ${humanBytes(current.bytecodeBytes)} bytecode, ${humanBytes(current.binaryBytes)} binary`,
			);
			console.log(
				`               ${current.objectSlotCoallocations} coallocated slots, ${current.objectSlotGrowMigrations} grow migrations, ${current.objectSlotDictionaryMigrations} dictionary migrations`,
			);
			console.log(
				`               ${current.stackObjectMaterializations} stack-object return materializations${delta(current.stackObjectMaterializations, prior?.stackObjectMaterializations)}`,
			);
		}
		console.log(
			`  node        ${entry.stackObject.nodeMs.toFixed(1)}ms  checksum ${entry.stackObject.checksum}`,
		);
	}
	if (entry.interpreter) {
		const p = previous?.interpreter;
		console.log("interpreter (language bytecode; vs V8):");
		console.log(
			`  maligator ${entry.interpreter.malMs.toFixed(1)}ms${delta(entry.interpreter.malMs, p?.malMs)}  rss ${entry.interpreter.rssMb.toFixed(1)}MB`,
		);
		console.log(`  node      ${entry.interpreter.nodeMs.toFixed(1)}ms`);
		console.log(
			`  ratio     ${entry.interpreter.ratio.toFixed(2)}x${delta(entry.interpreter.ratio, p?.ratio)}`,
		);
		console.log(
			`  dispatch  ${entry.interpreter.directLeafExecutions} direct leaves, ${entry.interpreter.boundaryDispatches} helper boundaries`,
		);
		console.log(
			`            ${entry.interpreter.stateSyncs} state syncs, ${entry.interpreter.stateReloads} state reloads`,
		);
		console.log(
			`            ${entry.interpreter.normalHelperContinuations} normal helpers continued locally`,
		);
		console.log(
			`            ${entry.interpreter.strictDirectHits} direct strict hits, ${entry.interpreter.strictStringFallbacks} string fallbacks`,
		);
		console.log(
			`            ${entry.interpreter.localLoadIcHits} local load IC hits, ${entry.interpreter.localStoreIcHits} local store IC hits`,
		);
		console.log(
			`            ${entry.interpreter.loadIcSyncFallbacks} synchronized load fallbacks, ${entry.interpreter.storeIcSyncFallbacks} synchronized store fallbacks`,
		);
		console.log(
			`  bytecode  ${entry.interpreter.instructionCount} instructions x ${entry.interpreter.instructionSize}B = ${humanBytes(entry.interpreter.instructionBytes)}${delta(entry.interpreter.instructionBytes, p?.instructionBytes)}`,
		);
		if (entry.interpreter.bytecodeBytes !== undefined) {
			const previousBytes = p?.bytecodeBytes ?? p?.instructionBytes;
			console.log(
				`            ${humanBytes(entry.interpreter.instructionDataBytes ?? 0)} side data, ${humanBytes(entry.interpreter.bytecodeBytes)} total${delta(entry.interpreter.bytecodeBytes, previousBytes)}`,
			);
		}
	}
	if (entry.sqliteBinding) {
		const current = entry.sqliteBinding;
		const prior = previous?.sqliteBinding;
		console.log("sqlite-binding (StatementSync.run; vs Node):");
		console.log(
			`  unbound   maligator ${current.mal.unboundMs.toFixed(1)}ms${delta(current.mal.unboundMs, prior?.mal.unboundMs)}  node ${current.node.unboundMs.toFixed(1)}ms  ratio ${current.unboundRatio.toFixed(2)}x`,
		);
		console.log(
			`  numbers   maligator ${current.mal.numberMs.toFixed(1)}ms${delta(current.mal.numberMs, prior?.mal.numberMs)}  node ${current.node.numberMs.toFixed(1)}ms  ratio ${current.numberRatio.toFixed(2)}x`,
		);
		console.log(
			`            incremental ${current.malNumberNsPerBind.toFixed(1)}ns/bind${delta(current.malNumberNsPerBind, prior?.malNumberNsPerBind)} vs Node ${current.nodeNumberNsPerBind.toFixed(1)}ns/bind  ratio ${current.numberBindingRatio.toFixed(2)}x`,
		);
		console.log(
			`  text      maligator ${current.mal.textMs.toFixed(1)}ms${delta(current.mal.textMs, prior?.mal.textMs)}  node ${current.node.textMs.toFixed(1)}ms  ratio ${current.textRatio.toFixed(2)}x`,
		);
		console.log(
			`            incremental ${current.malTextNsPerBind.toFixed(1)}ns/bind${delta(current.malTextNsPerBind, prior?.malTextNsPerBind)} vs Node ${current.nodeTextNsPerBind.toFixed(1)}ns/bind  ratio ${current.textBindingRatio.toFixed(2)}x`,
		);
		console.log(
			`  managed   ${current.collections} collections, ${current.allocatedMb.toFixed(1)}MB allocated${delta(current.allocatedMb, prior?.allocatedMb)}`,
		);
	}
	if (entry.prototypeCache) {
		const current = entry.prototypeCache;
		const prior = previous?.prototypeCache;
		console.log("prototype-cache (inherited method loads; vs Node):");
		console.log(
			`  runtime   maligator ${phaseTime(current.mal.runtimeMs)}${delta(current.mal.runtimeMs, prior?.mal.runtimeMs)}  node ${phaseTime(current.node.runtimeMs)}  ratio ${phaseRatio(current.runtimeRatio)}x`,
		);
		console.log(
			`  user 1x   maligator ${phaseTime(current.mal.userlandDirectMs)}${delta(current.mal.userlandDirectMs, prior?.mal.userlandDirectMs)}  node ${phaseTime(current.node.userlandDirectMs)}  ratio ${phaseRatio(current.userlandDirectRatio)}x`,
		);
		console.log(
			`  user 2x   maligator ${phaseTime(current.mal.userlandDeepMs)}${delta(current.mal.userlandDeepMs, prior?.mal.userlandDeepMs)}  node ${phaseTime(current.node.userlandDeepMs)}  ratio ${phaseRatio(current.userlandDeepRatio)}x`,
		);
		console.log(
			`  user 4x   maligator ${phaseTime(current.mal.userlandFourLinkMs)}${delta(current.mal.userlandFourLinkMs, prior?.mal.userlandFourLinkMs)}  node ${phaseTime(current.node.userlandFourLinkMs)}  ratio ${phaseRatio(current.userlandFourLinkRatio)}x`,
		);
		console.log(
			`  user 8x   maligator ${phaseTime(current.mal.userlandEightLinkMs)}${delta(current.mal.userlandEightLinkMs, prior?.mal.userlandEightLinkMs)}  node ${phaseTime(current.node.userlandEightLinkMs)}  ratio ${phaseRatio(current.userlandEightLinkRatio)}x`,
		);
		console.log(
			`  mutated   maligator ${phaseTime(current.mal.postMutationMs)}${delta(current.mal.postMutationMs, prior?.mal.postMutationMs)}  node ${phaseTime(current.node.postMutationMs)}  ratio ${phaseRatio(current.postMutationRatio)}x`,
		);
		console.log(
			`  IC        ${current.inheritedHits} inherited hits, ${current.inheritedLoopSummaries} loop summaries / ${current.inheritedLoopIterationsElided} iterations elided, ${current.inheritedFills} fills, ${current.inheritedRejectChain} chain rejects`,
		);
	}
	if (entry.gc) {
		console.log("gc (generational):");
		for (const [name, w] of Object.entries(entry.gc)) {
			const p = previous?.gc?.[name];
			console.log(
				`  ${name.padEnd(8)} wall ${w.wallMs.toFixed(1)}ms${delta(w.wallMs, p?.wallMs)}  rss ${w.rssMb.toFixed(1)}MB  maxPause ${w.maxPauseMs.toFixed(2)}ms`,
			);
		}
	}
	if (entry.http) {
		const p = previous?.http ?? undefined;
		console.log("http (vs Node):");
		console.log(
			`  maligator ${entry.http.malRps.toFixed(0)} req/s (p99 ${entry.http.malP99Ms.toFixed(2)}ms)${delta(entry.http.malRps, p?.malRps, false)}`,
		);
		console.log(
			`  node      ${entry.http.nodeRps.toFixed(0)} req/s (p99 ${entry.http.nodeP99Ms.toFixed(2)}ms)`,
		);
		console.log(
			`  ratio     ${entry.http.ratio.toFixed(2)}x${delta(entry.http.ratio, p?.ratio, false)}`,
		);
		if (entry.http.express) {
			console.log(
				`  express   ${humanBytes(entry.http.express.binaryBytes)} binary${delta(entry.http.express.binaryBytes, p?.express?.binaryBytes)}`,
			);
			for (const [name, current] of Object.entries(entry.http.express.workloads)) {
				const prior = p?.express?.workloads[name];
				console.log(
					`    ${name.padEnd(6)} maligator ${current.malRps.toFixed(0)} req/s (p99 ${current.malP99Ms.toFixed(2)}ms)${delta(current.malRps, prior?.malRps, false)}`,
				);
				console.log(
					`           node      ${current.nodeRps.toFixed(0)} req/s (p99 ${current.nodeP99Ms.toFixed(2)}ms)  ratio ${current.ratio.toFixed(2)}x${delta(current.ratio, prior?.ratio, false)}`,
				);
			}
		}
	}
}

// ---- main -----------------------------------------------------------------

const args = process.argv.slice(2);
const update = args.includes("--update");
const changed = args.includes("--changed");
const compareIdx = args.indexOf("--compare");
const compareRef = compareIdx >= 0 ? args[compareIdx + 1] : undefined;
const jsonOutIdx = args.indexOf("--json-out");
const jsonOut = jsonOutIdx >= 0 ? args[jsonOutIdx + 1] : undefined;
const runsIdx = args.indexOf("--runs");
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 5;
const maxPairsIdx = args.indexOf("--max-pairs");
const maxPairs = maxPairsIdx >= 0 ? Number(args[maxPairsIdx + 1]) : undefined;
const httpSecondsIdx = args.indexOf("--http-seconds");
const httpSeconds = httpSecondsIdx >= 0 ? Number(args[httpSecondsIdx + 1]) : 10;
const httpRequestsIdx = args.indexOf("--http-requests");
const httpRequests = httpRequestsIdx >= 0 ? Number(args[httpRequestsIdx + 1]) : 100_000;
const optionValues = new Set<number>();
if (runsIdx >= 0) optionValues.add(runsIdx + 1);
if (maxPairsIdx >= 0) optionValues.add(maxPairsIdx + 1);
if (httpSecondsIdx >= 0) optionValues.add(httpSecondsIdx + 1);
if (httpRequestsIdx >= 0) optionValues.add(httpRequestsIdx + 1);
if (compareIdx >= 0) optionValues.add(compareIdx + 1);
if (jsonOutIdx >= 0) optionValues.add(jsonOutIdx + 1);
const selected = args.filter(
	(a, index) => !a.startsWith("--") && !optionValues.has(index),
);
const defaultLanes = [
	"size",
	"compiler",
	"language",
	"module",
	"string",
	"promise",
	"coroutine",
	"arguments",
	"stack-object",
	"interpreter",
	"sqlite-binding",
	"prototype-cache",
	"gc",
	"http",
];

const entry: BenchmarkSnapshot = {};
const benchmarkLanes: Record<string, () => void> = {
	size: () => {
		entry.size = benchSize();
	},
	compiler: () => {
		entry.compiler = benchCompiler(runs);
	},
	"self-compile": () => {
		entry.selfCompile = benchSelfCompile(runs);
	},
	language: () => {
		entry.language = benchLanguage(runs);
	},
	module: () => {
		entry.module = benchModule(runs);
	},
	string: () => {
		entry.string = benchString(runs);
	},
	promise: () => {
		entry.promise = benchPromise(runs);
	},
	coroutine: () => {
		entry.coroutine = benchCoroutine(runs);
	},
	arguments: () => {
		entry.arguments = benchArguments(runs);
	},
	"stack-object": () => {
		entry.stackObject = benchStackObject(runs);
	},
	interpreter: () => {
		entry.interpreter = benchInterpreter(runs);
	},
	"sqlite-binding": () => {
		entry.sqliteBinding = benchSqliteBinding(runs);
	},
	"prototype-cache": () => {
		entry.prototypeCache = benchPrototypeCache(runs);
	},
	gc: () => {
		entry.gc = benchGc(runs);
	},
	http: () => {
		const http = benchHttp(httpSeconds, 50);
		if (http !== null) entry.http = http;
	},
	"http-profile": () => benchHttpProfile(httpRequests, 50),
	"string-profile": () => benchStringProfile(),
};

const changedSelection = changed
	? selectChangedBenchmarkLanes(compareRef ?? "HEAD", Object.keys(benchmarkLanes))
	: undefined;
const which =
	selected.length > 0
		? selected
		: changedSelection === undefined
			? defaultLanes
			: changedSelection.lanes;

if (changedSelection !== undefined) {
	console.log(
		`changed benchmark selection: ${changedSelection.files.length} files -> ${which.length === 0 ? "no lanes" : which.join(", ")}`,
	);
}

if (compareIdx >= 0) {
	if (compareRef === undefined || compareRef.startsWith("-")) {
		throw new Error("--compare requires a Git revision");
	}
	if (update) throw new Error("--compare cannot update the committed benchmark baseline");
	if (which.length === 0) {
		console.log("No benchmark lanes correspond to the changed files.");
		process.exit(0);
	}
	const comparison = runBenchmarkComparison({
		baseRef: compareRef,
		lanes: which,
		pairs: runs,
		maxPairs,
		extraArgs: [
			...(httpSecondsIdx >= 0 ? ["--http-seconds", String(httpSeconds)] : []),
			...(httpRequestsIdx >= 0 ? ["--http-requests", String(httpRequests)] : []),
		],
	});
	process.exit(comparison.exitCode);
}

const unknownLanes = which.filter((lane) => benchmarkLanes[lane] === undefined);
if (unknownLanes.length > 0)
	throw new Error(`unknown benchmark lane: ${unknownLanes.join(", ")}`);
benchmarkProgress.start(`${which.length} lanes · median of ${runs} samples`);
for (const [index, lane] of which.entries()) {
	activeBenchmarkLane = lane;
	benchmarkProgress.stage(index + 1, which.length, lane);
	try {
		benchmarkLanes[lane]!();
		benchmarkProgress.stagePassed(index + 1, which.length, lane);
	} catch (error) {
		benchmarkProgress.stageFailed(index + 1, which.length, lane);
		benchmarkProgress.failed();
		throw error;
	}
}

const baseline = readBenchmarkBaseline<BenchmarkSnapshot>(BASELINE_FILE);
if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(entry)}\n`);
report(entry, baseline);
persistBenchmarkBaseline(BASELINE_FILE, baseline, entry, update);
if (update) {
	console.log(`\nUpdated selected sections in ${BASELINE_FILE}.`);
} else {
	console.log("\n(run with --update to merge these sections into the saved baseline)");
}
benchmarkProgress.complete();
