/**
 * HTTP/1.1 request-parser unit-test runner (isolate_todo.md — fetch server).
 * Builds the pure-function parser test (runtime/http_test_main.c) and runs it.
 *
 *   node scripts/httptest.ts
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
	return buildLocalBinary({
		name,
		cSource,
		verbose: false,
		mainFile: "runtime/http_test_main.c",
	});
}

function run(binary: string): boolean {
	process.stdout.write("httptest ... ");
	try {
		const out = execFileSync(binary, { encoding: "utf-8", timeout: 20000 });
		const match = out.match(/httptest PASS (\d+)\/(\d+)/);
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

const bin = buildBinary("tests/local/fibertest_stub.js", "httptest");
process.exit(run(bin) ? 0 : 1);
