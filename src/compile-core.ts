import { conservativeCompilerProgramFacts } from "./compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler-facts.ts";
import { ensureCompilerSiteFacts } from "./compiler-site-facts.ts";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import { executeIRDevelopmentOptimizations, executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import type { IntermediateProgram } from "./ir.ts";
import { lowerIrProgramToVmDefinition } from "./lower-vm.ts";
import type { VmDefinition } from "./lower-vm.ts";
import { allocateDevelopmentRegisters, allocateRegisters } from "./register-alloc.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";

export type CompileCorePhase =
	| "compile to ir"
	| "ir optimizations"
	| "register allocation"
	| "lower to vm";

export interface CompileCoreOptions {
	facts?: CompilerProgramFacts;
	optimization?: "development" | "full";
	/** Derive source-site identities and compiler remarks for a profiled image. */
	profile?: boolean;
	ir?: {
		evalCompletion?: boolean;
		evalDirect?: boolean;
		directEvalContext?: DirectEvalContext;
	};
	afterOptimization?: (program: IntermediateProgram) => void;
	runPhase?: <T>(phase: CompileCorePhase, run: () => T) => T;
}

/** Pure semantic-program pipeline shared by eval, CLI, and host tooling. */
export function compileSemanticProgramToVmDefinition(
	semantic: SemanticProgram,
	options: CompileCoreOptions = {},
): VmDefinition {
	const runPhase =
		options.runPhase ?? (<T>(_phase: CompileCorePhase, run: () => T): T => run());
	const ir = runPhase("compile to ir", () =>
		compileSemanticProgramToIr(semantic, {
			...options.ir,
			collectOptimizationDiagnostics: options.profile === true,
			facts: {
				...(options.facts ?? conservativeCompilerProgramFacts()),
				compilationMode: options.optimization ?? "full",
			},
		}),
	);
	runPhase("ir optimizations", () =>
		options.optimization === "development"
			? executeIRDevelopmentOptimizations(ir)
			: executeIROptimizations(ir),
	);
	if (options.profile === true) ensureCompilerSiteFacts(ir);
	options.afterOptimization?.(ir);
	runPhase("register allocation", () =>
		options.optimization === "development"
			? allocateDevelopmentRegisters(ir)
			: allocateRegisters(ir),
	);
	return runPhase("lower to vm", () =>
		lowerIrProgramToVmDefinition(ir, options.profile === true),
	);
}
