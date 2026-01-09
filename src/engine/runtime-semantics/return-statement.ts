import { EngineValue } from "../types-and-values/data-types.ts";
import type { ReferenceRecord } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const ReturnStatement: Evaluator<"ReturnStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-continue-statement
	evaluate(node) {
		let v: EngineValue | ReferenceRecord | undefined = EngineValue.undefined();

		if (node.argument) {
			const expr = evaluate(node.argument);
			if (expr.type === "throw") {
				return expr;
			}

			// TODO: Await?

			v = expr.value;
		}

		return {
			type: "return",
			value: v,
		};
	},
};
