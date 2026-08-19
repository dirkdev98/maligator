import { intermediateProgramToCore } from "./core-ir-bridge.ts";
import type { CoreProgram } from "./core-ir.ts";
import type { CompilerProgramFacts } from "./compiler-facts.ts";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";

export interface CoreFrontendOptions {
	readonly evalCompletion?: boolean;
	readonly evalDirect?: boolean;
	readonly directEvalContext?: DirectEvalContext;
	readonly facts?: CompilerProgramFacts;
	readonly collectOptimizationDiagnostics?: boolean;
	readonly runPhase?: <T>(phase: "lower semantic program" | "construct core ir", run: () => T) => T;
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
		compileSemanticProgramToIr(semantic, {
			evalCompletion: options.evalCompletion,
			evalDirect: options.evalDirect,
			directEvalContext: options.directEvalContext,
			facts: options.facts,
			collectOptimizationDiagnostics: options.collectOptimizationDiagnostics,
		}),
	);
	return runPhase("construct core ir", () =>
		intermediateProgramToCore(lowered, { verify: true }),
	);
}
