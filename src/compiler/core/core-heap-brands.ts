import type { CompilerNumericTypedArrayKind } from "../shared/compiler-instruction.ts";

export type CoreNumericTypedArrayKind = CompilerNumericTypedArrayKind;
export type CoreExactCollectionBrand = "Map" | "Set" | "WeakMap" | "WeakSet";
export type CoreExactHeapBrand =
	| CoreNumericTypedArrayKind
	| CoreExactCollectionBrand
	| "Array";

// Null has no normal result yet; undefined has no brand constraint.
export type CoreHeapBrandState = CoreExactHeapBrand | null | undefined;

const NUMERIC_TYPED_ARRAY_KINDS: ReadonlySet<string> = new Set([
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
]);

export function coreNumericTypedArrayKind(
	value: unknown,
): CoreNumericTypedArrayKind | undefined {
	return typeof value === "string" && NUMERIC_TYPED_ARRAY_KINDS.has(value)
		? (value as CoreNumericTypedArrayKind)
		: undefined;
}

export function coreExactCollectionBrand(
	value: unknown,
): CoreExactCollectionBrand | undefined {
	return value === "Map" || value === "Set" || value === "WeakMap" || value === "WeakSet"
		? value
		: undefined;
}

export function coreExactHeapBrand(value: unknown): CoreExactHeapBrand | undefined {
	return value === "Array"
		? value
		: (coreExactCollectionBrand(value) ?? coreNumericTypedArrayKind(value));
}

export function joinCoreHeapBrands(
	left: CoreHeapBrandState,
	right: CoreHeapBrandState,
): CoreHeapBrandState {
	return left === null ? right : right === null || left === right ? left : undefined;
}
