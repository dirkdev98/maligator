import type { EngineValue } from "../types-and-values/data-types.ts";
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
