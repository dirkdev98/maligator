import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import { CoreProgramFlowEngine } from "./core-program-flow.ts";
import type { CoreProgramFlowReachabilityState } from "./core-program-flow.ts";
import type { CoreProgram } from "./core-store.ts";

export type CoreFunctionReachabilityState =
	CoreProgramFlowReachabilityState<CoreCallGraphIndex>;

export function analyzeCoreFunctionReachability(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	context: CoreCompilationContext,
	previous?: CoreFunctionReachabilityState,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
): CoreFunctionReachabilityState {
	return new CoreProgramFlowEngine(program).solveReachability(
		targets,
		context,
		previous,
		dirtyFunctions,
	);
}
