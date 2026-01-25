import { construct } from "../abstract-operations/object-operations.ts";
import { isConstructor } from "../abstract-operations/testing-and-comparison.ts";
import { throwCompletion } from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const NewExpression: Evaluator<"NewExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-new-operator
	evaluate(node) {
		const ref = evaluate(node.callee);
		if (ref.type === "throw") {
			return ref;
		}

		const constructor = getValue(ref.value);
		const args = node.arguments.map((it) => getValue(evaluate(it).value));

		if (!isConstructor(constructor).data.value) {
			return throwCompletion(new TypeError("Constructor is not callable."));
		}

		return construct(constructor.asObject(), args);
	},
};
