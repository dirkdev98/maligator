import type { OptimizationAblation } from "./compiler-diagnostics.ts";
import { conservativeCompilerProgramFacts } from "./compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler-facts.ts";
import { ensureCompilerSiteFacts } from "./compiler-site-facts.ts";
import {
	coreProgramToIntermediate,
	intermediateProgramToCore,
} from "./core-ir-bridge.ts";
import { executeCoreOptimizations } from "./core-ir-opt.ts";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import type { IntermediateProgram } from "./ir.ts";
import { lowerIrProgramToVmDefinition } from "./lower-vm.ts";
import type { VmDefinition } from "./lower-vm.ts";
import { allocateDevelopmentRegisters, allocateRegisters } from "./register-alloc.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";

export type CompileCorePhase =
	| "lower semantic program"
	| "construct core ir"
	| "core ir optimizations"
	| "lower core ir"
	| "register allocation"
	| "lower to vm";

export interface CompileCoreOptions {
	facts?: CompilerProgramFacts;
	optimization?: "development" | "full";
	/** Derive source-site identities and compiler remarks for a profiled image. */
	profile?: boolean;
	/** Bounded pass groups disabled only for controlled attribution builds. */
	optimizationAblations?: ReadonlySet<OptimizationAblation>;
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
	const ir = runPhase("lower semantic program", () =>
		compileSemanticProgramToIr(semantic, {
			...options.ir,
			collectOptimizationDiagnostics: options.profile === true,
			facts: {
				...(options.facts ?? conservativeCompilerProgramFacts()),
				compilationMode: options.optimization ?? "full",
			},
		}),
	);
	const core = runPhase("construct core ir", () =>
		intermediateProgramToCore(ir, { verify: true }),
	);
	const optimized = runPhase("core ir optimizations", () =>
		({
			...core,
			core: executeCoreOptimizations(core.core, {
				ablations: options.optimizationAblations,
			}).program,
		}),
	);
	const lowered = runPhase("lower core ir", () =>
		coreProgramToIntermediate(optimized),
	);
	if (options.profile === true) ensureCompilerSiteFacts(lowered);
	options.afterOptimization?.(lowered);
	runPhase("register allocation", () =>
		options.optimization === "development"
			? allocateDevelopmentRegisters(lowered)
			: allocateRegisters(lowered),
	);
	return runPhase("lower to vm", () =>
		lowerIrProgramToVmDefinition(lowered, options.profile === true),
	);
}
