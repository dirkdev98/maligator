import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { Evaluator } from "./index.ts";

export const EmptyStatement: Evaluator<"EmptyStatement"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-empty-statement
	evaluate(_node) {
		return normalCompletion(undefined);
	},
};
