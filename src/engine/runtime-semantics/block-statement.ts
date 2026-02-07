import type { ESTree } from "meriyah";
import type { EnvironmentRecord } from "../execution-contexts/environment-record.ts";
import { newDeclarativeEnvironment } from "../execution-contexts/environment-record.ts";
import { getCurrentExecutionContext } from "../execution-contexts/execution-context.ts";
import {
	normalCompletion,
	updateEmptyCompletion,
} from "../types-and-values/completion-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const BlockStatement: Evaluator<"BlockStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-block-runtime-semantics-evaluation
	evaluate(node) {
		if (node.body.length === 0) {
			return normalCompletion(undefined);
		}

		const oldEnv = getCurrentExecutionContext().lexicalEnvironment;
		const blockEnv = newDeclarativeEnvironment(oldEnv);

		blockDeclarationInstantiation(node.body, blockEnv);

		// @ts-expect-error - we reuse this for Programs
		if (node.type !== "Program") {
			getCurrentExecutionContext().lexicalEnvironment = blockEnv;
		}

		const blockValue = normalCompletion(undefined);

		for (const statement of node.body) {
			const res = evaluate(statement);
			if (res.type !== "normal") {
				getCurrentExecutionContext().lexicalEnvironment = oldEnv;
				return res;
			}
			updateEmptyCompletion(blockValue, res.value);
		}

		getCurrentExecutionContext().lexicalEnvironment = oldEnv;

		return blockValue;
	},
};

// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-blockdeclarationinstantiation
function blockDeclarationInstantiation(
	_statements: Array<ESTree.Statement>,
	_env: EnvironmentRecord,
) {
	// TODO: Implement
}
