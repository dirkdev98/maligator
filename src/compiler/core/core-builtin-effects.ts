import { knownBuiltinInvocationEffects } from "../shared/builtin-invocation-effects.ts";
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
