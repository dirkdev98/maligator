import type { CoreFunctionId } from "./core-ir.ts";

export const CORE_CALLEE_TARGET_CAP = 4;

export interface CoreCalleeTargets {
	// Finite provenance remains sorted and unique even when anyScript is set.
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
	readonly nonCallable: boolean;
}

export const CORE_CALLEE_TARGETS_BOTTOM: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: false,
	nonCallable: false,
});

export const CORE_CALLEE_TARGETS_NON_CALLABLE: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: false,
	nonCallable: true,
});

export const CORE_CALLEE_TARGETS_ANY_SCRIPT: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: true,
	opaque: false,
	nonCallable: false,
});

export const CORE_CALLEE_TARGETS_OPAQUE: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: true,
	nonCallable: true,
});

export const CORE_CALLEE_TARGETS_OPEN: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: true,
	opaque: true,
	nonCallable: true,
});

export const CORE_CALLEE_TARGETS_CALLABLE: CoreCalleeTargets = Object.freeze({
	...CORE_CALLEE_TARGETS_OPEN,
	nonCallable: false,
});

export const CORE_CALLEE_TARGETS_NATIVE_CALLABLE: CoreCalleeTargets = Object.freeze({
	...CORE_CALLEE_TARGETS_OPAQUE,
	nonCallable: false,
});

export function coreCalleeTargetsFunction(functionId: number): CoreCalleeTargets {
	return Object.freeze({
		functions: Object.freeze([functionId as CoreFunctionId]),
		anyScript: false,
		opaque: false,
		nonCallable: false,
	});
}

export function coreCalleeTargetsIsBottom(targets: CoreCalleeTargets): boolean {
	return (
		targets.functions.length === 0 &&
		!targets.anyScript &&
		!targets.opaque &&
		!targets.nonCallable
	);
}

// Class constructors remain callable even though ordinary invocation throws.
export function coreCalleeTargetsCallability(
	targets: CoreCalleeTargets,
): boolean | undefined {
	const callable = targets.opaque || targets.anyScript || targets.functions.length > 0;
	if (callable && !targets.nonCallable) return true;
	if (!callable && targets.nonCallable) return false;
	return undefined;
}

export function coreCalleeTargetsAreOpen(targets: CoreCalleeTargets): boolean {
	return targets.anyScript || targets.opaque || targets.nonCallable;
}

export function coreCalleeTargetsSingleFunction(
	targets: CoreCalleeTargets,
): CoreFunctionId | undefined {
	return targets.functions.length === 1 && !coreCalleeTargetsAreOpen(targets)
		? targets.functions[0]
		: undefined;
}

export const coreCalleeTargetsClosedFunction = coreCalleeTargetsSingleFunction;

export function coreCalleeTargetsEqual(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): boolean {
	if (left === right) return true;
	if (
		left.anyScript !== right.anyScript ||
		left.opaque !== right.opaque ||
		left.nonCallable !== right.nonCallable ||
		left.functions.length !== right.functions.length
	)
		return false;
	for (let index = 0; index < left.functions.length; index++)
		if (left.functions[index] !== right.functions[index]) return false;
	return true;
}

export function joinCoreCalleeTargets(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): CoreCalleeTargets {
	if (left === right || coreCalleeTargetsEqual(left, right)) return left;
	if (coreCalleeTargetsIsBottom(left)) return right;
	if (coreCalleeTargetsIsBottom(right)) return left;
	const functions: Array<CoreFunctionId> = [];
	let anyScript = left.anyScript || right.anyScript;
	if (!anyScript) {
		let leftIndex = 0,
			rightIndex = 0;
		while (leftIndex < left.functions.length || rightIndex < right.functions.length) {
			const leftFunction = left.functions[leftIndex];
			const rightFunction = right.functions[rightIndex];
			if (
				rightFunction === undefined ||
				(leftFunction !== undefined && leftFunction < rightFunction)
			) {
				functions.push(leftFunction!);
				leftIndex++;
			} else {
				functions.push(rightFunction);
				rightIndex++;
				if (leftFunction === rightFunction) leftIndex++;
			}
			if (functions.length > CORE_CALLEE_TARGET_CAP) {
				anyScript = true;
				functions.length = 0;
				break;
			}
		}
	}
	return Object.freeze({
		functions: Object.freeze(functions),
		anyScript,
		opaque: left.opaque || right.opaque,
		nonCallable: left.nonCallable || right.nonCallable,
	});
}
