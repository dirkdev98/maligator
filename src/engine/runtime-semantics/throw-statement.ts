import { throwCompletion } from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const ThrowStatement: Evaluator<"ThrowStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#prod-ThrowStatement
	evaluate(node) {
		const exprRef = evaluate(node.argument);
		if (exprRef.type === "throw") {
			return exprRef;
		}

		const v = getValue(exprRef.value);

		return throwCompletion(v);
	},
};
