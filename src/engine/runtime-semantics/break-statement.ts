import { unwrapCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { Evaluator } from "./index.ts";

export const BreakStatement: Evaluator<"BreakStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-break-statement
	evaluate(node) {
		return {
			type: "break",
			value: EngineValue.undefined(),
			target: node.label?.name,
			unwrap() {
				return unwrapCompletion(this);
			},
		};
	},
};
