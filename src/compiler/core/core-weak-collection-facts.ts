import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindCannotBeHeldWeakly,
} from "../shared/compiler-value-kinds.ts";
import { coreBuiltinCallInput } from "./core-builtin-result-projections.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export type CoreWeakCollectionResult = "get" | "predicate" | "mutator";

export interface CoreWeakCollectionKey {
	readonly result: CoreWeakCollectionResult;
	readonly input: CoreValueId | undefined;
}

export type CoreWeakCollectionNormalConstant =
	| { readonly kind: "undefined" }
	| { readonly kind: "boolean"; readonly value: false };

export function coreWeakCollectionKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreWeakCollectionKey | undefined {
	if (fn.instructionOpcodeName(instruction) !== "callKnown") return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (attributes.construct) return undefined;
	let result: CoreWeakCollectionResult;
	switch (attributes.operation) {
		case "WeakMap.prototype.get":
			result = "get";
			break;
		case "WeakMap.prototype.has":
		case "WeakMap.prototype.delete":
		case "WeakSet.prototype.has":
		case "WeakSet.prototype.delete":
			result = "predicate";
			break;
		case "WeakMap.prototype.set":
		case "WeakSet.prototype.add":
			result = "mutator";
			break;
		default:
			return undefined;
	}
	const key = coreBuiltinCallInput(fn, instruction, 1);
	return key === undefined ? undefined : { result, input: key.input };
}

export function coreWeakKeyNormalResultKinds(
	result: CoreWeakCollectionResult,
	key: number,
): number {
	if (key === 0) return 0;
	if (compilerValueKindCannotBeHeldWeakly(key))
		return result === "get"
			? COMPILER_VALUE_KIND_UNDEFINED
			: result === "predicate"
				? COMPILER_VALUE_KIND_BOOLEAN
				: 0;
	return result === "get"
		? COMPILER_VALUE_KIND_TOP
		: result === "predicate"
			? COMPILER_VALUE_KIND_BOOLEAN
			: COMPILER_VALUE_KIND_OBJECT;
}

// Receiver validation can still throw, so consumers replace result uses and retain the invocation.
export function coreWeakCollectionNormalConstant(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	mask: (value: CoreValueId) => number,
): CoreWeakCollectionNormalConstant | undefined {
	const key = coreWeakCollectionKey(fn, instruction);
	if (key === undefined || key.result === "mutator") return undefined;
	const kind = key.input === undefined ? COMPILER_VALUE_KIND_UNDEFINED : mask(key.input);
	if (!compilerValueKindCannotBeHeldWeakly(kind)) return undefined;
	return key.result === "get" ? { kind: "undefined" } : { kind: "boolean", value: false };
}
