import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { toInt32, toNumber, toString } from "../abstract-operations/type-conversion.ts";
import { intrinsicArrayPrototype } from "../intrinsics/array-prototype.ts";
import { intrinsicArray } from "../intrinsics/array.ts";
import { intrinsicBigIntPrototype } from "../intrinsics/bigint-prototype.ts";
import { intrinsicBigInt } from "../intrinsics/bigint.ts";
import { intrinsicBooleanPrototype } from "../intrinsics/boolean-prototype.ts";
import { intrinsicBoolean } from "../intrinsics/boolean.ts";
import { intrinsicFunctionPrototype } from "../intrinsics/function-prototype.ts";
import { intrinsicNumberPrototype } from "../intrinsics/number-prototype.ts";
import { intrinsicNumber } from "../intrinsics/number.ts";
import { intrinsicObjectPrototype } from "../intrinsics/object-prototype.ts";
import { intrinsicObject } from "../intrinsics/object.ts";
import { intrinsicStringPrototype } from "../intrinsics/string-prototype.ts";
import { intrinsicString } from "../intrinsics/string.ts";
import { intrinsicSymbolPrototype } from "../intrinsics/symbol-prototype.ts";
import { intrinsicSymbol } from "../intrinsics/symbol.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { newGlobalEnvironment } from "./environment-record.ts";
import type { GlobalEnvironmentRecord } from "./environment-record.ts";
import { ExecutionContext, pushNewExecutionContext } from "./execution-context.ts";

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-code-realms
export class Realm {
	agentSignifier = "__Maligator_0__";

	intrinsics: Record<string, EngineValue> = {};

	globalObject: EngineValue<"object"> | null = null;
	globalEnv: GlobalEnvironmentRecord | null = null;

	hostDefined = EngineValue.undefined();

