import {
	evaluateConstantOperation,
	PORTABLE_CONSTANT_TARGET,
} from "./constant-evaluator.ts";
import type {
	ConstantEvaluation,
	ConstantEvaluationTarget,
	ConstantValue,
} from "./constant-evaluator.ts";
import {
	formatConstantNumber,
	formatConstantNumberRadix,
} from "./constant-number-format.ts";
import { knownBuiltinErrors } from "./known-builtin-errors.ts";
import type { KnownBuiltinError } from "./known-builtin-errors.ts";
import { stringCaseLocale } from "./string-case-locale.ts";
import { UNICODE_VERSION } from "./unicode-data.ts";
import { normalizeUnicode, transformUnicodeCase } from "./unicode-transform.ts";

const absent: ConstantValue = { kind: "undefined" };

function mathUnarySpecialCase(operation: string, value: number): number | undefined {
	switch (operation) {
		case "Math.sin":
		case "Math.tan":
			if (value === 0) return value;
			return !Number.isFinite(value) ? NaN : undefined;
		case "Math.asin":
			if (value === 0) return value;
			return Math.abs(value) > 1 || Number.isNaN(value) ? NaN : undefined;
		case "Math.acos":
			if (value === 1) return 0;
			return Math.abs(value) > 1 || Number.isNaN(value) ? NaN : undefined;
		case "Math.atan":
			return value === 0 || Number.isNaN(value) ? value : undefined;
		case "Math.cbrt":
		case "Math.sinh":
		case "Math.asinh":
			return value === 0 || !Number.isFinite(value) ? value : undefined;
		case "Math.acosh":
			if (value < 1 || Number.isNaN(value)) return NaN;
			if (value === 1) return 0;
			return value === Infinity ? Infinity : undefined;
		case "Math.atanh":
			if (value === 0) return value;
			if (Math.abs(value) > 1 || Number.isNaN(value)) return NaN;
			if (value === 1) return Infinity;
			return value === -1 ? -Infinity : undefined;
		case "Math.cos":
			if (value === 0) return 1;
			return !Number.isFinite(value) ? NaN : undefined;
		case "Math.cosh":
			if (value === 0) return 1;
			if (Number.isNaN(value)) return NaN;
			return !Number.isFinite(value) ? Infinity : undefined;
		case "Math.tanh":
			if (value === 0 || Number.isNaN(value)) return value;
			if (value === Infinity) return 1;
			return value === -Infinity ? -1 : undefined;
		case "Math.exp":
			if (value === 0) return 1;
			if (value === -Infinity) return 0;
			return !Number.isFinite(value) ? value : undefined;
		case "Math.expm1":
			if (value === 0 || Number.isNaN(value) || value === Infinity) return value;
			return value === -Infinity ? -1 : undefined;
		case "Math.log":
		case "Math.log2":
		case "Math.log10":
			if (value === 0) return -Infinity;
			if (value < 0 || Number.isNaN(value)) return NaN;
			if (value === 1) return 0;
			return value === Infinity ? Infinity : undefined;
		case "Math.log1p":
			if (value === 0 || Number.isNaN(value) || value === Infinity) return value;
			if (value === -1) return -Infinity;
			return value < -1 ? NaN : undefined;
		case "Math.sqrt":
			if (value < 0) return NaN;
			return value === 0 || !Number.isFinite(value) ? value : undefined;
	}
	return undefined;
}

function numeric(value: ConstantValue | undefined): number | undefined {
	if (value === undefined || value.kind === "bigint") return undefined;
	if (value.kind === "number") return value.value;
	if (value.kind === "null") return 0;
	if (value.kind === "undefined") return NaN;
	if (value.kind === "boolean") return value.value ? 1 : 0;
	if (value.value.length > 4096) return undefined;
	let start = 0,
		end = value.value.length;
	while (start < end && whitespace(value.value.charCodeAt(start))) start++;
	while (end > start && whitespace(value.value.charCodeAt(end - 1))) end--;
	const source = value.value.slice(start, end);
	if (source === "") return 0;
	if (/^0[xXbBoO]/.test(source)) {
		const radix =
			source[1] === "x" || source[1] === "X"
				? 16
				: source[1] === "b" || source[1] === "B"
					? 2
					: 8;
		let result = 0;
		if (source.length === 2) return NaN;
		for (let index = 2; index < source.length; index++) {
			const digit = digitValue(source.charCodeAt(index));
			if (digit < 0 || digit >= radix) return NaN;
			if (result > (9007199254740991 - digit) / radix) return undefined;
			result = result * radix + digit;
		}
		return result;
	}
	// The runtime's decimal path uses correctly rounded strtod after this grammar check.
	return /^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/.test(source)
		? Number(source)
		: NaN;
}

