import { construct } from "../abstract-operations/object-operations.ts";
import { getCurrentRealm } from "../execution-contexts/execution-context.ts";
import { NATIVE_ERROR } from "../intrinsics/navite-error.ts";
import { EngineValue } from "./data-types.ts";

type CompletionType = "normal" | "break" | "continue" | "return";

// https://tc39.es/ecma262/#sec-completion-record-specification-type
export type CompletionRecord<T> =
	| {
			type: CompletionType;
			value: T;
			error?: never;
			target?: string;
			unwrap(): T;
	  }
	| {
			type: "throw";
			value?: never;
			error: Error | EngineValue;
			unwrap(): never;
	  };

// https://tc39.es/ecma262/#sec-normalcompletion
export function normalCompletion<T>(value: T): CompletionRecord<T> {
	return {
		type: "normal",
		value,
		unwrap() {
			return unwrapCompletion(this);
		},
	};
}

// https://tc39.es/ecma262/#sec-returncompletion
export function returnCompletion<T>(value: T): CompletionRecord<T> {
	return {
		type: "return",
		value,
		unwrap() {
			return unwrapCompletion(this);
		},
	};
}

/**
 * Not in the spec. Use any built-in error which would be converted to an intrinsic.
 */
export function throwCompletion(err: Error | EngineValue): CompletionRecord<never> {
	if (NATIVE_ERROR.includes(err.constructor.name) && "message" in err) {
		const O = construct(
			getCurrentRealm().intrinsics[`%${err.constructor.name}%`]!.asObject(),
			[EngineValue.string(err.message)],
		);
		if (O.type === "throw") {
			throw new Error("Could not construct internal error from native error", {
				cause: O,
			});
		} else {
			return {
				type: "throw",
				error: O.value,
				unwrap() {
					throw new CompletionUnwrapError(this);
				},
			};
		}
	}
	// TODO: Convert to intrinsic?

	return {
		type: "throw",
		error: err,
		unwrap() {
			throw new CompletionUnwrapError(this);
		},
	};
}

/**
 * Not in the spec.
 */
export function unwrapCompletion<T>(completion: CompletionRecord<T>): T {
	if (completion.type === "throw") {
		throw new CompletionUnwrapError(completion);
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

type ThrowCompletion = Extract<CompletionRecord<unknown>, { type: "throw" }>;

export class CompletionUnwrapError extends Error {
	completion: ThrowCompletion;

	constructor(completion: ThrowCompletion) {
		super(`Can't unwrap completion`, { cause: completion.error });

		this.completion = completion;
	}
}
