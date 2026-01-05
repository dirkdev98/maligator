import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { Evaluator } from "./index.ts";

export const Literal: Evaluator<"Literal"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-literals-runtime-semantics-evaluation
	evaluate(node) {
		if (node.value === null) {
			return normalCompletion(EngineValue.null());
		}

		if (node.value === true) {
			return normalCompletion(EngineValue.boolean(true));
		}

		if (node.value === false) {
			return normalCompletion(EngineValue.boolean(false));
		}

		if (typeof node.value === "number") {
			return normalCompletion(EngineValue.number(node.value));
		} else if (typeof node.value === "bigint") {
			return normalCompletion(EngineValue.bigint(node.value));
		} else if (typeof node.value === "string") {
			return normalCompletion(EngineValue.string(node.value));
		}

		throw new Error(`Unknown literal type: ${typeof node.value}`);
	},
};