	templateMap = [];

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-initializehostdefinedrealm
	static init() {
		const realm = new Realm();
		realm.createIntrinsics();

		const newContext = new ExecutionContext();
		newContext.realm = realm;

		pushNewExecutionContext(newContext);

		const globalObject = ordinaryObjectCreate(
			realm.intrinsics["%Object.prototype%"]?.asObject() ?? EngineValue.null(),
		);
		const thisValue = globalObject;
		realm.globalObject = globalObject;
		realm.globalEnv = newGlobalEnvironment(globalObject, thisValue);

		// TODO: Is this true?
		newContext.lexicalEnvironment = realm.globalEnv.objectRecord;
		newContext.variableEnvironment = realm.globalEnv.declarativeRecord;

		realm.setDefaultGlobalBindings();
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-createintrinsics
	createIntrinsics() {
		const fns: Array<(realm: Realm) => void | (() => void)> = [
			intrinsicObjectPrototype,
			intrinsicFunctionPrototype,

			intrinsicObject,

			intrinsicBooleanPrototype,
			intrinsicBoolean,

			intrinsicSymbolPrototype,
			intrinsicSymbol,

			intrinsicNumberPrototype,
			intrinsicNumber,

			intrinsicBigIntPrototype,
			intrinsicBigInt,

			intrinsicStringPrototype,
			intrinsicString,

			intrinsicArrayPrototype,
			intrinsicArray,
		];

		const callbacks = [];

		for (const fn of fns) {
			const returnCb = fn(this);
			if (typeof returnCb === "function") {
				callbacks.push(returnCb);
			}
		}

		for (const cb of callbacks) {
			cb();
		}
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-setdefaultglobalbindings
	setDefaultGlobalBindings() {
		const global = this.globalObject!;

		this.setGlobalValueProperties(global);
		this.setGlobalFunctionProperties(global);
		this.setGlobalConstructorProperties(global);
	}

	// https://tc39.es/ecma262/multipage/global-object.html#sec-value-properties-of-the-global-object
	setGlobalValueProperties(global: EngineValue<"object">) {
		definePropertyOrThrow(
			global,
			"globalThis",
			new PropertyDescriptor({
				value: this.globalEnv!.getThisBinding(),
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);

		definePropertyOrThrow(
			global,
			"Infinity",
			new PropertyDescriptor({
				value: EngineValue.number(Infinity),
				writable: false,
				enumerable: false,
				configurable: false,
			}),
		);

		definePropertyOrThrow(
			global,
			"NaN",
			new PropertyDescriptor({
				value: EngineValue.number(NaN),
				writable: false,
				enumerable: false,
				configurable: false,
			}),
		);

		definePropertyOrThrow(
			global,
			"undefined",
			new PropertyDescriptor({
				value: EngineValue.undefined(),
				writable: false,
				enumerable: false,
				configurable: false,
			}),
		);
	}

	// https://tc39.es/ecma262/multipage/global-object.html#sec-function-properties-of-the-global-object
	setGlobalFunctionProperties(global: EngineValue<"object">) {
		// https://tc39.es/ecma262/multipage/global-object.html#sec-isfinite-number
		definePropertyOrThrow(
			global,
			"isFinite",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(_, [value], __) => {
						const num = toNumber(value!);
						if (num.type === "throw") {
							return num;
						}

						return normalCompletion(EngineValue.boolean(isFinite(num.value.data.value)));
					},
					1,
					"isFinite",
					[],
				),
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/global-object.html#sec-isnan-number
		definePropertyOrThrow(
			global,
			"isNaN",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(_, [value], __) => {
						const num = toNumber(value!);
						if (num.type === "throw") {
							return num;
						}

						return normalCompletion(EngineValue.boolean(isNaN(num.value.data.value)));
					},
					1,
					"isNaN",
					[],
				),
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/global-object.html#sec-parsefloat-string
		definePropertyOrThrow(
			global,
			"parseFloat",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(_, [value], __) => {
						const num = toString(value!);
						if (num.type === "throw") {
							return num;
						}

						return normalCompletion(EngineValue.number(parseFloat(num.value.data.value)));
					},
					1,
					"parseFloat",
					[],
				),
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/global-object.html#sec-parseint-string-radix
		definePropertyOrThrow(
			global,
			"parseInt",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(_, [value, radixValue], __) => {
						const num = toString(value!);
						if (num.type === "throw") {
							return num;
						}

						const radix = toInt32(radixValue!);
						if (radix.type === "throw") {
							return radix;
						}

						return normalCompletion(
							EngineValue.number(parseInt(num.value.data.value, radix.value.data.value)),
						);
					},
					1,
					"parseInt",
					[],
				),
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);
	}

	// https://tc39.es/ecma262/multipage/global-object.html#sec-constructor-properties-of-the-global-object
	setGlobalConstructorProperties(global: EngineValue<"object">) {
		definePropertyOrThrow(
			global,
			"Object",
			new PropertyDescriptor({
				value: this.intrinsics["%Object%"]!,
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);

		definePropertyOrThrow(
			global,
			"Boolean",
			new PropertyDescriptor({
				value: this.intrinsics["%Boolean%"]!,
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);
		definePropertyOrThrow(
			global,
			"Symbol",
			new PropertyDescriptor({
				value: this.intrinsics["%Symbol%"]!,
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);
		definePropertyOrThrow(
			global,
			"Number",
			new PropertyDescriptor({
				value: this.intrinsics["%Number%"]!,
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);
		definePropertyOrThrow(
			global,
			"BigInt",
			new PropertyDescriptor({
				value: this.intrinsics["%BigInt%"]!,
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);
		definePropertyOrThrow(
			global,
			"String",
			new PropertyDescriptor({
				value: this.intrinsics["%String%"]!,
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);

		definePropertyOrThrow(
			global,
			"Array",
			new PropertyDescriptor({
				value: this.intrinsics["%Array%"]!,
				writable: false,
				enumerable: false,
				configurable: true,
			}),
		);
	}
}
