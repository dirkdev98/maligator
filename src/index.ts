import { existsSync } from "node:fs";
import * as path from "node:path";
import { executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import { allocateRegisters } from "./register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-analysis.ts";
import { log } from "./utils.ts";

const entrypoint = process.argv[2];

if (!entrypoint || !existsSync(entrypoint)) {
	log.info(`Usage: maligator [./entyproint.js]`);
	process.exit(1);
}

const entrypointPath = path.resolve(entrypoint);

const semTiming = log.time("semantic analysis");
const semanticProgram = loadEntrypointAndRunSemanticAnalysis(entrypointPath);
semTiming();

const irTiming = log.time("compile to ir");
const irProgram = compileSemanticProgramToIr(semanticProgram);
irTiming();

const irOptTiming = log.time("ir optimizations");
executeIROptimizations(irProgram);
irOptTiming();

const registerAllocTiming = log.time("register allocation");
allocateRegisters(irProgram);
registerAllocTiming();
