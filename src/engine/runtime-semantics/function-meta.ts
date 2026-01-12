// https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html#sec-runtime-semantics-evaluatefunctionbody
import type { ESTree } from "meriyah";
import {
	getCurrentExecutionContext,
	resolveBinding,
} from "../execution-contexts/execution-context.ts";
import { returnCompletion } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { evaluate } from "./index.ts";

export function evaluateFunctionBody(
	F: EngineValue<"object">,
	argumentsList: Array<EngineValue>,
): CompletionRecord<EngineValue> {
	functionDeclarationInstantiation(F, argumentsList);

	const evaluationResult = evaluate(
		F.objectGetInternalSlot("ECMAScriptCode") as ESTree.Node,
	);

	if (
		evaluationResult.type === "normal" ||
		(evaluationResult.type === "return" &&
			!(evaluationResult.value instanceof EngineValue))
	) {
		return returnCompletion(EngineValue.undefined());
	}

	return evaluationResult as CompletionRecord<EngineValue>;
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-functiondeclarationinstantiation
export function functionDeclarationInstantiation(
	F: EngineValue<"object">,
	argumentsList: Array<EngineValue>,
) {
	const calleeContext = getCurrentExecutionContext();
	const _code = F.objectGetInternalSlot("ECMAScriptCode");
	const _strict = F.objectGetInternalSlot("Strict");
	const formals = F.objectGetInternalSlot("FormalParameters");
	const paramNames = formals.map((it) => {
		switch (it.type) {
			case "Identifier":
				return it.name;
			default:
				return "";
		}
	});
	const _simpleParameterList = true;
	const _hasParameterExpressions = false;
	const _varNames = [];
	const _varDeclarations = [];
	const _lexicalNames = [];
	const _functionNames = [];

	// TODO: Initialize vars

	const env = calleeContext.lexicalEnvironment!;
	for (let i = 0; i < paramNames.length; i++) {
		const param = paramNames[i]!;
		if (!env.hasBinding(param)) {
			env.createMutableBinding(param, false);

			// TODO:
			// https://tc39.es/ecma262/multipage/syntax-directed-operations.html#sec-runtime-semantics-iteratorbindinginitialization
			const binding = resolveBinding(EngineValue.string(param));
			binding.initializeReferencedBinding(argumentsList[i]!);
		}
	}
}
