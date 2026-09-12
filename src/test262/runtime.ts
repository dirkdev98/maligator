import { execFile, execFileSync } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { buildDerivationFromConfig, resolveBuildConfig } from "../build-config.ts";
import {
	buildSuffix,
	gcDefines,
	gcGenerational,
	gmallocEnabled,
	perfStatsDefines,
	platformCcFlags,
	runEnv,
	sanitizerCcFlags,
} from "../build-flags.ts";
import { compilerEntrypointSourceFiles } from "../compiler-bake.ts";
import { stripCompactTypes } from "../compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../compiler/pipeline/compile-program.ts";
import {
	emitBatch,
	NATIVE_C_HEADER_LINES,
} from "../compiler/target/emit-program-image.ts";
import { serializeRuntimeImage } from "../compiler/target/program-image-codec.ts";
import type { ProgramImage } from "../compiler/target/program-image.ts";
import { cacheFrontendWire } from "../frontend-cache.ts";
import { buildLocalBinary } from "../local-build.ts";
import { resolveNativeBuildContext } from "../native-build-context.ts";
import { ensureNativeArtifacts } from "../runtime-build.ts";
import type { NativeArtifacts } from "../runtime-build.ts";
import { requireToolchain } from "../toolchain.ts";
import type { Toolchain } from "../toolchain.ts";
import {
	batchCacheKey,
	buildFingerprint,
	cacheEnabled,
	ensureCacheDir,
	loadArtifact,
	objectCachePath,
	pruneArtifactCacheToSize,
	pruneUnused,
	storeManifest,
} from "./artifact-cache.ts";
import type { BatchManifest } from "./artifact-cache.ts";
import { compileTest262ProgramImage } from "./compile.ts";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import {
	test262RuntimeVerdict,
	test262ScriptStrictness,
	test262SkipReason,
} from "./policy.ts";
import {
	loadTest262ProgramImage,
	storeTest262ProgramImage,
} from "./program-image-cache.ts";
import { mergeProgramImages } from "./program-image-merge.ts";
import {
	createTest262BatchReport,
	test262BatchId,
	test262SelectionId,
} from "./report.ts";
import type {
	Test262BatchCacheState,
	Test262BatchPhaseTimings,
	Test262BatchReport,
} from "./report.ts";
import {
	planTest262SharedHelpers,
	test262SourcePlanCacheInput,
} from "./shared-helper-plan.ts";
import type { Test262SharedHelper, Test262SourcePlan } from "./shared-helper-plan.ts";
import type { Test262File, Test262Result } from "./types.ts";

const execFileAsync = promisify(execFile);
let selectedToolchain: Toolchain | undefined;

function test262Toolchain(): Toolchain {
	return test262NativeBuildInputs().toolchain;
}

/**
 * cc invocation split into compile and link. Compiling the generated C is ~97%
 * of the cost; linking against the exact parent-selected library is ~3%. The
 * split lets the artifact cache reuse the compiled object across runs whenever
 * only the runtime implementation changed.
 */
// The default -O0 stays for fast compiles, but sanitizerCcFlags() must reach the
// generated-C object, the harness mains, AND the final link: under MAL_ASAN /
// MAL_UBSAN the archive is built instrumented (ccExtraFlags), so every consumer
// needs the matching `-fsanitize=…` or the link pulls in undefined
// sanitizer-runtime symbols. Empty for a normal build.
const GENERATED_C_OPT_FLAGS = ["-O0"];
const CC_COMPILE_FLAGS = [
	"-std=c2x",
	...GENERATED_C_OPT_FLAGS,
	...platformCcFlags(),
	"-I",
	"runtime/src",
	...gcDefines(),
	...perfStatsDefines(),
	...sanitizerCcFlags(),
];
const CC_LINK_FLAGS = [
	"-std=c2x",
	...GENERATED_C_OPT_FLAGS,
	...platformCcFlags(),
	...sanitizerCcFlags(),
];

/**
 * The generated objects and binaries are suffixed per GC/sanitizer build
 * dimension. Reusable runtime archives are content-addressed by runtime-build.ts.
 */
export type Test262NativeArtifactPaths = {
	c: Pick<NativeArtifacts["c"], "engine">;
	rust: Pick<NativeArtifacts["rust"], "linkArgs">;
};

/** Structured-clone-safe native inputs selected once by the parent thread. */
export type Test262NativeBuildInputs = {
	toolchain: Toolchain;
	artifacts: Test262NativeArtifactPaths;
	wireRunner?: string;
};

let nativeBuildInputs: Test262NativeBuildInputs | undefined;
const BUILD_PATH = `${TEST262_METADATA.buildPath}${buildSuffix()}`;
let reportSelectionId: string | undefined;

export function test262NativeBuildInputs(): Test262NativeBuildInputs {
	if (nativeBuildInputs === undefined) {
		throw new Error("test262 native build inputs have not been prepared");
	}
	return nativeBuildInputs;
}

export function test262SetNativeBuildInputs(inputs: Test262NativeBuildInputs): void {
	nativeBuildInputs = {
		toolchain: inputs.toolchain,
		wireRunner: inputs.wireRunner,
		artifacts: {
			c: { engine: inputs.artifacts.c.engine },
			rust: { linkArgs: [...inputs.artifacts.rust.linkArgs] },
		},
	};
}

export function test262NativeArtifacts(): Test262NativeArtifactPaths {
	return test262NativeBuildInputs().artifacts;
}

export function test262ReportPath(variant: "strict" | "sloppy" | "combined"): string {
	const backend = wireBackend()
		? "wire"
		: process.env.MAL_INTERP === "1"
			? "interpreted"
			: "compiled";
	const mode = process.env.MAL_GC_STRESS ? "gc-stress" : "normal";
	const selection = reportSelectionId === undefined ? "" : `-${reportSelectionId}`;
	return `${BUILD_PATH}/report-${backend}-${mode}-${variant}${selection}.json`;
}

export function test262SetReportSelection(paths?: Array<string>): void {
	reportSelectionId = paths === undefined ? undefined : test262SelectionId(paths);
}

