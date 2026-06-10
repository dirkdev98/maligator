import { execFile, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { emitVmDefinition } from "../emit-vm.ts";
import { executeIROptimizations } from "../ir-opt.ts";
import { compileSemanticProgramToIr } from "../ir.ts";
import { lowerIrProgramToVmDefinition } from "../lower-vm.ts";
import { parseScript } from "../parser.ts";
import { allocateRegisters } from "../register-alloc.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../semantic-analysis.ts";
import { collectUnsupportedSyntax } from "../supported-syntax.ts";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import type { Test262File } from "./types.ts";

const execFileAsync = promisify(execFile);

const SKIPPED_FLAGS = ["async", "onlyStrict", "CanBlockIsTrue"];
const SKIPPED_FEATURES = [
	"IsHTMLDDA",
	"decorators",
	"explicit-resource-management",
	"Temporal",
];
const SKIPPED_PATHS = ["annexB", "intl402"];

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
];

const HARNESS_CACHE: Record<string, string> = {};

/**
 * Aggregated failure reasons and unsupported constructs, each with a few
 * sample paths for follow-up.
 */
const FAILURE_CACHE: Record<string, Array<string>> = {};
const UNSUPPORTED_CACHE: Record<string, Array<string>> = {};

const FAILURE_COUNTS: Record<string, number> = {};
const UNSUPPORTED_COUNTS: Record<string, number> = {};

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

