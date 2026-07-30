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
import { compileEntrypointToBuffer } from "../compile-program.ts";
import { emitBatch, emitVmDefinition } from "../emit-vm.ts";
import { executeIROptimizations } from "../ir-opt.ts";
import { compileSemanticProgramToIr } from "../ir.ts";
import { lowerIrProgramToVmDefinition } from "../lower-vm.ts";
import type { VmDefinition } from "../lower-vm.ts";
import { resolveNativeBuildContext } from "../native-build-context.ts";
import { parseModule, parseScript } from "../parser.ts";
import { allocateRegisters } from "../register-alloc.ts";
import { ensureNativeArtifacts } from "../runtime-build.ts";
import type { NativeArtifacts } from "../runtime-build.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../semantic-program.ts";
import { requireToolchain } from "../toolchain.ts";
import type { Toolchain } from "../toolchain.ts";
import { stripTypesWithTypeScript } from "../typescript-strip.ts";
import {
	batchCacheKey,
	buildFingerprint,
	cacheEnabled,
	ensureCacheDir,
	loadArtifact,
	objectCachePath,
	pruneUnused,
	storeManifest,
} from "./artifact-cache.ts";
import type { BatchManifest } from "./artifact-cache.ts";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import { createTest262BatchReport } from "./report.ts";
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
import { mergeVmDefinitions } from "./vm-definition-merge.ts";

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
};

let nativeBuildInputs: Test262NativeBuildInputs | undefined;
const BUILD_PATH = `${TEST262_METADATA.buildPath}${buildSuffix()}`;

export function test262NativeBuildInputs(): Test262NativeBuildInputs {
	if (nativeBuildInputs === undefined) {
		throw new Error("test262 native build inputs have not been prepared");
	}
	return nativeBuildInputs;
}

export function test262SetNativeBuildInputs(inputs: Test262NativeBuildInputs): void {
	nativeBuildInputs = {
		toolchain: inputs.toolchain,
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
	const backend = process.env.MAL_INTERP === "1" ? "interpreted" : "compiled";
	const mode = process.env.MAL_GC_STRESS ? "gc-stress" : "normal";
	return `${BUILD_PATH}/report-${backend}-${mode}-${variant}.json`;
}

/**
 * Force every test function through the bytecode interpreter (no emit-c bodies).
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
		? "merged-helper-plans-nocompiled-v2"
		: "merged-helper-plans-v2";
}

/** Keys touched this run, so stale cache entries can be pruned at the end. */
const USED_CACHE_KEYS = new Set<string>();

export function test262PruneArtifactCache() {
	if (cacheEnabled()) {
		pruneUnused(USED_CACHE_KEYS);
	}
}

const SKIPPED_FLAGS = ["CanBlockIsTrue"];
const SKIPPED_FEATURES = [
	"IsHTMLDDA",
	"decorators",
	"explicit-resource-management",
	"Temporal",
];
// Unsupported module forms still run compile-time negative coverage, but their
// positive/runtime tests require parser or host-loader behavior we do not expose.
const SKIPPED_MODULE_FEATURES = [
	"import-defer",
	"source-phase-imports",
	"json-modules",
	"import-text",
	"import-bytes",
];
const SKIPPED_PATHS = ["annexB"];
// The pinned corpus predates tc39/test262@250f204f, which excludes the
// immutable-buffer harness variant from tests that require mutable element
// descriptors or writes.
const STALE_IMMUTABLE_VARIANT_TESTS = new Set([
	"test/built-ins/TypedArray/prototype/slice/speciesctor-return-same-buffer-with-offset.js",
	"test/built-ins/TypedArrayConstructors/internals/GetOwnProperty/BigInt/index-prop-desc.js",
	"test/built-ins/TypedArrayConstructors/internals/GetOwnProperty/index-prop-desc.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/BigInt/null-tobigint.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/BigInt/number-tobigint.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/BigInt/symbol-tobigint.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/BigInt/tonumber-value-throws.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/BigInt/string-nan-tobigint.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/BigInt/undefined-tobigint.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/bigint-tonumber.js",
	"test/built-ins/TypedArrayConstructors/internals/Set/tonumber-value-throws.js",
]);
// This pinned test's own BigInt adapter reads its deliberately throwing source
// before invoking the method under test. Node reproduces the same pre-call error,
// so keep the invalid corpus input visible as a skip instead of rewriting it.
const INVALID_PINNED_TESTS = new Set([
	"test/built-ins/TypedArray/prototype/set/this-backed-by-resizable-buffer.js",
]);
// These cases require a host-backed async waiter list that can be woken by
// Atomics.notify. The single-agent runtime exposes waitAsync's synchronous
// validation/result paths but does not schedule blocking waiter records.
const UNSUPPORTED_ASYNC_WAIT_TESTS = new Set([
	"test/built-ins/Atomics/waitAsync/bigint/undefined-for-timeout.js",
	"test/built-ins/Atomics/waitAsync/implicit-infinity-for-timeout.js",
	"test/built-ins/Atomics/waitAsync/returns-result-object-value-is-promise-resolves-to-ok.js",
	"test/built-ins/Atomics/waitAsync/undefined-for-timeout.js",
]);

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
}