function wireBackend(): boolean {
	return process.env.T262_WIRE === "1";
}

/**
 * Force every test function through the bytecode interpreter (no render-native-c bodies).
 * Used to stress the GC: collection is only safe with no compiled frame on the C
 * stack, so an all-interpreter build lets a safepoint collect at every poll. Set
 * MAL_INTERP=1. Folded into the cache key so it cannot reuse compiled artifacts.
 */
function interpreterOnly(): boolean {
	return process.env.MAL_INTERP === "1";
}

// Batches always share the harness's byte-identical static arrays (instructions +
// string constants) across their tests instead of re-emitting them per test —
// halves the generated C and cuts cc ~25% on a cold run, content-addressed so it
// cannot change behaviour. Folded into the cache key.
function emitMode(): string {
	return interpreterOnly()
		? "merged-helper-plans-nocompiled-v1"
		: "merged-helper-plans-v1";
}

/** Keys touched this run, so stale cache entries can be pruned at the end. */
const USED_CACHE_KEYS = new Set<string>();

export function test262PruneArtifactCache() {
	if (cacheEnabled()) {
		pruneUnused(USED_CACHE_KEYS);
	}
}

export function test262BoundArtifactCache(maxBytes: number) {
	return cacheEnabled() ? pruneArtifactCacheToSize(maxBytes) : undefined;
}

const HARNESS_CACHE: Record<string, string> = {};

/**
 * Aggregated failure reasons, with a few
 * sample paths for follow-up.
 */
const FAILURE_CACHE: Record<string, Array<string>> = {};
const FAILURE_COUNTS: Record<string, number> = {};

/**
 * Per-phase durations. Totals are summed per-test durations across all
 * workers, so they exceed wall time on parallel runs. Run timings come from
 * the batch driver's own per-test measurements.
 */
interface PhaseTimings {
	totalMs: number;
	count: number;
	slowest: Array<{ path: string; ms: number }>;
	overThreshold: Array<{ path: string; ms: number }>;
}

const TIMINGS: Record<"compile" | "cc" | "link" | "run", PhaseTimings> = {
	compile: { totalMs: 0, count: 0, slowest: [], overThreshold: [] },
	cc: { totalMs: 0, count: 0, slowest: [], overThreshold: [] },
	link: { totalMs: 0, count: 0, slowest: [], overThreshold: [] },
	run: { totalMs: 0, count: 0, slowest: [], overThreshold: [] },
};

function compareTimingSamples(
	left: { path: string; ms: number },
	right: { path: string; ms: number },
) {
	return right.ms - left.ms || left.path.localeCompare(right.path);
}

function recordTiming(phase: keyof typeof TIMINGS, label: string, ms: number) {
	const timing = TIMINGS[phase];
	const sample = { path: label, ms: Math.round(ms * 10) / 10 };

	timing.totalMs += ms;
	timing.count++;
	timing.slowest.push(sample);
	timing.slowest.sort(compareTimingSamples);
	timing.slowest.length = Math.min(timing.slowest.length, 10);
	if (phase === "run" && ms > TEST262_METADATA.runtimeOutlierThresholdMs) {
		timing.overThreshold.push(sample);
	}
}

/**
 * Aggregate code-size metrics across every successfully compiled test, plus an
 * opcode histogram to point performance work at the dominant instructions.
 * Counts can double on the rare batch-cc-failure retry path, so treat them as
 * tracking signals rather than exact totals.
 */
const CODE_STATS = { compiledFiles: 0, functionCount: 0, instructionCount: 0 };
const OPCODE_COUNTS: Record<string, number> = {};
const BATCH_REPORTS: Array<Test262BatchReport> = [];
const PROGRAM_IMAGE_CACHE_STATS = {
	hits: 0,
	misses: 0,
	corruptions: 0,
	writeFailures: 0,
	readBytes: 0,
	writtenBytes: 0,
};

export function getCodeStats() {
	const opcodes = Object.entries(OPCODE_COUNTS)
		.sort((a, b) => b[1] - a[1])
		.map(([opcode, count]) => ({ opcode, count }));

	return { ...CODE_STATS, opcodes };
}

export function getTimings() {
	return Object.fromEntries(
		Object.entries(TIMINGS).map(([phase, timing]) => [
			phase,
			{
				totalSeconds: Math.round(timing.totalMs / 100) / 10,
				count: timing.count,
				averageMs:
					timing.count > 0 ? Math.round((timing.totalMs / timing.count) * 10) / 10 : 0,
				slowest: timing.slowest,
				...(phase === "run"
					? {
							overThresholdMs: TEST262_METADATA.runtimeOutlierThresholdMs,
							overThreshold: [...timing.overThreshold].sort(compareTimingSamples),
						}
					: {}),
			},
		]),
	);
}

export function getBatchReports(): Array<Test262BatchReport> {
	return [...BATCH_REPORTS].sort((left, right) => left.id.localeCompare(right.id));
}

export function getProgramImageCacheStats() {
	return { ...PROGRAM_IMAGE_CACHE_STATS };
}

/**
 * Clear all run-level accumulators. Used between the strict and sloppy passes so
 * each pass reports its own timings, code stats, failure buckets, and pruned
 * cache keys.
 */
export function test262ResetStats() {
	for (const timing of Object.values(TIMINGS)) {
		timing.totalMs = 0;
		timing.count = 0;
		timing.slowest.length = 0;
		timing.overThreshold.length = 0;
	}
	CODE_STATS.compiledFiles = 0;
	CODE_STATS.functionCount = 0;
	CODE_STATS.instructionCount = 0;
	for (const record of [OPCODE_COUNTS, FAILURE_COUNTS, FAILURE_CACHE]) {
		for (const key of Object.keys(record)) {
			delete record[key];
		}
	}
	USED_CACHE_KEYS.clear();
	BATCH_REPORTS.length = 0;
	for (const key of Object.keys(PROGRAM_IMAGE_CACHE_STATS) as Array<
		keyof typeof PROGRAM_IMAGE_CACHE_STATS
	>) {
		PROGRAM_IMAGE_CACHE_STATS[key] = 0;
	}
}

