import { BIGINT_MAX_BITS } from "./bigint-digits.ts";
import type { KnownBuiltinError } from "./known-builtin-errors.ts";
import { UNICODE_VERSION } from "./unicode-data.ts";

export const CONSTANT_EVALUATOR_CONTRACT = "mal-binary64-utf16-bigint-v5";

export interface ConstantEvaluationTarget {
	readonly contract: string;
	readonly endianness: "little" | "big" | "unobserved";
	readonly numbers: "binary64-gradual-underflow" | "uncertified";
	readonly unicode?: string;
	readonly intl?: boolean;
	readonly icu?: string;
	readonly tzdb?: string;
	readonly regexp?: string;
	readonly locale?: string;
	readonly timezone?: string;
}

export const PORTABLE_CONSTANT_TARGET: ConstantEvaluationTarget = Object.freeze({
	contract: CONSTANT_EVALUATOR_CONTRACT,
	endianness: "unobserved",
	numbers: "binary64-gradual-underflow",
	unicode: UNICODE_VERSION,
	locale: "en-US",
});

export type ConstantValue =
	| { readonly kind: "null"; readonly value: null }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "bigint"; readonly value: bigint }
	| { readonly kind: "undefined" };

export type ConstantEvaluation =
	| {
			readonly kind: "value";
			readonly value: ConstantValue;
			readonly work: number;
	  }
	| {
			readonly kind: "throw";
			readonly error: "RangeError" | "TypeError" | "SyntaxError" | "URIError";
			readonly builtinError?: KnownBuiltinError;
			readonly stage: "invocation";
			readonly work: number;
	  }
	| {
			readonly kind: "unsupported";
			readonly reason: "uncertified-operation" | "target-contract" | "work-limit";
			readonly work: number;
	  };

function bigintWordCost(value: bigint, bits: number): number | undefined {
	if (BigInt.asIntN(bits, value) !== value) return undefined;
	return Math.max(1, Math.ceil((value < 0n ? -value : value).toString(16).length / 8));
}

