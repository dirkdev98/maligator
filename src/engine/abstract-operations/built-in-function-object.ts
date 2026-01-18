import {
	ExecutionContext,
	getCurrentExecutionContext,
	getCurrentRealm,
	popExecutionContext,
	pushNewExecutionContext,
} from "../execution-contexts/execution-context.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";
import { setFunctionLength, setFunctionName } from "./function-objects.ts";
import { ordinaryObjectCreate } from "./ordinary-object.ts";

export const BuiltinFunctionObjectInternalMethods = {
	Call: (
		O: EngineValue<"object">,
		thisArgument: EngineValue,
		argumentsList: Array<EngineValue>,
	) => {
		return builtinCallOrConstruct(O, thisArgument, argumentsList, undefined);
	},

	Construct: (
		O: EngineValue<"object">,
		argumentsList: Array<EngineValue>,
		newTarget: EngineValue<"object">,
	) => {
		return builtinCallOrConstruct(
			O,
			undefined,
			argumentsList,
			newTarget,
		) as CompletionRecord<EngineValue<"object">>;
	},
} satisfies Partial<ObjectInternalSlots>;

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-builtincallorconstruct
export function builtinCallOrConstruct(
	F: EngineValue<"object">,
	thisArgument: EngineValue | undefined,
	argumentsList: Array<EngineValue>,
	newTarget?: EngineValue<"object">,
): CompletionRecord<EngineValue> {
	const callerContext = getCurrentExecutionContext();
	// TODO: Suspend?

	const calleeContext = new ExecutionContext();
	calleeContext.function = F;
	const calleeRealm = F.objectGetInternalSlot("Realm");
	calleeContext.realm = calleeRealm;
	calleeContext.scriptOrModule = null;
	pushNewExecutionContext(calleeContext);

	// TODO: Async

	const result = F.objectGetInternalSlot("_BuiltinCallback")(
		thisArgument,
		argumentsList,
		newTarget,
	);

	popExecutionContext(callerContext);

	return result;
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-createbuiltinfunction
export function createBuiltinFunction(
	callback: ObjectInternalSlots["_BuiltinCallback"],
	length: number,
	name: string,
	additionalInternalSlotsList: Array<string>,
	realm?: Realm,
	prototype?: EngineValue<"object">,
	prefix?: string,
	async?: boolean,
) {
	realm ??= getCurrentRealm();
	prototype ??= realm.intrinsics["%Function.prototype%"]!.asObject();
	async ??= false;
	const internalSlotsList = [
		"Realm",
		"InitialName",
		"Async",
		...additionalInternalSlotsList,
	];

	const func = ordinaryObjectCreate(prototype, internalSlotsList);
	for (const [key, value] of Object.entries(BuiltinFunctionObjectInternalMethods)) {
		func.objectSetInternalSlot(key as keyof ObjectInternalSlots, value);
	}

	func.objectSetInternalSlot("_BuiltinCallback", callback);
	func.objectSetInternalSlot("Async", async);
	func.objectSetInternalSlot("Prototype", prototype);
	func.objectSetInternalSlot("Extensible", true);
	func.objectSetInternalSlot("Realm", realm);
	func.objectSetInternalSlot("InitialName", EngineValue.null());

	setFunctionLength(func, length);
	setFunctionName(func, name, prefix);

	return func;
}