export function test262PrepareBuild() {
	const toolchain = (selectedToolchain ??= requireToolchain({ needsCxx: true }));
	mkdirSync(BUILD_PATH, { recursive: true });
	for (const variant of ["strict", "sloppy", "combined"] as const) {
		rmSync(test262ReportPath(variant), { force: true });
	}
	for (const name of readdirSync(BUILD_PATH)) {
		if (!name.startsWith("report-")) {
			rmSync(path.join(BUILD_PATH, name), { recursive: true, force: true });
		}
	}

	test262Log(
		`Building LibMaligator${gcGenerational() ? " (generational)" : " (non-generational)"}...`,
	);
	const config = resolveBuildConfig({
		engine: {
			primordials: "mutable",
			eval: true,
			realms: true,
			regexp: true,
			temporal: true,
			intl: { enabled: true },
		},
		surface: { webPlatform: true, node: false },
	});
	const compilerSourceDirectory = path.resolve("src");
	const compilerEntrypoint = path.resolve(
		"src/compiler/pipeline/eval-compiler-entry.mts",
	);
	const nativeContext = resolveNativeBuildContext({
		toolchain,
		features: buildDerivationFromConfig(config).features,
		compilerBake: {
			kind: "source",
			sourceDirectory: compilerSourceDirectory,
			entrypoint: compilerEntrypoint,
			sourceFiles: compilerEntrypointSourceFiles(
				compilerSourceDirectory,
				compilerEntrypoint,
				stripCompactTypes,
			),
			bake: () =>
				compileEntrypointToBuffer(compilerEntrypoint, {
					intrinsicGlobalReads: true,
					stripTypes: stripCompactTypes,
				}),
			bakeProgram: () =>
				compileEntrypoint(compilerEntrypoint, {
					intrinsicGlobalReads: true,
					stripTypes: stripCompactTypes,
				}),
		},
	});
	const artifacts = ensureNativeArtifacts(nativeContext);
	const wireRunner = wireBackend()
		? buildLocalBinary({
				context: nativeContext,
				name: "Test262Wire",
				cSource: '#include "vm.h"\n',
				verbose: false,
				mainFile: path.resolve("runtime/test262_wire.c"),
				outDir: BUILD_PATH,
			}).binaryPath
		: undefined;
	test262SetNativeBuildInputs({ toolchain, artifacts, wireRunner });

	if (wireBackend()) return;

	// The mains include gc.h, whose header layout + barrier code differ under
	// MAL_GC_GENERATIONAL, so they must compile with the same defines as the lib;
	// sanitizer/perf flags likewise keep them instrumented in lockstep with the lib.
	const mainFlags = [
		...platformCcFlags(),
		...gcDefines(),
		...perfStatsDefines(),
		...sanitizerCcFlags(),
	].join(" ");
	test262Log("Compiling harness mains...");
	execFileSync(
		toolchain.tools.cc.path,
		[
			"-std=c2x",
			"-O1",
			"-I",
			"runtime/src",
			...mainFlags.split(" ").filter(Boolean),
			"-c",
			"runtime/test262_batch.c",
			"-o",
			`${BUILD_PATH}/test262_batch.o`,
		],
		{ env: nativeContext.environment, stdio: "inherit" },
	);
}

function activeTest262Variant(): "strict" | "sloppy" {
	return process.env.T262_VARIANT === "sloppy" ? "sloppy" : "strict";
}

export function test262ShouldSkip(file: Test262File): boolean {
	return test262SkipReason(file, activeTest262Variant()) !== undefined;
}

function loadHarnessFile(file: string) {
	HARNESS_CACHE[file] ??= readFileSync(path.join(TEST262_METADATA.path, file), "utf-8");
	return HARNESS_CACHE[file];
}

function sourcePlan(file: Test262File): Test262SourcePlan {
	return test262ShouldSkip(file)
		? { helpers: [], testSource: file.content }
		: planTest262SharedHelpers(file, (name) => loadHarnessFile(`harness/${name}`));
}

function applyRuntimeVerdict(
	file: Test262File,
	output: ReadonlyArray<string>,
	exitCode: number,
) {
	const verdict = test262RuntimeVerdict(file, output, exitCode);
	file.result = verdict.passed ? "PASSED" : "FAILED";
	if (!verdict.passed) {
		const reason =
			verdict.reason === "uncaught runtime exception"
				? (output.find((line) => line.startsWith("Uncaught ")) ?? verdict.reason)
				: verdict.reason;
		countReason(FAILURE_COUNTS, FAILURE_CACHE, normalizeFailureReason(reason), file);
	}
}

function recordFailure(
	cache: Record<string, Array<string>>,
	reason: string,
	file: Test262File,
) {
	cache[reason] ??= [];
	if (cache[reason].length < 5) {
		cache[reason].push(file.path);
	}
}

/**
 * Collapse the variable parts of an uncaught-error message so similar failures
 * cluster into one bucket: assertion values (`«…»`, quoted strings) and numeric
 * literals become placeholders. Keeps the error name and message shape so a
 * clustered correctness bug stands out instead of fragmenting into singletons.
 */
function normalizeFailureReason(reason: string): string {
	return reason
		.replace(/«[^»]*»/g, "«»")
		.replace(/"[^"]*"/g, '"…"')
		.replace(/'[^']*'/g, "'…'")
		.replace(/0[xX][0-9a-fA-F]+/g, "N")
		.replace(/-?\b\d+(\.\d+)?\b/g, "N");
}

function countReason(
	counts: Record<string, number>,
	cache: Record<string, Array<string>>,
	reason: string,
	file: Test262File,
) {
	counts[reason] = (counts[reason] ?? 0) + 1;
	recordFailure(cache, reason, file);
}

function firstLine(text: string) {
	return text.split("\n")[0]?.trim() ?? "";
}

/**
 * The outcome of compiling one test. Kept side-effect free (apart from the
 * compile timing) so the same value can both drive the live run and be folded
 * into a cache manifest for replay on a later hit. `image === undefined`
 * means there is nothing to execute (skipped / failed to compile).
 * Emission to C is left to the caller, which picks per-test or shared-harness
 * batch emission.
 */