function digitValue(unit: number): number {
	return unit >= 48 && unit <= 57
		? unit - 48
		: unit >= 65 && unit <= 90
			? unit - 55
			: unit >= 97 && unit <= 122
				? unit - 87
				: -1;
}

function legacyEscape(source: string, decode: boolean): string {
	const hex = "0123456789ABCDEF";
	let result = "";
	for (let index = 0; index < source.length; index++) {
		const unit = source.charCodeAt(index);
		if (decode) {
			const count = source[index + 1] === "u" ? 4 : 2;
			const start = index + (count === 4 ? 2 : 1);
			let value = 0;
			let valid = unit === 37 && start + count <= source.length;
			for (let offset = 0; valid && offset < count; offset++) {
				const digit = digitValue(source.charCodeAt(start + offset));
				valid = digit >= 0 && digit < 16;
				value = value * 16 + digit;
			}
			if (valid) {
				result += String.fromCharCode(value);
				index = start + count - 1;
			} else result += source[index];
		} else if (
			(unit >= 48 && unit <= 57) ||
			(unit >= 65 && unit <= 90) ||
			(unit >= 97 && unit <= 122) ||
			"@*_+-./".includes(source[index]!)
		)
			result += source[index];
		else
			result +=
				unit < 256
					? `%${hex[unit >>> 4]}${hex[unit & 15]}`
					: `%u${hex[unit >>> 12]}${hex[(unit >>> 8) & 15]}${hex[(unit >>> 4) & 15]}${hex[unit & 15]}`;
	}
	return result;
}

function text(value: ConstantValue | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value.kind === "undefined") return "undefined";
	if (value.kind === "number") {
		return formatConstantNumber(value.value, "toString");
	}
	return String(value.value);
}

function integer(value: number): number {
	return value !== value || value === 0 ? 0 : Math.trunc(value);
}

function roundFloat16(value: number): number {
	const magnitude = Math.abs(value);
	if (!Number.isFinite(value) || value === 0) return value;
	const sign = value < 0 ? -1 : 1;
	if (magnitude < 2 ** -25) return sign * 0;
	if (magnitude >= 65520) return sign * Infinity;
	const bits = new DataView(new ArrayBuffer(8));
	bits.setFloat64(0, magnitude, false);
	const exponent = ((bits.getUint32(0, false) >>> 20) & 2047) - 1023;
	const step = 2 ** Math.max(exponent - 10, -24);
	const units = magnitude / step;
	const lower = Math.floor(units);
	const remainder = units - lower;
	// Power-of-two scaling is exact; only the half-way decision rounds the input.
	const rounded =
		remainder > 0.5 || (remainder === 0.5 && lower % 2 !== 0) ? lower + 1 : lower;
	return sign * rounded * step;
}

function whitespace(unit: number): boolean {
	return (
		(unit >= 9 && unit <= 13) ||
		unit === 32 ||
		unit === 160 ||
		unit === 5760 ||
		(unit >= 8192 && unit <= 8202) ||
		unit === 8232 ||
		unit === 8233 ||
		unit === 8239 ||
		unit === 8287 ||
		unit === 12288 ||
		unit === 65279
	);
}

export function evaluateConstantStringSplit(
	receiver: ConstantValue | undefined,
	args: ReadonlyArray<ConstantValue | undefined>,
	workLimit = 4096,
): ReadonlyArray<string> | undefined {
	if (receiver === undefined || receiver.kind === "null" || receiver.kind === "undefined")
		return undefined;
	const source = text(receiver),
		separator = args.length === 0 ? absent : args[0];
	const limit =
		args.length < 2 || args[1]?.kind === "undefined" ? 0xffffffff : numeric(args[1]);
	if (source === undefined || separator === undefined || limit === undefined)
		return undefined;
	const splitLimit = limit >>> 0;
	if (source.length + args.length + 1 > workLimit) return undefined;
	if (splitLimit === 0) return [];
	if (separator.kind === "undefined") return [source];
	const delimiter = text(separator);
	if (delimiter === undefined || (source.length + 1) * (delimiter.length + 1) > workLimit)
		return undefined;
	return source.split(delimiter, splitLimit);
}

