import { resolveThisBinding } from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { Evaluator } from "./index.ts";

export const ThisExpression: Evaluator<"ThisExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-this-keyword-runtime-semantics-evaluation
	evaluate(_node) {
		return normalCompletion(resolveThisBinding());
	},
};
