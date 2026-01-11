import { isNil } from "../../utils.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { getIdentifierReference } from "./environment-record.ts";
import type { EnvironmentRecord } from "./environment-record.ts";
import type { Realm } from "./realm.ts";

export let runningExecutionContext: ExecutionContext;

const executionContextStack: Array<ExecutionContext> = [];

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-execution-contexts
export class ExecutionContext {
	codeEvaluationState: "todo" = "todo" as const;
	function: EngineValue<"object"> | null = null;
	realm: Realm | null = null;
	scriptOrModule: null = null;

	lexicalEnvironment: EnvironmentRecord | null = null;
	variableEnvironment: EnvironmentRecord | null = null;
	privateEnvironment: null = null;
	generator: null = null;
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-getactivescriptormodule
export function getActiveScriptOrModule() {
	if (executionContextStack.length === 0) {
		return null;
	}

	return (
		executionContextStack.findLast((it) => it.scriptOrModule !== null)?.scriptOrModule ??
		null
	);
}

export function getCurrentExecutionContext() {
	return runningExecutionContext!;
}

export function getCurrentRealm() {
	return getCurrentExecutionContext().realm!;
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-getglobalobject
export function getGlobalObject() {
	return getCurrentRealm().globalObject!;
}

export function pushNewExecutionContext(context: ExecutionContext) {
	executionContextStack.push(context);
	runningExecutionContext = context;
}

export function popExecutionContext(
	newContext: ExecutionContext | undefined = undefined,
) {
	executionContextStack.pop();
	runningExecutionContext =
		newContext ?? executionContextStack[executionContextStack.length - 1]!;
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-resolvebinding
export function resolveBinding(
	name: EngineValue<"string">,
	env?: EnvironmentRecord | EngineValue<"undefined">,
) {
	if (isNil(env) || env instanceof EngineValue) {
		env = getCurrentExecutionContext().lexicalEnvironment!;
	}

	// TODO: IsStrict;
	const strict = true;
	return getIdentifierReference(env, name, strict);
}
