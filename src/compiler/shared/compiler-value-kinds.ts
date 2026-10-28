import type { CompilerTypeofResult } from "./compiler-instruction.ts";
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
export const COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL = 1 << 6;
export const COMPILER_VALUE_KIND_OBJECT = 1 << 7;
export const COMPILER_VALUE_KIND_REGISTERED_SYMBOL = 1 << 8;
export const COMPILER_VALUE_KIND_SYMBOL =
	COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL | COMPILER_VALUE_KIND_REGISTERED_SYMBOL;

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

export const COMPILER_VALUE_KIND_NULLISH =
	COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_UNDEFINED;

export const COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE =
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED |
	COMPILER_VALUE_KIND_NULL |
	COMPILER_VALUE_KIND_BOOLEAN;

export const COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE =
	COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE | COMPILER_VALUE_KIND_STRING;

export const COMPILER_VALUE_KIND_TO_STRING_PRIMITIVE =
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE | COMPILER_VALUE_KIND_BIGINT;

export type CompilerOperatorInputKindMasks =
	| readonly [CompilerValueKindMask]
	| readonly [CompilerValueKindMask, CompilerValueKindMask];

// Number permits BigInt after object coercion; String special-cases only an input Symbol.
export function compilerPrimitiveConversionOperator(
	operation: string,
	mask: CompilerValueKindMask,
): "+" | "tostring" | undefined {
	if (!compilerValueKindMaskIsValid(mask, { allowTop: true })) return undefined;
	if (operation === "Number")
		return (mask & (COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_BIGINT)) === 0
			? "+"
			: undefined;
	if (operation === "String")
		return (mask & COMPILER_VALUE_KIND_SYMBOL) === 0 ? "tostring" : undefined;
	return undefined;
}

export const COMPILER_NUMERIC_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"-",
	"+",
	"~",
	"increment",
	"decrement",
	"tonumeric",
]);
export const COMPILER_NUMERIC_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);

// Equality must compare kinds before conversion; addition must retain concatenating Strings.
export function compilerNumberFastPathInputKind(
	operator: string,
	kind: CompilerValueKindMask,
): CompilerValueKindMask {
	if (kind === COMPILER_VALUE_KIND_NUMBER) return kind;
	if (operator === "===" || operator === "!==" || operator === "==" || operator === "!=")
		return kind & COMPILER_VALUE_KIND_NUMBER;
	return compilerValueKindMaskIsSubset(kind, COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE)
		? operator === "+"
			? kind & ~COMPILER_VALUE_KIND_STRING
			: kind
		: kind & COMPILER_VALUE_KIND_NUMBER;
}

// Primitive kinds ToPrimitive can produce from each kind; objects can produce any of them.
const MAY_BECOME_STRING = COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_OBJECT;
const MAY_BECOME_BIGINT = COMPILER_VALUE_KIND_BIGINT | COMPILER_VALUE_KIND_OBJECT;
const MAY_BECOME_NUMBER =
	COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE | COMPILER_VALUE_KIND_OBJECT;

/**
 * Transfers normal result kinds; zero denotes an unseeded lattice value, not an
 * unknown kind. Numeric operators yield a BigInt only when both operands can become
 * BigInts, since mixing a BigInt with a Number throws; Symbols always throw.
 */
export function compilerNumericResultKind(
	operation: "unary" | "binary" | "add",
	left: CompilerValueKindMask,
	right: CompilerValueKindMask = 0,
): CompilerValueKindMask {
	if (left === 0 || (operation !== "unary" && right === 0)) return 0;
	const bigint = (operand: CompilerValueKindMask) => (operand & MAY_BECOME_BIGINT) !== 0;
	if (operation === "unary")
		return COMPILER_VALUE_KIND_NUMBER | (bigint(left) ? COMPILER_VALUE_KIND_BIGINT : 0);
	const numeric =
		COMPILER_VALUE_KIND_NUMBER |
		(bigint(left) && bigint(right) ? COMPILER_VALUE_KIND_BIGINT : 0);
	if (operation === "binary") return numeric;
	const number =
		(left & MAY_BECOME_NUMBER) !== 0 && (right & MAY_BECOME_NUMBER) !== 0
			? COMPILER_VALUE_KIND_NUMBER
			: 0;
	return (
		(numeric & ~COMPILER_VALUE_KIND_NUMBER) |
		number |
		((left | right) & MAY_BECOME_STRING ? COMPILER_VALUE_KIND_STRING : 0)
	);
}

