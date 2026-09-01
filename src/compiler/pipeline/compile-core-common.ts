import { attachCoreCompilerSiteFacts } from "../core/compiler-site-facts.ts";
import type {
	CoreCompilation,
	CoreCompilationContext,
} from "../core/core-compilation.ts";
import { lowerSemanticProgramToCore } from "../core/core-frontend.ts";
import type { CoreOptimizationPlan } from "../core/core-ir-regions.ts";
import type { CoreVerificationProfile } from "../core/core-ir-verifier.ts";
import type { SealedCoreProgram } from "../core/core-ir.ts";
import type { CoreOptimizationReport } from "../core/core-optimization-report.ts";
import { optimizeCore } from "../core/optimize.ts";
import type { DirectEvalContext } from "../frontend/direct-eval-context.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import { conservativeCompilerProgramFacts } from "../shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";

export type CompileCorePhase =
	| "construct core ir"
	| "optimize core ir"
	| "core to execution"
	| "execution to image";

export interface CompileCoreOptions {
	facts?: CompilerProgramFacts;
	optimization?: "development" | "full";
	/** Derive source-site identities and compiler remarks for a profiled image. */
	profile?: boolean;
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
	afterCoreOptimization?: (
		program: SealedCoreProgram,
		context: CoreCompilationContext,
		report: CoreOptimizationReport,
		plan: CoreOptimizationPlan,
	) => void;
	runPhase?: <T>(phase: CompileCorePhase, run: () => T) => T;
}

export function optimizeSemanticProgramToCore(
	semantic: SemanticProgram,
	options: CompileCoreOptions,
	runPhase: <T>(phase: CompileCorePhase, run: () => T) => T,
): CoreCompilation {
	const core = lowerSemanticProgramToCore(semantic, {
		...options.semanticLowering,
		facts: {
			...(options.facts ?? conservativeCompilerProgramFacts()),
			compilationMode: options.optimization ?? "full",
		},
		runPhase,
	});
	const optimizedResult = runPhase("optimize core ir", () =>
		optimizeCore(core, {
			verification: options.coreVerification,
			mode: options.optimization ?? "full",
		}),
	);
	const optimized =
		options.profile === true
			? attachCoreCompilerSiteFacts(optimizedResult.compilation)
			: optimizedResult.compilation;
	options.afterCoreOptimization?.(
		optimized.program,
		optimized.context,
		optimizedResult.report,
		optimized.plan,
	);
	return optimized;
}
