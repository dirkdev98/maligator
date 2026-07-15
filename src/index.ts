import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	assertEvalPolicy,
	assertRegexpPolicy,
	BuildConfigError,
	buildDerivationFromConfig,
	loadBuildConfig,
} from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { gmallocEnabled, runEnv } from "./build-flags.ts";
import { executeBinary } from "./cli-run.ts";
import { CLI_HELP, CliUsageError, MALIGATOR_VERSION, parseCliArgs } from "./cli.ts";
import type { BuildCommand, RunCommand } from "./cli.ts";
import { compileEntrypointToBuffer } from "./compile-program.ts";
import { emitVmDefinition } from "./emit-vm.ts";
import { dumpProgramEscape, dumpStackAlloc } from "./escape.ts";
import {
	debugHofInlineSites,
	debugInlinableCalls,
	debugMethodInlineSites,
	debugSpeculativeInlineSites,
} from "./inline.ts";
import { executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import { debugProgramLiveness } from "./liveness.ts";
import { buildLocalBinary } from "./local-build.ts";
import { lowerIrProgramToVmDefinition, vmDefinitionStats } from "./lower-vm.ts";
import { allocateRegisters } from "./register-alloc.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-program.ts";
import { serializeVmDefinition } from "./serialize-vm.ts";
import { stripTypesWithTypeScript } from "./typescript-strip.ts";
import { log } from "./utils.ts";

let command: BuildCommand | RunCommand;
try {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.kind === "help") {
		log.info(CLI_HELP);
		process.exit(0);
	}
	if (parsed.kind === "version") {
		log.info(MALIGATOR_VERSION);
		process.exit(0);
	}
	if (parsed.kind === "init" || parsed.kind === "doctor") {
		log.info(`error: 'maligator ${parsed.kind}' is not implemented yet`);
		process.exit(1);
	}
	command = parsed;
} catch (error) {
	if (error instanceof CliUsageError) {
		// eslint-disable-next-line no-console -- usage failures belong on stderr.
		console.error(`error: ${error.message}`);
		// eslint-disable-next-line no-console -- usage failures belong on stderr.
		console.error("Run 'maligator --help' for usage.");
		process.exit(2);
	}
	throw error;
}

if (command.kind === "build" && command.production) {
	log.info("error: '--production' is not implemented yet");
	process.exit(1);
}

