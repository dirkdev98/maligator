import defaultValue, {
	err,
	ok,
	value,
	type Value,
} from "./typescript-erasable-issue-5-value.ts";

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

const genericResult = ok(value);
const genericError = err(new Error("expected"));
if (
	defaultValue !== value ||
	genericResult.value.label !== "compact" ||
	genericError.error.message !== "expected"
) {
	throw new Error("imported generic arrow lost its parameter binding");
}

const visited: string[] = [];
const visit = (label: string, path: readonly string[]): void => {
	visited.push([...path, label].join("/"));
};
visit("leaf", ["root"]);

const findLabels = (values: readonly Value[]): readonly string[] =>
	values.map((item) => item.label);
if (visited[0] !== "root/leaf" || findLabels([value]).join(",") !== "compact") {
	throw new Error("typed arrow erasure changed recursive or concise-body semantics");
}

console.log("TYPESCRIPT_ERASABLE_ISSUE_5_PASS");
