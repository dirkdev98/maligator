import type { ProgramInformation } from "./program-info.ts";
import type { ScopeInformation } from "./program-info.ts";

export function doThreadAndEnvSlotAllocation(program: ProgramInformation) {
	doRegisterAllocation(program);

	// TODO: slot allocation + depth tracking.
}

/**
 * Give each parameter a register number.
 *
 * When calling generated functions we have the following C signature:
 *
 * MalResult fn_some_function_in_some_file_js(MalThread *thread, MalEnv *env);
 *
 * The first register is always the return value, preinitialized to `undefined`.
 * The following registers are the bound function parameters. We can assume that we iterate over
 * them in the same order as the expected evaluation when collecting them from the Scope#bindings.
 *
 * Any local variable used can also be C local variables. Except for the captured variables, which
 * will reside in MalEnv.
 */
function doRegisterAllocation(program: ProgramInformation) {
	const walkScopes = (scope: ScopeInformation) => {
		let regIndex = 0;
		if (scope.type === "function") {
			for (const [_name, binding] of scope.bindings) {
				if (binding.kind === "param") {
					binding.register = regIndex++;
				}
			}

			scope.registerCount = regIndex;
		}

		for (const child of scope.children) {
			walkScopes(child);
		}
	};

	walkScopes(program.rootScope);
}
