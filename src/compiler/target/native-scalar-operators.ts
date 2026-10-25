import {
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	COMPILER_NUMERIC_BINARY_OPERATORS,
	compilerValueKindMaskIsSubset,
	compilerNumberFastPathInputKind,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";

// Scalar views preserve the Number operands; only these interval proofs permit unsigned conversion.
export function nativeUnsignedRemainderExpression(
	left: string,
	right: string,
	dividend: CompilerIntegerRange | undefined,
	divisor: CompilerIntegerRange | undefined,
	leftScalar = left,
	rightScalar = right,
): string | undefined {
	if (
		dividend === undefined ||
		divisor === undefined ||
		dividend.minimum < 0 ||
		dividend.maximum > 0xffff_ffff ||
		divisor.minimum <= 0 ||
		divisor.maximum > 0xffff_ffff
	)
		return undefined;
	return `(f64) ((u32) (${leftScalar}) % (u32) (${rightScalar}))`;
}

// Guards license primitive Number conversion; a fallback must retain the original operands.
export function nativeBinaryNumberInputs(
	operator: string,
	leftKind: CompilerValueKindMask,
	rightKind: CompilerValueKindMask,
	left: string,
	right: string,
):
	| {
			readonly masks: readonly [CompilerValueKindMask, CompilerValueKindMask];
			readonly guard: string;
	  }
	| undefined {
	const relational =
		operator === "<" || operator === "<=" || operator === ">" || operator === ">=";
	if (!relational && !COMPILER_NUMERIC_BINARY_OPERATORS.has(operator)) return undefined;
	const leftMask = compilerNumberFastPathInputKind(operator, leftKind);
	const rightMask = compilerNumberFastPathInputKind(operator, rightKind);
	if (leftMask === 0 || rightMask === 0) return undefined;
	const leftGuard = nativeNumberInputGuard(leftKind, leftMask, left);
	const rightGuard = nativeNumberInputGuard(rightKind, rightMask, right);
	let guard =
		leftGuard === "" || leftGuard === rightGuard
			? rightGuard
			: rightGuard === ""
				? leftGuard
				: `${leftGuard} && ${rightGuard}`;
	if (relational && (leftMask & rightMask & COMPILER_VALUE_KIND_STRING) !== 0) {
		// Two Strings compare lexically; converting either of them changes the result.
		if (
			leftMask === COMPILER_VALUE_KIND_STRING &&
			rightMask === COMPILER_VALUE_KIND_STRING
		)
			return undefined;
		const strings =
			leftMask === COMPILER_VALUE_KIND_STRING || left === right
				? `mal_value_is_string(${right})`
				: rightMask === COMPILER_VALUE_KIND_STRING
					? `mal_value_is_string(${left})`
					: `mal_value_is_string(${left}) && mal_value_is_string(${right})`;
		guard = guard === "" ? `!(${strings})` : `${guard} && !(${strings})`;
	}
	return { masks: [leftMask, rightMask], guard };
}

function nativeNumberInputGuard(
	kind: CompilerValueKindMask,
	mask: CompilerValueKindMask,
	value: string,
): string {
	return kind === mask
		? ""
		: compilerValueKindMaskIsSubset(kind, COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE)
			? `!mal_value_is_string(${value})`
			: `mal_ops_is_number(${value})`;
}

// Callers exclude Object, Symbol and BigInt; the final arm deliberately has no tag test.
export function nativePrimitiveNumberExpression(
	value: string,
	mask: CompilerValueKindMask,
	number = `mal_ops_number_as_f64(${value})`,
	boolean = `mal_value_to_boolean(${value})`,
): string {
	if (mask === COMPILER_VALUE_KIND_NUMBER) return number;
	if (mask === COMPILER_VALUE_KIND_STRING) return `mal_ops_to_number(${value})`;
	if (mask === COMPILER_VALUE_KIND_BOOLEAN) return `(${boolean} ? 1.0 : 0.0)`;
	if (mask === COMPILER_VALUE_KIND_NULL) return "0.0";
	if (mask === COMPILER_VALUE_KIND_UNDEFINED) return '__builtin_nan("")';
	const choices = [
		{
			mask: COMPILER_VALUE_KIND_UNDEFINED,
			test: `mal_value_is_undefined(${value})`,
			value: '__builtin_nan("")',
		},
		{ mask: COMPILER_VALUE_KIND_NULL, test: `mal_value_is_null(${value})`, value: "0.0" },
		{
			mask: COMPILER_VALUE_KIND_BOOLEAN,
			test: `mal_value_is_boolean(${value})`,
			value: `(${boolean} ? 1.0 : 0.0)`,
		},
		{
			mask: COMPILER_VALUE_KIND_STRING,
			test: `mal_value_is_string(${value})`,
			value: `mal_ops_to_number(${value})`,
		},
		{ mask: COMPILER_VALUE_KIND_NUMBER, test: "true", value: number },
	].filter((choice) => (mask & choice.mask) !== 0);
	let expression = choices.pop()!.value;
	for (const choice of choices.reverse())
		expression = `(${choice.test} ? ${choice.value} : ${expression})`;
	return expression;
}

export const NATIVE_ARITH: Readonly<Record<string, string>> = {
	"+": "+",
	"-": "-",
	"*": "*",
	"/": "/",
};

export const NATIVE_COMPARE: Readonly<Record<string, string>> = {
	"<": "<",
	"<=": "<=",
	">": ">",
	">=": ">=",
	"===": "==",
	"==": "==",
	"!==": "!=",
	"!=": "!=",
};

export const NATIVE_BITWISE: Readonly<Record<string, string>> = {
	"&": "&",
	"|": "|",
	"^": "^",
	"<<": "<<",
	">>": ">>",
};

export const MATH_UNARY_NATIVE_CALL: ReadonlyMap<string, string | null> = new Map([
	["Math.abs", "fabs"],
	["Math.floor", "floor"],
	["Math.ceil", "ceil"],
	["Math.round", null],
	["Math.trunc", "trunc"],
	["Math.sqrt", "sqrt"],
	["Math.cbrt", "cbrt"],
	["Math.sign", null],
	["Math.log", "log"],
	["Math.log2", "log2"],
	["Math.log10", "log10"],
	["Math.exp", "exp"],
	["Math.sin", "sin"],
	["Math.cos", "cos"],
	["Math.tan", "tan"],
	["Math.asin", "asin"],
	["Math.acos", "acos"],
	["Math.atan", "atan"],
	["Math.sinh", "sinh"],
	["Math.cosh", "cosh"],
	["Math.tanh", "tanh"],
	["Math.asinh", "asinh"],
	["Math.acosh", "acosh"],
	["Math.atanh", "atanh"],
	["Math.log1p", "log1p"],
	["Math.expm1", "expm1"],
	["Math.fround", null],
] as const);

export const MATH_BINARY_OPERATIONS = new Set(["Math.min", "Math.max"]);

export function nativeGuardedMathArity(
	operation: string,
	argumentCount: number,
): 1 | 2 | undefined {
	return argumentCount === 1 && MATH_UNARY_NATIVE_CALL.has(operation)
		? 1
		: argumentCount === 2 && MATH_BINARY_OPERATIONS.has(operation)
			? 2
			: undefined;
}

export const MATH_NUMBER_KERNELS: Readonly<Record<string, readonly [string, number]>> = {
	"Math.clz32": ["mal_builtin_math_clz32_number", 1],
	"Math.f16round": ["mal_builtin_math_f16round_number", 1],
	"Math.imul": ["mal_builtin_math_imul_number", 2],
	"Math.pow": ["mal_builtin_math_pow_number", 2],
	"Math.atan2": ["atan2", 2],
};

export const MATH_VARIADIC_OPERATIONS = new Set(["Math.min", "Math.max", "Math.hypot"]);

/** The consumed numeric arguments; other arguments have already finished evaluation. */
export function nativeMathNumberArity(
	operation: string,
	argumentCount: number,
): number | undefined {
	if (MATH_VARIADIC_OPERATIONS.has(operation))
		return argumentCount <= 64 ? argumentCount : undefined;
	return MATH_UNARY_NATIVE_CALL.has(operation) ? 1 : MATH_NUMBER_KERNELS[operation]?.[1];
}

export const NUMBER_PREDICATES: ReadonlyMap<string, string> = new Map([
	["Number.isNaN", "MAL_NUMBER_PREDICATE_IS_NAN"],
	["Number.isFinite", "MAL_NUMBER_PREDICATE_IS_FINITE"],
	["Number.isInteger", "MAL_NUMBER_PREDICATE_IS_INTEGER"],
	["Number.isSafeInteger", "MAL_NUMBER_PREDICATE_IS_SAFE_INTEGER"],
]);

export function nativeNumberPredicateExpression(
	operation: string,
	value: string,
): string {
	switch (operation) {
		case "Number.isNaN":
			return `isnan(${value})`;
		case "Number.isFinite":
			return `isfinite(${value})`;
		case "Number.isInteger":
			return `isfinite(${value}) && trunc(${value}) == ${value}`;
		case "Number.isSafeInteger":
			return `isfinite(${value}) && trunc(${value}) == ${value} && fabs(${value}) <= 9007199254740991.0`;
		default:
			throw new Error(`Invalid native Number predicate ${operation}`);
	}
}

/** The predicate over any boxed value; none of these builtins coerces its argument. */
export function boxedNumberPredicateExpression(operation: string, value: string): string {
	const predicate = NUMBER_PREDICATES.get(operation);
	if (predicate === undefined)
		throw new Error(`Invalid native Number predicate ${operation}`);
	return `mal_builtin_number_value_${predicate.slice("MAL_NUMBER_PREDICATE_".length).toLowerCase()}(${value})`;
}
