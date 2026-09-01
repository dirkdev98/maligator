import type {
	CoreCompilation,
	CoreCompilationContext,
} from "../core/core-compilation.ts";
import { lowerSemanticProgramToCore } from "../core/core-frontend.ts";
import type { CoreVerificationProfile } from "../core/core-ir-verifier.ts";
import type { SealedCoreProgram } from "../core/core-ir.ts";
import type { CoreOptimizationReport } from "../core/core-optimization-report.ts";
import { optimizeCore } from "../core/optimize.ts";
import type { DirectEvalContext } from "../frontend/direct-eval-context.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import type { OptimizationAblation } from "../shared/compiler-diagnostics.ts";
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
	afterCoreOptimization?: (
		program: SealedCoreProgram,
		context: CoreCompilationContext,
		report: CoreOptimizationReport,
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
		collectOptimizationDiagnostics: options.profile === true,
		facts: {
			...(options.facts ?? conservativeCompilerProgramFacts()),
			compilationMode: options.optimization ?? "full",
		},
		runPhase,
	});
	const optimized = runPhase("optimize core ir", () =>
		optimizeCore(core, { verification: options.coreVerification }),
	);
	options.afterCoreOptimization?.(
		optimized.compilation.program,
		optimized.compilation.context,
		optimized.report,
	);
	return optimized.compilation;
}
