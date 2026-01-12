import type { ESTree } from "meriyah";
import type { EnvironmentRecord } from "../execution-contexts/environment-record.ts";
import type { FunctionEnvironmentRecord } from "../execution-contexts/environment-record.ts";
import { newFunctionEnvironment } from "../execution-contexts/environment-record.ts";
import {
	ExecutionContext,
	getCurrentExecutionContext,
	getCurrentRealm,
	pushNewExecutionContext,
} from "../execution-contexts/execution-context.ts";
import { evaluateFunctionBody } from "../runtime-semantics/function-meta.ts";
import { unwrapCompletion } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";
import { definePropertyOrThrow } from "./object-operations.ts";
import { ordinaryObjectCreate } from "./ordinary-object.ts";
import { PropertyDescriptor } from "./property-map.ts";
import type { PropertyKey } from "./property-map.ts";
import { toObject } from "./type-conversion.ts";

export const FunctionObjectInternalMethods = {
	Call: (
		O: EngineValue<"object">,
		thisArgument: EngineValue,
		argumentsList: Array<EngineValue>,
	): CompletionRecord<EngineValue> => {
		const _callerContext = getCurrentExecutionContext();
		// TODO: Suspend?

		const calleeContext = prepareForOrdinaryCall(O, undefined);

		if (O.objectGetInternalSlot("IsClassConstructor")) {
			throw new Error("Not implemented.");
		}

		ordinaryCallBindThis(O, calleeContext, thisArgument);

		return ordinaryCallEvaluateBody(O, argumentsList);
	},
} satisfies Partial<ObjectInternalSlots>;

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-prepareforordinarycall
export function prepareForOrdinaryCall(
	F: EngineValue<"object">,
	newTarget?: EngineValue,
) {
	const _callerContext = getCurrentExecutionContext();

	const calleeContext = new ExecutionContext();
	calleeContext.function = F;
	const calleeRealm = F.objectGetInternalSlot("Realm");
	calleeContext.realm = calleeRealm;
	calleeContext.scriptOrModule = F.objectGetInternalSlot("ScriptOrModule");

	const localEnv = newFunctionEnvironment(F, newTarget);
	calleeContext.lexicalEnvironment = localEnv;
	calleeContext.variableEnvironment = localEnv;

	// TODO: PrivateEnvironment

	// TODO: Suspend callerContext if not done so.
	pushNewExecutionContext(calleeContext);
	return calleeContext;
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarycallbindthis
export function ordinaryCallBindThis(
	F: EngineValue<"object">,
	calleeContext: ExecutionContext,
	thisArgument: EngineValue,
) {
	const thisMode = F.objectGetInternalSlot("ThisMode");
	if (thisMode === "LEXICAL") {
		return;
	}

	const calleeRealm = F.objectGetInternalSlot("Realm");
	const localEnv = calleeContext.lexicalEnvironment;
	const thisValue =
		thisMode === "STRICT" ? thisArgument
		: thisArgument.isNull() || thisArgument.isUndefined() ?
			// eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
			calleeRealm.globalEnv?.globalThisValue!
		:	unwrapCompletion(toObject(thisArgument));

	if (localEnv && !localEnv?.hasThisBinding()) {
		localEnv.hasThisBinding();
		(localEnv as FunctionEnvironmentRecord).bindThisValue(thisValue);
	}
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarycallevaluatebody
// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-runtime-semantics-evaluatebody
export function ordinaryCallEvaluateBody(
	F: EngineValue<"object">,
	argumentsList: Array<EngineValue>,
) {
	return evaluateFunctionBody(F, argumentsList);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryfunctioncreate
export function ordinaryFunctionCreate(
	functionPrototype: EngineValue<"object">,
	sourceText: string,
	parameterList: Array<ESTree.Parameter>,
	body: ESTree.BlockStatementBase,
	thisMode: "LEXICAL-THIS" | "NON-LEXICAL-THIS",
	env: EnvironmentRecord,
	_privateEnvironment: EnvironmentRecord | null,
): EngineValue<"object"> {
	const internalSlotsList = [
		"Environment",
		"PrivateEnvironment",
		"FormalParameters",
		"ECMAScriptCode",
		"ConstructorKind",
		"Realm",
		"ScriptOrModule",
		"ThisMode",
		"Strict",
		"HomeObject",
		"SourceText",
		"Fields",
		"PrivateMethods",
		"ClassFieldInitializerName",
		"IsClassConstructor",
	];
	const F = ordinaryObjectCreate(functionPrototype, internalSlotsList);

	for (const [key, value] of Object.entries(FunctionObjectInternalMethods)) {
		F.objectSetInternalSlot(key as keyof ObjectInternalSlots, value);
	}

	F.objectSetInternalSlot("SourceText", sourceText);
	F.objectSetInternalSlot("FormalParameters", parameterList);
	F.objectSetInternalSlot("ECMAScriptCode", body);
	F.objectSetInternalSlot("Strict", true);
	if (thisMode === "LEXICAL-THIS") {
		F.objectSetInternalSlot("ThisMode", "LEXICAL");
	} else {
		// TODO: Strict vs global
		F.objectSetInternalSlot("ThisMode", "STRICT");
	}

	F.objectSetInternalSlot("IsClassConstructor", false);
	F.objectSetInternalSlot("Environment", env);
	// TODO: F.objectSetInternalSlot("PrivateEnvironment", _privateEnvironment ?? null);

	// TODO: ScriptOrModule
	F.objectSetInternalSlot("ScriptOrModule", null as unknown as ESTree.Program);
	F.objectSetInternalSlot("Realm", getCurrentRealm());
	F.objectSetInternalSlot("HomeObject", EngineValue.undefined());
	F.objectSetInternalSlot("Fields", []);
	F.objectSetInternalSlot("PrivateMethods", []);
	F.objectSetInternalSlot("ClassFieldInitializerName", null);

	// TODO: Fix this based on ExpectedArgumentCount
	setFunctionLength(F, parameterList.length);

	return F;
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-setfunctionname
export function setFunctionName(
	F: EngineValue<"object">,
	name: PropertyKey,
	prefix?: string,
) {
	if (name instanceof EngineValue) {
		if (name.data.description) {
			name = `[${name.data.description}]`;
		} else {
			name = "";
		}
	}

	if (F.objectHasInternalSlot("InitialName")) {
		F.objectSetInternalSlot("InitialName", EngineValue.string(name));
	}

	if (prefix) {
		name = `${prefix} ${name}`;
	}

	definePropertyOrThrow(
		F,
		"name",
		new PropertyDescriptor({
			value: EngineValue.string(name),
			writable: false,
			enumerable: false,
			configurable: true,
		}),
	);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-setfunctionlength
export function setFunctionLength(F: EngineValue<"object">, length: number) {
	definePropertyOrThrow(
		F,
		"length",
		new PropertyDescriptor({
			value: EngineValue.number(length),
			writable: false,
			enumerable: false,
			configurable: true,
		}),
	);
}
