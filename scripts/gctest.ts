/**
 * Targeted GC unit-test runner (T6.4). Builds tests/local/gctest.js and runs it
 * with the forced-collection hooks enabled (MAL_HOST_GC=1), once plain and once
 * under MAL_GC_STRESS + MAL_GC_VERIFY. A failed assertion in the test throws,
 * which the harness turns into a non-zero exit; this runner forwards that.
 *
 *   node scripts/gctest.ts [file.js]   (default tests/local/gctest.js)
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { emitVmDefinition } from "../src/emit-vm.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { buildLocalBinary } from "../src/local-build.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { allocateRegisters } from "../src/register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/semantic-program.ts";

function buildBinary(file: string, name: string, compiled: boolean): string {
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(path.resolve(file));
	const ir = compileSemanticProgramToIr(semanticProgram);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	const definition = lowerIrProgramToVmDefinition(ir);
	const cSource = emitVmDefinition(definition, { compiled });
	return buildLocalBinary({ name, cSource, verbose: false });
}

function run(binary: string, label: string, env: NodeJS.ProcessEnv): boolean {
	process.stdout.write(`gctest ${label} ... `);
	try {
		const out = execFileSync(binary, {
			env: { ...process.env, MAL_HOST_GC: "1", ...env },
			encoding: "utf-8",
		});
		const match = out.match(/gctest PASS (\d+)\/(\d+)/);
		console.log(match ? `OK (${match[0].replace("gctest PASS ", "")})` : "OK");
		return true;
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		console.log("FAIL");
		if (e.stdout) console.log(e.stdout.trim());
		if (e.stderr) console.log(e.stderr.trim());
		return false;
	}
}

const file = process.argv[2] ?? "tests/local/gctest.js";

// Compiled backend: plain, then collect-at-every-safepoint with the dangling
// checker on (proves the assertions hold while the collector runs aggressively).
const compiledBin = buildBinary(file, "gctest", true);
let allOk = run(compiledBin, "compiled", {});
allOk = run(compiledBin, "compiled + STRESS=1 + VERIFY", { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }) && allOk;

// Interpreter backend (Tier B root walk).
const interpBin = buildBinary(file, "gctest-ni", false);
allOk = run(interpBin, "interpreter", {}) && allOk;

process.exit(allOk ? 0 : 1);
