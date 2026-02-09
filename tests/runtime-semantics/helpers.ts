import { getCurrentRealm } from "../../src/engine/execution-contexts/execution-context.ts";
import { Realm } from "../../src/engine/execution-contexts/realm.ts";
import { parseScript } from "../../src/engine/parser/script.ts";
import { evaluate } from "../../src/engine/runtime-semantics/index.ts";
import type { CompletionRecord } from "../../src/engine/types-and-values/completion-record.ts";
import type { EngineValue } from "../../src/engine/types-and-values/data-types.ts";
import { getValue } from "../../src/engine/types-and-values/reference-record.ts";

type EvalResult = CompletionRecord<EngineValue | undefined>;

export function evaluateCode(code: string): EvalResult {
	Realm.init();
	const parsed = parseScript(code, {} as never);
	getCurrentRealm().isStrict ||= parsed.isStrict;
	const result = evaluate(parsed.ECMAScriptCode);

	if (result.type === "throw") {
		return result;
	}

	return {
		type: result.type,
		value: result.value !== undefined ? getValue(result.value) : undefined,
	};
}

/**
 * Extract the primitive value from an EngineValue for test assertions.
 * Only works for types that have a `value` property (boolean, string, number, bigint, null).
 */
export function primitiveValue(
	result: EvalResult,
): boolean | string | number | bigint | null | undefined {
	if (result.type === "throw" || result.value === undefined) {
		return undefined;
	}
	// Cast to access value property - safe for primitive types
	return (result.value.data as { value?: boolean | string | number | bigint | null })
		.value;
}
