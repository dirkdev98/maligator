import type { CompilerProgramFacts } from "./compiler-facts.ts";
import { buildCoreProgramFromSemanticGraph } from "./core-frontend-builder.ts";
import type { CoreProgram } from "./core-ir.ts";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";
import { lowerSemanticProgramToGraph } from "./semantic-lowering.ts";

export interface CoreFrontendOptions {
	readonly evalCompletion?: boolean;
	readonly evalDirect?: boolean;
	readonly directEvalContext?: DirectEvalContext;
	readonly facts?: CompilerProgramFacts;
	readonly collectOptimizationDiagnostics?: boolean;
	readonly runPhase?: <T>(
		phase: "lower semantic program" | "construct core ir",
		run: () => T,
	) => T;
}

/** Product frontend boundary: semantic analysis enters canonical verified Core. */
export function lowerSemanticProgramToCore(
	semantic: SemanticProgram,
	options: CoreFrontendOptions = {},
): CoreProgram {
	const runPhase =
		options.runPhase ??
		(<T>(_phase: "lower semantic program" | "construct core ir", run: () => T): T =>
			run());
	const lowered = runPhase("lower semantic program", () =>
		lowerSemanticProgramToGraph(semantic, {
			evalCompletion: options.evalCompletion,
			evalDirect: options.evalDirect,
			directEvalContext: options.directEvalContext,
			facts: options.facts,
			collectOptimizationDiagnostics: options.collectOptimizationDiagnostics,
		}),
	);
	return runPhase("construct core ir", () =>
		buildCoreProgramFromSemanticGraph(lowered, { verify: true }),
	);
}