interface CompileOutcome {
	image: ProgramImage | undefined;
	/** Verdict resolved at compile time; "UNKNOWN" means the run decides. */
	result: Test262Result;
	failure: string | undefined;
	stats:
		| {
				functionCount: number;
				instructionCount: number;
				opcodes: Record<string, number>;
		  }
		| undefined;
}

type ImageStats = NonNullable<CompileOutcome["stats"]>;

function imageStats(image: ProgramImage): ImageStats {
	const opcodes: Record<string, number> = {};
	let instructionCount = 0;
	for (const fn of image.runtime.functions) {
		instructionCount += fn.instructions.length;
		for (const instruction of fn.instructions) {
			opcodes[instruction.opcode] = (opcodes[instruction.opcode] ?? 0) + 1;
		}
	}
	return {
		functionCount: image.runtime.functions.length,
		instructionCount,
		opcodes,
	};
}

function combineImageStats(stats: Array<ImageStats>): ImageStats {
	const combined: ImageStats = {
		functionCount: 0,
		instructionCount: 0,
		opcodes: {},
	};
	for (const entry of stats) {
		combined.functionCount += entry.functionCount;
		combined.instructionCount += entry.instructionCount;
		for (const [opcode, count] of Object.entries(entry.opcodes)) {
			combined.opcodes[opcode] = (combined.opcodes[opcode] ?? 0) + count;
		}
	}
	return combined;
}

function test262CompileToC(file: Test262File, harness = false): CompileOutcome {
	const outcome: CompileOutcome = {
		image: undefined,
		result: "UNKNOWN",
		failure: undefined,
		stats: undefined,
	};
	if (!harness && test262ShouldSkip(file)) {
		outcome.result = "SKIPPED";
		return outcome;
	}
	const strict = !harness && test262ScriptStrictness(file, activeTest262Variant());
	const cacheInput = {
		path: file.path,
		source: file.content,
		frontmatter: file.frontmatter,
		variant: strict ? ("strict" as const) : ("sloppy" as const),
	};
	const cached = loadTest262ProgramImage(cacheInput);
	if (cached.state === "hit") {
		PROGRAM_IMAGE_CACHE_STATS.hits++;
		PROGRAM_IMAGE_CACHE_STATS.readBytes += cached.bytes;
		outcome.image = cached.image;
		outcome.stats = imageStats(cached.image);
		return outcome;
	}
	PROGRAM_IMAGE_CACHE_STATS.misses++;
	if (cached.state === "corrupt") {
		PROGRAM_IMAGE_CACHE_STATS.corruptions++;
		test262Log(`ProgramImage cache rejected ${file.path}: ${cached.reason}`);
	}
	const startedAt = performance.now();
	try {
		const compiled = compileTest262ProgramImage(file, strict);
		outcome.result = compiled.result;
		outcome.failure = compiled.failure;
		outcome.image = compiled.image;
		if (compiled.image !== undefined) {
			outcome.stats = imageStats(compiled.image);
			try {
				PROGRAM_IMAGE_CACHE_STATS.writtenBytes += storeTest262ProgramImage(
					cacheInput,
					compiled.image,
				);
			} catch {
				PROGRAM_IMAGE_CACHE_STATS.writeFailures++;
			}
		}
		return outcome;
	} finally {
		recordTiming("compile", file.path, performance.now() - startedAt);
	}
}

const HELPER_COMPILE_CACHE = new Map<string, CompileOutcome>();

function compileHelper(helper: Test262SharedHelper): CompileOutcome {
	const key = JSON.stringify(helper);
	let outcome = HELPER_COMPILE_CACHE.get(key);
	if (outcome === undefined) {
		outcome = test262CompileToC(
			{
				path: helper.path,
				content: helper.source,
				frontmatter: {},
				result: "UNKNOWN",
			},
			true,
		);
		HELPER_COMPILE_CACHE.set(key, outcome);
	}
	return outcome;
}

function compileWithHelpers(
	file: Test262File,
	helpers: ReadonlyArray<CompileOutcome>,
): CompileOutcome {
	const outcome = test262CompileToC(file);
	if (outcome.image === undefined) return outcome;
	const failed = helpers.find((helper) => helper.image === undefined);
	if (failed !== undefined) {
		return {
			image: undefined,
			result: "COMPILE_FAILED",
			failure: `harness: ${failed.failure ?? failed.result}`,
			stats: undefined,
		};
	}
	return outcome;
}

/**
 * Fold a compile outcome into the live result + the global failure/code-size
 * accumulators. Shared by the compile path and by cache-hit replay so both
 * produce identical reports.
 */
function applyOutcome(file: Test262File, outcome: CompileOutcome, includeStats = true) {
	file.result = outcome.result;
	if (outcome.failure !== undefined) {
		countReason(FAILURE_COUNTS, FAILURE_CACHE, outcome.failure, file);
	}
	if (includeStats && outcome.stats !== undefined) {
		CODE_STATS.compiledFiles++;
		CODE_STATS.functionCount += outcome.stats.functionCount;
		CODE_STATS.instructionCount += outcome.stats.instructionCount;
		for (const [opcode, count] of Object.entries(outcome.stats.opcodes)) {
			OPCODE_COUNTS[opcode] = (OPCODE_COUNTS[opcode] ?? 0) + count;
		}
	}
}

interface BatchEntry {
	file: Test262File;
	index: number;
}

interface RunnableBatchEntry extends BatchEntry {
	image: ProgramImage;
	helperIds: Array<string>;
	logicalStats: ImageStats;
	imageIndex: number;
	entryFunctionIndex: number;
	helperFunctionIndices: Array<number>;
}

interface WireBatchEntry extends BatchEntry {
	wirePath: string;
}

function compilerOutput(value: unknown): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf-8");
	return "";
}

