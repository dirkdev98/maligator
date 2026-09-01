import type {
	ConstructedCoreCompilation,
	CoreCompilation,
} from "./core-compilation.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";

export interface CoreOptimizationPlan {
	readonly directEntries: ReadonlyArray<never>;
	readonly specializations: ReadonlyArray<never>;
}

const EMPTY_OPTIMIZATION_PLAN: CoreOptimizationPlan = Object.freeze({
	directEntries: Object.freeze([]),
	specializations: Object.freeze([]),
});

export function optimizeCore(
	compilation: ConstructedCoreCompilation,
): CoreCompilation {
	verifyCoreProgram(
		compilation.program,
		{ stage: "pre-optimization" },
		compilation.context,
	);
	const program = compilation.program.seal();
	verifyCoreProgram(program, { stage: "pre-target" }, compilation.context);
	return Object.freeze({
		program,
		context: compilation.context,
		plan: EMPTY_OPTIMIZATION_PLAN,
	});
}
