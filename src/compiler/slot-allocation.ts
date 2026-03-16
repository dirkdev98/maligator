import type { ProgramInformation } from "./program-info.ts";
import type { ScopeInformation } from "./program-info.ts";

export function doThreadAndEnvSlotAllocation(program: ProgramInformation) {
	doRegisterAllocation(program);
	doSlotAllocation(program);
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

/**
 * Give each escaped / hoisted variable a slot number and depth.
 *
 * These are values that have different lifetimes than a normal register / C-local variable.
 */
function doSlotAllocation(program: ProgramInformation) {
	const walkScopes = (scope: ScopeInformation, depth: number) => {
		const scopeTypesWithSlots: Array<ScopeInformation["type"]> = [
			"function",
			"module",
			"script-global",
			"static-block",
		];

		if (
			scopeTypesWithSlots.includes(scope.type) ||
			scope.bindings.values().some((it) => it.isCaptured)
		) {
			scope.envScopeDepth = depth = depth + 1;
		}

		let regIndex = 0;
		for (const [_name, binding] of scope.bindings) {
			if (binding.kind === "var" || binding.isCaptured) {
				binding.envLocation = {
					depth,
					slot: regIndex++,
				};
			}
		}

		let hasUsedChildSlots = false;

		for (const child of scope.children) {
			hasUsedChildSlots = walkScopes(child, depth) || hasUsedChildSlots;
		}

		if (regIndex === 0 && !hasUsedChildSlots) {
			if (scope.envScopeDepth >= 0) {
				scope.envScopeDepth = -1;
			}

			return false;
		}

		return regIndex > 0;
	};

	walkScopes(program.rootScope, -1);
}
