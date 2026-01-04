import type { ESTree } from "meriyah";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import type { EngineValue } from "../types-and-values/data-types.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";

export const ExpressionStatement = {
	evaluate(node: ESTree.ExpressionStatement): CompletionRecord<EngineValue> {
		const exprRef = evaluate(node.expression);
		if (exprRef.type === "throw") {
			return exprRef;
		}

		return normalCompletion(getValue(exprRef.value));
	},
};
