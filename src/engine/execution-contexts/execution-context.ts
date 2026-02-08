import type { ESTree } from "meriyah";
import { isNil } from "../../utils.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { getIdentifierReference } from "./environment-record.ts";
import type { EnvironmentRecord, GlobalEnvironmentRecord } from "./environment-record.ts";
import type { Realm } from "./realm.ts";

export let runningExecutionContext: ExecutionContext;

const executionContextStack: Array<ExecutionContext> = [];

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-execution-contexts
export class ExecutionContext {
	codeEvaluationState: "todo" = "todo" as const;
	function: EngineValue<"object"> | null = null;
	realm: Realm | null = null;
	scriptOrModule: ESTree.Program | null = null;

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

export function popExecutionContextTillEmpty() {
	while (executionContextStack.length > 0) {
		executionContextStack.pop();
	}
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

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-getthisenvironment
export function getThisEnvironment(): GlobalEnvironmentRecord {
	let env = getCurrentExecutionContext().lexicalEnvironment!;

	while (env) {
		if (env.hasThisBinding()) {
			return env as GlobalEnvironmentRecord;
		}

		if (env.outerEnv === null) {
			return env as GlobalEnvironmentRecord;
		}

		env = env.outerEnv;
	}

	throw new Error("unreachable");
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-resolvethisbinding
export function resolveThisBinding() {
	const env = getThisEnvironment();
	return env.getThisBinding();
}

export function getActiveFunctionObject() {
	return getCurrentExecutionContext().function!;
}
