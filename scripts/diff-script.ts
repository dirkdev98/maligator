/**
 * Sloppy-script variant of the emit-c differential oracle. The CLI parses
 * entrypoints as strict modules, so sloppy-only constructs (`with`, sloppy
 * `arguments`, ...) can't be reached through it. This mirrors the test262 script
 * compile path — parseScript(strict:false) → sema → IR → emit-c — building the
 * fixture both compiled and interpreter-only, then diffing stdout.
 *
 * Usage: node scripts/diff-script.ts <fixture.js> [--strict] [--stress]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { emitVmDefinition } from "../src/emit-vm.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { buildLocalBinary } from "../src/local-build.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { parseScript } from "../src/parser.ts";
import { allocateRegisters } from "../src/register-alloc.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

const fixture = process.argv[2];
if (fixture === undefined) {
	console.error("usage: node scripts/diff-script.ts <fixture.js> [--strict] [--stress]");
	process.exit(2);
}
const strict = process.argv.includes("--strict");
const stress = process.argv.includes("--stress");
const source = readFileSync(path.resolve(fixture), "utf-8");

function buildBinary(name: string, compiled: boolean): string {
	const parsed = parseScript(source, { strict });
	const semanticProgram = analyzeSourceAndRunSemanticAnalysis(
		source,
		path.resolve(fixture!),
		parsed,
	);
	const ir = compileSemanticProgramToIr(semanticProgram);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	const definition = lowerIrProgramToVmDefinition(ir);
	const cSource = emitVmDefinition(definition, { compiled });
	return buildLocalBinary({ name, cSource, verbose: false });
}

function run(binary: string): { out: string; code: number } {
	try {
		const out = execFileSync(binary, {
			encoding: "utf-8",
			env: stress
				? { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }
				: process.env,
			timeout: 30000,
		});
		return { out, code: 0 };
	} catch (error) {
		const e = error as { stdout?: string; status?: number };
		return { out: e.stdout ?? "", code: e.status ?? -1 };
	}
}

const compiled = run(buildBinary("diff-script-compiled", true));
const interp = run(buildBinary("diff-script-interp", false));

if (compiled.out === interp.out && compiled.code === interp.code) {
	console.log(
		`MATCH (${compiled.out.split("\n").length - 1} lines, exit ${compiled.code})`,
	);
	process.exit(0);
}

console.log("DIVERGENCE");
console.log(`  compiled exit=${compiled.code}, interpreter exit=${interp.code}`);
const cl = compiled.out.split("\n");
const il = interp.out.split("\n");
for (let i = 0; i < Math.max(cl.length, il.length); i++) {
	if (cl[i] !== il[i]) {
		console.log(`  line ${i + 1}:`);
		console.log(`    compiled:    ${JSON.stringify(cl[i])}`);
		console.log(`    interpreter: ${JSON.stringify(il[i])}`);
	}
}
process.exit(1);
