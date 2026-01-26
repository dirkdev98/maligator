import type { ESTree } from "meriyah";
import { newDeclarativeEnvironment } from "../execution-contexts/environment-record.ts";
import { getCurrentExecutionContext } from "../execution-contexts/execution-context.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const TryStatement: Evaluator<"TryStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-try-statement
	evaluate(node) {
		const tryResult = evaluate(node.block);
		const catchResult =
			tryResult.type === "throw" && node.handler !== null ?
				catchClauseEvaluation(node.handler, tryResult.error)
			:	undefined;

		const finallyResult = node.finalizer ? evaluate(node.finalizer) : undefined;

		const result =
			!finallyResult || finallyResult?.type === "normal" ?
				(catchResult ?? tryResult)
			:	finallyResult;

		if (result.value === undefined) {
			result.value = EngineValue.undefined();
		}

		return result;
	},
};

function catchClauseEvaluation(node: ESTree.CatchClause, errValue: EngineValue | Error) {
	if (errValue instanceof Error) {
		throw new Error("Can't catch internal errors yet.", {
			cause: errValue,
		});
	}

	const oldEnv = getCurrentExecutionContext().lexicalEnvironment;
	const catchEnv = newDeclarativeEnvironment(oldEnv);

	// TODO: Bound names
	if (node.param?.type === "Identifier") {
		catchEnv.createMutableBinding(node.param.name, false);
		catchEnv.initializeBinding(node.param.name, errValue);
	}

	getCurrentExecutionContext().lexicalEnvironment = catchEnv;

	const result = evaluate(node.body);

	getCurrentExecutionContext().lexicalEnvironment = oldEnv;

	return result;
}
