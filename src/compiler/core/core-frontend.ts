import type { DirectEvalContext } from "../frontend/direct-eval-context.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import type { SourceFunctionOriginOptions } from "../frontend/source-function-origins.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import { constructSemanticProgramCore } from "./semantic-lowering.ts";

export interface CoreFrontendOptions {
	readonly pgoTraining?: boolean;
	readonly captureModuleExports?: boolean;
	readonly sourceOrigins?: SourceFunctionOriginOptions;
	readonly evalCompletion?: boolean;
	readonly evalDirect?: boolean;
	readonly directEvalContext?: DirectEvalContext;
	readonly facts?: CompilerProgramFacts;
	/** Engine implementation code reads intrinsic globals without freezing their properties. */
	readonly intrinsicGlobalReads?: boolean;
	readonly runPhase?: <T>(phase: "construct core ir", run: () => T) => T;
}

/** Product frontend boundary: semantic analysis enters canonical verified Core. */
export function lowerSemanticProgramToCore(
	semantic: SemanticProgram,
	options: CoreFrontendOptions = {},
): ConstructedCoreCompilation {
	const runPhase =
		options.runPhase ?? (<T>(_phase: "construct core ir", run: () => T): T => run());
	return runPhase("construct core ir", () =>
		constructSemanticProgramCore(semantic, {
			pgoTraining: options.pgoTraining,
			captureModuleExports: options.captureModuleExports,
			sourceOrigins: options.sourceOrigins,
			evalCompletion: options.evalCompletion,
			evalDirect: options.evalDirect,
			directEvalContext: options.directEvalContext,
			facts: options.facts,
			intrinsicGlobalReads: options.intrinsicGlobalReads,
		}),
	);
}
