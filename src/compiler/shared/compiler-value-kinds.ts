/**
 * Closed ECMAScript value-kind lattice shared by Core proof production and
 * target-plan consumers. These are semantic kinds, not physical register
 * representations: `number | undefined`, for example, remains boxed while still
 * proving that ToNumber cannot call user code or throw.
 */
export type CompilerValueKindMask = number;

export const COMPILER_VALUE_KIND_UNDEFINED = 1 << 0;
export const COMPILER_VALUE_KIND_NULL = 1 << 1;
export const COMPILER_VALUE_KIND_BOOLEAN = 1 << 2;
export const COMPILER_VALUE_KIND_NUMBER = 1 << 3;
export const COMPILER_VALUE_KIND_STRING = 1 << 4;
export const COMPILER_VALUE_KIND_BIGINT = 1 << 5;
export const COMPILER_VALUE_KIND_SYMBOL = 1 << 6;
export const COMPILER_VALUE_KIND_OBJECT = 1 << 7;

export const COMPILER_VALUE_KIND_TOP =
	COMPILER_VALUE_KIND_UNDEFINED |
	COMPILER_VALUE_KIND_NULL |
	COMPILER_VALUE_KIND_BOOLEAN |
	COMPILER_VALUE_KIND_NUMBER |
	COMPILER_VALUE_KIND_STRING |
	COMPILER_VALUE_KIND_BIGINT |
	COMPILER_VALUE_KIND_SYMBOL |
	COMPILER_VALUE_KIND_OBJECT;

export const COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED =
	COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED;

export const COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE =
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED |
	COMPILER_VALUE_KIND_NULL |
	COMPILER_VALUE_KIND_BOOLEAN;

export type CompilerOperatorInputKindMasks =
	| readonly [CompilerValueKindMask]
	| readonly [CompilerValueKindMask, CompilerValueKindMask];

export function compilerOperatorInputKindsHaveExactNativeSemantics(
	opcode: string,
	operator: unknown,
	masks: ReadonlyArray<CompilerValueKindMask>,
): masks is CompilerOperatorInputKindMasks {
	if (
		typeof operator !== "string" ||
		!masks.every((mask) => compilerValueKindMaskIsValid(mask))
	)
		return false;
	if (opcode === "unary") {
		if (masks.length !== 1) return false;
		switch (operator) {
			case "tostring":
				return masks[0] === COMPILER_VALUE_KIND_BOOLEAN;
			case "-":
			case "+":
			case "~":
			case "increment":
			case "decrement":
			case "tonumeric":
				return compilerValueKindMaskIsSubset(
					masks[0]!,
					COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
				);
			default:
				return false;
		}
	}
	if (opcode !== "binary" || masks.length !== 2) return false;
	let allowed: CompilerValueKindMask;
	switch (operator) {
		case "==":
		case "!=":
		case "===":
		case "!==":
			allowed = COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED;
			break;
		case "+":
		case "-":
		case "*":
		case "/":
		case "%":
		case "**":
		case "&":
		case "|":
		case "^":
		case "<<":
		case ">>":
		case ">>>":
		case "<":
		case "<=":
		case ">":
		case ">=":
			allowed = COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE;
			break;
		default:
			return false;
	}
	return masks.every((mask) => compilerValueKindMaskIsSubset(mask, allowed));
}

export function compilerValueKindMaskIsValid(
	value: unknown,
	options: { readonly allowEmpty?: boolean; readonly allowTop?: boolean } = {},
): value is CompilerValueKindMask {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= (options.allowEmpty === true ? 0 : 1) &&
		value <= COMPILER_VALUE_KIND_TOP &&
		(value & ~COMPILER_VALUE_KIND_TOP) === 0 &&
		(options.allowTop === true || value !== COMPILER_VALUE_KIND_TOP)
	);
}

export function compilerValueKindMaskIsSubset(
	value: CompilerValueKindMask,
	allowed: CompilerValueKindMask,
): boolean {
	return value !== 0 && (value & ~allowed) === 0;
}

export function compilerBuiltinInputKindsAreValid(
	masks: ReadonlyArray<CompilerValueKindMask>,
	operandCount: number,
): boolean {
	return (
		masks.length === operandCount &&
		masks.length >= 1 &&
		masks.length <= 17 &&
		masks.every(
			(mask) =>
				mask === COMPILER_VALUE_KIND_BOOLEAN ||
				mask === COMPILER_VALUE_KIND_NUMBER ||
				mask === COMPILER_VALUE_KIND_STRING ||
				mask === COMPILER_VALUE_KIND_TOP,
		)
	);
}