// Describes normal completion only; coercion can still call user code, collect or throw.
export function compilerOperatorFixedResultKind(
	opcode: string,
	operator: unknown,
): CompilerValueKindMask | undefined {
	if (opcode === "unary") {
		switch (operator) {
			case "+":
				return COMPILER_VALUE_KIND_NUMBER;
			case "!":
				return COMPILER_VALUE_KIND_BOOLEAN;
			case "typeof":
			case "tostring":
				return COMPILER_VALUE_KIND_STRING;
			case "void":
				return COMPILER_VALUE_KIND_UNDEFINED;
		}
	} else if (opcode === "binary") {
		switch (operator) {
			case "<":
			case "<=":
			case ">":
			case ">=":
			case "==":
			case "!=":
			case "===":
			case "!==":
				return COMPILER_VALUE_KIND_BOOLEAN;
		}
	}
	return undefined;
}

/**
 * Equality against a null or undefined operand needs no coercion: loose
 * equality is a nullish test and strict equality an encoding compare, so the
 * other operand may be unknown.
 */
export function compilerOperatorIsNullishEquality(
	opcode: string,
	operator: unknown,
	masks: ReadonlyArray<CompilerValueKindMask>,
): boolean {
	return (
		opcode === "binary" &&
		masks.length === 2 &&
		(operator === "==" ||
			operator === "!=" ||
			operator === "===" ||
			operator === "!==") &&
		masks.every((mask) => compilerValueKindMaskIsValid(mask, { allowTop: true })) &&
		masks.some((mask) => compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NULLISH))
	);
}

/**
 * `+` with a String operand concatenates; when the other operand is a
 * primitive whose ToString runs no user code and cannot throw, the whole
 * operation is a string conversion and a concatenation.
 */
export function compilerOperatorIsPrimitiveStringConcatenation(
	opcode: string,
	operator: unknown,
	masks: ReadonlyArray<CompilerValueKindMask>,
): boolean {
	return (
		opcode === "binary" &&
		operator === "+" &&
		masks.length === 2 &&
		masks.some((mask) => mask === COMPILER_VALUE_KIND_STRING) &&
		masks.every(
			(mask) =>
				compilerValueKindMaskIsValid(mask) &&
				compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_TO_STRING_PRIMITIVE),
		)
	);
}

export function compilerOperatorInputKindMasksAreValid(
	opcode: string,
	masks: ReadonlyArray<CompilerValueKindMask>,
): masks is CompilerOperatorInputKindMasks {
	return (
		((opcode === "unary" && masks.length === 1) ||
			(opcode === "binary" && masks.length === 2)) &&
		masks.every((mask) => compilerValueKindMaskIsValid(mask, { allowTop: true }))
	);
}

