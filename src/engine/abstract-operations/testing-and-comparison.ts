import type { EngineValue } from "../data-types.ts";
import { normalCompletion, throwCompletion } from "./completion-record.ts";
import type { CompletionRecord } from "./completion-record.ts";

export const UNUSED = -1;

// https://tc39.es/ecma262/#sec-requireobjectcoercible
export function requireObjectCoercible(
	argument: EngineValue,
): CompletionRecord<typeof UNUSED> {
	if (argument.isUndefined() || argument.isNull()) {
		return throwCompletion(new TypeError(`Argument can't be converted to an object.`));
	}

	return normalCompletion(UNUSED);
}