function retainBatchCcFailure(input: {
	generatedC: string;
	manifest: BatchManifest;
	paths: Array<string>;
	workerId: number;
	command: string;
	args: Array<string>;
	error: unknown;
}): string {
	const id = test262BatchId(input.paths).slice("batch-".length);
	const artifactPath = path.join(BUILD_PATH, `report-cc-failure-${id}`);
	const error = input.error as Error & {
		code?: unknown;
		signal?: unknown;
		killed?: unknown;
		stdout?: unknown;
		stderr?: unknown;
	};
	mkdirSync(artifactPath, { recursive: true });
	writeFileSync(path.join(artifactPath, "batch.c"), input.generatedC);
	writeFileSync(
		path.join(artifactPath, "failure.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				worker: input.workerId,
				paths: input.paths,
				manifest: input.manifest,
				command: input.command,
				args: input.args,
				error: {
					message: error instanceof Error ? error.message : String(input.error),
					code: error.code ?? null,
					signal: error.signal ?? null,
					killed: error.killed ?? null,
					stdout: compilerOutput(error.stdout),
					stderr: compilerOutput(error.stderr),
				},
			},
			null,
			2,
		),
	);
	return artifactPath;
}

function test262RunTimeoutMs(): number {
	if (gmallocEnabled()) return TEST262_METADATA.guardMallocRunTimeoutMs;
	if (process.env.MAL_GC_STRESS) return TEST262_METADATA.gcStressRunTimeoutMs;
	return TEST262_METADATA.runTimeoutMs;
}

async function executeWireBatch(
	entries: Array<WireBatchEntry>,
	workerId: number,
): Promise<Set<number>> {
	const runner = test262NativeBuildInputs().wireRunner;
	if (runner === undefined) throw new Error("Test262 wire runner was not prepared");
	const runTimeoutMs = test262RunTimeoutMs();
	let stdout = "";
	try {
		const result = await execFileAsync(
			runner,
			["--all", String(runTimeoutMs), ...entries.map((entry) => entry.wirePath)],
			{
				timeout: entries.length * runTimeoutMs + 15_000,
				maxBuffer: 64 * 1024 * 1024,
				env: runEnv(),
			},
		);
		stdout = result.stdout;
	} catch (error) {
		stdout = (error as { stdout?: string }).stdout ?? "";
	}

	const resolved = parseBatchOutput(stdout, entries);
	const unreported = entries.filter((entry) => !resolved.has(entry.index));
	if (unreported.length > 0) {
		const outputPath = path.join(BUILD_PATH, `wire${workerId}.last-stdout.txt`);
		writeFileSync(outputPath, stdout);
		test262Log(
			`Wire driver on worker ${workerId} left ${unreported.length}/${entries.length} unreported (stdout saved), retrying singly.`,
		);
	}
	for (const entry of unreported) {
		entry.file.result = "UNKNOWN";
		let singleStdout = "";
		try {
			const result = await execFileAsync(
				runner,
				["--all", String(runTimeoutMs), entry.wirePath],
				{
					timeout: runTimeoutMs + 5_000,
					maxBuffer: 4 * 1024 * 1024,
					env: runEnv(),
				},
			);
			singleStdout = result.stdout;
		} catch (error) {
			singleStdout = (error as { stdout?: string }).stdout ?? "";
		}
		const singleEntry: WireBatchEntry = { ...entry, index: 0 };
		if (!parseBatchOutput(singleStdout, [singleEntry]).has(0)) {
			entry.file.result = "CRASHED";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, "wire driver failed", entry.file);
		}
	}
	return resolved;
}

async function test262RunWireBatch(files: Array<Test262File>, workerId: number) {
	const entries: Array<WireBatchEntry> = [];
	for (const file of files) {
		const plan = sourcePlan(file);
		const helpers = plan.helpers.map(compileHelper);
		const outcome = compileWithHelpers(file, helpers);
		const images =
			outcome.image === undefined
				? []
				: [...helpers.map((helper) => helper.image!), outcome.image];
		applyOutcome(file, {
			...outcome,
			stats:
				outcome.image === undefined
					? undefined
					: combineImageStats(images.map(imageStats)),
		});
		if (images.length === 0) continue;
		const wirePaths = images.map((image) =>
			cacheFrontendWire(serializeRuntimeImage(image.runtime)),
		);
		const wirePath = path.join(BUILD_PATH, `wire${workerId}-${entries.length}.plan`);
		writeFileSync(wirePath, `${wirePaths.join("\n")}\n`);
		entries.push({ file, index: entries.length, wirePath });
	}

	if (entries.length > 0) await executeWireBatch(entries, workerId);
}

/** Link a compiled batch object against the parent-selected artifacts. Cheap (~3% of cc). */
async function linkBatch(objectPath: string, binPath: string): Promise<number> {
	const startedAt = performance.now();
	const artifacts = test262NativeArtifacts();
	await execFileAsync(
		test262Toolchain().tools.cc.path,
		[
			...CC_LINK_FLAGS,
			objectPath,
			`${BUILD_PATH}/test262_batch.o`,
			artifacts.c.engine,
			...artifacts.rust.linkArgs,
			"-o",
			binPath,
		],
		{ timeout: TEST262_METADATA.compileTimeoutMs },
	);
	const elapsedMs = performance.now() - startedAt;
	recordTiming("link", "batch", elapsedMs);
	return elapsedMs;
}

/** Execute a batch binary, parse its per-test verdicts, retry any unreported tests singly. */
async function runBatchBinary(
	binPath: string,
	entries: Array<BatchEntry>,
	workerId: number,
	retryUnreported: boolean,
) {
	let stdout = "";
	const runTimeoutMs = test262RunTimeoutMs();
	try {
		const result = await execFileAsync(binPath, ["--all", String(runTimeoutMs)], {
			timeout: entries.length * runTimeoutMs + 15_000,
			maxBuffer: 64 * 1024 * 1024,
			// MAL_GMALLOC=1 (folded in by runEnv) runs every forked test under Guard
			// Malloc (a broad
			// use-after-free / overflow net across the suite); a no-op otherwise.
			env: runEnv(),
		});
		stdout = result.stdout;
	} catch (e) {
		stdout = (e as { stdout?: string }).stdout ?? "";
	}

	const resolved = parseBatchOutput(stdout, entries);

	// Anything the driver never reported (driver crash, overall timeout)
	// retries individually.
	const unreported = entries.filter((entry) => !resolved.has(entry.index));
	if (unreported.length > 0) {
		writeFileSync(`${binPath}.last-stdout.txt`, stdout);
		test262Log(
			`Batch driver on worker ${workerId} left ${unreported.length}/${entries.length} unreported (stdout saved), retrying singly.`,
		);
	}
	for (const entry of unreported) {
		entry.file.result = "UNKNOWN";
		// The batch or cached manifest already attributed this logical test's code.
		if (retryUnreported) {
			await test262RunSingle(entry.file, workerId, false);
		} else {
			entry.file.result = "CRASHED";
			countReason(
				FAILURE_COUNTS,
				FAILURE_CACHE,
				"native driver failed before reporting",
				entry.file,
			);
		}
	}
}

