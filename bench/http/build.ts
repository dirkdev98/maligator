/**
 * Build a maligator HTTP-server fixture into a native binary linked against the
 * HOST entry (runtime/host_main.c), which runs the reactor event loop that
 * Mal.serve needs. This mirrors scripts/fetchtest.ts's build pipeline; the plain
 * `maligator` CLI links test262_main.c, which has no event loop.
 *
 *   node bench/http/build.ts <file.js> <out-name>
 */
import * as path from "node:path";
import { emitVmDefinition } from "../../src/emit-vm.ts";
import { executeIROptimizations } from "../../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../../src/ir.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import { lowerIrProgramToVmDefinition } from "../../src/lower-vm.ts";
import { allocateRegisters } from "../../src/register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../../src/semantic-program.ts";

const file = process.argv[2];
const name = process.argv[3];
if (!file || !name) {
	console.error("usage: node bench/http/build.ts <file.js> <out-name>");
	process.exit(1);
}

const semanticProgram = loadEntrypointAndRunSemanticAnalysis(path.resolve(file));
const ir = compileSemanticProgramToIr(semanticProgram);
executeIROptimizations(ir);
allocateRegisters(ir);
const definition = lowerIrProgramToVmDefinition(ir);
const cSource = emitVmDefinition(definition, { compiled: true });
const binaryPath = buildLocalBinary({ name, cSource, verbose: false, mainFile: "runtime/host_main.c" });
console.log(binaryPath);
