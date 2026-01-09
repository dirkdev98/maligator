import { toBoolean } from "../abstract-operations/type-conversion.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const IfStatement: Evaluator<"IfStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-if-statement
	evaluate(node) {
		const exprRef = evaluate(node.test);
		if (exprRef.type === "throw") {
			return exprRef;
		}

		const exprValue = toBoolean(getValue(exprRef.value));
		if (exprValue.data.value) {
			return evaluate(node.consequent);
		} else if (node.alternate !== null) {
			return evaluate(node.alternate);
		}

		return normalCompletion(undefined);
	},
};
