import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const SequenceExpression: Evaluator<"SequenceExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-comma-operator
	evaluate(node) {
		for (let i = 0; i < node.expressions.length - 1; i++) {
			const lRef = evaluate(node.expressions[i]!);
			if (lRef.type === "throw") {
				return lRef;
			}
			const v = getValue(lRef.value);

			if (i === node.expressions.length - 1) {
				return normalCompletion(v);
			}
		}

		return throwCompletion(new Error("Unexpected sequence expression."));
	},
};
