import { builtinPreservesIntegerInput } from "../shared/builtin-registry.ts";
import type { CompilerTypeofResult } from "../shared/compiler-instruction.ts";
import {
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	COMPILER_NUMERIC_BINARY_OPERATORS,
	compilerValueKindMaskIsSubset,
	compilerNumberFastPathInputKind,
	compilerTypeofComparison,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import { compilerIntegerRangeComparison } from "../shared/integer-range.ts";

export function nativeTypeofComparisonExpression(
	value: string,
	kind: CompilerValueKindMask,
	expected: CompilerTypeofResult,
): string {
	const constant = compilerTypeofComparison(kind, expected);
	if (constant !== undefined) return constant ? "true" : "false";
	if (expected !== "object") {
		const predicate =
			expected === "number"
				? "mal_ops_is_number"
				: expected === "function"
					? "mal_value_is_callable"
					: `mal_value_is_${expected}`;
		return `${predicate}(${value})`;
	}
	if ((kind & COMPILER_VALUE_KIND_OBJECT) === 0) return `mal_value_is_null(${value})`;
	// Object kinds include callable objects and arrays; null also fails IsCallable.
	if (
		compilerValueKindMaskIsSubset(
			kind,
			COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NULL,
		)
	)
		return `!mal_value_is_callable(${value})`;
	if ((kind & COMPILER_VALUE_KIND_NULL) === 0)
		return `(mal_value_is_object(${value}) && !mal_value_is_callable(${value}))`;
	return `mal_vm_typeof_compare(${value}, MAL_TYPEOF_OBJECT)`;
}

// Scalar views are noncoercing Number/Boolean/String reads; integer pairs exclude negative zero.
export function nativeEqualityExpression(
	semantics: "strict" | "same-value",
	left: string,
	right: string,
	leftKind: CompilerValueKindMask = COMPILER_VALUE_KIND_TOP,
	rightKind: CompilerValueKindMask = COMPILER_VALUE_KIND_TOP,
	leftScalar?: string,
	rightScalar?: string,
	integerPair = false,
	leftRange?: CompilerIntegerRange,
	rightRange?: CompilerIntegerRange,
): string {
	const common = leftKind & rightKind;
	if (left === right)
		return semantics === "same-value"
			? "true"
			: nativeReflexiveEqualityExpression(
					"===",
					left,
					common === COMPILER_VALUE_KIND_NUMBER ? leftScalar : undefined,
					common,
					integerPair || leftRange !== undefined || rightRange !== undefined,
				)!;
	if (common === 0) return "false";
	if (
		leftKind === rightKind &&
		(leftKind === COMPILER_VALUE_KIND_UNDEFINED || leftKind === COMPILER_VALUE_KIND_NULL)
	)
		return "true";
	const compared = compilerIntegerRangeComparison("===", leftRange, rightRange);
	if (compared !== undefined) return String(compared);
	if (
		leftKind === COMPILER_VALUE_KIND_BOOLEAN &&
		rightKind === leftKind &&
		leftScalar !== undefined &&
		rightScalar !== undefined
	)
		return `${leftScalar} == ${rightScalar}`;
	if (
		(common &
			(COMPILER_VALUE_KIND_NUMBER |
				COMPILER_VALUE_KIND_STRING |
				COMPILER_VALUE_KIND_BIGINT)) ===
		0
	)
		return `${left} == ${right}`;
	if (
		leftKind === COMPILER_VALUE_KIND_NUMBER ||
		rightKind === COMPILER_VALUE_KIND_NUMBER
	) {
		const a = leftScalar ?? `mal_ops_number_as_f64(${left})`;
		const b = rightScalar ?? `mal_ops_number_as_f64(${right})`;
		let equal: string;
		if (
			semantics === "strict" ||
			integerPair ||
			(leftRange !== undefined && rightRange !== undefined) ||
			(leftRange !== undefined && (leftRange.minimum > 0 || leftRange.maximum < 0)) ||
			(rightRange !== undefined && (rightRange.minimum > 0 || rightRange.maximum < 0))
		)
			equal = `${a} == ${b}`;
		else if (leftRange !== undefined)
			equal = `(${a} == ${b} && (${a} != 0.0 || !signbit(${b})))`;
		else if (rightRange !== undefined)
			equal = `(${a} == ${b} && (${b} != 0.0 || !signbit(${a})))`;
		else
			equal = `(${a} == ${b} ? (${a} != 0.0 || !!signbit(${a}) == !!signbit(${b})) : (isnan(${a}) && isnan(${b})))`;
		const guard =
			leftKind !== COMPILER_VALUE_KIND_NUMBER
				? `mal_ops_is_number(${left})`
				: rightKind !== COMPILER_VALUE_KIND_NUMBER
					? `mal_ops_is_number(${right})`
					: undefined;
		return guard === undefined ? equal : `(${guard} && (${equal}))`;
	}
	if (
		leftKind === COMPILER_VALUE_KIND_STRING ||
		rightKind === COMPILER_VALUE_KIND_STRING
	) {
		const a =
			leftKind === COMPILER_VALUE_KIND_STRING && leftScalar !== undefined
				? leftScalar
				: `mal_value_to_string(${left})`;
		const b =
			rightKind === COMPILER_VALUE_KIND_STRING && rightScalar !== undefined
				? rightScalar
				: `mal_value_to_string(${right})`;
		const equal = `mal_string_equals(${a}, ${b})`;
		const guard =
			leftKind !== COMPILER_VALUE_KIND_STRING
				? `mal_value_is_string(${left})`
				: rightKind !== COMPILER_VALUE_KIND_STRING
					? `mal_value_is_string(${right})`
					: undefined;
		return guard === undefined ? equal : `(${guard} && ${equal})`;
	}
	if (
		leftKind === COMPILER_VALUE_KIND_BIGINT ||
		rightKind === COMPILER_VALUE_KIND_BIGINT
	) {
		const equal = `mal_bigint_value(mal_value_to_bigint(${left})) == mal_bigint_value(mal_value_to_bigint(${right}))`;
		const guard =
			leftKind !== COMPILER_VALUE_KIND_BIGINT
				? `mal_value_is_bigint(${left})`
				: rightKind !== COMPILER_VALUE_KIND_BIGINT
					? `mal_value_is_bigint(${right})`
					: undefined;
		return guard === undefined ? equal : `(${guard} && (${equal}))`;
	}
	return semantics === "same-value" && (common & COMPILER_VALUE_KIND_NUMBER) !== 0
		? `mal_ops_same_value(${left}, ${right})`
		: `mal_ops_strict_equal_boxed(${left}, ${right})`;
}

export function nativeReflexiveEqualityExpression(
	operator: string,
	boxed: string,
	number: string | undefined,
	kind: CompilerValueKindMask = COMPILER_VALUE_KIND_TOP,
	excludesNaN = false,
): string | undefined {
	const equal = operator === "===" || operator === "==";
	if (!equal && operator !== "!==" && operator !== "!=") return undefined;
	const nan =
		excludesNaN || (kind & COMPILER_VALUE_KIND_NUMBER) === 0
			? "false"
			: number === undefined
				? `mal_value_is_nan(${boxed})`
				: `isnan(${number})`;
	return equal ? (nan === "false" ? "true" : `!(${nan})`) : nan;
}

// The caller proves the mathematical result fits int32, including exclusion of -0.
export function nativeInt32ArithmeticExpression(
	operator: string,
	left: string | undefined,
	right: string | undefined,
): string | undefined {
	return left !== undefined &&
		right !== undefined &&
		(operator === "+" || operator === "-" || operator === "*")
		? `(${left}) ${operator} (${right})`
		: undefined;
}

// A result proof must exclude signed overflow and negative zero before using C arithmetic.
export function nativeInt32UnaryExpression(
	operator: string,
	input: string | undefined,
): string | undefined {
	if (input === undefined) return undefined;
	switch (operator) {
		case "increment":
			return `(${input}) + 1`;
		case "decrement":
			return `(${input}) - 1`;
		case "-":
			return `-(${input})`;
		case "+":
		case "tonumeric":
			return input;
		default:
			return undefined;
	}
}

// Scalar views preserve the Number operands; only these interval proofs permit unsigned conversion.
export function nativeUnsignedRemainderExpression(
	left: string,
	right: string,
	dividend: CompilerIntegerRange | undefined,
	divisor: CompilerIntegerRange | undefined,
	leftScalar = left,
	rightScalar = right,
	result: "number" | "int32" = "number",
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
	return `(${result === "int32" ? "i32" : "f64"}) ((u32) (${leftScalar}) % (u32) (${rightScalar}))`;
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

export const OBJECT_BRAND_PREDICATES: ReadonlySet<string> = new Set([
	"ArrayBuffer.isView",
	"JSON.isRawJSON",
]);

export function nativeObjectBrandPredicateExpression(
	operation: string,
	value: string,
): string | undefined {
	switch (operation) {
		case "ArrayBuffer.isView":
			return `(mal_value_is_typed_array_object(${value}) || mal_value_is_data_view_object(${value}))`;
		case "JSON.isRawJSON":
			return `(mal_value_is_object(${value}) && mal_value_to_object(${value})->is_raw_json)`;
		default:
			return undefined;
	}
}

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

// A scalar view reads an existing Number; predicates never convert their input.
export function nativeNumberPredicateInputExpression(
	operation: string,
	boxed: string | undefined,
	kind: CompilerValueKindMask = COMPILER_VALUE_KIND_TOP,
	scalar?: string,
	range?: CompilerIntegerRange,
): string {
	if (boxed === undefined || (kind & COMPILER_VALUE_KIND_NUMBER) === 0) return "false";
	if (range !== undefined) return operation === "Number.isNaN" ? "false" : "true";
	return scalar === undefined
		? boxedNumberPredicateExpression(operation, boxed)
		: nativeNumberPredicateExpression(operation, scalar);
}

export function nativeMathUnaryExpr(
	operation: string,
	argument: string,
	range?: CompilerIntegerRange,
): string | null {
	if (range !== undefined) {
		if (builtinPreservesIntegerInput(operation)) return argument;
		if (operation === "Math.abs") {
			if (range.minimum >= 0) return argument;
			if (range.maximum < 0) return `-(${argument})`;
		}
		if (operation === "Math.sign") {
			if (range.minimum > 0) return "1.0";
			if (range.maximum < 0) return "-1.0";
			if (range.minimum === 0 && range.maximum === 0) return "0.0";
		}
	}
	const nativeCall = MATH_UNARY_NATIVE_CALL.get(operation);
	if (nativeCall === undefined) return null;
	if (nativeCall !== null) return `${nativeCall}(${argument})`;
	switch (operation) {
		case "Math.sign":
			return `mal_number_sign(${argument})`;
		case "Math.fround":
			return `(f64) (f32) ${argument}`;
		case "Math.round":
			return `mal_number_round(${argument})`;
		default:
			return null;
	}
}

export function nativeMathBinaryExpr(
	operation: string,
	left: string,
	right: string,
	ranges?: ReadonlyArray<CompilerIntegerRange | undefined>,
): string | null {
	if (!MATH_BINARY_OPERATIONS.has(operation)) return null;
	const a = ranges?.[0],
		b = ranges?.[1];
	if (a !== undefined && b !== undefined) {
		if (a.maximum <= b.minimum) return operation === "Math.min" ? left : right;
		if (b.maximum <= a.minimum) return operation === "Math.min" ? right : left;
	}
	return `mal_number_min_max(${left}, ${right}, ${operation === "Math.max"})`;
}

// Inputs are already Numbers; these kernels never coerce, throw or collect.
export function nativeNumericBuiltinExpr(
	operation: string,
	arguments_: ReadonlyArray<string>,
	ranges?: ReadonlyArray<CompilerIntegerRange | undefined>,
): string | null {
	if (NUMBER_PREDICATES.has(operation))
		return arguments_.length <= 1
			? nativeNumberPredicateInputExpression(
					operation,
					arguments_[0],
					COMPILER_VALUE_KIND_NUMBER,
					arguments_[0],
					ranges?.[0],
				)
			: null;
	if (arguments_.length === 1 && MATH_UNARY_NATIVE_CALL.has(operation))
		return nativeMathUnaryExpr(operation, arguments_[0]!, ranges?.[0]);
	if (arguments_.length === 2 && MATH_BINARY_OPERATIONS.has(operation))
		return nativeMathBinaryExpr(operation, arguments_[0]!, arguments_[1]!, ranges);
	const kernel = MATH_NUMBER_KERNELS[operation];
	if (kernel !== undefined && arguments_.length === kernel[1])
		return `${kernel[0]}(${arguments_.join(", ")})`;
	if (!MATH_VARIADIC_OPERATIONS.has(operation) || arguments_.length > 64) return null;
	const values =
		arguments_.length === 0 ? "nullptr" : `((f64[]){ ${arguments_.join(", ")} })`;
	return operation === "Math.hypot"
		? `mal_builtin_math_hypot_numbers(${values}, ${arguments_.length})`
		: `mal_builtin_math_min_max_numbers(${values}, ${arguments_.length}, ${operation === "Math.max"})`;
}
