import type { VmRegisterRepresentation } from "./program-image.ts";

export const NATIVE_VALUE_CONVERSIONS = [
	"identity",
	"box-number",
	"box-int32",
	"box-boolean",
	"unbox-number",
	"unbox-int32",
	"unbox-boolean",
	"int32-to-number",
	"number-to-int32",
] as const;

export type NativeValueConversion = (typeof NATIVE_VALUE_CONVERSIONS)[number];
export function nativeValueConversion(
	source: VmRegisterRepresentation,
	target: VmRegisterRepresentation,
): NativeValueConversion | undefined {
	if (
		source === target ||
		((source === "boxed" || source === "string") &&
			(target === "boxed" || target === "string"))
	)
		return "identity";
	if (target === "boxed") {
		if (source === "number") return "box-number";
		if (source === "int32") return "box-int32";
		if (source === "boolean") return "box-boolean";
	}
	if (source === "boxed") {
		if (target === "number") return "unbox-number";
		if (target === "int32") return "unbox-int32";
		if (target === "boolean") return "unbox-boolean";
	}
	if (source === "int32" && target === "number") return "int32-to-number";
	if (source === "number" && target === "int32") return "number-to-int32";
	return undefined;
}