export function evaluateConstantOperation(
	operation: string,
	inputs: ReadonlyArray<ConstantValue>,
	target: ConstantEvaluationTarget = PORTABLE_CONSTANT_TARGET,
	workLimit = 4096,
): ConstantEvaluation {
	let work = 0;
	const unsupported = (
		reason: "uncertified-operation" | "target-contract" | "work-limit",
	): ConstantEvaluation => ({ kind: "unsupported", reason, work });
	if (
		target.contract !== CONSTANT_EVALUATOR_CONTRACT ||
		target.numbers !== "binary64-gradual-underflow"
	)
		return unsupported("target-contract");
	if (!Number.isSafeInteger(workLimit) || workLimit < 1) return unsupported("work-limit");
	work++;
	const result = (value: ConstantValue): ConstantEvaluation => ({
		kind: "value",
		value,
		work,
	});
	const number = (value: number) => result({ kind: "number", value });
	const boolean = (value: boolean) => result({ kind: "boolean", value });
	const left = inputs[0];
	const right = inputs[1];
	if (
		operation.startsWith("number.binary:") &&
		left?.kind === "number" &&
		right?.kind === "number"
	) {
		const a = left.value,
			b = right.value;
		switch (operation.slice(14)) {
			case "+":
				return number(a + b);
			case "-":
				return number(a - b);
			case "*":
				return number(a * b);
			case "/":
				return number(a / b);
			case "%":
				return number(a % b);
			case "&":
				return number(a & b);
			case "|":
				return number(a | b);
			case "^":
				return number(a ^ b);
			case "<<":
				return number(a << b);
			case ">>":
				return number(a >> b);
			case ">>>":
				return number(a >>> b);
			case "<":
				return boolean(a < b);
			case "<=":
				return boolean(a <= b);
			case ">":
				return boolean(a > b);
			case ">=":
				return boolean(a >= b);
			case "==":
			case "===":
				return boolean(a === b);
			case "!=":
			case "!==":
				return boolean(a !== b);
			case "**": {
				if (Number.isNaN(b)) return number(NaN);
				if (b === 0) return number(1);
				if (Number.isNaN(a)) return number(NaN);
				if (!Number.isFinite(b)) {
					const magnitude = Math.abs(a);
					return number(magnitude === 1 ? NaN : magnitude > 1 === b > 0 ? Infinity : 0);
				}
				const odd = Math.abs(b % 2) === 1;
				if (!Number.isFinite(a)) {
					const magnitude = b > 0 ? Infinity : 0;
					return number(a < 0 && odd ? -magnitude : magnitude);
				}
				if (a === 0) {
					const magnitude = b > 0 ? 0 : Infinity;
					return number(Object.is(a, -0) && odd ? -magnitude : magnitude);
				}
				if (a < 0 && b % 1 !== 0) return number(NaN);
				if (Math.abs(a) === 1) return number(a < 0 && odd ? -1 : 1);
				if (b === 1) return number(a);
				// Integral powers of two are exact; general finite powers depend on target libm.
				if (a !== 2 || b % 1 !== 0 || b < -1074 || b > 1023)
					return unsupported("uncertified-operation");
				let value = 1;
				const magnitude = b < 0 ? -b : b;
				if (work + magnitude > workLimit) return unsupported("work-limit");
				for (let index = 0; index < magnitude; index++) {
					work++;
					value = b < 0 ? value / 2 : value * 2;
				}
				return number(value);
			}
		}
	}
	if (operation.startsWith("number.unary:") && left?.kind === "number") {
		switch (operation.slice(13)) {
			case "!":
				return boolean(!left.value);
			case "-":
				return number(-left.value);
			case "+":
			case "tonumeric":
				return number(left.value);
			case "~":
				return number(~left.value);
			case "increment":
				return number(left.value + 1);
			case "decrement":
				return number(left.value - 1);
		}
	}
	if (operation === "string.integer-number" && left?.kind === "string") {
		const text = left.value;
		if (text.length + work > workLimit) return unsupported("work-limit");
		let value = 0;
		let index = text[0] === "+" || text[0] === "-" ? 1 : 0;
		if (index === text.length && index !== 0) return unsupported("uncertified-operation");
		for (; index < text.length; index++) {
			work++;
			const digit = text.charCodeAt(index) - 48;
			if (digit < 0 || digit > 9 || value > 900719925474098)
				return unsupported("uncertified-operation");
			value = value * 10 + digit;
		}
		return number(text[0] === "-" ? -value : value);
	}
	if (
		operation === "string.code-unit" &&
		left?.kind === "string" &&
		right?.kind === "number"
	) {
		if (right.value % 1 !== 0) return unsupported("uncertified-operation");
		if (right.value < 0 || right.value >= left.value.length) return number(NaN);
		return number(left.value.charCodeAt(right.value));
	}
	if (operation === "string.length" && left?.kind === "string")
		return number(left.value.length);
	const foldBits = Math.min(BIGINT_MAX_BITS, Math.floor(workLimit) * 32);
	const spend = (cost: number): boolean => {
		if (!Number.isSafeInteger(cost) || work + cost > workLimit) return false;
		work += cost;
		return true;
	};
	if (operation.startsWith("bigint.unary:") && left?.kind === "bigint") {
		const operator = operation.slice(13);
		if (operator === "!") return boolean(left.value === 0n);
		if (operator === "tonumeric") return result(left);
		const cost = bigintWordCost(left.value, foldBits);
		if (cost === undefined || !spend(cost)) return unsupported("work-limit");
		let value: bigint;
		switch (operator) {
			case "-":
				value = -left.value;
				break;
			case "~":
				value = ~left.value;
				break;
			case "increment":
				value = left.value + 1n;
				break;
			case "decrement":
				value = left.value - 1n;
				break;
			default:
				return unsupported("uncertified-operation");
		}
		return bigintWordCost(value, foldBits) === undefined
			? unsupported("work-limit")
			: result({ kind: "bigint", value });
	}
	if (
		operation.startsWith("bigint.binary:") &&
		left?.kind === "bigint" &&
		right?.kind === "bigint"
	) {
		const operator = operation.slice(14);
		if (
			((operator === "/" || operator === "%") && right.value === 0n) ||
			(operator === "**" && right.value < 0n)
		)
			return { kind: "throw", error: "RangeError", stage: "invocation", work };
		if (operator === "**" && right.value === 0n)
			return result({ kind: "bigint", value: 1n });
		const a = bigintWordCost(left.value, foldBits),
			b = bigintWordCost(right.value, foldBits);
		if (a === undefined || b === undefined) return unsupported("work-limit");
		const cost =
			operator === "*" || operator === "/" || operator === "%" ? a * b : Math.max(a, b);
		if (!spend(cost)) return unsupported("work-limit");
		let value: bigint;
		switch (operator) {
			case "+":
				value = left.value + right.value;
				break;
			case "-":
				value = left.value - right.value;
				break;
			case "*":
				value = left.value * right.value;
				break;
			case "/":
				value = left.value / right.value;
				break;
			case "%":
				value = left.value % right.value;
				break;
			case "&":
				value = left.value & right.value;
				break;
			case "|":
				value = left.value | right.value;
				break;
			case "^":
				value = left.value ^ right.value;
				break;
			case "**": {
				if (left.value === 0n || left.value === 1n) {
					value = left.value;
					break;
				}
				if (left.value === -1n) {
					value = (right.value & 1n) === 0n ? 1n : -1n;
					break;
				}
				if (right.value > BigInt(foldBits)) return unsupported("work-limit");
				let base = left.value,
					exponent = right.value;
				value = 1n;
				while (exponent > 0n) {
					if ((exponent & 1n) !== 0n) {
						const x = bigintWordCost(value, foldBits),
							y = bigintWordCost(base, foldBits);
						if (x === undefined || y === undefined || !spend(x * y))
							return unsupported("work-limit");
						value *= base;
					}
					exponent >>= 1n;
					if (exponent === 0n) break;
					const words = bigintWordCost(base, foldBits);
					if (words === undefined || !spend(words * words))
						return unsupported("work-limit");
					base *= base;
				}
				break;
			}
			case "<<":
			case ">>": {
				const leftward = (operator === "<<") !== right.value < 0n;
				const count = right.value < 0n ? -right.value : right.value;
				if (left.value === 0n) {
					value = 0n;
					break;
				}
				if (count >= BigInt(foldBits)) {
					if (leftward) return unsupported("work-limit");
					value = left.value < 0n ? -1n : 0n;
					break;
				}
				if (leftward && !spend(Math.ceil(Number(count) / 32)))
					return unsupported("work-limit");
				value = leftward ? left.value << count : left.value >> count;
				break;
			}
			case "==":
			case "===":
				return boolean(left.value === right.value);
			case "!=":
			case "!==":
				return boolean(left.value !== right.value);
			case "<":
				return boolean(left.value < right.value);
			case "<=":
				return boolean(left.value <= right.value);
			case ">":
				return boolean(left.value > right.value);
			case ">=":
				return boolean(left.value >= right.value);
			default:
				return unsupported("uncertified-operation");
		}
		return bigintWordCost(value, foldBits) === undefined
			? unsupported("work-limit")
			: result({ kind: "bigint", value });
	}

	return unsupported("uncertified-operation");
}
