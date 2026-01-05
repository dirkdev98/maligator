import { normalCompletion } from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const ExpressionStatement: Evaluator<"ExpressionStatement"> = {
	evaluate(node) {
		const exprRef = evaluate(node.expression);
		if (exprRef.type === "throw") {
			return exprRef;
		}

		return normalCompletion(getValue(exprRef.value));
	},
};
