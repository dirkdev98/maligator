import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
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

		realm.setDefaultGlobalBindings();
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-createintrinsics
	createIntrinsics() {}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-setdefaultglobalbindings
	setDefaultGlobalBindings() {
		const global = this.globalObject!;

		this.setGlobalValueProperties(global);
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
}
