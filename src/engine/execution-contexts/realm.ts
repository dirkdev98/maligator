import { makeBasicObject } from "../abstract-operations/object-operations.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { GlobalEnvironmentRecord } from "./environment-record.ts";
import { ExecutionContext, pushNewExecutionContext } from "./execution-context.ts";

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-code-realms
export class Realm {
	agentSignifier = "__Maligator_0__";

	intrinsics: Record<string, EngineValue> = {};

	globalObject: EngineValue | null = null;
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

		//   a. Let global be OrdinaryObjectCreate(realm.[[Intrinsics]].[[%Object.prototype%]]).
		// TODO:
		const globalObject = makeBasicObject(["Extensible"]);
		const thisValue = globalObject;
		realm.globalObject = globalObject;

		// 15. Set realm.[[GlobalEnv]] to NewGlobalEnvironment(global, thisValue).
		// TODO:
		// realm.globalEnv = new GlobalEnvironmentRecord();

		realm.setGlobalBindings();
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-createintrinsics
	createIntrinsics() {}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-setdefaultglobalbindings
	setGlobalBindings() {}
}