// The build config (maligator.build.json) is the source of truth for engine
// capabilities. Absent → product defaults (eval OFF). A malformed / mistyped file
// fails fast with a clean message rather than a stack trace.
let buildConfig: ResolvedBuildConfig;
try {
	buildConfig = loadBuildConfig(command.configPath);
} catch (error) {
	if (error instanceof BuildConfigError) {
		log.info(`error: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

const entrypoint = command.entry ?? buildConfig.entry;
if (entrypoint === undefined) {
	log.info(
		"error: no entrypoint was provided and the build config has no 'entry'; " +
			"pass an entry or run 'maligator init'",
	);
	process.exit(1);
}
if (!existsSync(entrypoint)) {
	log.info(`error: entrypoint does not exist: ${path.resolve(entrypoint)}`);
	process.exit(1);
}
const entrypointPath = path.resolve(entrypoint);

const semTiming = log.time("semantic analysis");
// Pass the resolved build config into graph construction: it gates the `node`
// package export condition and `node:*` host built-in imports on surface.node.
const semanticProgram = loadEntrypointAndRunSemanticAnalysis(entrypointPath, {
	buildConfig,
	stripTypes: stripTypesWithTypeScript,
});
semTiming();

// Compile-time half of `engine.eval: false` enforcement (the runtime gate in
// builtin_eval.c is the other). Skipped for `--serialize`, which emits the wire
// definition for the baked compiler / eval tooling itself — internal, not a
// user build subject to the policy.
if (!(command.kind === "build" && command.internal.serializePath !== undefined)) {
	try {
		assertEvalPolicy(buildConfig, collectDisallowedEvalUsage(semanticProgram));
		assertRegexpPolicy(buildConfig, collectDisallowedRegexpUsage(semanticProgram));
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
if (command.kind === "build" && command.internal.dumpLiveness) {
	log.info(debugProgramLiveness(irProgram));
}

// Inliner eligibility analysis (task #6, foundation). Detection only — no
// transformation yet. `--dump-inline` lists the statically-known, inlinable direct
// `call` sites the substitution pass will consume.
if (command.kind === "build" && command.internal.dumpInline) {
	debugInlinableCalls(irProgram);
}

// HOF callback inlining eligibility (task #6, remaining). Detection only — no
// transformation yet. `--dump-hof` lists `arr.forEach(cb)`-style array-iteration
// sites whose callback resolves to an inlinable local function (the guarded
// substitution pass will consume these).
if (command.kind === "build" && command.internal.dumpHof) {
	debugHofInlineSites(irProgram);
}

// Speculative (guarded) direct-call inlining eligibility (call-opt phase B). Detection
// only — no transformation yet. `--dump-speculative` lists direct calls whose callee is a
// reassignable global with a known top-level function declaration, which a runtime
// function-index guard makes inlinable.
if (command.kind === "build" && command.internal.dumpSpeculative) {
	debugSpeculativeInlineSites(irProgram);
}

// Shape-guarded method inlining eligibility (call-opt phase C). Detection only.
// `--dump-methods` lists `obj.m()` sites whose method name uniquely resolves to an inlinable
// candidate — the sites a receiver-shape guard will make inlinable.
if (command.kind === "build" && command.internal.dumpMethods) {
	debugMethodInlineSites(irProgram);
}

// Escape / effect summary analysis (task #3 / §N.7). Detection only — no
// transformation. `--dump-escape` lists each function's parameter/receiver escape
// lattice, return provenance, effect flags, and the per-allocation escape kind the
// scalar-replacement (T7.4) and write-barrier-elision (T2.6) passes consume.
if (command.kind === "build" && command.internal.dumpEscape) {
	dumpProgramEscape(irProgram);
}

// Stack-allocation candidates (T7.4 / §N.7). Detection only. `--dump-stack-alloc`
// lists each single-assignment, non-escaping, shape-fixed shaped-object allocation
// and whether it is stack-only (identity observed) or also scalar-replaceable — the
// set emit-c places in the C root frame under MAL_STACK_ALLOC.
if (command.kind === "build" && command.internal.dumpStackAlloc) {
	dumpStackAlloc(irProgram);
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
const serializePath =
	command.kind === "build" ? command.internal.serializePath : undefined;
if (serializePath !== undefined) {
	const buffer = serializeVmDefinition(vmDefinition);
	writeFileSync(serializePath, buffer);
	log.info(`Serialized: ${serializePath} (${buffer.length} bytes)`);
	process.exit(0);
}

const output = emitVmDefinition(vmDefinition, {
	compiled: command.kind === "run" || command.internal.compiled,
});
if (command.kind === "build" && command.internal.emitC) {
	log.info(output);
}

const name = command.kind === "build" ? (command.internal.name ?? "out") : "out";
const verbose = command.kind === "build" && command.internal.verbose;

const buildTiming = log.time("build binary");
const binaryPath = buildLocalBinary({
	name,
	cSource: output,
	verbose,
	...buildDerivationFromConfig(buildConfig),
	compilerBake: {
		bake: () =>
			compileEntrypointToBuffer(path.resolve("src/eval-compiler-entry.mts"), {
				stripTypes: stripTypesWithTypeScript,
			}),
	},
});
buildTiming();
log.info(`Binary: ${binaryPath}`);

if (command.kind === "run") {
	if (gmallocEnabled()) {
		log.info("Running under Guard Malloc (MAL_GMALLOC).");
	}
	const outcome = executeBinary(binaryPath, command.programArgs, runEnv());
	if (outcome.status === 0) {
		log.info("Exit: 0");
	} else {
		log.info(
			`Exit: ${outcome.signal ? `signal ${outcome.signal}` : (outcome.status ?? "error")}`,
		);
		if (outcome.signal !== undefined) {
			process.kill(process.pid, outcome.signal);
		}
		process.exit(outcome.status ?? 1);
	}
}
