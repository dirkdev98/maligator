/**
 * Consolidated benchmark runner + historical tracker. One entry point drives the
 * whole bench/ tree and diffs against a commit-attributed baseline:
 *
 *   node scripts/bench.ts [size|language|stack-object|gc|http ...] [--runs N] [--update]
 *
 * Benches (default: all):
 *   - size      linked binary + per-archive bytes across a build-config matrix
 *               (full / no-eval / no-realms / no-intl / no-web / no-regexp /
 *               minimal) — the "small binary" goal, one row per config so each
 *               feature flag's marginal bytes are tracked. No V8 compare.
 *   - compiler  Node-hosted front-end throughput and serialized wire bytes for a
 *               deterministic, constant-heavy multi-function source corpus.
 *   - language  bench/language.js wall time vs Node/V8 (wide instruction coverage).
 *   - module    bench/module-alloc.mjs: an ES module whose top-level const-bound
 *               helpers are composed in a hot allocation loop. Wall time vs V8 plus
 *               the GC collection count — the tripwire for the const/module-scope
 *               inlining + scalar-replacement class (0 collections when the loop's
 *               transients are fully eliminated), which language.js does not cover.
 *   - string    bench/string.js: broad String + RegExp tokenization, plus an
 *               adversarial tiny-slice retention phase. Wall time vs V8 and GC
 *               allocation/live-set signals.
 *   - promise   bench/promise.js: chains, pending fan-out, combinators, thenables,
 *               rejection, and await. Wall time vs V8 plus managed and native
 *               promise-bookkeeping allocation signals.
 *   - coroutine bench/coroutine.js: generator, async, and async-generator frame
 *               churn in compiled and interpreted backends. Wall time and native
 *               support-buffer allocations.
 *   - arguments bench/arguments.js: direct non-escaping `arguments.length`/`[0]`
 *               reads in hot normal/default/generator calls. Backend wall time,
 *               managed allocation, coroutine-buffer churn, bytecode, and binary
 *               bytes isolate needless argument-object/slice materialization.
 *   - stack-object bench/stack-object.js: residual fixed-shape objects whose local
 *               identity/type/prototype observations prevent scalar replacement.
 *               Compiled and interpreted wall time, managed allocation/GC signals,
 *               bytecode, and binary size establish the pre-stack-allocation floor.
 *   - interpreter bench/language.js forced through bytecode: wide dispatch wall
 *               time, RSS, and exact loaded MalInstruction footprint.
 *   - gc        bench/gc/{cli,desktop,server}.js under the generational collector:
 *               wall, peak RSS, max GC pause (macOS: RSS/pauses via /usr/bin/time -l
 *               + MAL_GC_STATS). No V8 compare.
 *   - http      bare server and pinned Express 5 application: linked binary bytes,
 *               req/s, and p99 latency vs Node, driven by `oha` (multi-threaded, so
 *               the load generator isn't the bottleneck). Skipped if `oha` is absent.
 *
 * History: bench/baseline.json is a bounded list of entries keyed by commit
 * short-SHA (no timestamps). A run prints current-vs-latest deltas; `--update`
 * records an entry for HEAD (replacing any existing one for that SHA, marking
 * dirty if the tree isn't clean).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { MaligatorBuildConfig } from "../src/build-config.ts";
import { compileSourceToBuffer } from "../src/compile.ts";
import {
	buildNativeBinary,
	buildNativeBinaryResult,
	HOST_MAIN,
} from "../src/test-harness.ts";
import {
	formatOhaDuration,
	parseOhaOutput,
	planExpressHttpWorkload,
} from "./bench-http.ts";
import type { ExpressHttpWorkload, OhaMetrics } from "./bench-http.ts";

const BASELINE_FILE = "bench/baseline.json";
const HISTORY_LIMIT = 50;

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
}
interface CompilerMetrics {
	wallMs: number;
	sourceBytes: number;
	wireBytes: number;
	functionCount: number;
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
	instructionCount: number;
	bytecodeBytes: number;
	binaryBytes: number;
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
	instructionSize: number;
	instructionCount: number;
	instructionBytes: number;
	instructionDataBytes?: number;
	bytecodeBytes?: number;
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
interface Entry {
	commit: string;
	dirty: boolean;
	/** Per-config binary/archive bytes (keyed by SIZE_PROFILES name). */
	size?: Record<string, SizeMetrics>;
	compiler?: CompilerMetrics;
	language?: LanguageMetrics;
	module?: ModuleMetrics;
	string?: StringMetrics;
	promise?: PromiseMetrics;
	coroutine?: CoroutineMetrics;
	arguments?: ArgumentsMetrics;
	stackObject?: StackObjectMetrics;
	interpreter?: InterpreterMetrics;
	gc?: Record<string, GcWorkload>;
	http?: HttpMetrics | null;
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
		const start = process.hrtime.bigint();
		const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, stdio: "ignore" });
		if (r.status !== 0) {
			throw new Error(`command failed: ${cmd} ${args.join(" ")} (status ${r.status})`);
		}
		times.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	return median(times);
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
	for (const profile of SIZE_PROFILES) {
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

// ---- language (vs V8) -----------------------------------------------------

function benchLanguage(runs: number): LanguageMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/language.js",
		name: "bench-language",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeCommand("node", ["bench/language.js"], runs);
	return { malMs, nodeMs, ratio: malMs / nodeMs };
}

