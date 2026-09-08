import { UNICODE_VERSION } from "./unicode-data.ts";

export const CONSTANT_EVALUATOR_CONTRACT = "mal-binary64-utf16-i128-unicode17-v3";

export interface ConstantEvaluationTarget {
	readonly contract: string;
	readonly endianness: "little" | "big" | "unobserved";
	readonly numbers: "binary64-gradual-underflow" | "uncertified";
	readonly unicode?: string;
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
	| { readonly kind: "value"; readonly value: ConstantValue; readonly work: number }
	| {
			readonly kind: "throw";
			readonly error: "RangeError" | "TypeError";
			readonly stage: "invocation";
			readonly work: number;
	  }
	| {
			readonly kind: "unsupported";
			readonly reason: "uncertified-operation" | "target-contract" | "work-limit";
			readonly work: number;
	  };

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
	if (workLimit < 1) return unsupported("work-limit");
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
			// Integral powers of two are exact; other powers depend on the target libm.
			case "**": {
				if (b === 0) return number(1);
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
	if (operation.startsWith("bigint.unary:") && left?.kind === "bigint") {
		const halfRange = 1n << 126n;
		const minimum = -halfRange - halfRange,
			maximum = halfRange - 1n + halfRange;
		if (left.value < minimum || left.value > maximum)
			return unsupported("target-contract");
		switch (operation.slice(13)) {
			case "-":
				return left.value === minimum
					? unsupported("target-contract")
					: result({ kind: "bigint", value: -left.value });
			case "~":
				return result({ kind: "bigint", value: ~left.value });
			case "!":
				return boolean(left.value === 0n);
			case "tonumeric":
				return result(left);
		}
	}
	if (
		operation.startsWith("bigint.binary:") &&
		left?.kind === "bigint" &&
		right?.kind === "bigint"
	) {
		const halfRange = 1n << 126n;
		const minimum = -halfRange - halfRange,
			maximum = halfRange - 1n + halfRange;
		if (
			left.value < minimum ||
			left.value > maximum ||
			right.value < minimum ||
			right.value > maximum
		)
			return unsupported("target-contract");
		let value: bigint;
		switch (operation.slice(14)) {
			case "+":
				if (
					(right.value > 0n && left.value > maximum - right.value) ||
					(right.value < 0n && left.value < minimum - right.value)
				)
					return unsupported("target-contract");
				value = left.value + right.value;
				break;
			case "-":
				if (
					(right.value < 0n && left.value > maximum + right.value) ||
					(right.value > 0n && left.value < minimum + right.value)
				)
					return unsupported("target-contract");
				value = left.value - right.value;
				break;
			case "*":
				if (
					(left.value > 0n && right.value > 0n && left.value > maximum / right.value) ||
					(left.value > 0n && right.value < 0n && right.value < minimum / left.value) ||
					(left.value < 0n && right.value > 0n && left.value < minimum / right.value) ||
					(left.value < 0n && right.value < 0n && left.value < maximum / right.value)
				)
					return unsupported("target-contract");
				value = left.value * right.value;
				break;
			case "/":
			case "%":
				if (right.value === 0n)
					return { kind: "throw", error: "RangeError", stage: "invocation", work };
				if (left.value === minimum && right.value === -1n)
					return operation.endsWith("%")
						? result({ kind: "bigint", value: 0n })
						: unsupported("target-contract");
				value = operation.endsWith("/")
					? left.value / right.value
					: left.value % right.value;
				break;
			case "===":
				return boolean(left.value === right.value);
			default:
				return unsupported("uncertified-operation");
		}
		return value < minimum || value > maximum
			? unsupported("target-contract")
			: result({ kind: "bigint", value });
	}
	return unsupported("uncertified-operation");
}
