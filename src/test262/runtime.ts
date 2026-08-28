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
import { parseModule, parseScript } from "../compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "../compiler/pipeline/compile-core.ts";
import { compileEntrypointToBuffer } from "../compiler/pipeline/compile-program.ts";
import {
	emitBatch,
	emitProgramImage,
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
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import { test262RuntimeNegativeVerdict } from "./policy.ts";
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
// MAL_UBSAN the archive is built instrumented (runtimeCcFlags), so every consumer
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
			"runtime/test262_main.c",
			"-o",
			`${BUILD_PATH}/test262_main.o`,
		],
		{ env: nativeContext.environment, stdio: "inherit" },
	);
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

export function test262ShouldSkip(file: Test262File): boolean {
	// Variant-aware run-mode filtering. The sloppy pass runs only the tests that
	// have a sloppy variant (default + `noStrict`), skipping the strict-only ones
	// (`onlyStrict`/`module`/`raw`); the strict pass skips `noStrict` tests, which
	// cannot run strict. A run always sets T262_VARIANT to one or the other.
	const flags = file.frontmatter.flags ?? [];
	if (process.env.T262_VARIANT === "sloppy") {
		if (
			flags.includes("onlyStrict") ||
			flags.includes("module") ||
			flags.includes("raw")
		) {
			return true;
		}
	} else if (flags.includes("noStrict")) {
		return true;
	}

	return false;
}

function loadHarnessFile(file: string) {
	HARNESS_CACHE[file] ??= readFileSync(path.join(TEST262_METADATA.path, file), "utf-8");
	return HARNESS_CACHE[file];
}

/**
 * `flags: [async]` tests signal completion by calling `$DONE`, defined in
 * `harness/doneprintHandle.js`, which writes a `Test262:AsyncTestComplete` /
 * `:AsyncTestFailure` sentinel through a host-provided `print`. We back `print`
 * with `console.log` (it writes the bare string to stdout) and auto-include the
 * handle ahead of the test's own `includes` (e.g. `asyncHelpers.js` references
 * `$DONE`). The sentinel — not the exit code — decides the verdict; see
 * `asyncVerdict`. The microtask drain that lets `$DONE` actually fire already
 * happens in `mal_vm_run`.
 */
const TEST262_ASYNC_PRELUDE = `function print(message) { console.log(message); }
`;

function isAsyncTest(file: Test262File): boolean {
	return file.frontmatter.flags?.includes("async") ?? false;
}

function composeSource(file: Test262File, content = file.content) {
	if (file.frontmatter.flags?.includes("raw")) {
		return content;
	}

	const harnessFiles = ["harness/assert.js", "harness/sta.js"];
	if (isAsyncTest(file)) {
		harnessFiles.push("harness/doneprintHandle.js");
	}
	harnessFiles.push(...(file.frontmatter.includes ?? []).map((it) => `harness/${it}`));

	const prelude = isAsyncTest(file) ? TEST262_ASYNC_PRELUDE : "";
	return `${prelude}${harnessFiles.map(loadHarnessFile).join("\n")}\n${content}`;
}

/**
 * Decide an async test's verdict from the captured stdout sentinel. A passing
 * test prints exactly `Test262:AsyncTestComplete`; a failing one prints a
 * `Test262:AsyncTestFailure:<detail>` line (via `$DONE(error)`). Neither line
 * means the test never settled (a missing `$DONE`, a sync throw, an unhandled
 * rejection) — also a failure.
 */
function asyncVerdict(output: Array<string>): {
	passed: boolean;
	reason: string;
} {
	const failure = output.find((line) =>
		line.trim().startsWith("Test262:AsyncTestFailure"),
	);
	if (failure !== undefined) {
		return { passed: false, reason: failure.trim() };
	}
	if (output.some((line) => line.trim() === "Test262:AsyncTestComplete")) {
		return { passed: true, reason: "" };
	}
	return { passed: false, reason: "async test did not complete" };
}

/** Apply `asyncVerdict` to a raw stdout string (single-test path). */
function applyAsyncVerdict(file: Test262File, stdout: string) {
	const verdict = asyncVerdict(stdout.split("\n"));
	if (verdict.passed) {
		file.result = "PASSED";
	} else {
		file.result = "FAILED";
		countReason(
			FAILURE_COUNTS,
			FAILURE_CACHE,
			normalizeFailureReason(verdict.reason),
			file,
		);
	}
}

