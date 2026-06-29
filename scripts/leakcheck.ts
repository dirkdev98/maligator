/**
 * GC leak-audit runner (T6.3). Builds the leak-audit exerciser(s), runs each
 * under the MAL_GC_AT_EXIT teardown + the macOS `leaks` tool, and asserts ZERO
 * leaked bytes at shutdown. Exits non-zero if any exerciser leaks.
 *
 *   node scripts/leakcheck.ts [file.js ...]
 *
 * With no arguments it runs tests/local/leakaudit.js (the comprehensive
 * per-category exerciser). The teardown (test262_main.c under MAL_GC_AT_EXIT)
 * forces a final full GC and frees every reclaimable allocation, so a leak the
 * tool reports is a genuine finalizer gap, not just "live at exit". `leaks` is
 * macOS-only; on other platforms this is a no-op skip (ASAN/LeakSanitizer is the
 * Linux equivalent, but it currently deadlocks on macOS 26.x — see build-flags).
 */

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { buildLocalBinary } from "../src/local-build.ts";
import { emitVmDefinition } from "../src/emit-vm.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { allocateRegisters } from "../src/register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/semantic-program.ts";

const DEFAULT_EXERCISERS = ["tests/local/leakaudit.js"];

function buildBinary(file: string, name: string): string {
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(path.resolve(file));
	const ir = compileSemanticProgramToIr(semanticProgram);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	const definition = lowerIrProgramToVmDefinition(ir);
	const cSource = emitVmDefinition(definition, { compiled: true });
	return buildLocalBinary({ name, cSource, verbose: false });
}

/** Parse the "Process N: K leaks for M total leaked bytes." line from `leaks`. */
function parseLeaks(output: string): { leaks: number; bytes: number } | undefined {
	const match = output.match(/(\d+) leaks for (\d+) total leaked bytes/);
	if (!match) {
		return undefined;
	}
	return { leaks: Number(match[1]), bytes: Number(match[2]) };
}

function runLeaks(binary: string): { leaks: number; bytes: number; raw: string } {
	let output = "";
	try {
		output = execFileSync("leaks", ["--atExit", "--groupByType", "--", binary], {
			env: { ...process.env, MAL_GC_AT_EXIT: "1" },
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		// `leaks` exits non-zero when it finds leaks; its report is still on stdout.
		output = (error as { stdout?: string }).stdout ?? "";
	}
	const parsed = parseLeaks(output);
	if (!parsed) {
		throw new Error(`could not parse leaks output for ${binary}:\n${output.slice(0, 2000)}`);
	}
	return { ...parsed, raw: output };
}

if (os.platform() !== "darwin") {
	console.log("leakcheck: `leaks` is macOS-only — skipping on this platform.");
	process.exit(0);
}

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_EXERCISERS;
let failed = false;

for (const file of files) {
	const name = `leakcheck-${path.basename(file, ".js")}`;
	process.stdout.write(`leakcheck ${file} ... `);
	const binary = buildBinary(file, name);
	const { leaks, bytes, raw } = runLeaks(binary);
	if (leaks === 0 && bytes === 0) {
		console.log("OK (0 leaks)");
	} else {
		failed = true;
		console.log(`FAIL (${leaks} leaks, ${bytes} bytes)`);
		// Surface the grouped backtraces so the leaking category is obvious.
		for (const line of raw.split("\n")) {
			if (/ROOT LEAK|STACK OF|leaks for/.test(line)) {
				console.log(`  ${line.trim()}`);
			}
		}
	}
}

process.exit(failed ? 1 : 0);
