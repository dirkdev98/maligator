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
	const next = [...path, label];
	if (label === "branch") {
		visit("leaf", next);
		return;
	}
	visited.push(next.join("/"));
};
visit("branch", ["root"]);

const findLabels = (values: readonly Value[]): readonly string[] =>
	values.map((item) => item.label);
if (visited[0] !== "root/branch/leaf" || findLabels([value]).join(",") !== "compact") {
	throw new Error("typed arrow erasure changed recursive or concise-body semantics");
}

type Exercise =
	| { type: "matching"; prompts: readonly string[] }
	| { type: "ordering"; items: readonly string[] }
	| { type: "text_input"; answers: readonly string[] };

const validateExercise = (exercise: Exercise): readonly string[] => {
	const issues: string[] = [];
	switch (exercise.type) {
		case "matching": {
			if (exercise.prompts.length === 0) issues.push("prompts");
			break;
		}
		case "ordering": {
			if (exercise.items.length === 0) issues.push("items");
			break;
		}
		case "text_input": {
			if (exercise.answers.length === 0) issues.push("answers");
			break;
		}
	}
	return issues;
};

if (validateExercise({ type: "matching", prompts: [] }).join(",") !== "prompts") {
	throw new Error("typed union switch case labels were stripped");
}

interface Projection {
	readonly value: number;
}

interface ProjectionService {
	readonly create: () => Projection;
}

const projectionStage = (mastery: number, confidence: number) => {
	if (mastery < 0.7 || confidence < 0.8) return "learning";
	return "secure";
};

const createProjectionService = (initial: number): ProjectionService => {
	const create = (): Projection => ({ value: initial });
	return { create };
};

if (
	projectionStage(0.6, 0.9) !== "learning" ||
	createProjectionService(25).create().value !== 25
) {
	throw new Error("comparison operators consumed a nested typed concise factory");
}

console.log("TYPESCRIPT_ERASABLE_ISSUE_5_PASS");
