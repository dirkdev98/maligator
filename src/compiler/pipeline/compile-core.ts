import { attachCoreCompilerSiteFacts } from "../core/compiler-site-facts.ts";
import { lowerSemanticProgramToCore } from "../core/core-frontend.ts";
import { executeCoreOptimizations } from "../core/core-ir-opt.ts";
import type { CoreVerificationProfile } from "../core/core-ir-verifier.ts";
import type { CoreProgram } from "../core/core-ir.ts";
import type { DirectEvalContext } from "../frontend/direct-eval-context.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import type { OptimizationAblation } from "../shared/compiler-diagnostics.ts";
import { conservativeCompilerProgramFacts } from "../shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import { lowerCoreProgramToTarget } from "../target/core-target-lowering.ts";
import { lowerCoreProgramToVmDefinition } from "../target/lower-vm.ts";
import type { VmDefinition } from "../target/lower-vm.ts";

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
	/**
	 * Core verification depth. Boundary verification is unconditional; `per-pass`
	 * additionally attributes an invalid graph to the pass that produced it.
	 */
	coreVerification?: CoreVerificationProfile;
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
			...(options.coreVerification === undefined
				? {}
				: { verification: options.coreVerification }),
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
