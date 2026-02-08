import { arrayCreate } from "../abstract-operations/array-exotic.ts";
import {
	createDataPropertyOrThrow,
	set,
} from "../abstract-operations/object-operations.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const ArrayExpression: Evaluator<"ArrayExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-array-initializer-runtime-semantics-evaluation
	evaluate(node) {
		const arr = arrayCreate(0);
		if (arr.type === "throw") {
			return arr;
		}

		let length = 0;

		// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-runtime-semantics-arrayaccumulation
		for (const element of node.elements) {
			length++;

			if (element === null) {
				set(arr.value, "length", EngineValue.number(length), true);
			} else if (element.type === "SpreadElement") {
				const spreadRef = evaluate(element.argument);
				if (spreadRef.type === "throw") {
					return spreadRef;
				}
				const spreadValue = getValue(spreadRef.value);

				// TODO: Iterators
				if (spreadValue.isObject()) {
					for (const key of spreadValue.data.properties.arrayIndexPropertyKeys()) {
						const value = spreadValue.data.properties.get(key);

						// TODO: Getters
						createDataPropertyOrThrow(arr.value, `${length - 1}`, value.value!);
						length++;
					}
				}
			} else {
				const elementValue = evaluate(element);
				if (elementValue.type === "throw") {
					return elementValue;
				}

				const value = getValue(elementValue.value);
				createDataPropertyOrThrow(arr.value, `${length - 1}`, value);
			}
		}

		return arr;
	},
};
