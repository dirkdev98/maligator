import { normalCompletion } from "../types-and-values/completion-record.ts";
import { getValue, putValue } from "../types-and-values/reference-record.ts";
import { applyStringOrNumericBinaryOperator } from "./binary-expression.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const AssignmentExpression: Evaluator<"AssignmentExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-assignment-operators-runtime-semantics-evaluation
	evaluate(node) {
		// TODO: Array literal / object literal assignment.

		const lRef = evaluate(node.left);
		if (lRef.type === "throw") {
			return lRef;
		}

		const lVal = node.operator !== "=" ? getValue(lRef.value) : undefined;

		// TODO: Implement strict checks on eval & arguments.

		// TODO: Anonymous functions handling

		const rRef = evaluate(node.right);
		if (rRef.type === "throw") {
			return rRef;
		}
		const rValue = getValue(rRef.value);

		if (node.operator === "=") {
			putValue(lRef.value, rValue);
		} else if (["??=", "&&=", "||="].includes(node.operator)) {
			throw new Error(`Missing implementation for '${node.operator}'`);
		} else {
			const r = applyStringOrNumericBinaryOperator(
				lVal!,
				node.operator.slice(0, -1),
				rValue,
			);
			if (r.type === "throw") {
				return r;
			}

			putValue(lRef.value, r.value);
			return r;
		}

		return normalCompletion(rValue);
	},
};
