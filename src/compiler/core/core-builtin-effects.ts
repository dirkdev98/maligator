import { knownBuiltinInvocationEffects } from "../shared/builtin-invocation-effects.ts";
import { builtinNormalResultKinds } from "../shared/builtin-registry.ts";
import { COMPILER_VALUE_KIND_OBJECT } from "../shared/compiler-value-kinds.ts";
import type { CoreInstructionEffects, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export const CORE_KNOWN_BUILTIN_EFFECT_FACT = "known-builtin-effects";

export function coreKnownBuiltinInvocationEffects(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreInstructionEffects | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	return !attributes.construct &&
		attributes.argumentMode === undefined &&
		typeof attributes.operation === "string"
		? knownBuiltinInvocationEffects(attributes.operation)
		: undefined;
}

export function coreKnownBuiltinOnlyObservesOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const effects = coreKnownBuiltinInvocationEffects(fn, instruction);
	if (effects === undefined) return false;
	const operation = fn.instructionAttributes(instruction).operation as string;
	// IsArray only follows internal Proxy targets and throws a fresh TypeError on revocation.
	if (operation === "Array.isArray") return true;
	if (
		effects.writes.length > 0 ||
		effects.callsUserCode ||
		effects.maySuspend ||
		effects.mayThrow
	)
		return false;
	const result = builtinNormalResultKinds(operation);
	return result !== undefined && (result & COMPILER_VALUE_KIND_OBJECT) === 0;
}
