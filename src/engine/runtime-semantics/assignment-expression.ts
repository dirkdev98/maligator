import { normalCompletion } from "../types-and-values/completion-record.ts";
import { getValue, putValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const AssignmentExpression: Evaluator<"AssignmentExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-assignment-operators-runtime-semantics-evaluation
	evaluate(node) {
		if (node.operator !== "=") {
			throw new Error(`Operator isn't yet implemented: ${node.operator}`);
		}

		// TODO: Array literal / object literal assignment.

		const lRef = evaluate(node.left);
		if (lRef.type === "throw") {
			return lRef;
		}

		// TODO: Implement strict checks on eval & arguments.

		// TODO: Anonymous functions handling

		const rRef = evaluate(node.right);
		if (rRef.type === "throw") {
			return rRef;
		}
		const rValue = getValue(rRef.value);
		putValue(lRef.value, rValue);

		return normalCompletion(rValue);
	},
};
