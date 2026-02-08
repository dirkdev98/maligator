import { EvaluateError } from "../runtime-semantics/index.ts";
import type { EngineValue } from "./data-types.ts";

type CompletionType = "normal" | "break" | "continue" | "return";

// https://tc39.es/ecma262/#sec-completion-record-specification-type
export type CompletionRecord<T> =
	| {
			type: CompletionType;
			value: T;
			error?: never;
			target?: string;
	  }
	| {
			type: "throw";
			value?: never;
			error: Error | EngineValue;
	  };

// https://tc39.es/ecma262/#sec-normalcompletion
export function normalCompletion<T>(value: T): CompletionRecord<T> {
	return {
		type: "normal",
		value,
	};
}

// https://tc39.es/ecma262/#sec-returncompletion
export function returnCompletion<T>(value: T): CompletionRecord<T> {
	return {
		type: "return",
		value,
	};
}

/**
 * Not in the spec. Use any built-in error which would be converted to an intrinsic.
 */
export function throwCompletion(err: Error | EngineValue): CompletionRecord<never> {
	// TODO: Convert to intrinsic?

	return {
		type: "throw",
		error: err,
	};
}

/**
 * Not in the spec.
 */
export function unwrapCompletion<T>(completion: CompletionRecord<T>): T {
	if (completion.type === "throw") {
		if (completion.error instanceof EvaluateError) {
			throw new Error(`Can't unwrap completion: ${completion.error.error.message}`, {
				cause: completion.error,
			});
		}

		throw new Error("Can't unwrap completion...", {
			cause: completion.error,
		});
	}

	return completion.value;
}

// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-updateempty
export function updateEmptyCompletion<T>(
	completion: CompletionRecord<T>,
	value: T,
): CompletionRecord<T> {
	if (completion.type === "return" || completion.type === "throw") {
		return completion;
	}

	// TODO: is this correct?
	if (value) {
		completion.value = value;
	}

	return completion;
}
