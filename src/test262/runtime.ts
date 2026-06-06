import { execFile, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { emitVmDefinition } from "../emit-vm.ts";
import { executeIROptimizations } from "../ir-opt.ts";
import { compileSemanticProgramToIr } from "../ir.ts";
import { lowerIrProgramToVmDefinition } from "../lower-vm.ts";
import { allocateRegisters } from "../register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../semantic-analysis.ts";
import { collectUnsupportedSyntax } from "../supported-syntax.ts";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import type { Test262File } from "./types.ts";

const execFileAsync = promisify(execFile);

const SKIPPED_FLAGS = ["module", "async", "onlyStrict", "CanBlockIsTrue"];
const SKIPPED_FEATURES = [
	"IsHTMLDDA",
	"decorators",
	"explicit-resource-management",
	"Temporal",
];
const SKIPPED_PATHS = ["annexB", "intl402"];

const HARNESS_CACHE: Record<string, string> = {};

/**
 * Aggregated failure reasons and unsupported constructs, each with a few
 * sample paths for follow-up.
 */
const FAILURE_CACHE: Record<string, Array<string>> = {};
const UNSUPPORTED_CACHE: Record<string, Array<string>> = {};

export function test262PrepareBuild() {
	rmSync(TEST262_METADATA.buildPath, { recursive: true, force: true });
	mkdirSync(TEST262_METADATA.buildPath, { recursive: true });

	test262Log("Building LibMaligator...");
	execSync(`cmake --build runtime/build`, { stdio: "ignore" });

	test262Log("Compiling harness main...");
	execSync(
		`cc -std=c2x -O1 -I runtime/src -c runtime/test262_main.c -o ${TEST262_METADATA.buildPath}/test262_main.o`,
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

	return false;
}

function loadHarnessFile(file: string) {
	HARNESS_CACHE[file] ??= readFileSync(path.join(TEST262_METADATA.path, file), "utf-8");
	return HARNESS_CACHE[file];
}

function composeSource(file: Test262File) {
	if (file.frontmatter.flags?.includes("raw")) {
		return file.content;
	}

	const harnessFiles = ["harness/assert.js", "harness/sta.js"];
	harnessFiles.push(...(file.frontmatter.includes ?? []).map((it) => `harness/${it}`));

	return `${harnessFiles.map(loadHarnessFile).join("\n")}\n${file.content}`;
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

const FAILURE_COUNTS: Record<string, number> = {};
const UNSUPPORTED_COUNTS: Record<string, number> = {};

/**
 * Per-phase durations. Totals are summed per-test durations across all
 * workers, so they exceed wall time on parallel runs.
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

function recordTiming(phase: keyof typeof TIMINGS, file: Test262File, startedAt: number) {
	const ms = performance.now() - startedAt;
	const timing = TIMINGS[phase];

	timing.totalMs += ms;
	timing.count++;
	timing.slowest.push({ path: file.path, ms: Math.round(ms * 10) / 10 });
	timing.slowest.sort((a, b) => b.ms - a.ms);
	timing.slowest.length = Math.min(timing.slowest.length, 10);
}

export function getTimings() {
	return Object.fromEntries(
		Object.entries(TIMINGS).map(([phase, timing]) => [
			phase,
			{
				totalSeconds: Math.round(timing.totalMs / 100) / 10,
				count: timing.count,
				averageMs: timing.count > 0 ? Math.round(timing.totalMs / timing.count) : 0,
				slowest: timing.slowest,
			},
		]),
	);
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

export async function test262RunFile(file: Test262File, workerId: number) {
	if (test262ShouldSkip(file)) {
		file.result = "SKIPPED";
		return;
	}

	const source = composeSource(file);
	const baseName = path.join(TEST262_METADATA.buildPath, `t${workerId}`);

	// Phase 1: compile JS to a C translation unit in-process.
	const compileStartedAt = performance.now();
	let cSource: string;
	try {
		writeFileSync(`${baseName}.js`, source);

		const semanticProgram = loadEntrypointAndRunSemanticAnalysis(
			path.resolve(`${baseName}.js`),
		);

		const unsupported = collectUnsupportedSyntax(semanticProgram.files[0]!.ast);
		if (unsupported.size > 0) {
			file.result = "UNSUPPORTED";
			for (const feature of unsupported) {
				countReason(UNSUPPORTED_COUNTS, UNSUPPORTED_CACHE, feature, file);
			}
			return;
		}

		const irProgram = compileSemanticProgramToIr(semanticProgram);
		executeIROptimizations(irProgram);
		allocateRegisters(irProgram);
		const vmDefinition = lowerIrProgramToVmDefinition(irProgram);
		cSource = emitVmDefinition(vmDefinition);
	} catch (e) {
		file.result = "COMPILE_FAILED";
		countReason(
			FAILURE_COUNTS,
			FAILURE_CACHE,
			`compile: ${e instanceof Error ? e.message : String(e)}`,
			file,
		);
		return;
	} finally {
		recordTiming("compile", file, compileStartedAt);
	}

	// Phase 2: cc against the prebuilt harness main and runtime library.
	const ccStartedAt = performance.now();
	try {
		writeFileSync(`${baseName}.c`, cSource);
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
		recordTiming("cc", file, ccStartedAt);
	}

	// Phase 3: run the binary in isolation.
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
			code?: number | string;
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
		recordTiming("run", file, runStartedAt);
	}
}

function firstLine(text: string) {
	return text.split("\n")[0]?.trim() ?? "";
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
