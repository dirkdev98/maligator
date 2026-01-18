import type { ESTree } from "meriyah";
import { isNil } from "../../utils.ts";
import type {
	PropertyDescriptor,
	PropertyKey,
} from "../abstract-operations/property-map.ts";
import { PropertyMap } from "../abstract-operations/property-map.ts";
import { toInt32, toUint32 } from "../abstract-operations/type-conversion.ts";
import type { EnvironmentRecord } from "../execution-contexts/environment-record.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import type { CompletionRecord } from "./completion-record.ts";
import { normalCompletion, throwCompletion } from "./completion-record.ts";

// https://tc39.es/ecma262/#sec-privateelement-specification-type
type PrivateElement =
	| {
			key: string;
			kind: "field" | "method";
			value: EngineValue;
	  }
	| {
			key: string;
			kind: "accessor";
			get: EngineValue<"object" | "undefined">;
			set: EngineValue<"object" | "undefined">;
	  };

export type ObjectInternalSlots = {
	// https://tc39.es/ecma262/#sec-object-internal-methods-and-internal-slots
	PrivateElements: Array<PrivateElement>;

	// https://tc39.es/ecma262/#sec-object-internal-methods-and-internal-slots
	//
	// For implementations, see https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots
	GetPrototypeOf: (
		obj: EngineValue<"object">,
	) => CompletionRecord<EngineValue<"object" | "null">>;

	SetPrototypeOf: (
		obj: EngineValue<"object">,
		V: EngineValue<"object" | "null">,
	) => CompletionRecord<EngineValue<"boolean">>;

	IsExtensible: (obj: EngineValue<"object">) => CompletionRecord<EngineValue<"boolean">>;

	PreventExtensions: (
		obj: EngineValue<"object">,
	) => CompletionRecord<EngineValue<"boolean">>;

	GetOwnProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
	) => CompletionRecord<EngineValue<"undefined"> | PropertyDescriptor>;

	DefineOwnProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
		Desc: PropertyDescriptor,
	) => CompletionRecord<EngineValue<"boolean">>;

	HasProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
	) => CompletionRecord<EngineValue<"boolean">>;

	Get: (
		obj: EngineValue<"object">,
		P: PropertyKey,
		Receiver: EngineValue,
	) => CompletionRecord<EngineValue>;

	Set: (
		obj: EngineValue<"object">,
		P: PropertyKey,
		V: EngineValue,
		Receiver: EngineValue,
	) => CompletionRecord<EngineValue<"boolean">>;

	Delete: (
		O: EngineValue<"object">,
		P: PropertyKey,
	) => CompletionRecord<EngineValue<"boolean">>;

	// Built-in Function objects
	InitialName: EngineValue<"null" | "string">;
	Async: boolean;
	_BuiltinCallback: (
		thisArgument: EngineValue | undefined,
		argumentsList: Array<EngineValue>,
		newTarget?: EngineValue<"object">,
	) => CompletionRecord<EngineValue>;

	// Exotic function or built-in function objects
	Realm: Realm;

	Call: (
		O: EngineValue<"object">,
		thisArgument: EngineValue,
		argumentsList: Array<EngineValue>,
	) => CompletionRecord<EngineValue>;

	Construct: (
		O: EngineValue<"object">,
		argumentsList: Array<EngineValue>,
		newTarget: EngineValue<"object">,
	) => CompletionRecord<EngineValue<"object">>;

	// Function slots
	Environment: EnvironmentRecord;
	FormalParameters: Array<ESTree.Parameter>;
	ECMAScriptCode: ESTree.BlockStatementBase;
	ConstructorKind: "BASE" | "DERIVED";
	ScriptOrModule: ESTree.Program;
	ThisMode: "LEXICAL" | "STRICT" | "GLOBAL";
	Strict: boolean;
	HomeObject: EngineValue<"object" | "undefined">;
	SourceText: string;

	// Class related function slots
	Fields: Array<unknown>;
	PrivateMethods: Array<unknown>;
	ClassFieldInitializerName: string | EngineValue<"symbol"> | null;
	IsClassConstructor: boolean;

	// Shared between object and function
	Prototype: EngineValue<"object" | "null">;
	Extensible: boolean;
};

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
	  }
	| {
			type: "object";
			properties: PropertyMap;
			internalSlots: Partial<ObjectInternalSlots>;
			internalSlotsList: Array<string>;
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
 * Base engine value type to represent ECMAScript data types and values.
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

	static object(internalSlotsList: Array<string>) {
		return new EngineValue("object", {
			internalSlotsList,
			internalSlots: {},
			properties: new PropertyMap(),
		});
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

	isObject(): this is EngineValue<"object"> {
		return this.type === "object";
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

	assertIsObject(): asserts this is EngineValue<"object"> {
		if (this.type !== "object") {
			throw new Error("Can't call this operation on a non-object value.");
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

	asObject(): EngineValue<"object"> {
		this.assertIsObject();
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

	// https://tc39.es/ecma262/#sec-numeric-types-number-leftShift
	numberLeftShift(this: EngineValue<"number">, other: EngineValue<"number">) {
		const lNumCompletion = toInt32(this);
		if (lNumCompletion.type === "throw") {
			throw lNumCompletion.error;
		}

		const rNumCompletion = toUint32(other);
		if (rNumCompletion.type === "throw") {
			throw rNumCompletion.error;
		}

		const shiftCount = rNumCompletion.value.data.value % 32;

		return EngineValue.number(lNumCompletion.value.data.value << shiftCount);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-signedRightShift
	numberSignedRightShift(
		this: EngineValue<"number">,
		other: EngineValue<"number">,
	): EngineValue<"number"> {
		const lNumCompletion = toInt32(this);
		if (lNumCompletion.type === "throw") {
			throw lNumCompletion.error;
		}

		const rNumCompletion = toUint32(other);
		if (rNumCompletion.type === "throw") {
			throw rNumCompletion.error;
		}

		const shiftCount = rNumCompletion.value.data.value % 32;

		return EngineValue.number(lNumCompletion.value.data.value >> shiftCount);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-unsignedRightShift
	numberUnsignedRightShift(
		this: EngineValue<"number">,
		other: EngineValue<"number">,
	): EngineValue<"number"> {
		const lNumCompletion = toUint32(this);
		if (lNumCompletion.type === "throw") {
			throw lNumCompletion.error;
		}

		const rNumCompletion = toUint32(other);
		if (rNumCompletion.type === "throw") {
			throw rNumCompletion.error;
		}

		const shiftCount = rNumCompletion.value.data.value % 32;

		return EngineValue.number(lNumCompletion.value.data.value >>> shiftCount);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-lessThan
	numberLessThan(this: EngineValue<"number">, other: EngineValue<"number">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (isNaN(xValue)) {
			return EngineValue.undefined();
		}

		if (isNaN(yValue)) {
			return EngineValue.undefined();
		}

		if (xValue === yValue) {
			return EngineValue.boolean(false);
		}

		if (xValue === +0 && EngineValueUtils.isNegativeZero(yValue)) {
			return EngineValue.boolean(false);
		}

		if (EngineValueUtils.isNegativeZero(xValue) && yValue === +0) {
			return EngineValue.boolean(false);
		}

		if (xValue === Infinity) {
			return EngineValue.boolean(false);
		}

		if (yValue === Infinity) {
			return EngineValue.boolean(true);
		}

		if (yValue === -Infinity) {
			return EngineValue.boolean(false);
		}

		if (xValue === -Infinity) {
			return EngineValue.boolean(true);
		}

		return xValue < yValue ? EngineValue.boolean(true) : EngineValue.boolean(false);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-equal
	numberEqual(this: EngineValue<"number">, other: EngineValue<"number">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (isNaN(xValue)) {
			return EngineValue.boolean(false);
		}

		if (isNaN(yValue)) {
			return EngineValue.boolean(false);
		}

		if (xValue === +0 && EngineValueUtils.isNegativeZero(yValue)) {
			return EngineValue.boolean(true);
		}

		if (EngineValueUtils.isNegativeZero(xValue) && yValue === +0) {
			return EngineValue.boolean(true);
		}

		if (xValue === yValue) {
			return EngineValue.boolean(true);
		}

		return EngineValue.boolean(false);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-sameValue
	numberSameValue(this: EngineValue<"number">, other: EngineValue<"number">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (isNaN(xValue) && isNaN(yValue)) {
			return EngineValue.boolean(true);
		}

		if (
			EngineValueUtils.isNegativeZero(xValue) &&
			EngineValueUtils.isNegativeZero(yValue)
		) {
			return EngineValue.boolean(true);
		}

		if (xValue === +0 && EngineValueUtils.isNegativeZero(yValue)) {
			return EngineValue.boolean(false);
		}

		if (EngineValueUtils.isNegativeZero(xValue) && yValue === +0) {
			return EngineValue.boolean(false);
		}

		return EngineValue.boolean(xValue === yValue);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-sameValueZero
	numberSameValueZero(this: EngineValue<"number">, other: EngineValue<"number">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (isNaN(xValue) && isNaN(yValue)) {
			return EngineValue.boolean(true);
		}

		if (xValue === +0 && EngineValueUtils.isNegativeZero(yValue)) {
			return EngineValue.boolean(true);
		}
		if (EngineValueUtils.isNegativeZero(xValue) && yValue === +0) {
			return EngineValue.boolean(true);
		}

		return EngineValue.boolean(xValue === yValue);
	}

	// https://tc39.es/ecma262/#sec-numberbitwiseop
	numberBitwiseOp(
		this: EngineValue<"number">,
		op: "&" | "^" | "|",
		other: EngineValue<"number">,
	) {
		const lNumCompletion = toInt32(this);
		if (lNumCompletion.type === "throw") {
			throw lNumCompletion.error;
		}
		const rNumCompletion = toInt32(other);
		if (rNumCompletion.type === "throw") {
			throw rNumCompletion.error;
		}

		const lNum = lNumCompletion.value.data.value;
		const rNum = rNumCompletion.value.data.value;

		// Taking a wee shortcut here;

		if (op === "&") {
			return EngineValue.number(lNum & rNum);
		} else if (op === "^") {
			return EngineValue.number(lNum ^ rNum);
		}
		return EngineValue.number(lNum | rNum);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-bitwiseAND
	numberBitwiseAND(this: EngineValue<"number">, other: EngineValue<"number">) {
		return this.numberBitwiseOp("&", other);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-bitwiseXOR
	numberBitwiseXOR(this: EngineValue<"number">, other: EngineValue<"number">) {
		return this.numberBitwiseOp("^", other);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-bitwiseOR
	numberBitwiseOR(this: EngineValue<"number">, other: EngineValue<"number">) {
		return this.numberBitwiseOp("|", other);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-number-tostring
	numberToString(this: EngineValue<"number">, radix: number): EngineValue<"string"> {
		const x = this.data.value;

		if (isNaN(x)) {
			return EngineValue.string("NaN");
		}

		if (EngineValueUtils.isPositiveOrNegativeZero(x)) {
			return EngineValue.string("0");
		}

		if (x < 0) {
			return EngineValue.string(
				`-${EngineValue.number(-x).numberToString(radix).data.value}`,
			);
		}

		if (x === Infinity) {
			return EngineValue.string("Infinity");
		}

		// Weee shortcut here;
		return EngineValue.string(x.toString(radix));
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-unaryMinus
	bigintUnaryMinus(this: EngineValue<"bigint">) {
		const value = this.data.value;
		if (value === 0n) {
			return EngineValue.bigint(0n);
		}

		return EngineValue.bigint(-this.data.value);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-bitwiseNOT
	bigintBitwiseNOT(this: EngineValue<"bigint">) {
		return EngineValue.bigint(-this.data.value - 1n);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-exponentiate
	bigintExponentiate(this: EngineValue<"bigint">, exponent: EngineValue<"bigint">) {
		const base = this.data.value;
		const exp = exponent.data.value;

		if (base < 0n) {
			return throwCompletion(new RangeError("Cannot exponentiate negative numbers"));
		}

		if (base === 0n && exp === 0n) {
			return normalCompletion(EngineValue.bigint(1n));
		}

		return normalCompletion(EngineValue.bigint(base ** exp));
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-multiply
	bigintMultiply(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		return EngineValue.bigint(xValue * yValue);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-divide
	bigintDivide(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (yValue === 0n) {
			return throwCompletion(new RangeError("Cannot divide by zero"));
		}

		// Auto-truncates
		const quotient = xValue / yValue;
		return normalCompletion(EngineValue.bigint(quotient));
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-remainder
	bigintRemainder(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		const nValue = this.data.value;
		const dValue = other.data.value;

		if (dValue === 0n) {
			return throwCompletion(new RangeError("Cannot divide by zero"));
		}

		if (nValue === 0n) {
			return normalCompletion(EngineValue.bigint(0n));
		}

		const quotient = nValue / dValue;
		return normalCompletion(EngineValue.bigint(nValue - dValue * quotient));
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-add
	bigintAdd(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return EngineValue.bigint(this.data.value + other.data.value);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-subtract
	bigintSubtract(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return EngineValue.bigint(this.data.value - other.data.value);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-leftShift
	bigintLeftShift(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (yValue < 0) {
			return EngineValue.bigint(xValue / 2n ** -yValue);
		}

		return EngineValue.bigint(xValue * 2n ** yValue);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-signedRightShift
	bigintSignedRightShift(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return this.bigintLeftShift(EngineValue.bigint(-other.data.value));
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-unsignedRightShift
	bigintUnsignedRightShift(this: EngineValue<"bigint">, _other: EngineValue<"bigint">) {
		return throwCompletion(new TypeError("Cannot shift unsigned bigints"));
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-lessThan
	bigintLessThan(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return this.data.value < other.data.value ?
				EngineValue.boolean(true)
			:	EngineValue.boolean(false);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-equal
	bigintEqual(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return EngineValue.boolean(this.data.value === other.data.value);
	}

	// https://tc39.es/ecma262/#sec-binaryand
	binaryAnd(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (xValue === 1n && yValue === 1n) {
			return EngineValue.bigint(1n);
		}

		return EngineValue.bigint(0n);
	}

	// https://tc39.es/ecma262/#sec-binaryor
	binaryOr(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (xValue === 1n || yValue === 1n) {
			return EngineValue.bigint(1n);
		}

		return EngineValue.bigint(0n);
	}

	// https://tc39.es/ecma262/#sec-binaryxor
	binaryXor(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		const xValue = this.data.value;
		const yValue = other.data.value;

		if (xValue === 1n && yValue === 0n) {
			return EngineValue.bigint(1n);
		}

		if (xValue === 0n && yValue === 1n) {
			return EngineValue.bigint(1n);
		}

		return EngineValue.bigint(0n);
	}

	// https://tc39.es/ecma262/#sec-bigintbitwiseop
	bigintBitwiseOp(
		this: EngineValue<"bigint">,
		op: "&" | "^" | "|",
		other: EngineValue<"bigint">,
	): EngineValue<"bigint"> {
		let xValue = this.data.value;
		let yValue = other.data.value;

		let result = 0n;
		let shift = 0n;

		while (!(xValue === 0n || xValue === -1n) || !(yValue === 0n || yValue === -1n)) {
			const xDigit = xValue & 1n;
			const yDigit = yValue & 1n;

			if (op === "&") {
				result =
					result +
					2n ** shift *
						EngineValue.bigint(xDigit).binaryAnd(EngineValue.bigint(yDigit)).data.value;
			} else if (op === "|") {
				result =
					result +
					2n ** shift *
						EngineValue.bigint(xDigit).binaryOr(EngineValue.bigint(yDigit)).data.value;
			} else {
				result =
					result +
					2n ** shift *
						EngineValue.bigint(xDigit).binaryXor(EngineValue.bigint(yDigit)).data.value;
			}

			shift += 1n;
			xValue = (xValue - xDigit) / 2n;
			yValue = (yValue - yDigit) / 2n;
		}

		if (op === "&") {
			const tmp = EngineValue.bigint(xValue & 1n).binaryAnd(
				EngineValue.bigint(yValue & 1n),
			);
			if (tmp.data.value !== 0n) {
				result = result - 2n ** shift;
			}
			return EngineValue.bigint(result);
		} else if (op === "|") {
			const tmp = EngineValue.bigint(xValue & 1n).binaryOr(
				EngineValue.bigint(yValue & 1n),
			);
			if (tmp.data.value !== 0n) {
				result = result - 2n ** shift;
			}
			return EngineValue.bigint(result);
		}

		const tmp = EngineValue.bigint(xValue & 1n).binaryXor(
			EngineValue.bigint(yValue & 1n),
		);
		if (tmp.data.value !== 0n) {
			result = result - 2n ** shift;
		}

		return EngineValue.bigint(result);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-bitwiseAND
	bigintBitwiseAND(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return this.bigintBitwiseOp("&", other);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-bitwiseXOR
	bigintBitwiseXOR(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return this.bigintBitwiseOp("^", other);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-bitwiseOR
	bigintBitwiseOR(this: EngineValue<"bigint">, other: EngineValue<"bigint">) {
		return this.bigintBitwiseOp("|", other);
	}

	// https://tc39.es/ecma262/#sec-numeric-types-bigint-tostring
	bigintToString(this: EngineValue<"bigint">, radix: number): EngineValue<"string"> {
		if (this.data.value < 0n) {
			return EngineValue.string(
				`-${EngineValue.bigint(-this.data.value).bigintToString(radix).data.value}`,
			);
		}

		// Weee shortcut here;
		return EngineValue.string(this.data.value.toString(radix));
	}

	objectHasInternalSlot(
		this: EngineValue<"object">,
		slot: keyof ObjectInternalSlots,
	): boolean {
		return !isNil(this.data.internalSlots[slot]);
	}

	objectGetInternalSlot<const K extends keyof ObjectInternalSlots>(
		this: EngineValue<"object">,
		slot: K,
	): ObjectInternalSlots[K] {
		return this.data.internalSlots[slot]!;
	}

	objectSetInternalSlot<const K extends keyof ObjectInternalSlots>(
		this: EngineValue<"object">,
		slot: K,
		value: ObjectInternalSlots[K],
	): void {
		this.data.internalSlots[slot] = value;
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
