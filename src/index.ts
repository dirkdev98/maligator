import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { emitVmDefinition } from "./emit-vm.ts";
import { executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import { debugProgramLiveness } from "./liveness.ts";
import { buildLocalBinary } from "./local-build.ts";
import { lowerIrProgramToVmDefinition, vmDefinitionStats } from "./lower-vm.ts";
import { allocateRegisters } from "./register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-analysis.ts";
import { log } from "./utils.ts";

const FLAGS_WITH_VALUES = new Set(["--name"]);

function argValue(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function argFlag(name: string) {
	return process.argv.includes(name);
}

// The first non-flag argument is the entrypoint; flags may appear before it.
const positionals: Array<string> = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]!;
	if (arg.startsWith("--")) {
		if (FLAGS_WITH_VALUES.has(arg)) {
			i++;
		}
		continue;
	}
	positionals.push(arg);
}

const entrypoint = positionals[0];

if (!entrypoint || !existsSync(entrypoint)) {
	log.info(
		`Usage: maligator <entrypoint.js> [--name out] [--run] [--emit-c] [--verbose]`,
	);
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

// GC liveness/safepoint analysis (T0.4). The real consumer runs inside
// `lowerIrProgramToVmDefinition` (below, post-allocation) to minimize each
// compiled function's GC root frame (C1). This `--dump-liveness` dump runs on the
// pre-allocation virtual registers — handy for inspecting the safepoint map at the
// IR level, though the numbering differs from the post-allocation set the backend
// actually roots.
if (argFlag("--dump-liveness")) {
	log.info(debugProgramLiveness(irProgram));
}

const registerAllocTiming = log.time("register allocation");
allocateRegisters(irProgram);
registerAllocTiming();

const lowerTiming = log.time("lower to vm");
const vmDefinition = lowerIrProgramToVmDefinition(irProgram);
lowerTiming();

const stats = vmDefinitionStats(vmDefinition);
log.info(`Functions: ${stats.functionCount}, instructions: ${stats.instructionCount}`);

const output = emitVmDefinition(vmDefinition, {
	compiled: !argFlag("--no-compiled"),
});
if (argFlag("--emit-c") || argFlag("--print")) {
	log.info(output);
}

const name = argValue("--name") ?? "out";
const verbose = argFlag("--verbose");

const buildTiming = log.time("build binary");
const binaryPath = buildLocalBinary({ name, cSource: output, verbose });
buildTiming();
log.info(`Binary: ${binaryPath}`);

if (argFlag("--run")) {
	try {
		execFileSync(binaryPath, { stdio: "inherit" });
		log.info("Exit: 0");
	} catch (error) {
		const status = (error as { status?: number; signal?: string }).status;
		const signal = (error as { signal?: string }).signal;
		log.info(`Exit: ${signal ? `signal ${signal}` : (status ?? "error")}`);
	}
}
