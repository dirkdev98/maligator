/**
 * Phase 1 host event-loop acceptance runner (isolate_todo.md). Builds a JS program
 * that uses setTimeout/clearTimeout + promises, links the host entry
 * (runtime/host_main.c) which runs the program then drives the event loop, and
 * asserts the exact stdout sequence — plain and under MAL_GC_STRESS + MAL_GC_VERIFY
 * (which proves pending timer callbacks stay GC-rooted).
 *
 *   node scripts/hosttest.ts [file.js]
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

const EXPECTED = [
	"start",
	"end",
	"microtask-1",
	"t:0",
	"t:args x y",
	"t:50 schedules another",
	"t:50 microtask",
	"t:nested",
	"t:100",
];

function buildBinary(file: string, name: string, compiled: boolean): string {
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(path.resolve(file));
	const ir = compileSemanticProgramToIr(semanticProgram);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	const definition = lowerIrProgramToVmDefinition(ir);
	const cSource = emitVmDefinition(definition, { compiled });
	return buildLocalBinary({ name, cSource, verbose: false, mainFile: "runtime/host_main.c" });
}

function run(binary: string, label: string, env: NodeJS.ProcessEnv): boolean {
	process.stdout.write(`hosttest ${label} ... `);
	try {
		const out = execFileSync(binary, {
			env: { ...process.env, ...env },
			encoding: "utf-8",
			timeout: 20000,
		});
		const lines = out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		const ok = lines.length === EXPECTED.length && lines.every((l, i) => l === EXPECTED[i]);
		console.log(ok ? `OK (${lines.length} lines)` : "FAIL");
		if (!ok) {
			console.log("  got:", JSON.stringify(lines));
			console.log("  exp:", JSON.stringify(EXPECTED));
		}
		return ok;
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		console.log("FAIL");
		if (e.stdout) console.log(e.stdout.trim());
		if (e.stderr) console.log(e.stderr.trim());
		return false;
	}
}

const file = process.argv[2] ?? "tests/local/host_settimeout.js";

const bin = buildBinary(file, "hosttest", true);
let allOk = run(bin, "compiled", {});
allOk = run(bin, "compiled + STRESS=1 + VERIFY", { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }) && allOk;

process.exit(allOk ? 0 : 1);