function applyRuntimeNegativeVerdict(
	file: Test262File,
	output: ReadonlyArray<string>,
	didThrow: boolean,
): boolean {
	const verdict = test262RuntimeNegativeVerdict(file, output, didThrow);
	if (verdict === undefined) {
		return false;
	}
	file.result = verdict.passed ? "PASSED" : "FAILED";
	if (!verdict.passed) {
		countReason(
			FAILURE_COUNTS,
			FAILURE_CACHE,
			normalizeFailureReason(verdict.reason),
			file,
		);
	}
	return true;
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
		| { functionCount: number; instructionCount: number; opcodes: Record<string, number> }
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

function strictForTest262File(file: Test262File): boolean {
	return process.env.T262_VARIANT === "strict"
		? true
		: process.env.T262_VARIANT === "sloppy"
			? false
			: !(file.frontmatter.flags?.includes("noStrict") ?? false);
}

/**
 * Compile a test to a program image, resolving the SKIPPED and
 * COMPILE_FAILED verdicts along the way. `source` is the pre-composed
 * harness+test (also the cache-key input), passed in so it is built exactly once
 * per test.
 */
function test262CompileToC(
	file: Test262File,
	source: string,
	preParsed?: ReturnType<typeof parseScript>,
): CompileOutcome {
	const outcome: CompileOutcome = {
		image: undefined,
		result: "UNKNOWN",
		failure: undefined,
		stats: undefined,
	};

	if (test262ShouldSkip(file)) {
		outcome.result = "SKIPPED";
		return outcome;
	}
	const cacheInput = {
		path: file.path,
		source,
		variant:
			process.env.T262_VARIANT === "sloppy" ? ("sloppy" as const) : ("strict" as const),
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

	const isModule = file.frontmatter.flags?.includes("module") ?? false;
	// Strictness of the script parse. T262_VARIANT forces every script one way
	// (the strict pass strict, the sloppy pass sloppy); the fallback only fires if
	// a script runs with no variant set. A sloppy parse just relaxes the
	// early-error surface (octal, `with`, …); the sloppy runtime behaviors gate on
	// the per-scope strict flag sema derives from it.
	const strict = strictForTest262File(file);

	// A parse/early/resolution negative test must be REJECTED at compile: a
	// SyntaxError thrown below is the pass; compiling successfully is the fail.
	const negative = file.frontmatter.negative;
	const negativeAtCompile =
		negative !== undefined &&
		(negative.phase === "parse" ||
			negative.phase === "early" ||
			negative.phase === "resolution");

	const compileStartedAt = performance.now();
	try {
		// Parse and scan before any further work. Module-flagged tests parse
		// as modules; the harness is still prepended (its functions become
		// module-scoped, which the test references in the same scope).
		const parsed = isModule
			? parseModule(source)
			: (preParsed ?? parseScript(source, { strict }));

		const hasDynamicImport =
			file.frontmatter.features?.includes("dynamic-import") ?? false;

		// Module and dynamic-import tests run through the loader/graph pipeline so
		// sibling `*_FIXTURE.js` imports resolve from the test's real directory. For
		// module tests, the composed harness+test and all fixtures are modules. For
		// script dynamic-import tests, only dependencies are forced to modules; the
		// entry remains a script.
		const semanticProgram = isModule
			? loadEntrypointAndRunSemanticAnalysis(
					path.join(TEST262_METADATA.path, file.path),
					{
						entrySource: source,
						goalOverride: "module",
					},
				)
			: hasDynamicImport
				? loadEntrypointAndRunSemanticAnalysis(
						path.join(TEST262_METADATA.path, file.path),
						{
							entryGoal: "script",
							entrySource: source,
							dependencyGoalOverride: "module",
						},
					)
				: analyzeSourceAndRunSemanticAnalysis(source, file.path, parsed);

		const programImage = compileSemanticProgramToProgramImage(semanticProgram);

		if (negativeAtCompile) {
			// The source compiled cleanly, but a parse/early/resolution negative
			// test expects a SyntaxError before execution — accepting it is a fail.
			outcome.result = "FAILED";
			outcome.failure = `negative(${negative.phase}): expected ${negative.type} but compiled`;
			return outcome;
		}

		outcome.stats = imageStats(programImage);

		outcome.image = programImage;
		try {
			PROGRAM_IMAGE_CACHE_STATS.writtenBytes += storeTest262ProgramImage(
				cacheInput,
				programImage,
			);
		} catch {
			// Cache publication must never turn a valid compilation into a test failure.
			PROGRAM_IMAGE_CACHE_STATS.writeFailures++;
		}
		return outcome;
	} catch (e) {
		if (negativeAtCompile && e instanceof SyntaxError) {
			// The expected parse/early/resolution SyntaxError (meriyah's ParseError
			// extends SyntaxError; sema/IR early errors throw SyntaxError too) — the
			// negative test is rejected as required, so it passes. A non-SyntaxError
			// throw is our own compiler bug, not the expected rejection.
			outcome.result = "PASSED";
			return outcome;
		}
		outcome.result = "COMPILE_FAILED";
		outcome.failure = `compile: ${e instanceof Error ? e.message : String(e)}`;
		return outcome;
	} finally {
		recordTiming("compile", file.path, performance.now() - compileStartedAt);
	}
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
	mode: "shared" | "legacy";
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

async function executeWireBatch(
	entries: Array<WireBatchEntry>,
	workerId: number,
): Promise<Set<number>> {
	const runner = test262NativeBuildInputs().wireRunner;
	if (runner === undefined) throw new Error("Test262 wire runner was not prepared");
	// Collecting and verifying at every gated safepoint makes tests which invoke
	// the embedded compiler repeatedly much slower than ordinary conformance
	// tests. Keep a finite ten-minute fuse while allowing those verified runs to
	// complete (the ShadowRealm global-properties test takes about 7.5 minutes on
	// the development machine).
	const timeoutScale = gmallocEnabled() ? 12 : process.env.MAL_GC_STRESS ? 40 : 1;
	const runTimeoutMs = TEST262_METADATA.runTimeoutMs * timeoutScale;
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
		const content = file.content;
		const composed = composeSource(file, content);
		const plan = test262ShouldSkip(file)
			? ({ kind: "legacy", reason: "skipped" } satisfies Test262SourcePlan)
			: planTest262SharedHelpers(
					file,
					strictForTest262File(file),
					(name) => loadHarnessFile(`harness/${name}`),
					content,
				);
		let outcome: CompileOutcome;
		let images: Array<ProgramImage>;
		if (plan.kind === "shared") {
			const helperOutcomes = plan.helpers.map((helper) =>
				test262CompileToC(
					{
						path: helper.path,
						frontmatter: {},
						content: helper.source,
						result: "UNKNOWN",
					},
					helper.source,
					helper.parsed,
				),
			);
			const canShare = helperOutcomes.every(
				(helperOutcome) => helperOutcome.image !== undefined,
			);
			outcome = canShare
				? test262CompileToC(file, plan.testSource, plan.parsedTest)
				: test262CompileToC(file, composed);
			if (canShare && outcome.image !== undefined) {
				const testImage = outcome.image;
				const helperImages = helperOutcomes.map((helperOutcome) => {
					if (helperOutcome.image === undefined) {
						throw new Error("shared Test262 helper image missing after validation");
					}
					return helperOutcome.image;
				});
				const helperStats = helperOutcomes.map((helperOutcome) => helperOutcome.stats!);
				outcome = {
					...outcome,
					stats:
						outcome.stats === undefined
							? undefined
							: combineImageStats([...helperStats, outcome.stats]),
				};
				images = [...helperImages, testImage];
			} else {
				if (canShare && outcome.result === "COMPILE_FAILED") {
					outcome = test262CompileToC(file, composed);
				}
				images = outcome.image === undefined ? [] : [outcome.image];
			}
		} else {
			outcome = test262CompileToC(file, composed);
			images = outcome.image === undefined ? [] : [outcome.image];
		}
		applyOutcome(file, outcome);
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
) {
	let stdout = "";
	// Stress collection at every poll and Guard Malloc are deliberately slower,
	// so scale both the per-test and overall budgets to avoid spurious TIMEOUTs.
	const timeoutScale = gmallocEnabled() ? 12 : process.env.MAL_GC_STRESS ? 40 : 1;
	const runTimeoutMs = TEST262_METADATA.runTimeoutMs * timeoutScale;
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
		await test262RunSingle(entry.file, workerId, false);
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

	// Compose every test once: it feeds both the cache key and the compiler.
	const contents = files.map((file) => file.content);
	const composed = files.map((file, index) => composeSource(file, contents[index]));
	const plans: Array<Test262SourcePlan> = files.map(
		(file, index): Test262SourcePlan =>
			test262ShouldSkip(file)
				? { kind: "legacy", reason: "skipped" }
				: planTest262SharedHelpers(
						file,
						strictForTest262File(file),
						(name) => loadHarnessFile(`harness/${name}`),
						contents[index],
					),
	);

	let cacheKey = "";
	if (useCache) {
		cacheKey = batchCacheKey(
			buildFingerprint(
				[...CC_COMPILE_FLAGS, ...CC_LINK_FLAGS],
				test262Toolchain().fingerprint,
			),
			emitMode(),
			plans.map((plan, index) => test262SourcePlanCacheInput(plan, composed[index]!)),
		);
		USED_CACHE_KEYS.add(cacheKey);

		const cached = loadArtifact(cacheKey);
		if (cached) {
			const entries = applyManifest(files, cached.manifest, includeStats);
			if (cached.objectPath !== undefined && entries.length > 0) {
				timings.linkMs = await linkBatch(cached.objectPath, `${baseName}.bin`);
				const runStartedAt = performance.now();
				await runBatchBinary(`${baseName}.bin`, entries, workerId);
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
		if (plan.kind === "shared") {
			for (const helper of plan.helpers) helpers.set(helper.id, helper);
		}
	}
	const helperOutcomes = new Map<string, CompileOutcome>();
	for (const helper of helpers.values()) {
		const helperFile: Test262File = {
			path: helper.path,
			frontmatter: {},
			content: helper.source,
			result: "UNKNOWN",
		};
		helperOutcomes.set(
			helper.id,
			test262CompileToC(helperFile, helper.source, helper.parsed),
		);
	}

	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		const plan = plans[i]!;
		const canShare =
			plan.kind === "shared" &&
			plan.helpers.every((helper) => helperOutcomes.get(helper.id)?.image !== undefined);
		let mode: "shared" | "legacy" = canShare ? "shared" : "legacy";
		let outcome =
			plan.kind === "shared" && canShare
				? test262CompileToC(file, plan.testSource, plan.parsedTest)
				: test262CompileToC(file, composed[i]!);

		// A standalone fragment that reaches an unsupported compiler edge must not
		// turn sharing into a new failure mode. Retry the exact legacy source.
		if (mode === "shared" && outcome.result === "COMPILE_FAILED") {
			mode = "legacy";
			outcome = test262CompileToC(file, composed[i]!);
		}

		const helperIds =
			mode === "shared" && plan.kind === "shared"
				? plan.helpers.map((helper) => helper.id)
				: [];
		const logicalStats =
			outcome.stats === undefined
				? undefined
				: combineImageStats([
						...(mode === "shared"
							? helperIds.map((id) => helperOutcomes.get(id)!.stats!)
							: []),
						outcome.stats,
					]);
		const logicalOutcome = { ...outcome, stats: logicalStats };
		applyOutcome(file, logicalOutcome, includeStats);

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
			mode,
			helperIds,
			logicalStats: logicalStats!,
			imageIndex: -1,
			entryFunctionIndex: -1,
			helperFunctionIndices: [],
		});
	}

	const physicalImages: Array<ProgramImage> = [];
	const sharedEntries = entries.filter((entry) => entry.mode === "shared");
	const usedHelperIds = new Set(sharedEntries.flatMap((entry) => entry.helperIds));
	const usedHelpers = [...helpers.values()].filter((helper) =>
		usedHelperIds.has(helper.id),
	);
	if (sharedEntries.length > 0) {
		const sharedComponents = [
			...usedHelpers.map((helper) => helperOutcomes.get(helper.id)!.image!),
			...sharedEntries.map((entry) => entry.image),
		];
		const merged = mergeProgramImages(sharedComponents);
		physicalImages.push(merged.image);
		const helperBases = new Map(
			usedHelpers.map(
				(helper, index) => [helper.id, merged.functionBases[index]!] as const,
			),
		);
		sharedEntries.forEach((entry, index) => {
			entry.imageIndex = 0;
			entry.entryFunctionIndex = merged.functionBases[usedHelpers.length + index]!;
			entry.helperFunctionIndices = entry.helperIds.map((id) => helperBases.get(id)!);
		});
	}
	for (const entry of entries) {
		if (entry.mode === "legacy") {
			entry.imageIndex = physicalImages.length;
			entry.entryFunctionIndex = 0;
			physicalImages.push(entry.image);
		}
	}
	const physicalStats = combineImageStats(
		physicalImages.map((image) => imageStats(image)),
	);

	const manifest: BatchManifest = {
		schemaVersion: 2,
		hasBinary: entries.length > 0,
		generatedCBytes: null,
		entries: entries.map((entry) => ({
			path: entry.file.path,
			index: entry.index,
			mode: entry.mode,
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
			await test262RunSingle(retryFiles[0]!, workerId, false);
		} else {
			const midpoint = Math.ceil(retryFiles.length / 2);
			test262Log(
				`Isolating batch cc failure as ${midpoint}+${retryFiles.length - midpoint} tests.`,
			);
			await test262RunBatch(retryFiles.slice(0, midpoint), workerId, false);
			await test262RunBatch(retryFiles.slice(midpoint), workerId, false);
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
	await runBatchBinary(`${baseName}.bin`, entries, workerId);
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

		if (kind === "EXIT" && applyRuntimeNegativeVerdict(file, currentOutput, code !== 0)) {
			// The runtime-negative matcher owns this verdict, including error type.
		} else if (kind === "EXIT" && isAsyncTest(file)) {
			// Async tests exit 0 whether they pass or fail (`$DONE` never throws);
			// the stdout sentinel is authoritative. A non-zero exit means a sync
			// throw before settling, which `asyncVerdict` reports as no completion.
			const verdict = asyncVerdict(currentOutput);
			if (verdict.passed) {
				file.result = "PASSED";
			} else {
				file.result = "FAILED";
				countReason(
					FAILURE_COUNTS,
					FAILURE_CACHE,
					normalizeFailureReason(verdict.reason),
					file,
				);
			}
		} else if (kind === "EXIT" && code === 0) {
			file.result = "PASSED";
		} else if (kind === "EXIT") {
			file.result = "FAILED";
			const raw =
				currentOutput.find((it) => it.startsWith("Uncaught"))?.trim() || "non-zero exit";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, normalizeFailureReason(raw), file);
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

/**
 * Single-test execution, used as the fallback when a batch cannot be
 * compiled or its driver died before reporting.
 */
export async function test262RunSingle(
	file: Test262File,
	workerId: number,
	includeStats = true,
) {
	const outcome = test262CompileToC(file, composeSource(file));
	applyOutcome(file, outcome, includeStats);
	if (outcome.image === undefined) {
		return;
	}
	const cSource = emitProgramImage(outcome.image, { includeHeader: false });

	const baseName = path.join(BUILD_PATH, `t${workerId}`);

	const ccStartedAt = performance.now();
	try {
		const artifacts = test262NativeArtifacts();
		writeFileSync(`${baseName}.c`, `${NATIVE_C_HEADER_LINES.join("\n")}\n${cSource}`);
		await execFileAsync(
			test262Toolchain().tools.cc.path,
			[
				"-std=c2x",
				...GENERATED_C_OPT_FLAGS,
				"-I",
				"runtime/src",
				...perfStatsDefines(),
				...sanitizerCcFlags(),
				`${baseName}.c`,
				`${BUILD_PATH}/test262_main.o`,
				artifacts.c.engine,
				...artifacts.rust.linkArgs,
				"-o",
				`${baseName}.bin`,
			],
			{ timeout: TEST262_METADATA.compileTimeoutMs },
		);
	} catch (e) {
		file.result = "COMPILE_FAILED";
		const message = e instanceof Error ? e.message : String(e);
		countReason(FAILURE_COUNTS, FAILURE_CACHE, `cc: ${firstLine(message)}`, file);
		return;
	} finally {
		recordTiming("cc", file.path, performance.now() - ccStartedAt);
	}

	const runStartedAt = performance.now();
	try {
		const { stdout } = await execFileAsync(`${baseName}.bin`, [], {
			timeout: TEST262_METADATA.runTimeoutMs,
			maxBuffer: 1024 * 1024,
			env: { ...runEnv(), MAL_TEST262: "1" },
		});
		if (applyRuntimeNegativeVerdict(file, stdout.split("\n"), false)) {
			// A runtime-negative test must throw; normal completion is a failure.
		} else if (isAsyncTest(file)) {
			applyAsyncVerdict(file, stdout);
		} else {
			file.result = "PASSED";
		}
	} catch (e) {
		const error = e as NodeJS.ErrnoException & {
			signal?: string;
			stdout?: string;
			stderr?: string;
			killed?: boolean;
		};

		if (error.killed || error.signal === "SIGTERM") {
			file.result = "TIMEOUT";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, "timeout", file);
		} else if (error.signal) {
			file.result = "CRASHED";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, `signal: ${error.signal}`, file);
		} else if (
			applyRuntimeNegativeVerdict(
				file,
				[...(error.stdout ?? "").split("\n"), ...(error.stderr ?? "").split("\n")],
				true,
			)
		) {
			// The expected runtime exception and exact constructor decide the verdict.
		} else if (isAsyncTest(file)) {
			// A non-zero exit means the script threw before settling: no sentinel,
			// so `asyncVerdict` reports it as an incomplete async test.
			applyAsyncVerdict(file, error.stdout ?? "");
		} else {
			file.result = "FAILED";
			const reason = firstLine(error.stderr ?? "") || "non-zero exit";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, reason, file);
		}
	} finally {
		recordTiming("run", file.path, performance.now() - runStartedAt);
	}
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
	codeStats: { compiledFiles: number; functionCount: number; instructionCount: number };
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
