/**
 * WinterTC Minimum Common API acceptance runner (isolate_todo.md). Builds a JS
 * program that exercises the self-contained web globals (TextEncoder/Decoder,
 * btoa/atob, queueMicrotask, performance, crypto, setInterval), links the host
 * entry, and asserts the fixture's own "RESULT <passed>/<total>" line reports a
 * full pass with no "FAIL:" lines — plain and under MAL_GC_STRESS + MAL_GC_VERIFY.
 *
 *   node scripts/webtest.ts [file.js]
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

function buildBinary(file: string, name: string): string {
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(path.resolve(file));
	const ir = compileSemanticProgramToIr(semanticProgram);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	const definition = lowerIrProgramToVmDefinition(ir);
	const cSource = emitVmDefinition(definition, { compiled: true });
	return buildLocalBinary({ name, cSource, verbose: false, mainFile: "runtime/host_main.c" });
}

function run(binary: string, label: string, env: NodeJS.ProcessEnv): boolean {
	process.stdout.write(`webtest ${label} ... `);
	try {
		const out = execFileSync(binary, { env: { ...process.env, ...env }, encoding: "utf-8", timeout: 20000 });
		const lines = out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		const failures = lines.filter((l) => l.startsWith("FAIL:"));
		const result = lines.find((l) => l.startsWith("RESULT "));
		const m = result?.match(/RESULT (\d+)\/(\d+)/);
		const ok = failures.length === 0 && m != null && m[1] === m[2] && Number(m[2]) > 0;
		console.log(ok ? `OK (${result})` : "FAIL");
		if (!ok) {
			for (const f of failures) console.log("  " + f);
			console.log("  result line:", result ?? "(none)");
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

const file = process.argv[2] ?? "tests/local/web_globals.js";
const bin = buildBinary(file, "webtest");
let allOk = run(bin, "compiled", {});
allOk = run(bin, "compiled + STRESS=1 + VERIFY", { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }) && allOk;

process.exit(allOk ? 0 : 1);
