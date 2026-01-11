import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { toInt32, toNumber, toString } from "../abstract-operations/type-conversion.ts";
import { intrinsicFunctionPrototype } from "../intrinsics/function-prototype.ts";
import { intrinsicObjectPrototype } from "../intrinsics/object-prototype.ts";
import { intrinsicObject } from "../intrinsics/object.ts";
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
			intrinsicObject,

			intrinsicFunctionPrototype,
		];

		const callbacks = [];

		for (const fn of fns) {
			const returnCb = fn(this);
			if (typeof returnCb === "function") {
				callbacks.push(returnCb);
			}
		}
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-setdefaultglobalbindings
	setDefaultGlobalBindings() {
		const global = this.globalObject!;

		this.setGlobalValueProperties(global);
		this.setGlobalFunctionProperties(global);
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
}
