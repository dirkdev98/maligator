import type { CoreInstructionAttributes } from "./core-ir.ts";

export const CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE = "guardedInlineFallback";
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
