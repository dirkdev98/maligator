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
export class EngineValue<T extends ValueType> {
	private type: T;
	private data: ValueProperties<T>;

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

	private constructor(type: T, data: ValueProperties<T>) {
		this.type = type;
		this.data = data;
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

	/**
	 * Custom added to aid w/ testing
	 */
	symbolDescription(this: EngineValue<"symbol">): string | undefined {
		return this.data.description;
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