/**
 * Replay a cached manifest onto the live files: restore the resolved verdicts
 * and their failure/code-size accounting, and reconstruct the runnable entries
 * so the (still freshly executed) binary's output can be attributed.
 */
function applyManifest(
	files: Array<Test262File>,
	manifest: BatchManifest,
	includeStats = true,
): Array<BatchEntry> {
	const byPath = new Map(files.map((file) => [file.path, file]));

	for (const entry of manifest.resolved) {
		const file = byPath.get(entry.path);
		if (!file) {
			continue;
		}
		applyOutcome(
			file,
			{
				image: undefined,
				result: entry.result as Test262Result,
				failure: entry.failure,
				stats: undefined,
			},
			includeStats,
		);
	}

	// The compiled tests' aggregate code stats were summed in the manifest.
	if (includeStats) {
		CODE_STATS.compiledFiles += manifest.stats.compiledFiles;
		CODE_STATS.functionCount += manifest.stats.functionCount;
		CODE_STATS.instructionCount += manifest.stats.instructionCount;
		for (const [opcode, count] of Object.entries(manifest.stats.opcodes)) {
			OPCODE_COUNTS[opcode] = (OPCODE_COUNTS[opcode] ?? 0) + count;
		}
	}

	const entries: Array<BatchEntry> = [];
	for (const entry of manifest.entries) {
		const file = byPath.get(entry.path);
		if (file) {
			entries.push({ file, index: entry.index });
		}
	}
	return entries;
}

/**
 * Run a batch of tests as a single translation unit and binary. The batch
 * driver forks per test, so cc and process-image setup are paid once per
 * batch while crash and timeout isolation stay per test.
 *
 * Compiling the generated C dominates cost, so when the artifact cache is
 * enabled we key the batch on (compiler + headers + every test's composed
 * source) and reuse the compiled `.o` across runs - only re-linking and
 * re-running. The binary is always executed, so results are never cached.
 */
