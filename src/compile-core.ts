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
import { executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import type { IntermediateProgram } from "./ir.ts";
import { lowerIrProgramToVmDefinition } from "./lower-vm.ts";
import type { VmDefinition } from "./lower-vm.ts";
import { allocateDevelopmentRegisters, allocateRegisters } from "./register-alloc.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";

export type CompileCorePhase =
	| "compile to ir"
	| "normalize semantic ir"
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
	/** Verify the read-only production Core import as an explicit diagnostic. */
	verifyCoreIr?: boolean;
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
	runPhase("normalize semantic ir", () =>
		options.optimization === "development"
			? undefined
			: executeIROptimizations(ir, { ablations: options.optimizationAblations }),
	);
	const usesCoreLowering = options.optimization === "development";
	const constructsCore = usesCoreLowering || options.verifyCoreIr === true;
	const core = runPhase("construct core ir", () =>
		constructsCore
			? intermediateProgramToCore(ir, {
					verify: true,
					retainLoweringMetadata: usesCoreLowering,
				})
			: undefined,
	);
	const optimized = runPhase("core ir optimizations", () =>
		usesCoreLowering && core !== undefined
			? {
					...core,
					core: executeCoreOptimizations(core.core, {
						ablations: options.optimizationAblations,
					}).program,
				}
			: core,
	);
	const lowered = runPhase("lower core ir", () =>
		usesCoreLowering && optimized !== undefined
			? coreProgramToIntermediate(optimized)
			: ir,
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