export function compilerOperatorInputKindsHaveExactNativeSemantics(
	opcode: string,
	operator: unknown,
	masks: ReadonlyArray<CompilerValueKindMask>,
): masks is CompilerOperatorInputKindMasks {
	if (compilerOperatorIsNullishEquality(opcode, operator, masks)) return true;
	if (compilerOperatorIsPrimitiveStringConcatenation(opcode, operator, masks))
		return true;
	if (
		typeof operator !== "string" ||
		!masks.every((mask) => compilerValueKindMaskIsValid(mask))
	)
		return false;
	if (opcode === "unary") {
		if (masks.length !== 1) return false;
		switch (operator) {
			case "tostring":
				return compilerValueKindMaskIsSubset(
					masks[0]!,
					COMPILER_VALUE_KIND_TO_STRING_PRIMITIVE,
				);
			case "-":
			case "+":
			case "~":
			case "increment":
			case "decrement":
			case "tonumeric":
				return compilerValueKindMaskIsSubset(
					masks[0]!,
					COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
				);
			default:
				return false;
		}
	}
	if (opcode !== "binary" || masks.length !== 2) return false;
	if (masks.every((mask) => mask === COMPILER_VALUE_KIND_STRING))
		return ["+", "<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(operator);
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

export function compilerComparisonInputKindsAvoidObjectCoercion(
	operator: string,
	masks: ReadonlyArray<CompilerValueKindMask>,
): boolean {
	if (
		compilerOperatorFixedResultKind("binary", operator) !== COMPILER_VALUE_KIND_BOOLEAN ||
		masks.length !== 2 ||
		!masks.every((mask) => compilerValueKindMaskIsValid(mask, { allowTop: true }))
	)
		return false;
	if (operator === "===" || operator === "!==") return true;
	const left = masks[0]!,
		right = masks[1]!;
	if (operator !== "==" && operator !== "!=")
		return ((left | right) & COMPILER_VALUE_KIND_OBJECT) === 0;
	const coerciblePrimitive =
		COMPILER_VALUE_KIND_TOP & ~(COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NULLISH);
	return !(
		((left & COMPILER_VALUE_KIND_OBJECT) !== 0 && (right & coerciblePrimitive) !== 0) ||
		((right & COMPILER_VALUE_KIND_OBJECT) !== 0 && (left & coerciblePrimitive) !== 0)
	);
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

export function compilerValueKindsHaveEmptyPrimitiveWrappers(
	mask: CompilerValueKindMask,
): boolean {
	return compilerValueKindMaskIsSubset(
		mask,
		COMPILER_VALUE_KIND_BOOLEAN |
			COMPILER_VALUE_KIND_NUMBER |
			COMPILER_VALUE_KIND_BIGINT |
			COMPILER_VALUE_KIND_SYMBOL,
	);
}

export function compilerValueKindCanBeHeldWeakly(mask: CompilerValueKindMask): boolean {
	return compilerValueKindMaskIsSubset(
		mask,
		COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
	);
}

export function compilerValueKindCannotBeHeldWeakly(
	mask: CompilerValueKindMask,
): boolean {
	return compilerValueKindMaskIsSubset(
		mask,
		COMPILER_VALUE_KIND_TOP &
			~(COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL),
	);
}

export function compilerBuiltinInputKindsAreValid(
	masks: ReadonlyArray<CompilerValueKindMask>,
	operandCount: number,
): boolean {
	return (
		masks.length === operandCount &&
		masks.length >= 1 &&
		masks.every((mask) => compilerValueKindMaskIsValid(mask, { allowTop: true }))
	);
}

export function compilerTypeofComparison(
	mask: CompilerValueKindMask,
	expected: CompilerTypeofResult,
): boolean | undefined {
	const kind =
		expected === "undefined"
			? COMPILER_VALUE_KIND_UNDEFINED
			: expected === "boolean"
				? COMPILER_VALUE_KIND_BOOLEAN
				: expected === "number"
					? COMPILER_VALUE_KIND_NUMBER
					: expected === "string"
						? COMPILER_VALUE_KIND_STRING
						: expected === "bigint"
							? COMPILER_VALUE_KIND_BIGINT
							: expected === "symbol"
								? COMPILER_VALUE_KIND_SYMBOL
								: expected === "object"
									? COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NULL
									: COMPILER_VALUE_KIND_OBJECT;
	if ((mask & kind) === 0) return false;
	if (expected === "function") return undefined;
	if (expected === "object") return mask === COMPILER_VALUE_KIND_NULL ? true : undefined;
	return compilerValueKindMaskIsSubset(mask, kind) ? true : undefined;
}

export function compilerValueKindTruthiness(
	mask: CompilerValueKindMask,
): boolean | undefined {
	if (compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NULLISH)) return false;
	if (
		compilerValueKindMaskIsSubset(
			mask,
			COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_SYMBOL,
		)
	)
		return true;
	return undefined;
}
