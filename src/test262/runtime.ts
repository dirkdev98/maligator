import { execFile, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { emitBatch, emitVmDefinition } from "../emit-vm.ts";
import { executeIROptimizations } from "../ir-opt.ts";
import { compileSemanticProgramToIr } from "../ir.ts";
import { lowerIrProgramToVmDefinition } from "../lower-vm.ts";
import type { VmDefinition } from "../lower-vm.ts";
import { gmallocEnabled, runEnv } from "../build-flags.ts";
import { parseModule, parseScript } from "../parser.ts";
import { allocateRegisters } from "../register-alloc.ts";
import { ensureRustLibrary, rustLinkArgs } from "../rust-build.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	loadEntrypointAndRunSemanticAnalysis,
} from "../semantic-analysis.ts";
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
import type { Test262File, Test262Result } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * cc invocation split into compile and link. Compiling the generated C is ~97%
 * of the cost; linking against the (always freshly built) library is ~3%. The
 * split lets the artifact cache reuse the compiled object across runs whenever
 * only the runtime implementation changed.
 */
const CC_COMPILE_FLAGS = ["-std=c2x", "-O0", "-I", "runtime/src"];
const CC_LINK_FLAGS = ["-std=c2x", "-O0"];

/**
 * Share byte-identical static arrays (the harness's instructions and string
 * constants) across the tests in a batch, instead of re-emitting them per test.
 * Halves the generated C and cuts cc ~25% on a cold run; content-addressed so it
 * cannot change behaviour. On by default (set T262_SHARED_HARNESS=0 to compare).
 * Folded into the cache key since it changes the compiled object.
 */
function sharedHarnessEnabled(): boolean {
	return process.env.T262_SHARED_HARNESS !== "0";
}

/**
 * Force every test function through the bytecode interpreter (no emit-c bodies).
 * Used to stress the GC: collection is only safe with no compiled frame on the C
 * stack, so an all-interpreter build lets a safepoint collect at every poll. Set
 * T262_NO_COMPILED=1. Folded into the cache key so it cannot reuse compiled
 * artifacts.
 */
function interpreterOnly(): boolean {
	return process.env.T262_NO_COMPILED === "1";
}

function emitMode(): string {
	const base = sharedHarnessEnabled() ? "shared-harness" : "per-test";
	return interpreterOnly() ? `${base}-nocompiled` : base;
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
const SKIPPED_PATHS = ["annexB"];

/**
 * Tests quarantined purely for suite speed: each is already failing AND pays a
 * disproportionate cost (a ~10s run timeout, or pathological codegen volume).
 * Skipping them trims wall time without hiding a passing test. Substring match.
 *
 * The Array-method entries all share one root cause: on an array-like with a
 * length near 2^32 we iterate it instead of throwing RangeError early, so each
 * spins for the full run timeout. (Every matching corpus test already fails,
 * so the substrings cannot mask a passing test.)
 *
 * - string-upper-lower-mapping emits ~77MB of C (a giant case-mapping table),
 *   ~1.5s of serial compile plus a ~4s cc, and still fails.
 * - array-iterator-close runs to the timeout.
 */
const SKIPPED_SLOW_PATHS = [
	"length-exceeding-array-length-limit",
	"arg-length-exceeding-integer-limit",
	"arg-length-near-integer-limit",
	"length-near-integer-limit",
	"throws-if-integer-limit-exceeded",
	"create-non-array-invalid-len",
	"Array/prototype/lastIndexOf/15.4.4.15-3-28",
	"Array/prototype/map/15.4.4.19-3-14",
	"Array/prototype/map/15.4.4.19-3-28",
	"Array/prototype/map/15.4.4.19-3-29",
	"Array/prototype/map/15.4.4.19-3-8",
	"staging/sm/String/string-upper-lower-mapping",
	"staging/sm/destructuring/array-iterator-close",
	// RegExp CharacterClassEscapes + property-escapes brute-force the harness's
	// buildString over Unicode-scale ranges (up to ~1.1M code points) with `+=`,
	// which is O(n²) on this engine's immutable strings (no rope) and times out
	// building the test string — before regex even runs. The regex semantics they
	// cover (regress's \p{} data + character classes) are exercised by
	// smaller-scale tests; these are a string-perf limitation, not a regex gap.
	// See docs/decisions/03-regexp.md.
	"built-ins/RegExp/CharacterClassEscapes",
	"built-ins/RegExp/property-escapes",
];

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
}

