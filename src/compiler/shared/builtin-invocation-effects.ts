import { builtinOperationDescriptor } from "./builtin-registry.ts";
import { NO_EFFECT_SUMMARY } from "./effect-summary.ts";
import type { EffectSummary } from "./effect-summary.ts";

const HOST_READ_EFFECTS: EffectSummary = Object.freeze({
	...NO_EFFECT_SUMMARY,
	reads: Object.freeze(["host"] as const),
});

const ARRAY_BRAND_EFFECTS: EffectSummary = Object.freeze({
	...NO_EFFECT_SUMMARY,
	reads: Object.freeze(["object-property"] as const),
	mayThrow: true,
	mayGc: true,
});

export function knownBuiltinInvocationEffects(
	operation: string,
): EffectSummary | undefined {
	return operation === "Array.isArray"
		? ARRAY_BRAND_EFFECTS
		: scalarBuiltinInvocationEffects(operation);
}

// The exact scalar kernels bypass call-bridge polling; receiver brand checks require separate proofs.
export function scalarBuiltinInvocationEffects(
	operation: string,
): EffectSummary | undefined {
	const descriptor = builtinOperationDescriptor(operation);
	if (
		descriptor?.receiver !== "none" ||
		!descriptor.lowerings.includes("exact-builtin-call") ||
		!descriptor.effects.every((effect) => effect === "read-host")
	)
		return undefined;
	return descriptor.effects.length === 0 ? NO_EFFECT_SUMMARY : HOST_READ_EFFECTS;
}
