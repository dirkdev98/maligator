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
