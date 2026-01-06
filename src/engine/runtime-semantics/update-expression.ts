import { toNumeric } from "../abstract-operations/type-conversion.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { getValue, putValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const UpdateExpression: Evaluator<"UpdateExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-update-expressions
	evaluate(node) {
		const lhs = evaluate(node.argument);
		if (lhs.type === "throw") {
			return lhs;
		}
		const oldValue = toNumeric(getValue(lhs.value));
		if (oldValue.type === "throw") {
			return oldValue;
		}

		let newValue: EngineValue;

		if (oldValue.value.isNumber()) {
			if (node.operator === "++") {
				newValue = oldValue.value.numberAdd(EngineValue.number(1));
			} else {
				newValue = oldValue.value.numberSubtract(EngineValue.number(1));
			}
		} else {
			if (node.operator === "++") {
				newValue = oldValue.value.asBigInt().bigintAdd(EngineValue.bigint(1n));
			} else {
				newValue = oldValue.value.asBigInt().bigintSubtract(EngineValue.bigint(1n));
			}
		}

		putValue(lhs.value, newValue);

		return normalCompletion(node.prefix ? newValue : oldValue.value);
	},
};
