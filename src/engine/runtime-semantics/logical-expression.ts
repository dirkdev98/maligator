import { toBoolean } from "../abstract-operations/type-conversion.ts";
import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const LogicalExpression: Evaluator<"LogicalExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-binary-logical-operators
	evaluate(node) {
		if (node.operator === "&&") {
			const lRef = evaluate(node.left);
			if (lRef.type === "throw") {
				return lRef;
			}
			const lVal = getValue(lRef.value);
			if (!toBoolean(lVal).data.value) {
				return normalCompletion(lVal);
			}

			const rRef = evaluate(node.right);
			if (rRef.type === "throw") {
				return rRef;
			}

			return normalCompletion(getValue(rRef.value));
		} else if (node.operator === "||") {
			const lRef = evaluate(node.left);
			if (lRef.type === "throw") {
				return lRef;
			}
			const lVal = getValue(lRef.value);
			if (toBoolean(lVal).data.value) {
				return normalCompletion(lVal);
			}

			const rRef = evaluate(node.right);
			if (rRef.type === "throw") {
				return rRef;
			}

			return normalCompletion(getValue(rRef.value));
		} else if (node.operator === "??") {
			const lRef = evaluate(node.left);
			if (lRef.type === "throw") {
				return lRef;
			}
			const lVal = getValue(lRef.value);
			if (lVal.isNull() || lVal.isUndefined()) {
				const rRef = evaluate(node.right);
				if (rRef.type === "throw") {
					return rRef;
				}
				return normalCompletion(getValue(rRef.value));
			}

			return normalCompletion(lVal);
		}
		return throwCompletion(new Error(`Unknown logical operator: ${node.operator}`));
	},
};
