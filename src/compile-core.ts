import type { OptimizationAblation } from "./compiler-diagnostics.ts";
import { conservativeCompilerProgramFacts } from "./compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler-facts.ts";
import { attachCoreCompilerSiteFacts } from "./compiler-site-facts.ts";
import {
	intermediateProgramToCore,
	lowerCoreProgramToRegisters,
} from "./core-ir-bridge.ts";
import { executeCoreOptimizations } from "./core-ir-opt.ts";
import type { CoreProgram } from "./core-ir.ts";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import { lowerCoreProgramToVmDefinition } from "./lower-vm.ts";
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
	semanticLowering?: {
		evalCompletion?: boolean;
		evalDirect?: boolean;
		directEvalContext?: DirectEvalContext;
	};
	afterCoreOptimization?: (program: CoreProgram) => void;
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
			...options.semanticLowering,
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
	const optimized = runPhase("core ir optimizations", () => {
		const result = executeCoreOptimizations(core, {
			ablations: options.optimizationAblations,
		}).program;
		return options.profile === true ? attachCoreCompilerSiteFacts(result) : result;
	});
	options.afterCoreOptimization?.(optimized);
	const lowered = runPhase("lower core ir", () =>
		lowerCoreProgramToRegisters(optimized),
	);
	runPhase("register allocation", () =>
		options.optimization === "development"
			? allocateDevelopmentRegisters(lowered)
			: allocateRegisters(lowered),
	);
	return runPhase("lower to vm", () =>
		lowerCoreProgramToVmDefinition(lowered, options.profile === true),
	);
}