const TIMINGS: Record<"compile" | "cc" | "link" | "run", PhaseTimings> = {
	compile: { totalMs: 0, count: 0, slowest: [] },
	cc: { totalMs: 0, count: 0, slowest: [] },
	link: { totalMs: 0, count: 0, slowest: [] },
	run: { totalMs: 0, count: 0, slowest: [] },
};

function recordTiming(phase: keyof typeof TIMINGS, label: string, ms: number) {
	const timing = TIMINGS[phase];

	timing.totalMs += ms;
	timing.count++;
	timing.slowest.push({ path: label, ms: Math.round(ms * 10) / 10 });
	timing.slowest.sort((a, b) => b.ms - a.ms);
	timing.slowest.length = Math.min(timing.slowest.length, 10);
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
			},
		]),
	);
}

export function getBatchReports(): Array<Test262BatchReport> {
	return [...BATCH_REPORTS].sort((left, right) => left.id.localeCompare(right.id));
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
			eval: true,
			realms: true,
			regexp: true,
			intl: { enabled: true },
		},
		surface: { webPlatform: true, node: false },
	});
	const nativeContext = resolveNativeBuildContext({
		toolchain,
		features: buildDerivationFromConfig(config).features,
		compilerBake: {
			kind: "source",
			sourceDirectory: path.resolve("src"),
			entrypoint: path.resolve("src/eval-compiler-entry.mts"),
			bake: () =>
				compileEntrypointToBuffer(path.resolve("src/eval-compiler-entry.mts"), {
					stripTypes: stripTypesWithTypeScript,
				}),
		},
	});
	const artifacts = ensureNativeArtifacts(nativeContext);
	test262SetNativeBuildInputs({ toolchain, artifacts });

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
	if (
		INVALID_PINNED_TESTS.has(file.path) ||
		UNSUPPORTED_ASYNC_WAIT_TESTS.has(file.path)
	) {
		return true;
	}

	if (file.frontmatter.negative) {
		// Parse/early/resolution negatives are resolved at compile time: a
		// SyntaxError thrown while compiling is exactly the rejection the test
		// expects (see test262CompileToC). Runtime negatives would need run-phase
		// error-type matching (not yet implemented), so they stay skipped.
		if (file.frontmatter.negative.phase === "runtime") {
			return true;
		}
	}

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

	for (const flag of SKIPPED_FLAGS) {
		if (file.frontmatter.flags?.includes(flag)) {
			return true;
		}
	}
	// The harness helper requires the unimplemented $262.agent host API. Keep
	// ordinary SharedArrayBuffer and Atomics coverage active.
	if (file.frontmatter.includes?.includes("atomicsHelper.js")) {
		return true;
	}

	for (const feature of SKIPPED_FEATURES) {
		if (file.frontmatter.features?.includes(feature)) {
			return true;
		}
	}
	for (const feature of SKIPPED_MODULE_FEATURES) {
		if (
			file.frontmatter.features?.includes(feature) &&
			(!file.frontmatter.negative || file.frontmatter.negative.phase === "runtime") &&
			// `defer` remains a valid default-import binding. Test262 tags that
			// contextual-keyword test with import-defer even though neither it nor
			// its dependency uses the unsupported deferred-import production.
			(feature !== "import-defer" ||
				!file.path.endsWith("/syntax/valid-default-binding-named-defer.js"))
		) {
			return true;
		}
	}

	for (const part of SKIPPED_PATHS) {
		if (file.path.includes(part)) {
			return true;
		}
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

function testContent(file: Test262File): string {
	let content = file.content;
	if (STALE_IMMUTABLE_VARIANT_TESTS.has(file.path)) {
		const patched = content.replace(/\}\);\s*$/, '}, null, null, ["immutable"]);');
		if (patched === content) {
			throw new Error(`Could not apply immutable-variant exclusion to '${file.path}'.`);
		}
		content = patched;
	}
	return content;
}

