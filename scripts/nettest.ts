/**
 * Host TCP socket acceptance runner (isolate_todo.md — fetch-server groundwork).
 * Builds a real isolate, links the socket round-trip driver
 * (runtime/net_test_main.c), and runs it plain and under MAL_GC_STRESS +
 * MAL_GC_VERIFY.
 *
 *   node scripts/nettest.ts [file.js]   (default tests/local/fibertest_stub.js)
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
	return buildLocalBinary({
		name,
		cSource,
		verbose: false,
		mainFile: "runtime/net_test_main.c",
	});
}

function run(binary: string, label: string, env: NodeJS.ProcessEnv): boolean {
	process.stdout.write(`nettest ${label} ... `);
	try {
		const out = execFileSync(binary, {
			env: { ...process.env, ...env },
			encoding: "utf-8",
			timeout: 20000,
		});
		const match = out.match(/nettest PASS (\d+)\/(\d+)/);
		const ok = match != null && match[1] === match[2];
		console.log(ok ? `OK (${match[1]}/${match[2]})` : "FAIL");
		if (!ok) console.log(out.trim());
		return ok;
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		console.log("FAIL");
		if (e.stdout) console.log(e.stdout.trim());
		if (e.stderr) console.log(e.stderr.trim());
		return false;
	}
}

const file = process.argv[2] ?? "tests/local/fibertest_stub.js";

const bin = buildBinary(file, "nettest", true);
let allOk = run(bin, "compiled", {});
allOk = run(bin, "compiled + STRESS=1 + VERIFY", { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }) && allOk;

process.exit(allOk ? 0 : 1);
