import { toBoolean } from "../abstract-operations/type-conversion.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { EngineValue } from "../types-and-values/data-types.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const DoWhileStatement: Evaluator<"DoWhileStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-whileloopevaluation
	evaluate(node) {
		let V: EngineValue | undefined = undefined;

		while (true) {
			const stmtResult = evaluate(node.body);
			if (stmtResult.type === "throw") {
				return stmtResult;
			}

			if (stmtResult.type !== "normal") {
				V = stmtResult.value as EngineValue;
				break;
			}

			if (stmtResult.value !== undefined) {
				V = stmtResult.value as EngineValue;
			}

			const exprRef = evaluate(node.test);
			if (exprRef.type === "throw") {
				return exprRef;
			}

			if (!toBoolean(getValue(exprRef.value)).data.value) {
				break;
			}
		}

		return normalCompletion(V);
	},
};