function composeSource(file: Test262File, content = testContent(file)) {
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
 * into a cache manifest for replay on a later hit. `definition === undefined`
 * means there is nothing to execute (skipped / failed to compile).
 * Emission to C is left to the caller, which picks per-test or shared-harness
 * batch emission.
 */
interface CompileOutcome {
	definition: VmDefinition | undefined;
	/** Verdict resolved at compile time; "UNKNOWN" means the run decides. */
	result: Test262Result;
	failure: string | undefined;
	stats:
		| { functionCount: number; instructionCount: number; opcodes: Record<string, number> }
		| undefined;
}

type DefinitionStats = NonNullable<CompileOutcome["stats"]>;

function definitionStats(definition: VmDefinition): DefinitionStats {
	const opcodes: Record<string, number> = {};
	let instructionCount = 0;
	for (const fn of definition.functions) {
		instructionCount += fn.instructions.length;
		for (const instruction of fn.instructions) {
			opcodes[instruction.opcode] = (opcodes[instruction.opcode] ?? 0) + 1;
		}
	}
	return {
		functionCount: definition.functions.length,
		instructionCount,
		opcodes,
	};
}

function combineDefinitionStats(stats: Array<DefinitionStats>): DefinitionStats {
	const combined: DefinitionStats = {
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
 * Compile a test to a VM definition, resolving the SKIPPED and
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
		definition: undefined,
		result: "UNKNOWN",
		failure: undefined,
		stats: undefined,
	};

	if (test262ShouldSkip(file)) {
		outcome.result = "SKIPPED";
		return outcome;
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

		const irProgram = compileSemanticProgramToIr(semanticProgram);
		executeIROptimizations(irProgram);
		allocateRegisters(irProgram);
		const vmDefinition = lowerIrProgramToVmDefinition(irProgram);

		if (negativeAtCompile) {
			// The source compiled cleanly, but a parse/early/resolution negative
			// test expects a SyntaxError before execution — accepting it is a fail.
			outcome.result = "FAILED";
			outcome.failure = `negative(${negative.phase}): expected ${negative.type} but compiled`;
			return outcome;
		}

		outcome.stats = definitionStats(vmDefinition);

		outcome.definition = vmDefinition;
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
	definition: VmDefinition;
	mode: "shared" | "legacy";
	helperIds: Array<string>;
	logicalStats: DefinitionStats;
	definitionIndex: number;
	entryFunctionIndex: number;
	helperFunctionIndices: Array<number>;
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
	const timeoutScale = gmallocEnabled() ? 12 : process.env.MAL_GC_STRESS ? 8 : 1;
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
): Array<BatchEntry> {
	const byPath = new Map(files.map((file) => [file.path, file]));

	for (const entry of manifest.resolved) {
		const file = byPath.get(entry.path);
		if (!file) {
			continue;
		}
		applyOutcome(file, {
			definition: undefined,
			result: entry.result as Test262Result,
			failure: entry.failure,
			stats: undefined,
		});
	}

	// The compiled tests' aggregate code stats were summed in the manifest.
	CODE_STATS.compiledFiles += manifest.stats.compiledFiles;
	CODE_STATS.functionCount += manifest.stats.functionCount;
	CODE_STATS.instructionCount += manifest.stats.instructionCount;
	for (const [opcode, count] of Object.entries(manifest.stats.opcodes)) {
		OPCODE_COUNTS[opcode] = (OPCODE_COUNTS[opcode] ?? 0) + count;
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
export async function test262RunBatch(files: Array<Test262File>, workerId: number) {
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
	) => {
		BATCH_REPORTS.push(
			createTest262BatchReport({
				paths,
				manifest,
				objectBytes,
				cache,
				worker: workerId,
				timings,
			}),
		);
	};

	// Compose every test once: it feeds both the cache key and the compiler.
	const contents = files.map((file) => testContent(file));
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
			const entries = applyManifest(files, cached.manifest);
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
			plan.helpers.every(
				(helper) => helperOutcomes.get(helper.id)?.definition !== undefined,
			);
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
				: combineDefinitionStats([
						...(mode === "shared"
							? helperIds.map((id) => helperOutcomes.get(id)!.stats!)
							: []),
						outcome.stats,
					]);
		const logicalOutcome = { ...outcome, stats: logicalStats };
		applyOutcome(file, logicalOutcome);

		if (outcome.definition === undefined) {
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
			definition: outcome.definition,
			mode,
			helperIds,
			logicalStats: logicalStats!,
			definitionIndex: -1,
			entryFunctionIndex: -1,
			helperFunctionIndices: [],
		});
	}

	const physicalDefinitions: Array<VmDefinition> = [];
	const sharedEntries = entries.filter((entry) => entry.mode === "shared");
	const usedHelperIds = new Set(sharedEntries.flatMap((entry) => entry.helperIds));
	const usedHelpers = [...helpers.values()].filter((helper) =>
		usedHelperIds.has(helper.id),
	);
	if (sharedEntries.length > 0) {
		const sharedComponents = [
			...usedHelpers.map((helper) => helperOutcomes.get(helper.id)!.definition!),
			...sharedEntries.map((entry) => entry.definition),
		];
		const merged = mergeVmDefinitions(sharedComponents);
		physicalDefinitions.push(merged.definition);
		const helperBases = new Map(
			usedHelpers.map(
				(helper, index) => [helper.id, merged.functionBases[index]!] as const,
			),
		);
		sharedEntries.forEach((entry, index) => {
			entry.definitionIndex = 0;
			entry.entryFunctionIndex = merged.functionBases[usedHelpers.length + index]!;
			entry.helperFunctionIndices = entry.helperIds.map((id) => helperBases.get(id)!);
		});
	}
	for (const entry of entries) {
		if (entry.mode === "legacy") {
			entry.definitionIndex = physicalDefinitions.length;
			entry.entryFunctionIndex = 0;
			physicalDefinitions.push(entry.definition);
		}
	}
	const physicalStats = combineDefinitionStats(
		physicalDefinitions.map((definition) => definitionStats(definition)),
	);

	const manifest: BatchManifest = {
		schemaVersion: 3,
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
			definitionCount: physicalDefinitions.length,
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
	const body = emitBatch(physicalDefinitions, { compiled });
	const helperIndices = entries.flatMap((entry) => entry.helperFunctionIndices);
	const helperOffsets = [0];
	for (const entry of entries) {
		helperOffsets.push(helperOffsets.at(-1)! + entry.helperFunctionIndices.length);
	}

	const sources: Array<string> = [
		'#include "vm.h"',
		'#include "vm_ops.h"',
		'#include "value_ops.h"',
		'#include "builtin_array.h"',
		'#include "builtin_string.h"',
		'#include "builtin_math.h"',
		'#include "builtin_iterator.h"',
		'#include "builtin_async_iterator.h"',
		// Compiled coroutines dereference MalGeneratorObject (resume_state->frame).
		'#include "generator_object.h"',
		"",
		body,
		"",
		"const MalVmDefinition *const mal_test262_artifact_definitions[] = {",
		...physicalDefinitions.map((_, index) => `    &mal_vm_definition_${index},`),
		"};",
		`const int mal_test262_artifact_definition_count = ${physicalDefinitions.length};`,
		`const int mal_test262_plan_definition_indices[] = { ${entries.map((entry) => entry.definitionIndex).join(", ")} };`,
		`const int mal_test262_plan_entry_indices[] = { ${entries.map((entry) => entry.entryFunctionIndex).join(", ")} };`,
		`const int mal_test262_plan_helper_offsets[] = { ${helperOffsets.join(", ")} };`,
		`const int mal_test262_plan_helper_indices[] = { ${helperIndices.length > 0 ? helperIndices.join(", ") : "0"} };`,
		`const int mal_test262_plan_count = ${entries.length};`,
		"",
	];

	const generatedC = sources.join("\n");
	manifest.generatedCBytes = Buffer.byteLength(generatedC);
	const ccStartedAt = performance.now();
	try {
		const artifacts = test262NativeArtifacts();
		writeFileSync(`${baseName}.c`, generatedC);
		if (useCache) {
			// Compile straight into the cache so a hit needs only a re-link.
			ensureCacheDir();
			await execFileAsync(
				test262Toolchain().tools.cc.path,
				[...CC_COMPILE_FLAGS, "-c", `${baseName}.c`, "-o", objectCachePath(cacheKey)],
				{ timeout: TEST262_METADATA.compileTimeoutMs },
			);
		} else {
			// Baseline path: compile + link in one shot, no cache.
			await execFileAsync(
				test262Toolchain().tools.cc.path,
				[
					...CC_COMPILE_FLAGS,
					`${baseName}.c`,
					`${BUILD_PATH}/test262_batch.o`,
					artifacts.c.engine,
					...artifacts.rust.linkArgs,
					"-o",
					`${baseName}.bin`,
				],
				{ timeout: TEST262_METADATA.compileTimeoutMs },
			);
		}
	} catch (e) {
		// A cc failure cannot be attributed to a single test; retry every test
		// through the single-test path instead.
		timings.ccMs = performance.now() - ccStartedAt;
		recordTiming("cc", `batch(${entries.length}) FAILED`, timings.ccMs);
		test262Log(
			`Batch cc failed on worker ${workerId}, retrying single tests: ${firstLine(
				e instanceof Error ? e.message : String(e),
			)}`,
		);
		for (const entry of entries) {
			entry.file.result = "UNKNOWN";
			// Compilation above already attributed this logical test's code.
			await test262RunSingle(entry.file, workerId, false);
		}
		recordBatch(manifest, useCache ? "miss" : "disabled", null);
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

		if (kind === "EXIT" && isAsyncTest(file)) {
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
	if (outcome.definition === undefined) {
		return;
	}
	const cSource = emitVmDefinition(outcome.definition, { includeHeader: false });

	const baseName = path.join(BUILD_PATH, `t${workerId}`);

	const ccStartedAt = performance.now();
	try {
		const artifacts = test262NativeArtifacts();
		writeFileSync(
			`${baseName}.c`,
			`#include "vm.h"\n#include "vm_ops.h"\n#include "value_ops.h"\n#include "builtin_array.h"\n#include "builtin_string.h"\n#include "builtin_math.h"\n#include "builtin_iterator.h"\n#include "builtin_async_iterator.h"\n#include "generator_object.h"\n\n${cSource}`,
		);
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
		if (isAsyncTest(file)) {
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
		target.slowest.sort((a, b) => b.ms - a.ms);
		target.slowest.length = Math.min(target.slowest.length, 10);
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
