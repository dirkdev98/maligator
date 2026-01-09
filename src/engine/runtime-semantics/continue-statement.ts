import { EngineValue } from "../types-and-values/data-types.ts";
import type { Evaluator } from "./index.ts";

export const ContinueStatement: Evaluator<"ContinueStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-continue-statement
	evaluate(node) {
		return {
			type: "continue",
			value: EngineValue.undefined(),
			target: node.label?.name,
		};
	},
};