export function evaluateConstantBuiltin(
	operation: string,
	receiver: ConstantValue | undefined,
	args: ReadonlyArray<ConstantValue | undefined>,
	target: ConstantEvaluationTarget = PORTABLE_CONSTANT_TARGET,
	workLimit = 4096,
): ConstantEvaluation {
	const contract = evaluateConstantOperation(
		"number.unary:+",
		[{ kind: "number", value: 0 }],
		target,
		workLimit,
	);
	if (contract.kind !== "value") return contract;
	let work = 1;
	const unsupported = (
		reason: "uncertified-operation" | "work-limit" = "uncertified-operation",
	): ConstantEvaluation => ({ kind: "unsupported", reason, work });
	const result = (value: ConstantValue): ConstantEvaluation => ({
		kind: "value",
		value,
		work,
	});
	const failure = (builtinError: KnownBuiltinError): ConstantEvaluation => ({
		kind: "throw",
		error: knownBuiltinErrors[builtinError].error,
		builtinError,
		stage: "invocation",
		work,
	});
	const number = (value: number) => result({ kind: "number", value });
	const boolean = (value: boolean) => result({ kind: "boolean", value });
	const string = (value: string) =>
		value.length + work > workLimit
			? unsupported("work-limit")
			: result({ kind: "string", value });
	const argument = (index: number) => (index < args.length ? args[index] : absent);
	if (args.length > workLimit) return unsupported("work-limit");
	const first = argument(0);
	const halfRange = 1n << 126n;
	if (
		[receiver, ...args].some(
			(value) =>
				value?.kind === "bigint" &&
				(value.value < -halfRange - halfRange ||
					value.value > halfRange - 1n + halfRange),
		)
	)
		return { kind: "unsupported", reason: "target-contract", work };
	const brands = ["Number", "Boolean", "String", "BigInt", "Symbol"] as const;
	for (const brand of brands) {
		if (
			receiver !== undefined &&
			operation.startsWith(`${brand}.prototype.`) &&
			(brand !== "String" ||
				operation === "String.prototype.valueOf" ||
				operation === "String.prototype.toString") &&
			receiver.kind !== brand.toLowerCase()
		) {
			const failures = {
				Number: "numberReceiver",
				Boolean: "booleanReceiver",
				String: "stringReceiver",
				BigInt: "bigintReceiver",
				Symbol: "symbolReceiver",
			} as const;
			return failure(failures[brand]);
		}
	}
	if (operation === "Symbol.keyFor" && first !== undefined) return failure("symbolKey");
	if (
		["parseInt", "Number.parseInt", "parseFloat", "Number.parseFloat"].includes(operation)
	) {
		const source = text(first);
		if (source === undefined) return unsupported();
		if (work + source.length > workLimit) return unsupported("work-limit");
		work += source.length;
		let cursor = 0;
		while (cursor < source.length && whitespace(source.charCodeAt(cursor))) cursor++;
		if (operation.endsWith("parseFloat")) {
			const prefix = /^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
				source.slice(cursor),
			);
			return number(prefix === null ? NaN : Number(prefix[0]));
		}
		const rawRadix = numeric(argument(1));
		if (rawRadix === undefined) return unsupported();
		let radix = rawRadix | 0;
		const stripPrefix = radix === 0 || radix === 16;
		if (radix !== 0 && (radix < 2 || radix > 36)) return number(NaN);
		if (radix === 0) radix = 10;
		const negative = source[cursor] === "-";
		if (negative || source[cursor] === "+") cursor++;
		if (
			stripPrefix &&
			source[cursor] === "0" &&
			(source[cursor + 1] === "x" || source[cursor + 1] === "X")
		) {
			radix = 16;
			cursor += 2;
		}
		let value = 0,
			found = false;
		for (; cursor < source.length; cursor++) {
			const digit = digitValue(source.charCodeAt(cursor));
			if (digit < 0 || digit >= radix) break;
			if (value > (9007199254740991 - digit) / radix) return unsupported();
			value = value * radix + digit;
			found = true;
		}
		return number(found ? (negative ? -value : value) : NaN);
	}
	const codec =
		operation === "globalThis.escape"
			? "escape"
			: operation === "globalThis.unescape"
				? "unescape"
				: operation;
	if (
		[
			"encodeURI",
			"encodeURIComponent",
			"decodeURI",
			"decodeURIComponent",
			"escape",
			"unescape",
		].includes(codec)
	) {
		const source = text(first);
		if (source === undefined) return unsupported();
		if (source.length * 12 + work > workLimit) return unsupported("work-limit");
		work += source.length;
		try {
			switch (codec) {
				case "encodeURI":
					return string(encodeURI(source));
				case "encodeURIComponent":
					return string(encodeURIComponent(source));
				case "decodeURI":
					return string(decodeURI(source));
				case "decodeURIComponent":
					return string(decodeURIComponent(source));
				case "escape":
					return string(legacyEscape(source, false));
				case "unescape":
					return string(legacyEscape(source, true));
			}
		} catch {
			return failure("uri");
		}
	}
	if (operation === "Boolean")
		return first === undefined
			? unsupported()
			: boolean(first.kind !== "undefined" && Boolean(first.value));
	if (operation === "Number") {
		const value =
			args.length === 0
				? 0
				: first?.kind === "bigint"
					? Number(first.value)
					: numeric(first);
		return value === undefined ? unsupported() : number(value);
	}
	if (operation === "BigInt") {
		if (first === undefined) return unsupported();
		if (first.kind === "bigint") return result(first);
		if (first.kind === "boolean")
			return result({ kind: "bigint", value: first.value ? 1n : 0n });
		if (first.kind === "number") {
			if (first.value % 1 !== 0) return failure("bigintNumber");
			if (first.value < -(2 ** 127) || first.value >= 2 ** 127) return unsupported();
			return result({ kind: "bigint", value: BigInt(first.value) });
		}
		if (first.kind !== "string") return failure("bigintValue");
		if (first.value.length + work > workLimit) return unsupported("work-limit");
		work += first.value.length;
		let start = 0,
			end = first.value.length;
		while (start < end && whitespace(first.value.charCodeAt(start))) start++;
		while (end > start && whitespace(first.value.charCodeAt(end - 1))) end--;
		const source = first.value.slice(start, end);
		if (source === "") return result({ kind: "bigint", value: 0n });
		const negative = source[0] === "-",
			signed = negative || source[0] === "+";
		let cursor = signed ? 1 : 0,
			radix = 10;
		if (!signed && /^0[xXbBoO]/.test(source)) {
			radix =
				source[1] === "x" || source[1] === "X"
					? 16
					: source[1] === "b" || source[1] === "B"
						? 2
						: 8;
			cursor = 2;
		}
		if (cursor === source.length) return failure("bigintString");
		const half = 1n << 126n,
			minimum = -half - half,
			maximum = half - 1n + half,
			base = BigInt(radix);
		let value = 0n;
		for (; cursor < source.length; cursor++) {
			const digit = digitValue(source.charCodeAt(cursor));
			if (digit < 0 || digit >= radix) return failure("bigintString");
			const next = BigInt(digit);
			const limit = negative ? (minimum + next) / base : (maximum - next) / base;
			if (negative && value < limit) return unsupported();
			if (!negative && value > limit) return unsupported();
			value = negative ? value * base - next : value * base + next;
		}
		return result({ kind: "bigint", value });
	}
	if (operation === "BigInt.prototype.toString") {
		if (receiver?.kind !== "bigint") return unsupported();
		const radix = first?.kind === "undefined" ? 10 : numeric(first);
		if (radix === undefined) return unsupported();
		if (integer(radix) < 2 || integer(radix) > 36) return failure("numberRadix");
		const base = BigInt(integer(radix));
		let remaining = receiver.value > 0n ? -receiver.value : receiver.value,
			output = "";
		do {
			output =
				"0123456789abcdefghijklmnopqrstuvwxyz"[Number(-(remaining % base))] + output;
			remaining /= base;
		} while (remaining !== 0n);
		return string((receiver.value < 0n ? "-" : "") + output);
	}
	if (operation === "String") {
		const value = args.length === 0 ? "" : text(first);
		return value === undefined ? unsupported() : string(value);
	}
	if (
		[
			"Number.prototype.toString",
			"Number.prototype.toFixed",
			"Number.prototype.toExponential",
			"Number.prototype.toPrecision",
		].includes(operation)
	) {
		if (receiver?.kind !== "number") return unsupported();
		const value = receiver.value,
			method = operation.slice("Number.prototype.".length) as
				| "toString"
				| "toFixed"
				| "toExponential"
				| "toPrecision";
		const supplied = first?.kind === "undefined" ? undefined : numeric(first);
		if (supplied === undefined && first?.kind !== "undefined") return unsupported();
		const parameter = supplied === undefined ? undefined : integer(supplied);
		if (method === "toString" && parameter !== undefined && parameter !== 10) {
			if (parameter < 2 || parameter > 36) return failure("numberRadix");
			work += 1100;
			if (work > workLimit) return unsupported("work-limit");
			const formatted = formatConstantNumberRadix(value, parameter);
			return formatted === undefined ? unsupported() : string(formatted);
		}
		if (parameter !== undefined) {
			if (method === "toFixed" && (parameter < 0 || parameter > 100))
				return failure("numberFixed");
			if (Number.isFinite(value)) {
				if (method === "toExponential" && (parameter < 0 || parameter > 100))
					return failure("numberExponential");
				if (method === "toPrecision" && (parameter < 1 || parameter > 100))
					return failure("numberPrecision");
			}
		}
		// Binary64 expansion has at most 1100 decimal digits, independent of the value.
		work += 1100;
		if (work > workLimit) return unsupported("work-limit");
		const formatted = formatConstantNumber(
			value,
			method,
			method === "toString" ? undefined : parameter,
		);
		return formatted === undefined ? unsupported() : string(formatted);
	}
	if (
		operation === "Boolean.prototype.valueOf" ||
		operation === "Number.prototype.valueOf" ||
		operation === "String.prototype.valueOf" ||
		operation === "BigInt.prototype.valueOf"
	) {
		return receiver?.kind === operation.slice(0, operation.indexOf(".")).toLowerCase()
			? result(receiver)
			: unsupported();
	}
	if (
		operation === "Boolean.prototype.toString" ||
		operation === "String.prototype.toString"
	) {
		if (receiver?.kind !== operation.slice(0, operation.indexOf(".")).toLowerCase())
			return unsupported();
		return receiver.kind === "string" || receiver.kind === "boolean"
			? string(String(receiver.value))
			: unsupported();
	}
	if (operation.startsWith("Number.is")) {
		if (first === undefined) return unsupported();
		if (first.kind !== "number") return boolean(false);
		const value = first.value;
		switch (operation) {
			case "Number.isNaN":
				return boolean(value !== value);
			case "Number.isFinite":
				return boolean(value === value && value !== Infinity && value !== -Infinity);
			case "Number.isInteger":
				return boolean(value % 1 === 0);
			case "Number.isSafeInteger":
				return boolean(
					value % 1 === 0 && value >= -9007199254740991 && value <= 9007199254740991,
				);
		}
	}
	if (operation === "isNaN" || operation === "isFinite") {
		const value = numeric(first);
		return value === undefined
			? unsupported()
			: boolean(
					operation === "isNaN"
						? value !== value
						: value === value && value !== Infinity && value !== -Infinity,
				);
	}
	if (operation === "BigInt.asIntN" || operation === "BigInt.asUintN") {
		const bits = numeric(first);
		let value = argument(1);
		if (bits === undefined) return unsupported();
		if (integer(bits) < 0 || integer(bits) > 9007199254740991)
			return failure("bigintWidth");
		if (value === undefined) return unsupported();
		if (value.kind === "number" || value.kind === "null" || value.kind === "undefined")
			return failure("bigintValue");
		if (value.kind !== "bigint") {
			const converted = evaluateConstantBuiltin(
				"BigInt",
				undefined,
				[value],
				target,
				workLimit - work,
			);
			if (converted.kind !== "value")
				return { ...converted, work: converted.work + work };
			if (converted.value.kind !== "bigint") return unsupported();
			work += converted.work;
			value = converted.value;
		}
		const half = 1n << 126n;
		if (value.value < -half - half || value.value > half - 1n + half)
			return unsupported();
		const width = integer(bits);
		if (width === 0) return result({ kind: "bigint", value: 0n });
		if (width >= 128)
			return operation === "BigInt.asIntN" || value.value >= 0n
				? result(value)
				: unsupported();
		const top = 1n << BigInt(width - 1),
			mask = top - 1n + top;
		let narrowed = value.value & mask;
		if (operation === "BigInt.asIntN" && narrowed >= top) narrowed = narrowed - top - top;
		return result({ kind: "bigint", value: narrowed });
	}
	if (operation.startsWith("Math.")) {
		if (operation === "Math.hypot") {
			if (args.length + work > workLimit) return unsupported("work-limit");
			const values = args.map(numeric);
			work += args.length;
			if (values.some((value) => value === undefined)) return unsupported();
			if (values.some((value) => value === Infinity || value === -Infinity))
				return number(Infinity);
			if (values.some((value) => Number.isNaN(value))) return number(NaN);
			if (values.every((value) => value === 0)) return number(0);
			if (values.length === 1) return number(Math.abs(values[0]!));
			return unsupported();
		}
		if (operation === "Math.min" || operation === "Math.max") {
			if (args.length + work > workLimit) return unsupported("work-limit");
			let value = operation === "Math.min" ? Infinity : -Infinity;
			for (const arg of args) {
				const next = numeric(arg);
				if (next === undefined) return unsupported();
				work++;
				value = operation === "Math.min" ? Math.min(value, next) : Math.max(value, next);
			}
			return number(value);
		}
		const value = numeric(first);
		if (value === undefined) return unsupported();
		if (operation === "Math.pow") {
			const exponent = numeric(argument(1));
			if (exponent === undefined) return unsupported();
			const evaluated = evaluateConstantOperation(
				"number.binary:**",
				[
					{ kind: "number", value },
					{ kind: "number", value: exponent },
				],
				target,
				workLimit - work,
			);
			return { ...evaluated, work: work + evaluated.work };
		}
		if (operation === "Math.atan2") {
			const x = numeric(argument(1));
			if (x === undefined) return unsupported();
			if (Number.isNaN(value) || Number.isNaN(x)) return number(NaN);
			if (value === 0 && (x > 0 || Object.is(x, 0))) return number(value);
			if (Number.isFinite(value) && x === Infinity)
				return number(value < 0 || Object.is(value, -0) ? -0 : 0);
			return unsupported();
		}
		const special = mathUnarySpecialCase(operation, value);
		if (special !== undefined) return number(special);
		switch (operation) {
			case "Math.abs":
				return number(Math.abs(value));
			case "Math.ceil":
				return number(Math.ceil(value));
			case "Math.floor":
				return number(Math.floor(value));
			case "Math.trunc":
				return number(Math.trunc(value));
			case "Math.round":
				return number(Math.round(value));
			case "Math.sign":
				return number(Math.sign(value));
			case "Math.f16round":
				return number(roundFloat16(value));
			case "Math.fround": {
				const bits = new DataView(new ArrayBuffer(4));
				bits.setFloat32(0, value, false);
				return number(bits.getFloat32(0, false));
			}
			case "Math.clz32":
				return number(Math.clz32(value));
			case "Math.imul": {
				const right = numeric(argument(1));
				return right === undefined ? unsupported() : number(Math.imul(value, right));
			}
		}
	}
	if (operation === "String.fromCharCode" || operation === "String.fromCodePoint") {
		if (args.length * 2 + work > workLimit) return unsupported("work-limit");
		let value = "";
		for (const arg of args) {
			const unit = numeric(arg);
			if (unit === undefined) return unsupported();
			if (operation === "String.fromCharCode") value += String.fromCharCode(unit);
			else {
				if (unit % 1 !== 0 || unit < 0 || unit > 0x10ffff) return failure("codePoint");
				value += String.fromCodePoint(unit);
			}
			work++;
		}
		return string(value);
	}
	if (
		!operation.startsWith("String.prototype.") ||
		receiver === undefined ||
		receiver.kind === "null" ||
		receiver.kind === "undefined"
	)
		return unsupported();
	const source = text(receiver);
	if (source === undefined) return unsupported();
	work += source.length;
	if (work > workLimit) return unsupported("work-limit");
	const method = operation.slice("String.prototype.".length);
	if (method === "replace" || method === "replaceAll") {
		const needle = text(first),
			replacement = text(argument(1));
		if (needle === undefined || replacement === undefined) return unsupported();
		if (work + (source.length + 1) * (needle.length + 1) + replacement.length > workLimit)
			return unsupported("work-limit");
		work += (source.length + 1) * (needle.length + 1) + replacement.length;
		let output = "",
			cursor = 0,
			position = source.indexOf(needle);
		while (position >= 0) {
			output += source.slice(cursor, position);
			for (let index = 0; index < replacement.length; index++) {
				let part = replacement.charAt(index);
				if (part === "$" && index + 1 < replacement.length) {
					const token = replacement.charAt(index + 1);
					if (token === "$" || token === "&" || token === "`" || token === "'") {
						part =
							token === "$"
								? "$"
								: token === "&"
									? needle
									: token === "`"
										? source.slice(0, position)
										: source.slice(position + needle.length);
						index++;
					}
				}
				work += part.length + 1;
				if (work + output.length + part.length > workLimit)
					return unsupported("work-limit");
				output += part;
			}
			cursor = position + needle.length;
			if (method === "replace" || (needle.length === 0 && position === source.length))
				break;
			position = source.indexOf(needle, position + Math.max(needle.length, 1));
		}
		return string(output + source.slice(cursor));
	}
	const html: Readonly<Record<string, readonly [string, string?]>> = {
		anchor: ["a", "name"],
		big: ["big"],
		blink: ["blink"],
		bold: ["b"],
		fixed: ["tt"],
		fontcolor: ["font", "color"],
		fontsize: ["font", "size"],
		italics: ["i"],
		link: ["a", "href"],
		small: ["small"],
		strike: ["strike"],
		sub: ["sub"],
		sup: ["sup"],
	};
	const tag = Object.hasOwn(html, method) ? html[method] : undefined;
	if (tag !== undefined) {
		const value = tag[1] === undefined ? "" : text(first);
		if (value === undefined) return unsupported();
		if (work + value.length * 6 > workLimit) return unsupported("work-limit");
		const attribute =
			tag[1] === undefined ? "" : ` ${tag[1]}="${value.replaceAll('"', "&quot;")}"`;
		return string(`<${tag[0]}${attribute}>${source}</${tag[0]}>`);
	}
	if (["at", "charAt", "charCodeAt", "codePointAt"].includes(method)) {
		const position = numeric(first);
		if (position === undefined) return unsupported();
		let index = integer(position);
		if (method === "at" && index < 0) index += source.length;
		if (index < 0 || index >= source.length)
			return method === "charAt"
				? string("")
				: method === "charCodeAt"
					? number(NaN)
					: result(absent);
		return method === "at" || method === "charAt"
			? string(source.charAt(index))
			: number(
					method === "charCodeAt" ? source.charCodeAt(index) : source.codePointAt(index)!,
				);
	}
	if (["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith"].includes(method)) {
		const needle = text(first),
			position = argument(1);
		if (needle === undefined) return unsupported();
		const index = numeric(position);
		if (index === undefined) return unsupported();
		if (work + (source.length + 1) * (needle.length + 1) > workLimit)
			return unsupported("work-limit");
		work += (source.length + 1) * (needle.length + 1);
		switch (method) {
			case "includes":
				return boolean(source.includes(needle, index));
			case "indexOf":
				return number(source.indexOf(needle, index));
			case "lastIndexOf":
				return number(source.lastIndexOf(needle, index));
			case "startsWith":
				return boolean(source.startsWith(needle, index));
			case "endsWith":
				return boolean(
					source.endsWith(needle, position?.kind === "undefined" ? undefined : index),
				);
		}
	}
	if (["slice", "substring", "substr"].includes(method)) {
		const start = numeric(first),
			end = argument(1);
		if (start === undefined) return unsupported();
		const finish = end?.kind === "undefined" ? undefined : numeric(end);
		if (finish === undefined && end?.kind !== "undefined") return unsupported();
		if (method === "slice") return string(source.slice(start, finish));
		if (method === "substring") return string(source.substring(start, finish));
		const offset =
			integer(start) < 0
				? Math.max(source.length + integer(start), 0)
				: Math.min(integer(start), source.length);
		return string(
			source.slice(
				offset,
				offset + (finish === undefined ? source.length : Math.max(integer(finish), 0)),
			),
		);
	}
	if (method === "concat") {
		let value = source;
		for (const arg of args) {
			const suffix = text(arg);
			if (suffix === undefined) return unsupported();
			if (work + value.length + suffix.length > workLimit)
				return unsupported("work-limit");
			work += suffix.length;
			value += suffix;
		}
		return string(value);
	}
	if (method === "repeat") {
		const count = numeric(first);
		if (count === undefined) return unsupported();
		const copies = integer(count);
		if (copies < 0 || copies === Infinity) return failure("repeatCount");
		if (source.length * copies + work > workLimit) return unsupported("work-limit");
		return string(source.repeat(copies));
	}
	if (method === "padStart" || method === "padEnd") {
		const length = numeric(first);
		if (length === undefined) return unsupported();
		const size = Math.max(integer(length), 0);
		if (size <= source.length) return string(source);
		const padding = argument(1)?.kind === "undefined" ? " " : text(argument(1));
		if (padding === undefined) return unsupported();
		if (padding === "") return string(source);
		if (size + work > workLimit) return unsupported("work-limit");
		return string(
			method === "padStart"
				? source.padStart(size, padding)
				: source.padEnd(size, padding),
		);
	}
	if (
		method === "normalize" ||
		["toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase"].includes(
			method,
		)
	) {
		if (target.unicode !== UNICODE_VERSION)
			return { kind: "unsupported", reason: "target-contract", work };
		let transformed;
		if (method === "normalize") {
			const form = first?.kind === "undefined" ? "NFC" : text(first);
			if (form === undefined) return unsupported();
			if (form !== "NFC" && form !== "NFD" && form !== "NFKC" && form !== "NFKD")
				return failure("normalization");
			transformed = normalizeUnicode(source, form, workLimit - work);
		} else {
			let locale: "und" | "tr" | "lt" = "und";
			if (method.includes("Locale") && target.intl !== false) {
				if (first?.kind === "undefined") {
					if (target.locale !== "en-US") return unsupported();
				} else {
					if (target.intl !== true || first?.kind !== "string") return unsupported();
					const selected = stringCaseLocale(first.value);
					if (selected === undefined) return unsupported();
					locale = selected;
				}
			}
			transformed = transformUnicodeCase(
				source,
				method.includes("Upper"),
				locale,
				workLimit - work,
			);
		}
		if (transformed === undefined) return unsupported("work-limit");
		work += transformed.work;
		return result({ kind: "string", value: transformed.value });
	}
	if (["trim", "trimStart", "trimLeft", "trimEnd", "trimRight"].includes(method)) {
		let start = 0,
			end = source.length;
		if (method !== "trimEnd" && method !== "trimRight")
			while (start < end && whitespace(source.charCodeAt(start))) start++;
		if (method !== "trimStart" && method !== "trimLeft")
			while (end > start && whitespace(source.charCodeAt(end - 1))) end--;
		return string(source.slice(start, end));
	}
	if (method === "isWellFormed" || method === "toWellFormed") {
		let value = "",
			valid = true;
		for (let index = 0; index < source.length; index++) {
			const unit = source.charCodeAt(index);
			if (
				unit >= 0xd800 &&
				unit <= 0xdbff &&
				source.charCodeAt(index + 1) >= 0xdc00 &&
				source.charCodeAt(index + 1) <= 0xdfff
			) {
				value += source.slice(index, index + 2);
				index++;
			} else if (unit >= 0xd800 && unit <= 0xdfff) {
				valid = false;
				value += "\ufffd";
			} else value += source.charAt(index);
		}
		return method === "isWellFormed" ? boolean(valid) : string(value);
	}
	return unsupported();
}
