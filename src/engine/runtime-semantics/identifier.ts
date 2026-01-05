import { resolveBinding } from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { Evaluator } from "./index.ts";

export const Identifier: Evaluator<"Identifier"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-identifiers-runtime-semantics-evaluation
	evaluate(node) {
		return normalCompletion(resolveBinding(EngineValue.string(node.name)));
	},
};
