import { toBoolean } from "../abstract-operations/type-conversion.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const ConditionalExpression: Evaluator<"ConditionalExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#prod-ConditionalExpression
	evaluate(node) {
		const lRef = evaluate(node.test);
		if (lRef.type === "throw") {
			return lRef;
		}

		const lVal = toBoolean(getValue(lRef.value));

		const rRef = evaluate(lVal.data.value ? node.consequent : node.alternate);
		if (rRef.type === "throw") {
			return rRef;
		}

		return normalCompletion(getValue(rRef.value));
	},
};