// ---- module (const-helper allocation; vs V8) ------------------------------

/** A `key=value` field from the single `MAL_GC_STATS=1` `[gc-stats]` line. */
function parseGcStat(stderr: string, field: string): number {
	const line = stderr.split("\n").find((l) => l.includes("[gc-stats]"));
	const m = line?.match(new RegExp(`${field}=([0-9.]+)`));
	return m ? Number(m[1]) : 0;
}

function benchModule(runs: number): ModuleMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/module-alloc.mjs",
		name: "bench-module",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeCommand("node", ["bench/module-alloc.mjs"], runs);
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
	const nodeMs = timeCommand("node", ["bench/string.js"], runs);
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
		allocatedMb: parseGcStat(stderr, "allocated_bytes") / (1024 * 1024),
		peakLiveKb: parseGcStat(stderr, "peak_live_bytes") / 1024,
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

function benchPromise(runs: number): PromiseMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/promise.js",
		name: "bench-promise",
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeCommand("node", ["bench/promise.js"], runs);
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
		nodeMs: timeCommand("node", ["bench/coroutine.js"], runs),
	};
}

// ---- arguments (implicit object/slice allocation; compiled + interpreted) --

function benchArgumentsBackend(binary: string, runs: number): ArgumentsBackendMetrics {
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
		instructionCount: parseVmStat(stderr, "instruction_count"),
		bytecodeBytes: parseVmStat(stderr, "bytecode_bytes"),
		binaryBytes: fileBytes(binary),
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
	return {
		compiled: benchArgumentsBackend(compiled, runs),
		interpreted: benchArgumentsBackend(interpreted, runs),
		nodeMs: timeCommand("node", ["bench/arguments.js"], runs),
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
	const nodeMs = timeCommand("node", ["bench/stack-object.js"], runs);
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

function benchInterpreter(runs: number): InterpreterMetrics {
	const binary = buildNativeBinary({
		fixture: "bench/language.js",
		name: "bench-interpreter",
		compiled: false,
	});
	const malMs = timeCommand(binary, [], runs);
	const nodeMs = timeCommand("node", ["bench/language.js"], runs);
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

// ---- http (vs Node) -------------------------------------------------------

function ohaAvailable(): boolean {
	return spawnSync("oha", ["--version"], { stdio: "ignore" }).status === 0;
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
		{ encoding: "utf-8" },
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

function workloadArgs(workload: ExpressHttpWorkload): Array<string> {
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

// ---- history + reporting --------------------------------------------------

function gitInfo(): { commit: string; dirty: boolean } {
	const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
		encoding: "utf-8",
	}).trim();
	const dirty =
		execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" }).trim().length >
		0;
	return { commit, dirty };
}

function loadBaseline(): { entries: Array<Entry> } {
	if (!existsSync(BASELINE_FILE)) return { entries: [] };
	return JSON.parse(readFileSync(BASELINE_FILE, "utf-8")) as { entries: Array<Entry> };
}

function latestMetrics(entries: Array<Entry>): Entry | undefined {
	if (entries.length === 0) return undefined;
	const latest: Entry = { commit: "latest-per-metric", dirty: false };
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined) continue;
		latest.size ??= entry.size;
		latest.language ??= entry.language;
		latest.module ??= entry.module;
		latest.string ??= entry.string;
		latest.promise ??= entry.promise;
		latest.coroutine ??= entry.coroutine;
		latest.arguments ??= entry.arguments;
		latest.stackObject ??= entry.stackObject;
		latest.interpreter ??= entry.interpreter;
		latest.gc ??= entry.gc;
		latest.http ??= entry.http;
	}
	return latest;
}

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

function report(entry: Entry, previous: Entry | undefined): void {
	console.log(`\n=== bench @ ${entry.commit}${entry.dirty ? " (dirty)" : ""} ===`);
	if (entry.size) {
		console.log("size (per build-config profile):");
		for (const [name, m] of Object.entries(entry.size)) {
			// Diff against the same profile in the previous entry (undefined the first
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
			`  native    ${entry.promise.jobAllocations} job allocations${delta(entry.promise.jobAllocations, p?.jobAllocations)}, ${entry.promise.jobReuses} reused`,
		);
		console.log(
			`            ${entry.promise.reactionAllocations} reaction allocations${delta(entry.promise.reactionAllocations, p?.reactionAllocations)}, ${entry.promise.reactionReuses} reused`,
		);
		console.log(
			`  direct    ${entry.promise.directCapabilities} capabilities${delta(entry.promise.directCapabilities, p?.directCapabilities)}, ${entry.promise.materializedFallbackPairs} fallback pairs materialized${delta(entry.promise.materializedFallbackPairs, p?.materializedFallbackPairs)}`,
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
				`               ${current.instructionCount} instructions, ${humanBytes(current.bytecodeBytes)} bytecode, ${humanBytes(current.binaryBytes)} binary`,
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
			`  bytecode  ${entry.interpreter.instructionCount} instructions x ${entry.interpreter.instructionSize}B = ${humanBytes(entry.interpreter.instructionBytes)}${delta(entry.interpreter.instructionBytes, p?.instructionBytes)}`,
		);
		if (entry.interpreter.bytecodeBytes !== undefined) {
			const previousBytes = p?.bytecodeBytes ?? p?.instructionBytes;
			console.log(
				`            ${humanBytes(entry.interpreter.instructionDataBytes ?? 0)} side data, ${humanBytes(entry.interpreter.bytecodeBytes)} total${delta(entry.interpreter.bytecodeBytes, previousBytes)}`,
			);
		}
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
const runsIdx = args.indexOf("--runs");
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 5;
const httpSecondsIdx = args.indexOf("--http-seconds");
const httpSeconds = httpSecondsIdx >= 0 ? Number(args[httpSecondsIdx + 1]) : 10;
const optionValues = new Set<number>();
if (runsIdx >= 0) optionValues.add(runsIdx + 1);
if (httpSecondsIdx >= 0) optionValues.add(httpSecondsIdx + 1);
const selected = args.filter(
	(a, index) => !a.startsWith("--") && !optionValues.has(index),
);
const which =
	selected.length > 0
		? selected
		: [
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
				"gc",
				"http",
			];

const { commit, dirty } = gitInfo();
const entry: Entry = { commit, dirty };

if (which.includes("size")) entry.size = benchSize();
if (which.includes("compiler")) entry.compiler = benchCompiler(runs);
if (which.includes("language")) entry.language = benchLanguage(runs);
if (which.includes("module")) entry.module = benchModule(runs);
if (which.includes("string")) entry.string = benchString(runs);
if (which.includes("promise")) entry.promise = benchPromise(runs);
if (which.includes("coroutine")) entry.coroutine = benchCoroutine(runs);
if (which.includes("arguments")) entry.arguments = benchArguments(runs);
if (which.includes("stack-object")) entry.stackObject = benchStackObject(runs);
if (which.includes("interpreter")) entry.interpreter = benchInterpreter(runs);
if (which.includes("gc")) entry.gc = benchGc(runs);
if (which.includes("http")) entry.http = benchHttp(httpSeconds, 50);

const baseline = loadBaseline();
const previous = latestMetrics(baseline.entries);
report(entry, previous);

if (update) {
	const last = baseline.entries[baseline.entries.length - 1];
	if (last && last.commit === commit) {
		baseline.entries[baseline.entries.length - 1] = entry;
	} else {
		baseline.entries.push(entry);
	}
	if (baseline.entries.length > HISTORY_LIMIT) {
		baseline.entries = baseline.entries.slice(-HISTORY_LIMIT);
	}
	writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
	console.log(`\nUpdated ${BASELINE_FILE} for ${commit}.`);
} else {
	console.log("\n(run with --update to record this as the new baseline entry)");
}