export async function test262RunBatch(
	files: Array<Test262File>,
	workerId: number,
	includeStats = true,
	retryUnreported = true,
) {
	if (wireBackend()) {
		await test262RunWireBatch(files, workerId);
		return;
	}
	const useCache = cacheEnabled();
	const baseName = path.join(BUILD_PATH, `batch${workerId}`);
	const paths = files.map((file) => file.path);
	const timings: Test262BatchPhaseTimings = {
		compileMs: null,
		ccMs: null,
		linkMs: null,
		runMs: null,
	};
	const recordBatch = (
		manifest: BatchManifest,
		cache: Test262BatchCacheState,
		objectBytes: number | null,
		ccFailureArtifact: string | null = null,
	) => {
		BATCH_REPORTS.push(
			createTest262BatchReport({
				paths,
				manifest,
				objectBytes,
				cache,
				ccFailureArtifact,
				worker: workerId,
				timings,
			}),
		);
	};

	const plans = files.map(sourcePlan);

	let cacheKey = "";
	if (useCache) {
		cacheKey = batchCacheKey(
			buildFingerprint(
				[...CC_COMPILE_FLAGS, ...CC_LINK_FLAGS],
				test262Toolchain().fingerprint,
			),
			emitMode(),
			plans.map(test262SourcePlanCacheInput),
		);
		USED_CACHE_KEYS.add(cacheKey);

		const cached = loadArtifact(cacheKey);
		if (cached) {
			const entries = applyManifest(files, cached.manifest, includeStats);
			if (cached.objectPath !== undefined && entries.length > 0) {
				timings.linkMs = await linkBatch(cached.objectPath, `${baseName}.bin`);
				const runStartedAt = performance.now();
				await runBatchBinary(`${baseName}.bin`, entries, workerId, retryUnreported);
				timings.runMs = performance.now() - runStartedAt;
			}
			recordBatch(
				cached.manifest,
				"hit",
				cached.objectPath === undefined ? null : statSync(cached.objectPath).size,
			);
			return;
		}
	}

	const compileStartedAt = performance.now();
	const entries: Array<RunnableBatchEntry> = [];
	const resolved: BatchManifest["resolved"] = [];
	const stats = {
		compiledFiles: 0,
		functionCount: 0,
		instructionCount: 0,
		opcodes: {} as Record<string, number>,
	};
	const helpers = new Map<string, Test262SharedHelper>();
	for (const plan of plans) {
		for (const helper of plan.helpers) helpers.set(helper.id, helper);
	}
	const helperOutcomes = new Map(
		[...helpers].map(([id, helper]) => [id, compileHelper(helper)]),
	);
	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		const plan = plans[i]!;
		const helperIds = plan.helpers.map((helper) => helper.id);
		const outcomes = helperIds.map((id) => helperOutcomes.get(id)!);
		const outcome = compileWithHelpers(file, outcomes);
		const logicalStats =
			outcome.stats === undefined
				? undefined
				: combineImageStats([...outcomes.map((helper) => helper.stats!), outcome.stats]);
		applyOutcome(file, { ...outcome, stats: logicalStats }, includeStats);

		if (outcome.image === undefined) {
			resolved.push({
				path: file.path,
				result: outcome.result,
				failure: outcome.failure,
			});
			continue;
		}

		if (logicalStats !== undefined) {
			stats.compiledFiles++;
			stats.functionCount += logicalStats.functionCount;
			stats.instructionCount += logicalStats.instructionCount;
			for (const [opcode, count] of Object.entries(logicalStats.opcodes)) {
				stats.opcodes[opcode] = (stats.opcodes[opcode] ?? 0) + count;
			}
		}

		entries.push({
			file,
			index: entries.length,
			image: outcome.image,
			helperIds,
			logicalStats: logicalStats!,
			imageIndex: -1,
			entryFunctionIndex: -1,
			helperFunctionIndices: [],
		});
	}

	const physicalImages: Array<ProgramImage> = [];
	const usedHelperIds = new Set(entries.flatMap((entry) => entry.helperIds));
	const usedHelpers = [...helpers.values()].filter((helper) =>
		usedHelperIds.has(helper.id),
	);
	if (entries.length > 0) {
		const merged = mergeProgramImages([
			...usedHelpers.map((helper) => helperOutcomes.get(helper.id)!.image!),
			...entries.map((entry) => entry.image),
		]);
		physicalImages.push(merged.image);
		const helperBases = new Map(
			usedHelpers.map(
				(helper, index) => [helper.id, merged.functionBases[index]!] as const,
			),
		);
		entries.forEach((entry, index) => {
			entry.imageIndex = 0;
			entry.entryFunctionIndex = merged.functionBases[usedHelpers.length + index]!;
			entry.helperFunctionIndices = entry.helperIds.map((id) => helperBases.get(id)!);
		});
	}
	const physicalStats = combineImageStats(
		physicalImages.map((image) => imageStats(image)),
	);

	const manifest: BatchManifest = {
		schemaVersion: 3,
		hasBinary: entries.length > 0,
		generatedCBytes: null,
		entries: entries.map((entry) => ({
			path: entry.file.path,
			index: entry.index,
			stats: entry.logicalStats,
		})),
		resolved,
		stats,
		physical: {
			imageCount: physicalImages.length,
			sharedHelperCount: usedHelpers.length,
			...physicalStats,
		},
	};
	timings.compileMs = performance.now() - compileStartedAt;

	if (entries.length === 0) {
		if (useCache) {
			storeManifest(cacheKey, manifest);
		}
		recordBatch(manifest, useCache ? "miss" : "disabled", null);
		return;
	}

	// Emit the batch's C as one shared translation unit (deduping the harness),
	// headers prepended once.
	const compiled = !interpreterOnly();
	const body = emitBatch(physicalImages, { compiled });
	const helperIndices = entries.flatMap((entry) => entry.helperFunctionIndices);
	const helperOffsets = [0];
	for (const entry of entries) {
		helperOffsets.push(helperOffsets.at(-1)! + entry.helperFunctionIndices.length);
	}

	const sources: Array<string> = [
		...NATIVE_C_HEADER_LINES,
		body,
		"",
		"const MalRuntimeImage *const mal_test262_artifact_images[] = {",
		...physicalImages.map((_, index) => `    &mal_runtime_image_${index},`),
		"};",
		`const int mal_test262_artifact_image_count = ${physicalImages.length};`,
		`const int mal_test262_plan_image_indices[] = { ${entries.map((entry) => entry.imageIndex).join(", ")} };`,
		`const int mal_test262_plan_entry_indices[] = { ${entries.map((entry) => entry.entryFunctionIndex).join(", ")} };`,
		`const int mal_test262_plan_helper_offsets[] = { ${helperOffsets.join(", ")} };`,
		`const int mal_test262_plan_helper_indices[] = { ${helperIndices.length > 0 ? helperIndices.join(", ") : "0"} };`,
		`const int mal_test262_plan_count = ${entries.length};`,
		"",
	];

	const generatedC = sources.join("\n");
	manifest.generatedCBytes = Buffer.byteLength(generatedC);
	const artifacts = test262NativeArtifacts();
	const ccArgs = useCache
		? [...CC_COMPILE_FLAGS, "-c", `${baseName}.c`, "-o", objectCachePath(cacheKey)]
		: [
				...CC_COMPILE_FLAGS,
				`${baseName}.c`,
				`${BUILD_PATH}/test262_batch.o`,
				artifacts.c.engine,
				...artifacts.rust.linkArgs,
				"-o",
				`${baseName}.bin`,
			];
	const ccStartedAt = performance.now();
	try {
		writeFileSync(`${baseName}.c`, generatedC);
		if (useCache) ensureCacheDir();
		await execFileAsync(test262Toolchain().tools.cc.path, ccArgs, {
			timeout: TEST262_METADATA.compileTimeoutMs,
		});
	} catch (e) {
		timings.ccMs = performance.now() - ccStartedAt;
		recordTiming("cc", `batch(${entries.length}) FAILED`, timings.ccMs);
		const failureArtifact = retainBatchCcFailure({
			generatedC,
			manifest,
			paths,
			workerId,
			command: test262Toolchain().tools.cc.path,
			args: ccArgs,
			error: e,
		});
		recordBatch(manifest, useCache ? "miss" : "disabled", null, failureArtifact);
		test262Log(
			`Batch cc failed on worker ${workerId}; retained ${failureArtifact}: ${firstLine(
				e instanceof Error ? e.message : String(e),
			)}`,
		);
		const retryFiles = entries.map((entry) => entry.file);
		for (const file of retryFiles) {
			file.result = "UNKNOWN";
		}
		if (retryFiles.length === 1) {
			const file = retryFiles[0]!;
			file.result = "COMPILE_FAILED";
			countReason(
				FAILURE_COUNTS,
				FAILURE_CACHE,
				`cc: ${firstLine(e instanceof Error ? e.message : String(e))}`,
				file,
			);
		} else {
			const midpoint = Math.ceil(retryFiles.length / 2);
			test262Log(
				`Isolating batch cc failure as ${midpoint}+${retryFiles.length - midpoint} tests.`,
			);
			await test262RunBatch(
				retryFiles.slice(0, midpoint),
				workerId,
				false,
				retryUnreported,
			);
			await test262RunBatch(retryFiles.slice(midpoint), workerId, false, retryUnreported);
		}
		return;
	}
	timings.ccMs = performance.now() - ccStartedAt;
	recordTiming("cc", `batch(${entries.length})`, timings.ccMs);

	let objectBytes: number | null = null;
	if (useCache) {
		// Publish the manifest only after the object compiled successfully.
		storeManifest(cacheKey, manifest);
		const objectPath = objectCachePath(cacheKey);
		objectBytes = statSync(objectPath).size;
		timings.linkMs = await linkBatch(objectPath, `${baseName}.bin`);
	}

	const runStartedAt = performance.now();
	await runBatchBinary(`${baseName}.bin`, entries, workerId, retryUnreported);
	timings.runMs = performance.now() - runStartedAt;
	recordBatch(manifest, useCache ? "miss" : "disabled", objectBytes);
}

