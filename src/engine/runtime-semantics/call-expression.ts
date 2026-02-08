import type { ESTree } from "meriyah";
import { call } from "../abstract-operations/object-operations.ts";
import { isCallable } from "../abstract-operations/testing-and-comparison.ts";
import { throwCompletion } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { ReferenceRecord } from "../types-and-values/reference-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const CallExpression: Evaluator<"CallExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-function-calls-runtime-semantics-evaluation
	evaluate(node) {
		const ref = evaluate(node.callee as ESTree.Node);
		if (ref.type === "throw") {
			return ref;
		}

		const func = getValue(ref.value);

		// TODO: IsInTailPosition

		return evaluateCall(func, ref.value!, node.arguments, false);
	},
};

export function evaluateCall(
	func: EngineValue,
	ref: EngineValue | ReferenceRecord,
	args: ReadonlyArray<ESTree.Expression>,
	_tailPosition: boolean,
): CompletionRecord<EngineValue> {
	let thisValue: EngineValue = EngineValue.undefined();
	if (ref instanceof ReferenceRecord) {
		if (ref.isPropertyReference()) {
			thisValue = ref.getThisValue();
		} else {
			const refEvn = ref.getEnvironmentRecordBase();
			thisValue = refEvn.withBaseObject();
		}
	}

	// TODO: SpreadElement
	const funcArgs = args.map((arg) => getValue(evaluate(arg).value));

	if (!func.isObject() || !isCallable(func)) {
		return throwCompletion(new TypeError("Function is not callable."));
	}

	return call(func, thisValue, funcArgs);
}
