import { toInt32 } from "./abstract-operations/type-conversion.ts";

/**
 * https://tc39.es/ecma262/#sec-ecmascript-language-types
 */
type Value =
	| {
			type: "undefined";
	  }
	| {
			type: "null";
			value: null;
	  }
	| {
			type: "boolean";
			value: boolean;
	  }
	| {
			type: "string";
			value: string;
	  }
	| {
			type: "symbol";

			// Should this be an EngineValue<string>?
			description?: string;
	  }
	| {
			type: "number";
			value: number;
	  }
	| {
			type: "bigint";
			value: bigint;
	  };

type ValueType = Value["type"];
type ValueProperties<Type extends ValueType> = Omit<
	Extract<Value, { type: Type }>,
	"type"
>;

/**
 * Symbol used in various algorithms. I think we can get away with it being -1.
 */
const NOT_FOUND = -1;

/**
 * Base engine value type to represent ECMAscript data types and values.
 *
 * For ease of implementation uses the runtimes semantics of string and numbers to manage the
 * valid representation of things like UTF-16 code units and floating point handling.
 */
export class EngineValue<T extends ValueType = ValueType> {
	readonly type: T;
	data: ValueProperties<T>;

	static undefined() {
		return new EngineValue("undefined", {});
	}

	static null() {
		return new EngineValue("null", { value: null });
	}

	static boolean(value: boolean) {
		return new EngineValue("boolean", { value });
	}

	static string(value: string) {
		return new EngineValue("string", { value });
	}

	static symbol(description?: string) {
		return new EngineValue("symbol", { description });
	}

	static number(value: number) {
		return new EngineValue("number", { value });
	}

	static bigint(value: bigint) {
		return new EngineValue("bigint", { value });
	}

	private constructor(type: T, data: ValueProperties<T>) {
		this.type = type;
		this.data = data;
	}

	isUndefined(): this is EngineValue<"undefined"> {
		return this.type === "undefined";
	}

	isNull(): this is EngineValue<"null"> {
		return this.type === "null";
	}

	isBoolean(): this is EngineValue<"boolean"> {
		return this.type === "boolean";
	}

	isString(): this is EngineValue<"string"> {
		return this.type === "string";
	}

	isSymbol(): this is EngineValue<"symbol"> {
		return this.type === "symbol";
	}

	isNumber(): this is EngineValue<"number"> {
		return this.type === "number";
	}

	isBigInt(): this is EngineValue<"bigint"> {
		return this.type === "bigint";
	}

	assertIsUndefined(): asserts this is EngineValue<"undefined"> {
		if (this.type !== "undefined") {
			throw new Error("Can't call this operation on a non-undefined value.");
		}
	}

	assertIsNull(): asserts this is EngineValue<"null"> {
		if (this.type !== "null") {
			throw new Error("Can't call this operation on a non-null value.");
		}
	}

	assertIsBoolean(): asserts this is EngineValue<"boolean"> {
		if (this.type !== "boolean") {
			throw new Error("Can't call this operation on a non-boolean value.");
		}
	}

	assertIsString(): asserts this is EngineValue<"string"> {
		if (this.type !== "string") {
			throw new Error("Can't call this operation on a non-string value.");
		}
	}

	assertIsSymbol(): asserts this is EngineValue<"symbol"> {
		if (this.type !== "symbol") {
			throw new Error("Can't call this operation on a non-symbol value.");
		}
	}

	assertIsNumber(): asserts this is EngineValue<"number"> {
		if (this.type !== "number") {
			throw new Error("Can't call this operation on a non-number value.");
		}
	}

	assertIsBigInt(): asserts this is EngineValue<"bigint"> {
		if (this.type !== "bigint") {
			throw new Error("Can't call this operation on a non-bigint value.");
		}
	}

	asUndefined(): EngineValue<"undefined"> {
		this.assertIsUndefined();
		return this;
	}

	asNull(): EngineValue<"null"> {
		this.assertIsNull();
		return this;
	}

	asBoolean(): EngineValue<"boolean"> {
		this.assertIsBoolean();
		return this;
	}

	asString(): EngineValue<"string"> {
		this.assertIsString();
		return this;
	}

	asSymbol(): EngineValue<"symbol"> {
		this.assertIsSymbol();
		return this;
	}

	asNumber(): EngineValue<"number"> {
		this.assertIsNumber();
		return this;
	}

	asBigInt(): EngineValue<"bigint"> {
		this.assertIsBigInt();
		return this;
	}

	// https://tc39.es/ecma262/#sec-stringindexof
	stringIndexOf(
		this: EngineValue<"string">,
		searchValue: EngineValue<"string">,
		fromIndex: number,
	) {
		const len = this.data.value.length;

		if (searchValue.data.value.length === 0 && fromIndex <= len) {
			return fromIndex;
		}

		const searchLen = searchValue.data.value.length;

		for (let i = fromIndex; i <= len - searchLen; i++) {
			const candidate = this.data.value.slice(i, i + searchLen);
			if (candidate === searchValue.data.value) {
				return i;
			}
		}

		return NOT_FOUND;
	}