const TIMINGS: Record<"compile" | "cc" | "run", PhaseTimings> = {
	compile: { totalMs: 0, count: 0, slowest: [] },
	cc: { totalMs: 0, count: 0, slowest: [] },
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

export function test262PrepareBuild() {
	rmSync(TEST262_METADATA.buildPath, { recursive: true, force: true });
	mkdirSync(TEST262_METADATA.buildPath, { recursive: true });

	test262Log("Building LibMaligator...");
	execSync(`cmake --build runtime/build`, { stdio: "ignore" });

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
 * what the runtime can already back: `global`, a no-op `gc` (no collector yet),
 * and `detachArrayBuffer` via ArrayBuffer.prototype.transfer (which detaches the
 * original). evalScript/createRealm require eval/realms we do not have, so they
 * are present (so `typeof` checks pass) but throw when invoked.
 */
const TEST262_HOST_PRELUDE = `var $262 = {
  global: globalThis,
  gc: function gc() {},
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

function composeSource(file: Test262File) {
	if (file.frontmatter.flags?.includes("raw")) {
		return file.content;
	}

	const harnessFiles = ["harness/assert.js", "harness/sta.js"];
	harnessFiles.push(...(file.frontmatter.includes ?? []).map((it) => `harness/${it}`));

	return `${TEST262_HOST_PRELUDE}${harnessFiles.map(loadHarnessFile).join("\n")}\n${file.content}`;
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
 * Compile a test to a C translation unit fragment, resolving the SKIPPED,
 * UNSUPPORTED and COMPILE_FAILED verdicts along the way. Returns undefined
 * when there is nothing to execute.
 */
function test262CompileToC(file: Test262File, symbolSuffix: string): string | undefined {
	if (test262ShouldSkip(file)) {
		file.result = "SKIPPED";
		return undefined;
	}

	const source = composeSource(file);

	const compileStartedAt = performance.now();
	try {
		// Parse and scan before any further work: unsupported tests stop here
		// without paying for scope and binding analysis.
		const parsed = parseScript(source, { strict: true });
		const unsupported = collectUnsupportedSyntax(parsed.ast);
		if (unsupported.size > 0) {
			file.result = "UNSUPPORTED";
			for (const feature of unsupported) {
				countReason(UNSUPPORTED_COUNTS, UNSUPPORTED_CACHE, feature, file);
			}
			return undefined;
		}

		const semanticProgram = analyzeSourceAndRunSemanticAnalysis(
			source,
			file.path,
			parsed,
		);
		const irProgram = compileSemanticProgramToIr(semanticProgram);
		executeIROptimizations(irProgram);
		allocateRegisters(irProgram);
		const vmDefinition = lowerIrProgramToVmDefinition(irProgram);

		CODE_STATS.compiledFiles++;
		CODE_STATS.functionCount += vmDefinition.functions.length;
		for (const fn of vmDefinition.functions) {
			CODE_STATS.instructionCount += fn.instructions.length;
			for (const instruction of fn.instructions) {
				OPCODE_COUNTS[instruction.opcode] = (OPCODE_COUNTS[instruction.opcode] ?? 0) + 1;
			}
		}

		return emitVmDefinition(vmDefinition, { symbolSuffix, includeHeader: false });
	} catch (e) {
		file.result = "COMPILE_FAILED";
		countReason(
			FAILURE_COUNTS,
			FAILURE_CACHE,
			`compile: ${e instanceof Error ? e.message : String(e)}`,
			file,
		);
		return undefined;
	} finally {
		recordTiming("compile", file.path, performance.now() - compileStartedAt);
	}
}

interface BatchEntry {
	file: Test262File;
	index: number;
}

/**
 * Run a batch of tests as a single translation unit and binary. The batch
 * driver forks per test, so cc and process-image setup are paid once per
 * batch while crash and timeout isolation stay per test.
 */
export async function test262RunBatch(files: Array<Test262File>, workerId: number) {
	const entries: Array<BatchEntry> = [];
	const sources: Array<string> = [
		'#include "vm.h"',
		'#include "vm_ops.h"',
		'#include "value_ops.h"',
		"",
	];

	for (const file of files) {
		const cSource = test262CompileToC(file, `_${entries.length}`);
		if (cSource === undefined) {
			continue;
		}

		sources.push(cSource, "");
		entries.push({ file, index: entries.length });
	}

	if (entries.length === 0) {
		return;
	}

	sources.push(
		"const MalVmDefinition *const mal_test262_definitions[] = {",
		...entries.map((entry) => `    &mal_vm_definition_${entry.index},`),
		"};",
		`const int mal_test262_definition_count = ${entries.length};`,
		"",
	);

	const baseName = path.join(TEST262_METADATA.buildPath, `batch${workerId}`);
	const ccStartedAt = performance.now();
	try {
		writeFileSync(`${baseName}.c`, sources.join("\n"));
		await execFileAsync(
			"cc",
			[
				"-std=c2x",
				"-O0",
				"-I",
				"runtime/src",
				`${baseName}.c`,
				`${TEST262_METADATA.buildPath}/test262_batch.o`,
				"runtime/build/libLibMaligator.a",
				"-o",
				`${baseName}.bin`,
			],
			{ timeout: TEST262_METADATA.compileTimeoutMs },
		);
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

	let stdout = "";
	try {
		const result = await execFileAsync(
			`${baseName}.bin`,
			["--all", String(TEST262_METADATA.runTimeoutMs)],
			{
				timeout: entries.length * TEST262_METADATA.runTimeoutMs + 15_000,
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		stdout = result.stdout;
	} catch (e) {
		stdout = (e as { stdout?: string }).stdout ?? "";
	}

	const resolved = parseBatchOutput(stdout, entries);

	// Anything the driver never reported (driver crash, overall timeout)
	// retries individually.
	const unreported = entries.filter((entry) => !resolved.has(entry.index));
	if (unreported.length > 0) {
		writeFileSync(`${baseName}.last-stdout.txt`, stdout);
		test262Log(
			`Batch driver on worker ${workerId} left ${unreported.length}/${entries.length} unreported (stdout saved), retrying singly.`,
		);
	}
	for (const entry of unreported) {
		entry.file.result = "UNKNOWN";
		await test262RunSingle(entry.file, workerId);
	}
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

		if (kind === "EXIT" && code === 0) {
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
	const cSource = test262CompileToC(file, "");
	if (cSource === undefined) {
		return;
	}

	const baseName = path.join(TEST262_METADATA.buildPath, `t${workerId}`);

	const ccStartedAt = performance.now();
	try {
		writeFileSync(
			`${baseName}.c`,
			`#include "vm.h"\n#include "vm_ops.h"\n#include "value_ops.h"\n\n${cSource}`,
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
		await execFileAsync(`${baseName}.bin`, [], {
			timeout: TEST262_METADATA.runTimeoutMs,
			maxBuffer: 1024 * 1024,
		});
		file.result = "PASSED";
	} catch (e) {
		const error = e as NodeJS.ErrnoException & {
			signal?: string;
			stderr?: string;
			killed?: boolean;
		};

		if (error.killed || error.signal === "SIGTERM") {
			file.result = "TIMEOUT";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, "timeout", file);
		} else if (error.signal) {
			file.result = "CRASHED";
			countReason(FAILURE_COUNTS, FAILURE_CACHE, `signal: ${error.signal}`, file);
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
		unsupported: sortedWithSamples(UNSUPPORTED_COUNTS, UNSUPPORTED_CACHE),
		failures: sortedWithSamples(FAILURE_COUNTS, FAILURE_CACHE),
	};
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