function parseBatchOutput(stdout: string, entries: Array<BatchEntry>): Set<number> {
	const resolved = new Set<number>();
	const byIndex = new Map(entries.map((entry) => [entry.index, entry.file]));

	let currentOutput: Array<string> = [];

	for (const line of stdout.split("\n")) {
		if (/^##TEST \d+$/.test(line)) {
			currentOutput = [];
			continue;
		}

		const resultMatch = line.match(
			/^##RESULT (\d+) (EXIT|SIGNAL|TIMEOUT|FORK_FAILED) (\d+)(?: (\d+)ms)?$/,
		);
		if (!resultMatch) {
			currentOutput.push(line);
			continue;
		}

		const index = Number(resultMatch[1]);
		const kind = resultMatch[2]!;
		const code = Number(resultMatch[3]);
		const elapsedMs = Number(resultMatch[4] ?? 0);
		const file = byIndex.get(index);
		if (!file) {
			continue;
		}

		resolved.add(index);
		recordTiming("run", file.path, elapsedMs);

		if (kind === "EXIT") {
			applyRuntimeVerdict(file, currentOutput, code);
		} else if (kind === "SIGNAL") {
			file.result = "CRASHED";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, `signal: ${code}`, file);
		} else if (kind === "TIMEOUT") {
			file.result = "TIMEOUT";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, "timeout", file);
		} else {
			file.result = "CRASHED";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, "fork failed", file);
		}

		currentOutput = [];
	}

	return resolved;
}

/** Retry a lost batch member with the same source plan and a bounded single-test driver. */
export async function test262RunSingle(
	file: Test262File,
	workerId: number,
	includeStats = true,
) {
	await test262RunBatch([file], workerId, includeStats, false);
}

export function getFailuresWithSamples() {
	return {
		failures: sortedWithSamples(FAILURE_COUNTS, FAILURE_CACHE),
	};
}

/**
 * A worker thread's full contribution to the aggregate report. Plain data so it
 * survives a structured-clone postMessage back to the main thread.
 */
export interface StatsSnapshot {
	timings: Record<string, PhaseTimings>;
	codeStats: {
		compiledFiles: number;
		functionCount: number;
		instructionCount: number;
	};
	opcodes: Record<string, number>;
	failureCounts: Record<string, number>;
	failureCache: Record<string, Array<string>>;
	usedCacheKeys: Array<string>;
	batches: Array<Test262BatchReport>;
	programImageCache: typeof PROGRAM_IMAGE_CACHE_STATS;
}

/** Snapshot this thread's accumulators (used by a compile worker before it exits). */
export function test262DrainStats(): StatsSnapshot {
	return {
		timings: TIMINGS,
		codeStats: { ...CODE_STATS },
		opcodes: OPCODE_COUNTS,
		failureCounts: FAILURE_COUNTS,
		failureCache: FAILURE_CACHE,
		usedCacheKeys: [...USED_CACHE_KEYS],
		batches: [...BATCH_REPORTS],
		programImageCache: { ...PROGRAM_IMAGE_CACHE_STATS },
	};
}

function mergeSampleCache(
	dst: Record<string, Array<string>>,
	src: Record<string, Array<string>>,
) {
	for (const [reason, samples] of Object.entries(src)) {
		dst[reason] ??= [];
		for (const sample of samples) {
			if (dst[reason].length < 5 && !dst[reason].includes(sample)) {
				dst[reason].push(sample);
			}
		}
	}
}

/** Fold a worker's snapshot into the main thread's accumulators. */
export function test262MergeStats(snapshot: StatsSnapshot) {
	for (const phase of ["compile", "cc", "link", "run"] as const) {
		const source = snapshot.timings[phase];
		if (!source) {
			continue;
		}
		const target = TIMINGS[phase];
		target.totalMs += source.totalMs;
		target.count += source.count;
		target.slowest.push(...source.slowest);
		target.slowest.sort(compareTimingSamples);
		target.slowest.length = Math.min(target.slowest.length, 10);
		target.overThreshold.push(...source.overThreshold);
	}

	CODE_STATS.compiledFiles += snapshot.codeStats.compiledFiles;
	CODE_STATS.functionCount += snapshot.codeStats.functionCount;
	CODE_STATS.instructionCount += snapshot.codeStats.instructionCount;
	for (const [opcode, count] of Object.entries(snapshot.opcodes)) {
		OPCODE_COUNTS[opcode] = (OPCODE_COUNTS[opcode] ?? 0) + count;
	}

	for (const [reason, count] of Object.entries(snapshot.failureCounts)) {
		FAILURE_COUNTS[reason] = (FAILURE_COUNTS[reason] ?? 0) + count;
	}
	mergeSampleCache(FAILURE_CACHE, snapshot.failureCache);

	for (const key of snapshot.usedCacheKeys) {
		USED_CACHE_KEYS.add(key);
	}
	BATCH_REPORTS.push(...snapshot.batches);
	for (const key of Object.keys(PROGRAM_IMAGE_CACHE_STATS) as Array<
		keyof typeof PROGRAM_IMAGE_CACHE_STATS
	>) {
		PROGRAM_IMAGE_CACHE_STATS[key] += snapshot.programImageCache[key];
	}
}

function sortedWithSamples(
	counts: Record<string, number>,
	cache: Record<string, Array<string>>,
) {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 30)
		.map(([reason, count]) => ({
			reason,
			count,
			samples: cache[reason] ?? [],
		}));
}