	// https://tc39.es/ecma262/#sec-stringlastindexof
	stringLastIndexOf(
		this: EngineValue<"string">,
		searchValue: EngineValue<"string">,
		fromIndex: number,
	) {
		const len = this.data.value.length;
		const searchLen = searchValue.data.value.length;

		// TODO: assert abstraction?
		if (!(fromIndex + searchLen <= len)) {
			throw new Error("Assertion failed: fromIndex + searchLen <= len");
		}

		for (let i = fromIndex; i >= 0; i--) {
			const candidate = this.data.value.slice(i, i + searchLen);
			if (candidate === searchValue.data.value) {
				return i;
			}
		}

		return NOT_FOUND;
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-unaryMinus
	numberUnaryMinus(this: EngineValue<"number">) {
		if (isNaN(this.data.value)) {
			return EngineValue.number(NaN);
		}

		return EngineValue.number(-this.data.value);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-bitwiseNOT
	numberBitwiseNot(this: EngineValue<"number">) {
		const numberValue = toInt32(this);
		if (numberValue.type === "throw") {
			throw numberValue.error;
		}

		return EngineValue.number(~numberValue.value.data.value);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-exponentiate
	numberExponentiate(
		this: EngineValue<"number">,
		exponent: EngineValue<"number">,
	): EngineValue<"number"> {
		const thisValue = this.data.value;
		const expValue = exponent.data.value;

		if (Number.isNaN(expValue)) {
			return EngineValue.number(NaN);
		}

		if (EngineValueUtils.isPositiveOrNegativeZero(expValue)) {
			return EngineValue.number(1);
		}

		if (Number.isNaN(thisValue)) {
			return EngineValue.number(NaN);
		}

		if (thisValue === +Infinity) {
			if (expValue > 0) {
				return EngineValue.number(Infinity);
			}

			return EngineValue.number(0);
		}

		if (thisValue === -Infinity) {
			if (expValue > 0) {
				if (expValue % 2 !== 0) {
					return EngineValue.number(-Infinity);
				}
				return EngineValue.number(Infinity);
			}
			if (expValue % 2 === 0) {
				return EngineValue.number(-0);
			}
			return EngineValue.number(0);
		}

		if (thisValue === 0) {
			if (expValue > 0) {
				return EngineValue.number(0);
			}
			return EngineValue.number(Infinity);
		}

		if (EngineValueUtils.isNegativeZero(thisValue)) {
			if (expValue > 0) {
				if (expValue % 2 !== 0) {
					return EngineValue.number(-0);
				}
				return EngineValue.number(0);
			}
			if (expValue % 2 !== 0) {
				return EngineValue.number(-Infinity);
			}
			return EngineValue.number(+Infinity);
		}

		if (expValue === Infinity) {
			const absBaseValue = Math.abs(thisValue);

			if (absBaseValue > 1) {
				return EngineValue.number(Infinity);
			} else if (absBaseValue === 1) {
				return EngineValue.number(NaN);
			}
			return EngineValue.number(0);
		}

		if (expValue === -Infinity) {
			const absBaseValue = Math.abs(thisValue);

			if (absBaseValue > 1) {
				return EngineValue.number(0);
			} else if (absBaseValue === 1) {
				return EngineValue.number(NaN);
			}
			return EngineValue.number(Infinity);
		}

		return EngineValue.number(thisValue ** expValue);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-multiply
	numberMultiply(
		this: EngineValue<"number">,
		other: EngineValue<"number">,
	): EngineValue<"number"> {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (isNaN(xValue) || isNaN(yValue)) {
			return EngineValue.number(NaN);
		}

		if (xValue === Infinity || xValue === -Infinity) {
			if (EngineValueUtils.isPositiveOrNegativeZero(yValue)) {
				return EngineValue.number(NaN);
			} else if (yValue > 0) {
				return EngineValue.number(xValue);
			}

			return EngineValue.number(-xValue);
		}

		if (yValue === Infinity || yValue === -Infinity) {
			if (EngineValueUtils.isPositiveOrNegativeZero(xValue)) {
				return EngineValue.number(NaN);
			} else if (xValue > 0) {
				return EngineValue.number(yValue);
			}
			return EngineValue.number(-yValue);
		}

		if (EngineValueUtils.isNegativeZero(xValue)) {
			if (EngineValueUtils.isNegativeZero(yValue) || yValue < 0) {
				return EngineValue.number(+0);
			}
			return EngineValue.number(-0);
		}

		if (EngineValueUtils.isNegativeZero(yValue)) {
			if (xValue < 0) {
				return EngineValue.number(+0);
			}
			return EngineValue.number(-0);
		}

		return EngineValue.number(xValue * yValue);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-divide
	numberDivide(
		this: EngineValue<"number">,
		other: EngineValue<"number">,
	): EngineValue<"number"> {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (isNaN(xValue) || isNaN(yValue)) {
			return EngineValue.number(NaN);
		}

		if (xValue === Infinity || xValue === -Infinity) {
			if (yValue === Infinity || yValue === -Infinity) {
				return EngineValue.number(NaN);
			}

			if (yValue >= 0) {
				return EngineValue.number(xValue);
			}

			return EngineValue.number(-xValue);
		}

		if (yValue === Infinity) {
			if (xValue < 0 || EngineValueUtils.isNegativeZero(xValue)) {
				return EngineValue.number(-0);
			}

			return EngineValue.number(+0);
		}

		if (yValue === -Infinity) {
			if (xValue < 0 || EngineValueUtils.isNegativeZero(xValue)) {
				return EngineValue.number(0);
			}

			return EngineValue.number(-0);
		}

		if (EngineValueUtils.isPositiveOrNegativeZero(xValue)) {
			if (EngineValueUtils.isPositiveOrNegativeZero(yValue)) {
				return EngineValue.number(NaN);
			}

			if (yValue > 0) {
				return EngineValue.number(xValue);
			}

			return EngineValue.number(-xValue);
		}

		if (EngineValueUtils.isNegativeZero(yValue)) {
			if (xValue > 0) {
				return EngineValue.number(-Infinity);
			}
			return EngineValue.number(Infinity);
		}

		if (yValue === 0) {
			if (xValue > 0) {
				return EngineValue.number(Infinity);
			}
			return EngineValue.number(-Infinity);
		}

		return EngineValue.number(xValue / yValue);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-remainder
	numberRemainder(
		this: EngineValue<"number">,
		divisor: EngineValue<"number">,
	): EngineValue<"number"> {
		const thisValue = this.data.value;
		const divisorValue = divisor.data.value;

		if (isNaN(thisValue) || isNaN(divisorValue)) {
			return EngineValue.number(NaN);
		}

		if (thisValue === Infinity || thisValue === -Infinity) {
			return EngineValue.number(NaN);
		}

		if (divisorValue === Infinity || divisorValue === -Infinity) {
			return EngineValue.number(thisValue);
		}

		if (EngineValueUtils.isPositiveOrNegativeZero(divisorValue)) {
			return EngineValue.number(NaN);
		}

		if (EngineValueUtils.isPositiveOrNegativeZero(thisValue)) {
			return EngineValue.number(thisValue);
		}

		const quotient = thisValue / divisorValue;
		const q = quotient < 0 ? -Math.floor(-quotient) : Math.floor(quotient);
		const r = thisValue - divisorValue * q;

		if (r === 0 && thisValue < 0) {
			return EngineValue.number(-0);
		}

		return EngineValue.number(r);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-add
	numberAdd(this: EngineValue<"number">, other: EngineValue<"number">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (isNaN(xValue) || isNaN(yValue)) {
			return EngineValue.number(NaN);
		}

		if (xValue === Infinity && yValue === -Infinity) {
			return EngineValue.number(NaN);
		}

		if (xValue === -Infinity && yValue === Infinity) {
			return EngineValue.number(NaN);
		}

		if (xValue === Infinity || xValue === -Infinity) {
			return EngineValue.number(xValue);
		}

		if (yValue === Infinity || yValue === -Infinity) {
			return EngineValue.number(yValue);
		}

		if (
			EngineValueUtils.isNegativeZero(xValue) &&
			EngineValueUtils.isNegativeZero(yValue)
		) {
			return EngineValue.number(-0);
		}

		return EngineValue.number(xValue + yValue);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-subtract
	numberSubtract(this: EngineValue<"number">, other: EngineValue<"number">) {
		return this.numberAdd(other.numberUnaryMinus());
	}
}

// https://tc39.es/ecma262/#sec-well-known-symbols
export const WELL_KNOWN_SYMBOLS = {
	"%Symbol.asyncIterator%": EngineValue.symbol("Symbol.asyncIterator"),
	"%Symbol.hasInstance%": EngineValue.symbol("Symbol.hasInstance"),
	"%Symbol.isConcatSpreadable%": EngineValue.symbol("Symbol.isConcatSpreadable"),
	"%Symbol.iterator%": EngineValue.symbol("Symbol.iterator"),
	"%Symbol.match%": EngineValue.symbol("Symbol.match"),
	"%Symbol.matchAll%": EngineValue.symbol("Symbol.matchAll"),
	"%Symbol.replace%": EngineValue.symbol("Symbol.replace"),
	"%Symbol.search%": EngineValue.symbol("Symbol.search"),
	"%Symbol.species%": EngineValue.symbol("Symbol.species"),
	"%Symbol.split%": EngineValue.symbol("Symbol.split"),
	"%Symbol.toPrimitive%": EngineValue.symbol("Symbol.toPrimitive"),
	"%Symbol.toStringTag%": EngineValue.symbol("Symbol.toStringTag"),
	"%Symbol.unscopables%": EngineValue.symbol("Symbol.unscopables"),
};

export const EngineValueUtils = {
	isNegativeZero(value: EngineValue<"number"> | number) {
		const v = typeof value === "number" ? value : value.data.value;
		return Object.is(v, -0);
	},

	isPositiveOrNegativeZero(value: EngineValue<"number"> | number) {
		const v = typeof value === "number" ? value : value.data.value;

		return EngineValueUtils.isNegativeZero(v) || v === +0;
	},
};
