import type { ESTree } from "meriyah";
import { isStrictlyEqual } from "../abstract-operations/testing-and-comparison.ts";
import { newDeclarativeEnvironment } from "../execution-contexts/environment-record.ts";
import { getCurrentExecutionContext } from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ReferenceRecord } from "../types-and-values/reference-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const SwitchStatement: Evaluator<"SwitchStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-switch-statement-runtime-semantics-evaluation
	evaluate(node) {
		const exprRef = evaluate(node.discriminant);
		if (exprRef.type === "throw") {
			return exprRef;
		}

		const exprValue = getValue(exprRef.value);
		const oldEnv = getCurrentExecutionContext().lexicalEnvironment;
		const blockEnv = newDeclarativeEnvironment(oldEnv);
		getCurrentExecutionContext().lexicalEnvironment = blockEnv;

		const r = caseBlockEvaluation(node, exprValue);
		getCurrentExecutionContext().lexicalEnvironment = oldEnv;

		return r;
	},
};

/**
 * https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-caseblockevaluation
 */
function caseBlockEvaluation(
	node: ESTree.SwitchStatement,
	switchValue: EngineValue,
): CompletionRecord<EngineValue | ReferenceRecord | undefined> {
	if (node.cases.length === 0) {
		return normalCompletion(EngineValue.undefined());
	}

	const casesBeforeDefault: Array<ESTree.SwitchCase> = [];
	let defaultCase: ESTree.SwitchCase | undefined = undefined;
	const casesAfterDefault: Array<ESTree.SwitchCase> = [];

	for (const item of node.cases) {
		if (defaultCase) {
			casesAfterDefault.push(item);
		} else if (item.test === null) {
			defaultCase = item;
		} else {
			casesBeforeDefault.push(item);
		}
	}

	let v: EngineValue | ReferenceRecord = EngineValue.undefined();
	let found = false;

	for (const item of casesBeforeDefault) {
		if (!found) {
			found = caseIsSelected(item.test, switchValue);
		}

		if (found) {
			const r = evaluate({
				type: "BlockStatement",
				body: item.consequent,
			});

			if ("value" in r && !!r.value) {
				v = r.value;
			}
			if (r.type !== "normal") {
				r.value = v;
				return r;
			}
		}
	}

	return normalCompletion(v);
}

// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-caseclauseisselected
function caseIsSelected(
	test: ESTree.Expression | null,
	switchValue: EngineValue,
): boolean {
	if (test === null) {
		return true;
	}

	const exprRef = evaluate(test);
	if (exprRef.type === "throw") {
		throw new Error("Unexpected error while evaluating case expression");
	}

	const value = getValue(exprRef.value);
	return isStrictlyEqual(switchValue, value).data.value;
}
