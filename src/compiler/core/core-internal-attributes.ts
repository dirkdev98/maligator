import type { CoreInstructionAttributes, CoreInstructionId } from "./core-ir.ts";

export const CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE = "guardedInlineFallback";
/** Eliminating this predicate requires SSA kinds that final verification can replay. */
export const CORE_REPLAYABLE_TYPEOF_ATTRIBUTE = "replayableTypeof";
/** A generator call that a guarded fusion keeps for its generic twin or a rebuild. */
export const CORE_GENERATOR_FUSION_TWIN_ATTRIBUTE = "generatorFusionTwin";
/** A global name load that a primordial-bindings guard already twinned. */
export const CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE = "primordialBindingTwin";
export const CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE =
	"containedDenseArrayElementRead";
export const CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE = "freshArrayLengthNumber";
export const CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE = "exactShapeOwnSlot";
export const CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE = "exactCollectionReceiver";
export const CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE = "exactTypedArrayKind";
export const CORE_CONTAINED_FIXED_TYPED_ARRAY_KIND_ATTRIBUTE =
	"containedFixedTypedArrayKind";
export const CORE_CONTAINED_FIXED_TYPED_ARRAY_LENGTH_ATTRIBUTE =
	"containedFixedTypedArrayLength";
export const CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE =
	"exactCallArgumentRepresentations";
export const CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE = "exactBinaryInputKindMasks";
export const CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE = "exactScalarAfterTdz";
export const CORE_STATIC_SELECTION_FALLBACK_ATTRIBUTE = "staticSelectionFallback";
export const CORE_CALL_RESULT_KIND_ATTRIBUTE = "callResultKindMask";
export const CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE = "normalResultIntegerRange";
export const CORE_NORMAL_RESULT_HEAP_BRAND_ATTRIBUTE = "normalResultHeapBrand";
export const CORE_RECORD_FIELD_KIND_ATTRIBUTE = "recordFieldKindMask";
export const CORE_KNOWN_OWN_DATA_ATTRIBUTE = "knownOwnData";
export const CORE_KNOWN_OWN_SLOT_ATTRIBUTE = "knownOwnSlot";

// Function-scoped effect proofs must be re-established after cloning or inlining.
export function coreUnscopedInstructionAttributes(
	attributes: CoreInstructionAttributes,
): CoreInstructionAttributes {
	if (attributes[CORE_KNOWN_OWN_DATA_ATTRIBUTE] === undefined) return attributes;
	const result = { ...attributes };
	delete result[CORE_KNOWN_OWN_DATA_ATTRIBUTE];
	return result;
}

export const CORE_SHAPE_ORIGIN_CAP = 4;

export interface CoreKnownOwnSlotCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
	readonly slot: number;
}

export interface CoreKnownOwnSlot {
	readonly candidates: ReadonlyArray<CoreKnownOwnSlotCandidate>;
}

export interface CoreShapeCaseCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: CoreInstructionId;
}

function nonnegativeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		!Object.is(value, -0)
	);
}

export function coreShapeCaseCandidatesFromAttribute(
	value: unknown,
): ReadonlyArray<CoreShapeCaseCandidate> | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > CORE_SHAPE_ORIGIN_CAP)
		return undefined;
	const candidates: Array<CoreShapeCaseCandidate> = [];
	for (const entry of value as ReadonlyArray<unknown>) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			return undefined;
		const candidate = entry as Record<string, unknown>;
		if (
			Object.keys(candidate).length !== 2 ||
			!nonnegativeInteger(candidate.shapeFunctionIndex) ||
			!nonnegativeInteger(candidate.shapeInstruction)
		)
			return undefined;
		if (
			candidates.some(
				(existing) =>
					existing.shapeFunctionIndex === candidate.shapeFunctionIndex &&
					existing.shapeInstruction === candidate.shapeInstruction,
			)
		)
			return undefined;
		candidates.push(
			Object.freeze({
				shapeFunctionIndex: candidate.shapeFunctionIndex,
				shapeInstruction: candidate.shapeInstruction as CoreInstructionId,
			}),
		);
	}
	return Object.freeze(candidates);
}

export function coreKnownOwnSlotFromAttribute(
	value: unknown,
): CoreKnownOwnSlot | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 1 ||
		!Array.isArray(record.candidates) ||
		record.candidates.length < 1 ||
		record.candidates.length > CORE_SHAPE_ORIGIN_CAP
	)
		return undefined;
	const candidates: Array<CoreKnownOwnSlotCandidate> = [];
	for (const entry of record.candidates as ReadonlyArray<unknown>) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			return undefined;
		const candidate = entry as Record<string, unknown>;
		if (
			Object.keys(candidate).length !== 3 ||
			!nonnegativeInteger(candidate.shapeFunctionIndex) ||
			!nonnegativeInteger(candidate.shapeInstruction) ||
			!nonnegativeInteger(candidate.slot)
		)
			return undefined;
		if (
			candidates.some(
				(existing) =>
					existing.shapeFunctionIndex === candidate.shapeFunctionIndex &&
					existing.shapeInstruction === candidate.shapeInstruction,
			)
		)
			return undefined;
		candidates.push(
			Object.freeze({
				shapeFunctionIndex: candidate.shapeFunctionIndex,
				shapeInstruction: candidate.shapeInstruction as CoreInstructionId,
				slot: candidate.slot,
			}),
		);
	}
	return Object.freeze({ candidates: Object.freeze(candidates) });
}
