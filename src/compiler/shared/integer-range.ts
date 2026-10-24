export interface CompilerIntegerRange {
	readonly minimum: number;
	readonly maximum: number;
	readonly exactSafeIntegers: true;
	readonly excludesNegativeZero: true;
}

export const COMPILER_INT32_RANGE: CompilerIntegerRange = Object.freeze({
	minimum: -0x8000_0000,
	maximum: 0x7fff_ffff,
	exactSafeIntegers: true,
	excludesNegativeZero: true,
});

export const COMPILER_UINT32_RANGE: CompilerIntegerRange = Object.freeze({
	minimum: 0,
	maximum: 0xffff_ffff,
	exactSafeIntegers: true,
	excludesNegativeZero: true,
});

export function compilerIntegerRangeIsValid(range: CompilerIntegerRange): boolean {
	return (
		range !== null &&
		typeof range === "object" &&
		Number.isSafeInteger(range.minimum) &&
		Number.isSafeInteger(range.maximum) &&
		range.minimum <= range.maximum &&
		!Object.is(range.minimum, -0) &&
		!Object.is(range.maximum, -0) &&
		range.exactSafeIntegers === true &&
		range.excludesNegativeZero === true
	);
}

export function compilerIntegerRangeIsInt32(
	range: CompilerIntegerRange | undefined,
): boolean {
	return (
		range !== undefined &&
		range.minimum >= COMPILER_INT32_RANGE.minimum &&
		range.maximum <= COMPILER_INT32_RANGE.maximum
	);
}

export function compilerIntegerRangesEqual(
	left: CompilerIntegerRange | undefined,
	right: CompilerIntegerRange | undefined,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.minimum === right.minimum &&
			left.maximum === right.maximum)
	);
}

export function compilerIntegerRangeTruthiness(
	range: CompilerIntegerRange | undefined,
): boolean | undefined {
	if (range === undefined) return undefined;
	if (range.minimum === 0 && range.maximum === 0) return false;
	return range.minimum > 0 || range.maximum < 0 ? true : undefined;
}

export function compilerIntegerRangeComparison(
	operator: string,
	left: CompilerIntegerRange | undefined,
	right: CompilerIntegerRange | undefined,
): boolean | undefined {
	if (left === undefined || right === undefined) return undefined;
	switch (operator) {
		case "<":
			return left.maximum < right.minimum
				? true
				: left.minimum >= right.maximum
					? false
					: undefined;
		case "<=":
			return left.maximum <= right.minimum
				? true
				: left.minimum > right.maximum
					? false
					: undefined;
		case ">":
			return left.minimum > right.maximum
				? true
				: left.maximum <= right.minimum
					? false
					: undefined;
		case ">=":
			return left.minimum >= right.maximum
				? true
				: left.maximum < right.minimum
					? false
					: undefined;
		case "==":
		case "===":
		case "!=":
		case "!==": {
			const equal =
				left.maximum < right.minimum || right.maximum < left.minimum
					? false
					: left.minimum === left.maximum && right.minimum === right.maximum
						? left.minimum === right.minimum
						: undefined;
			return equal === undefined
				? undefined
				: equal !== (operator === "!=" || operator === "!==");
		}
		default:
			return undefined;
	}
}
