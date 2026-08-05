import { describe, expect, test } from "vitest";
import { stripCompactTypes } from "../src/compact-type-strip.ts";
import { parseScript } from "../src/parser.ts";
import { stripTypesWithTypeScript } from "../src/typescript-strip.ts";

describe("stripCompactTypes", () => {
	test("matches ts-blank-space for the supported fixture subset", () => {
		const source = `import type { Model } from "./types.ts";
export type Result = string;
interface Local {
	value: number;
}
const count: number = 2;
let label: string = "type Fake = number;";
function render(model: Model, prefix: string): string {
	return \`${"${prefix}"}: ${"${model.value}"}\`;
}
// const ignored: number = 0;
`;
		const compact = stripCompactTypes(source, "fixture.mts");
		expect(compact).toBe(stripTypesWithTypeScript(source, "fixture.mts"));
		expect(compact).toHaveLength(source.length);
		expect(compact.split("\n")).toHaveLength(source.split("\n").length);
	});

	test.each([
		["type assignment", "let type; type = sideEffect();"],
		["default import named type", 'import type from "./type.js";'],
		["export named type", "const type = 1; export { type };"],
	])("preserves ordinary JavaScript %s", (_name, source) => {
		expect(stripCompactTypes(source, "ordinary.mjs")).toBe(source);
	});

	test("only strips an exact top-level type alias declaration", () => {
		const source = "type Result = string;\ntype = sideEffect();\n";
		const stripped = stripCompactTypes(source, "mixed.ts");
		expect(stripped.split("\n")[0]).toMatch(/^\s+$/);
		expect(stripped.split("\n")[1]).toBe("type = sideEffect();");
	});

	test("strips Node-compatible inline type specifiers", () => {
		const source = `import DefaultModel, { type Model } from "./default-model.ts";
import { type Model, value, type Other as Alias } from "./model.ts";
export { type Model, value };
`;
		const stripped = stripCompactTypes(source, "imports.ts");
		expect(stripped).toBe(stripTypesWithTypeScript(source, "imports.ts"));
	});

	test("strips typed destructured arrow parameters", () => {
		const source = `interface Dependencies {
	readonly service: Service;
}
export const createController = ({ service }: Dependencies) => service;
`;
		const stripped = stripCompactTypes(source, "controller.ts");
		expect(stripped).toBe(stripTypesWithTypeScript(source, "controller.ts"));
	});

	test("strips generic declarations with compound types", () => {
		const source = `export type Result<ErrorType, ValueType> =
	| { ok: true; value: ValueType }
	| { ok: false; error: ErrorType };
interface Container<ValueType> extends Iterable<ValueType> {
	readonly value?: ValueType;
}
`;
		const stripped = stripCompactTypes(source, "result.ts");
		expect(stripped).toBe(stripTypesWithTypeScript(source, "result.ts"));
	});

	test("strips common erasable expression and function syntax", () => {
		const source = `function identity<Value>(value?: Value): Value | undefined {
	return value;
}
const arrow = <Value,>(value: Value): Value => value;
const selected = identity<string>("ok") as string satisfies string;
const length = selected!.length;
const message = \`value:${"${selected as string}"}\`;
`;
		const stripped = stripCompactTypes(source, "erasable.ts");
		expect(stripped).toBe(stripTypesWithTypeScript(source, "erasable.ts"));
	});

	test.each([
		[
			"typed recursive block body",
			`const visit = (ruleId: string, path: readonly string[]): void => {
	visit(ruleId, path);
};`,
		],
		[
			"multiline expression body with an untyped nested arrow",
			`const findMigrationFiles = (folder: string): readonly MigrationFile[] =>
	readdirSync(folder).map((name) => ({ name }));`,
		],
		[
			"generic expression body with a typed nested arrow",
			`const map = <const Input extends readonly unknown[], Output = Input[number]>(
	values: Input,
	callback: (value: Input[number]) => Output,
): readonly Output[] => values.map((value: Input[number]): Output => callback(value));`,
		],
		[
			"async generic arrow with optional input",
			`const load = async <Value extends object>(
	path: string,
	fallback?: Value,
): Promise<Value> => (await read(path)) as Value;`,
		],
		[
			"destructured and rest parameters",
			`const collect = (
	{ value = 1 }: { readonly value?: number },
	...rest: readonly string[]
): readonly [number, ...string[]] => [value, ...rest];`,
		],
		[
			"type predicate return",
			`const isString = (value: unknown): value is string => typeof value === "string";`,
		],
		[
			"assertion return",
			`const assertString = (value: unknown): asserts value is string => {
	if (typeof value !== "string") throw new Error();
};`,
		],
	])("matches TypeScript for %s", (_name, source) => {
		const stripped = stripCompactTypes(source, "arrow-matrix.ts");
		expect(stripped).toHaveLength(source.length);
		expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("preserves switch case labels inside a typed union arrow", () => {
		const source = `type Exercise =
	| { type: "matching"; prompts: readonly string[] }
	| { type: "ordering"; items: readonly string[] }
	| { type: "text_input"; answers: readonly string[] };
interface ContentIssue {
	readonly code: string;
}
const validateExercise = (
	exercise: Exercise,
): readonly ContentIssue[] => {
	const issues: ContentIssue[] = [];
	switch (exercise.type) {
		case "matching": {
			if (exercise.prompts.length === 0) issues.push({ code: "prompts" });
			break;
		}
		case "ordering": {
			if (exercise.items.length === 0) issues.push({ code: "items" });
			break;
		}
		case "text_input": {
			if (exercise.answers.length === 0) issues.push({ code: "answers" });
			break;
		}
	}
	return issues;
};`;
		const stripped = stripCompactTypes(source, "content-validation.ts");

		expect(stripped).toContain('case "matching":');
		expect(stripped).toContain('case "ordering":');
		expect(stripped).toContain('case "text_input":');
		expect(stripped).toContain("return issues;");
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test.each([
		[
			"object return types",
			`const make = (value: string): { readonly value: string } => ({ value });`,
		],
		[
			"conditional return types",
			`const choose = <Value>(value: Value): Value extends string ? string : Value =>
	value as never;`,
		],
		[
			"this parameters",
			`function call(this: Context, value: string): void {
	this.use(value);
}`,
		],
		["instantiation expressions", `const specialized = identity<string>;`],
		["class method declarations", `class Box { method?(value: string): number; }`],
	])("strips adjacent erasable syntax: %s", (_name, source) => {
		const stripped = stripCompactTypes(source, "adjacent-erasable.ts");
		expect(stripped).toBe(stripTypesWithTypeScript(source, "adjacent-erasable.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("strips generic class syntax without accepting parameter properties", () => {
		const source = `abstract class Box<Value> extends Base<Value> implements Container<Value> {
	readonly value!: Value;
	protected count: number = 0;
	abstract parse<Input>(input?: Input): Input;
	public map<Output>(callback: (value: Value) => Output): Output {
		return callback(this.value);
	}
}
`;
		const stripped = stripCompactTypes(source, "class.ts");
		expect(stripped).toBe(stripTypesWithTypeScript(source, "class.ts"));
		expect(() =>
			stripCompactTypes(
				"class Box { constructor(readonly value: string) {} }",
				"parameter-property.ts",
			),
		).toThrow(/parameter properties/);
	});

	test("strips object method parameters and return annotations", () => {
		const source = `export const store = {
	set(name: string, value: number): void {
		void name;
		void value;
	},
	async load(name: string): Promise<number | undefined> {
		return name.length;
	},
};
`;
		expect(stripCompactTypes(source, "object-methods.ts")).toBe(
			stripTypesWithTypeScript(source, "object-methods.ts"),
		);
	});

	test("strips ambient and type-only namespaces but rejects runtime namespaces", () => {
		const source = `declare const ambient: string;
export declare function load<Value>(value: Value): Value;
export namespace Types {
	// Type-only namespaces are erasable in Node's strip-only mode.
	export type Item<Value> = { value: Value };
	export interface Named {
		readonly name: string;
	}
}
`;
		const stripped = stripCompactTypes(source, "ambient.ts");
		expect(stripped).toBe(stripTypesWithTypeScript(source, "ambient.ts"));
		expect(() =>
			stripCompactTypes("namespace Runtime { export const value = 1; }", "runtime.ts"),
		).toThrow(/runtime code/);
	});

	test("strips type-only star exports", () => {
		const source = `export type * from "./types.ts";`;
		expect(stripCompactTypes(source, "exports.ts")).toBe(
			stripTypesWithTypeScript(source, "exports.ts"),
		);
	});

	test("does not treat TypeScript contextual words as declarations", () => {
		const source =
			"const enumValue = { enum: 1, namespace: 2, module: 3, declare: 4 }; const pattern = /as string satisfies Type/;";
		expect(stripCompactTypes(source, "ordinary.ts")).toBe(source);
	});

	test.each([
		["enums", "enum Mode { One }"],
		["decorators", "@sealed class Box {}"],
		["auto-accessor class fields", `class Box { accessor value: string = "x"; }`],
	])("rejects unsupported %s syntax", (_name, source) => {
		expect(() => stripCompactTypes(source, "bad.ts")).toThrow(/does not support/);
	});
});