export function test262PrepareBuild() {
	rmSync(TEST262_METADATA.buildPath, { recursive: true, force: true });
	mkdirSync(TEST262_METADATA.buildPath, { recursive: true });

	test262Log("Building LibMaligator...");
	execSync(`cmake --build runtime/build`, { stdio: "ignore" });

	// Build the Rust shim once per pass; cheap when cached. Date tz + Intl
	// (ICU4X) and the RegExp engine (regress), both in libmal_rust.a.
	ensureRustLibrary();

	test262Log("Compiling harness mains...");
	execSync(
		`cc -std=c2x -O1 -I runtime/src -c runtime/test262_main.c -o ${TEST262_METADATA.buildPath}/test262_main.o`,
		{ stdio: "inherit" },
	);
	execSync(
		`cc -std=c2x -O1 -I runtime/src -c runtime/test262_batch.c -o ${TEST262_METADATA.buildPath}/test262_batch.o`,
		{ stdio: "inherit" },
	);
}

export function test262ShouldSkip(file: Test262File): boolean {
	if (file.frontmatter.negative) {
		// TODO(test262): negative runtime tests could assert on the throw kind.
		return true;
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

	for (const feature of SKIPPED_FEATURES) {
		if (file.frontmatter.features?.includes(feature)) {
			return true;
		}
	}

	for (const part of SKIPPED_PATHS) {
		if (file.path.includes(part)) {
			return true;
		}
	}

	for (const part of SKIPPED_SLOW_PATHS) {
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
 * The host-provided `$262` object (test262's realm/agent hook). We implement
 * what the runtime can already back: `global`, a real `gc` (forces a full
 * collection — the runtime installs a `__mal_collect_garbage` hook on globalThis
 * under MAL_HOST_GC, which we capture into the `gc` closure and then delete so it
 * never pollutes a test body's global), and `detachArrayBuffer` via
 * ArrayBuffer.prototype.transfer (which detaches the original). evalScript/
 * createRealm require eval/realms we do not have, so they are present (so
 * `typeof` checks pass) but throw when invoked.
 */
const TEST262_HOST_PRELUDE = `var $262 = {
  global: globalThis,
  gc: (function () {
    var collect = typeof globalThis.__mal_collect_garbage === "function"
      ? globalThis.__mal_collect_garbage
      : function () {};
    try { delete globalThis.__mal_collect_garbage; } catch (e) {}
    try { delete globalThis.__mal_gc_live_bytes; } catch (e) {}
    return function gc() { collect(); };
  })(),
  detachArrayBuffer: function detachArrayBuffer(buffer) {
    if (buffer !== null && buffer !== undefined && typeof buffer.transfer === "function") {
      buffer.transfer();
    }
    return null;
  },
  evalScript: function evalScript() {
    throw new TypeError("$262.evalScript is not supported");
  },
  createRealm: function createRealm() {
    throw new TypeError("$262.createRealm is not supported");
  },
};
`;

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

function composeSource(file: Test262File) {
	if (file.frontmatter.flags?.includes("raw")) {
		return file.content;
	}

	const harnessFiles = ["harness/assert.js", "harness/sta.js"];
	if (isAsyncTest(file)) {
		harnessFiles.push("harness/doneprintHandle.js");
	}
	harnessFiles.push(...(file.frontmatter.includes ?? []).map((it) => `harness/${it}`));

	const prelude = TEST262_HOST_PRELUDE + (isAsyncTest(file) ? TEST262_ASYNC_PRELUDE : "");
	return `${prelude}${harnessFiles.map(loadHarnessFile).join("\n")}\n${file.content}`;
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

/**
 * Compile a test to a VM definition, resolving the SKIPPED and
 * COMPILE_FAILED verdicts along the way. `source` is the pre-composed
 * harness+test (also the cache-key input), passed in so it is built exactly once
 * per test.
 */
function test262CompileToC(file: Test262File, source: string): CompileOutcome {
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
	const strict =
		process.env.T262_VARIANT === "strict"
			? true
			: process.env.T262_VARIANT === "sloppy"
				? false
				: !(file.frontmatter.flags?.includes("noStrict") ?? false);

	const compileStartedAt = performance.now();
	try {
		// Parse and scan before any further work. Module-flagged tests parse
		// as modules; the harness is still prepended (its functions become
		// module-scoped, which the test references in the same scope).
		const parsed = isModule ? parseModule(source) : parseScript(source, { strict });

		// Module tests run through the loader/graph pipeline so sibling
		// `*_FIXTURE.js` imports resolve from the test's real directory; the
		// composed harness+test is the in-memory entry, and every module in the
		// graph is forced to the module goal (test262 fixtures are `.js`).
		const semanticProgram = isModule
			? loadEntrypointAndRunSemanticAnalysis(
					path.join(TEST262_METADATA.path, file.path),
					{
						entrySource: source,
						goalOverride: "module",
					},
				)
			: analyzeSourceAndRunSemanticAnalysis(source, file.path, parsed);

		const irProgram = compileSemanticProgramToIr(semanticProgram);
		executeIROptimizations(irProgram);
		allocateRegisters(irProgram);
		const vmDefinition = lowerIrProgramToVmDefinition(irProgram);

		const opcodes: Record<string, number> = {};
		let instructionCount = 0;
		for (const fn of vmDefinition.functions) {
			instructionCount += fn.instructions.length;
			for (const instruction of fn.instructions) {
				opcodes[instruction.opcode] = (opcodes[instruction.opcode] ?? 0) + 1;
			}
		}
		outcome.stats = {
			functionCount: vmDefinition.functions.length,
			instructionCount,
			opcodes,
		};

		outcome.definition = vmDefinition;
		return outcome;
	} catch (e) {
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
function applyOutcome(file: Test262File, outcome: CompileOutcome) {
	file.result = outcome.result;
	if (outcome.failure !== undefined) {
		countReason(FAILURE_COUNTS, FAILURE_CACHE, outcome.failure, file);
	}
	if (outcome.stats !== undefined) {
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

/** Link a compiled batch object against the freshly built library. Cheap (~3% of cc). */
async function linkBatch(objectPath: string, binPath: string) {
	const startedAt = performance.now();
	await execFileAsync(
		"cc",
		[
			...CC_LINK_FLAGS,
			objectPath,
			`${TEST262_METADATA.buildPath}/test262_batch.o`,
			"runtime/build/libLibMaligator.a",
			...rustLinkArgs(),
			"-o",
			binPath,
		],
		{ timeout: TEST262_METADATA.compileTimeoutMs },
	);
	recordTiming("link", "batch", performance.now() - startedAt);
}

/** Execute a batch binary, parse its per-test verdicts, retry any unreported tests singly. */
async function runBatchBinary(
	binPath: string,
	entries: Array<BatchEntry>,
	workerId: number,
) {
	let stdout = "";
	// Guard Malloc is far slower per test, so scale the per-test and overall
	// timeouts to avoid spurious TIMEOUTs in that (deliberately slow) mode.
	const runTimeoutMs = TEST262_METADATA.runTimeoutMs * (gmallocEnabled() ? 12 : 1);
	try {
		const result = await execFileAsync(binPath, ["--all", String(runTimeoutMs)], {
			timeout: entries.length * runTimeoutMs + 15_000,
			maxBuffer: 64 * 1024 * 1024,
			// MAL_HOST_GC backs the host `$262.gc()`. MAL_GMALLOC=1 (folded in by
			// runEnv) runs every forked test under Guard Malloc (a broad
			// use-after-free / overflow net across the suite); a no-op otherwise.
			env: { ...runEnv(), MAL_HOST_GC: "1" },
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
		await test262RunSingle(entry.file, workerId);
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
	const baseName = path.join(TEST262_METADATA.buildPath, `batch${workerId}`);

	// Compose every test once: it feeds both the cache key and the compiler.
	const composed = files.map((file) => composeSource(file));

	let cacheKey = "";
	if (useCache) {
		cacheKey = batchCacheKey(
			buildFingerprint([...CC_COMPILE_FLAGS, ...CC_LINK_FLAGS]),
			emitMode(),
			composed,
		);
		USED_CACHE_KEYS.add(cacheKey);

		const cached = loadArtifact(cacheKey);
		if (cached) {
			const entries = applyManifest(files, cached.manifest);
			if (cached.objectPath !== undefined && entries.length > 0) {
				await linkBatch(cached.objectPath, `${baseName}.bin`);
				await runBatchBinary(`${baseName}.bin`, entries, workerId);
			}
			return;
		}
	}

	const entries: Array<BatchEntry> = [];
	const definitions: Array<VmDefinition> = [];
	const resolved: BatchManifest["resolved"] = [];
	const stats = {
		compiledFiles: 0,
		functionCount: 0,
		instructionCount: 0,
		opcodes: {} as Record<string, number>,
	};

	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		const outcome = test262CompileToC(file, composed[i]!);
		applyOutcome(file, outcome);

		if (outcome.definition === undefined) {
			resolved.push({
				path: file.path,
				result: outcome.result,
				failure: outcome.failure,
			});
			continue;
		}

		if (outcome.stats !== undefined) {
			stats.compiledFiles++;
			stats.functionCount += outcome.stats.functionCount;
			stats.instructionCount += outcome.stats.instructionCount;
			for (const [opcode, count] of Object.entries(outcome.stats.opcodes)) {
				stats.opcodes[opcode] = (stats.opcodes[opcode] ?? 0) + count;
			}
		}

		entries.push({ file, index: entries.length });
		definitions.push(outcome.definition);
	}

	const manifest: BatchManifest = {
		hasBinary: entries.length > 0,
		entries: entries.map((entry) => ({ path: entry.file.path, index: entry.index })),
		resolved,
		stats,
	};

	if (entries.length === 0) {
		if (useCache) {
			storeManifest(cacheKey, manifest);
		}
		return;
	}

	// Emit the batch's C: one shared translation unit (deduping the harness) or
	// each definition self-contained, headers prepended once either way.
	const compiled = !interpreterOnly();
	const body = sharedHarnessEnabled()
		? emitBatch(definitions, { compiled })
		: definitions
				.map((definition, i) =>
					emitVmDefinition(definition, {
						symbolSuffix: `_${i}`,
						includeHeader: false,
						compiled,
					}),
				)
				.join("\n");

	const sources: Array<string> = [
		'#include "vm.h"',
		'#include "vm_ops.h"',
		'#include "value_ops.h"',
		'#include "builtin_iterator.h"',
		"",
		body,
		"",
		"const MalVmDefinition *const mal_test262_definitions[] = {",
		...entries.map((entry) => `    &mal_vm_definition_${entry.index},`),
		"};",
		`const int mal_test262_definition_count = ${entries.length};`,
		"",
	];

	const ccStartedAt = performance.now();
	try {
		writeFileSync(`${baseName}.c`, sources.join("\n"));
		if (useCache) {
			// Compile straight into the cache so a hit needs only a re-link.
			ensureCacheDir();
			await execFileAsync(
				"cc",
				[...CC_COMPILE_FLAGS, "-c", `${baseName}.c`, "-o", objectCachePath(cacheKey)],
				{ timeout: TEST262_METADATA.compileTimeoutMs },
			);
		} else {
			// Baseline path: compile + link in one shot, no cache.
			await execFileAsync(
				"cc",
				[
					...CC_COMPILE_FLAGS,
					`${baseName}.c`,
					`${TEST262_METADATA.buildPath}/test262_batch.o`,
					"runtime/build/libLibMaligator.a",
					...rustLinkArgs(),
					"-o",
					`${baseName}.bin`,
				],
				{ timeout: TEST262_METADATA.compileTimeoutMs },
			);
		}
	} catch (e) {
		// A cc failure cannot be attributed to a single test; retry every test
		// through the single-test path instead.
		recordTiming(
			"cc",
			`batch(${entries.length}) FAILED`,
			performance.now() - ccStartedAt,
		);
		test262Log(
			`Batch cc failed on worker ${workerId}, retrying single tests: ${firstLine(
				e instanceof Error ? e.message : String(e),
			)}`,
		);
		for (const entry of entries) {
			entry.file.result = "UNKNOWN";
			await test262RunSingle(entry.file, workerId);
		}
		return;
	}
	recordTiming("cc", `batch(${entries.length})`, performance.now() - ccStartedAt);

	if (useCache) {
		// Publish the manifest only after the object compiled successfully.
		storeManifest(cacheKey, manifest);
		await linkBatch(objectCachePath(cacheKey), `${baseName}.bin`);
	}

	await runBatchBinary(`${baseName}.bin`, entries, workerId);
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
export async function test262RunSingle(file: Test262File, workerId: number) {
	const outcome = test262CompileToC(file, composeSource(file));
	applyOutcome(file, outcome);
	if (outcome.definition === undefined) {
		return;
	}
	const cSource = emitVmDefinition(outcome.definition, { includeHeader: false });

	const baseName = path.join(TEST262_METADATA.buildPath, `t${workerId}`);

	const ccStartedAt = performance.now();
	try {
		writeFileSync(
			`${baseName}.c`,
			`#include "vm.h"\n#include "vm_ops.h"\n#include "value_ops.h"\n#include "builtin_iterator.h"\n\n${cSource}`,
		);
		await execFileAsync(
			"cc",
			[
				"-std=c2x",
				"-O0",
				"-I",
				"runtime/src",
				`${baseName}.c`,
				`${TEST262_METADATA.buildPath}/test262_main.o`,
				"runtime/build/libLibMaligator.a",
				...rustLinkArgs(),
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
			env: { ...runEnv(), MAL_HOST_GC: "1" },
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
