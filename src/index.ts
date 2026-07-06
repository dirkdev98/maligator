import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	assertEvalPolicy,
	BuildConfigError,
	buildConfigCacheSuffix,
	loadBuildConfig,
} from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { gmallocEnabled, runEnv } from "./build-flags.ts";
import { emitVmDefinition } from "./emit-vm.ts";
import { dumpProgramEscape } from "./escape.ts";
import { debugHofInlineSites, debugInlinableCalls } from "./inline.ts";
import { executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import { debugProgramLiveness } from "./liveness.ts";
import { buildLocalBinary } from "./local-build.ts";
import { lowerIrProgramToVmDefinition, vmDefinitionStats } from "./lower-vm.ts";
import { allocateRegisters } from "./register-alloc.ts";
import { collectDisallowedEvalUsage } from "./semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-program.ts";
import { serializeVmDefinition } from "./serialize-vm.ts";
import { log } from "./utils.ts";

const FLAGS_WITH_VALUES = new Set(["--name", "--serialize", "--config"]);

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

// The build config (maligator.build.json) is the source of truth for engine
// capabilities. Absent → product defaults (eval OFF). A malformed / mistyped file
// fails fast with a clean message rather than a stack trace.
let buildConfig: ResolvedBuildConfig;
try {
	buildConfig = loadBuildConfig(argValue("--config"));
} catch (error) {
	if (error instanceof BuildConfigError) {
		log.info(`error: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

const semTiming = log.time("semantic analysis");
const semanticProgram = loadEntrypointAndRunSemanticAnalysis(entrypointPath);
semTiming();

// Compile-time half of `engine.eval: false` enforcement (the runtime gate in
// builtin_eval.c is the other). Skipped for `--serialize`, which emits the wire
// definition for the baked compiler / eval tooling itself — internal, not a
// user build subject to the policy.
if (!argFlag("--serialize")) {
	try {
		assertEvalPolicy(buildConfig, collectDisallowedEvalUsage(semanticProgram));
	} catch (error) {
		if (error instanceof BuildConfigError) {
			log.info(`error: ${error.message}`);
			process.exit(1);
		}
		throw error;
	}
}

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

// Inliner eligibility analysis (task #6, foundation). Detection only — no
// transformation yet. `--dump-inline` lists the statically-known, inlinable direct
// `call` sites the substitution pass will consume.
if (argFlag("--dump-inline")) {
	debugInlinableCalls(irProgram);
}

// HOF callback inlining eligibility (task #6, remaining). Detection only — no
// transformation yet. `--dump-hof` lists `arr.forEach(cb)`-style array-iteration
// sites whose callback resolves to an inlinable local function (the guarded
// substitution pass will consume these).
if (argFlag("--dump-hof")) {
	debugHofInlineSites(irProgram);
}

// Escape / effect summary analysis (task #3 / §N.7). Detection only — no
// transformation. `--dump-escape` lists each function's parameter/receiver escape
// lattice, return provenance, effect flags, and the per-allocation escape kind the
// scalar-replacement (T7.4) and write-barrier-elision (T2.6) passes consume.
if (argFlag("--dump-escape")) {
	dumpProgramEscape(irProgram);
}

const registerAllocTiming = log.time("register allocation");
allocateRegisters(irProgram);
registerAllocTiming();

const lowerTiming = log.time("lower to vm");
const vmDefinition = lowerIrProgramToVmDefinition(irProgram);
lowerTiming();

const stats = vmDefinitionStats(vmDefinition);
log.info(`Functions: ${stats.functionCount}, instructions: ${stats.instructionCount}`);

// Emit the binary wire format (consumed by mal_vm_load_definition / runtime
// eval) instead of building a C binary. Interpreter-only — no compiled bodies.
const serializePath = argValue("--serialize");
if (serializePath !== undefined) {
	const buffer = serializeVmDefinition(vmDefinition);
	writeFileSync(serializePath, buffer);
	log.info(`Serialized: ${serializePath} (${buffer.length} bytes)`);
	process.exit(0);
}

const output = emitVmDefinition(vmDefinition, {
	compiled: !argFlag("--no-compiled"),
});
if (argFlag("--emit-c") || argFlag("--print")) {
	log.info(output);
}

const name = argValue("--name") ?? "out";
const verbose = argFlag("--verbose");

const buildTiming = log.time("build binary");
const binaryPath = buildLocalBinary({
	name,
	cSource: output,
	verbose,
	evalEnabled: buildConfig.engine.eval,
	cacheSuffix: buildConfigCacheSuffix(buildConfig),
});
buildTiming();
log.info(`Binary: ${binaryPath}`);

if (argFlag("--run")) {
	if (gmallocEnabled()) {
		log.info("Running under Guard Malloc (MAL_GMALLOC).");
	}
	try {
		execFileSync(binaryPath, { stdio: "inherit", env: runEnv() });
		log.info("Exit: 0");
	} catch (error) {
		const status = (error as { status?: number; signal?: string }).status;
		const signal = (error as { signal?: string }).signal;
		log.info(`Exit: ${signal ? `signal ${signal}` : (status ?? "error")}`);
	}
}
