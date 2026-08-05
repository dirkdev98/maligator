import { value, type Value } from "./typescript-erasable-issue-5-value.ts";

interface Dependencies {
	readonly value: Value;
}

type Result<ErrorType, ValueType> =
	| { ok: true; value: ValueType }
	| { ok: false; error: ErrorType };

const createController = ({ value: selected }: Dependencies): Result<Error, Value> => ({
	ok: true,
	value: selected,
});

const result = createController({ value });
if (!result.ok || result.value.label !== "compact") {
	throw new Error("compact TypeScript erasure changed runtime semantics");
}

console.log("TYPESCRIPT_ERASABLE_ISSUE_5_PASS");
