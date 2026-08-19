import type { OptimizationAblation } from "./compiler-diagnostics.ts";
import { conservativeCompilerProgramFacts } from "./compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler-facts.ts";
import { attachCoreCompilerSiteFacts } from "./compiler-site-facts.ts";
import { lowerSemanticProgramToCore } from "./core-frontend.ts";
import { executeCoreOptimizations } from "./core-ir-opt.ts";
import type { CoreProgram } from "./core-ir.ts";
import { lowerCoreProgramToTarget } from "./core-target-lowering.ts";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import { lowerCoreProgramToVmDefinition } from "./lower-vm.ts";
import type { VmDefinition } from "./lower-vm.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";

export type CompileCorePhase =
	| "construct core ir"
	| "core ir optimizations"
	| "lower core ir"
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
	const core = lowerSemanticProgramToCore(semantic, {
		...options.semanticLowering,
		collectOptimizationDiagnostics: options.profile === true,
		facts: {
			...(options.facts ?? conservativeCompilerProgramFacts()),
			compilationMode: options.optimization ?? "full",
		},
		runPhase,
	});
	const optimized = runPhase("core ir optimizations", () => {
		const result = executeCoreOptimizations(core, {
			ablations: options.optimizationAblations,
		}).program;
		return options.profile === true ? attachCoreCompilerSiteFacts(result) : result;
	});
	options.afterCoreOptimization?.(optimized);
	const lowered = runPhase("lower core ir", () =>
		lowerCoreProgramToTarget(optimized, {
			reuseRegisters: options.optimization !== "development",
		}),
	);
	return runPhase("lower to vm", () =>
		lowerCoreProgramToVmDefinition(lowered, options.profile === true),
	);
}
