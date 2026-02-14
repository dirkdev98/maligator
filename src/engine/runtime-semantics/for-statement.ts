import type { ESTree } from "meriyah";
import { isNil } from "../../utils.ts";
import { toBoolean } from "../abstract-operations/type-conversion.ts";
import { newDeclarativeEnvironment } from "../execution-contexts/environment-record.ts";
import { getCurrentExecutionContext } from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ReferenceRecord } from "../types-and-values/reference-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const ForStatement: Evaluator<"ForStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-forloopevaluation
	evaluate(node) {
		const oldEnv = getCurrentExecutionContext().lexicalEnvironment;
		const loopEnv = newDeclarativeEnvironment(oldEnv);
		getCurrentExecutionContext().lexicalEnvironment = loopEnv;

		if (node.init) {
			const initResult = evaluate(node.init);
			if (initResult.type !== "normal") {
				getCurrentExecutionContext().lexicalEnvironment = oldEnv;
				return initResult;
			}
		}

		let result: CompletionRecord<EngineValue | ReferenceRecord | undefined> =
			normalCompletion(EngineValue.undefined());

		try {
			result = forBodyEvaluation(node.test, node.update, node.body);
		} finally {
			getCurrentExecutionContext().lexicalEnvironment = oldEnv;
		}

		return result;
	},
};

// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-forbodyevaluation
function forBodyEvaluation(
	test: ESTree.Expression | null,
	increment: ESTree.Expression | null,
	body: ESTree.Statement,
): CompletionRecord<EngineValue | ReferenceRecord | undefined> {
	let v: EngineValue | ReferenceRecord | undefined = EngineValue.undefined();

	{
		// Push a temp env so createPerIterationEnvironment drop it.
		// TODO: Not sure why this is needed.
		const tmpEnv = getCurrentExecutionContext().lexicalEnvironment!;
		getCurrentExecutionContext().lexicalEnvironment = newDeclarativeEnvironment(tmpEnv);
	}

	createPerIterationEnvironment();

	const start = Date.now();
	const endTime = 500;

	while (Date.now() < start + endTime) {
		if (test) {
			const testRef = evaluate(test).unwrap();
			const testValue = getValue(testRef);
			if (!toBoolean(testValue).data.value) {
				return normalCompletion(v);
			}
		}

		const result = evaluate(body);
		if (result.type !== "normal") {
			return result;
		}

		if (!isNil(result.value)) {
			v = result.value;
		}

		createPerIterationEnvironment();

		if (increment) {
			getValue(evaluate(increment).unwrap());
		}
	}

	return normalCompletion(v);
}

// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-createperiterationenvironment
function createPerIterationEnvironment() {
	const lastIterationEnv = getCurrentExecutionContext().lexicalEnvironment!;
	const outer = lastIterationEnv.outerEnv!;

	const thisIterationEnv = newDeclarativeEnvironment(outer);
	getCurrentExecutionContext().lexicalEnvironment = thisIterationEnv;
}
