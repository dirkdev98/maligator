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

	test("strips block-level type aliases and interfaces", () => {
		const source = `function collect(values: readonly string[]): number {
	type Selected = Extract<typeof values[number], string>;
	interface Candidate {
		value: Selected;
	}
	const candidate: Candidate = { value: values[0]! };
	return candidate.value.length;
}`;
		const stripped = stripCompactTypes(source, "local-types.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "local-types.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("preserves statement boundaries before later type declarations", () => {
		const source = `function runtime() {}
export interface Model {
	value: number;
}
type Result = Model | undefined;
const value = runtime();`;

		expect(stripCompactTypes(source, "type-boundary.ts")).toBe(
			stripTypesWithTypeScript(source, "type-boundary.ts"),
		);
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

	test("strips literal unions from later arrow parameters", () => {
		const source = `const identity = (
	value: string,
	role: "admin" | "teacher",
) => \`${"${value}:${role}"}\`;`;
		const stripped = stripCompactTypes(source, "literal-union.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "literal-union.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("relocates the closing parenthesis across multiline return types", () => {
		const source = `type Result<E, T> = { error: E; ok: false } | { ok: true; value: T };
const createValue = (): Result<
	{ type: "missing" } | { type: "taken" },
	{ value: string }
> => ({ ok: true, value: { value: "ready" } });`;
		const stripped = stripCompactTypes(source, "multiline-return.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "multiline-return.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
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

	test("matches generic function boundaries containing callback arrows", () => {
		const source = `function recurseAst<
	Args extends Array<unknown>,
	Callback extends (node: ESTree.Node, ...args: Args) => void,
>(node: ESTree.Node, callback: Callback, ...args: Args): void {
	callback(node, ...args);
}`;
		const stripped = stripCompactTypes(source, "generic-callback.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "generic-callback.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("does not treat a const type parameter as a variable declaration", () => {
		const source = `export type Result<ErrorType, ValueType> =
	| { readonly ok: true; readonly value: ValueType }
	| { readonly error: ErrorType; readonly ok: false };
export const ok = <const ValueType>(value: ValueType): Result<never, ValueType> => ({
	ok: true,
	value,
});`;
		const stripped = stripCompactTypes(source, "const-generic-arrow.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "const-generic-arrow.ts"));
	});

	test("does not treat const assertions as variable declarations", () => {
		const source = `const parseWidget = (valid: boolean) => {
	if (!valid) {
		return { found: false as const, invalid: true as const };
	}
	return { found: true as const, value: "ok" };
};
console.log(parseWidget(false));`;
		const stripped = stripCompactTypes(source, "object-property-as-const.ts");

		expect(stripped).toBe(
			stripTypesWithTypeScript(source, "object-property-as-const.ts"),
		);
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("stops variable annotation scans at for-of header boundaries", () => {
		const source = `function visit(values: readonly string[]): void {
	for (const value of values) use(value);
}
function immediateValue(
	instruction: IRInstruction | undefined,
): IRImmediateValue | undefined {
	if (instruction === undefined) return undefined;
	return { kind: "undefined" };
}`;
		const stripped = stripCompactTypes(source, "for-of-boundary.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "for-of-boundary.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("preserves contextual keywords used as runtime names", () => {
		const source = `const values = {
	const: 1,
	let: 2,
	var: 3,
	as: 4,
	satisfies: 5,
	declare: 6,
	namespace: 7,
	module: 8,
	import: 9,
	export: 10,
	function(value: number): number { return value; },
	generic<T>(value: T): T { return value; },
};
class Names {
	public(value: number): number { return value + values.as; }
	private() { return values.satisfies; }
	protected() { return values.const; }
	readonly() { return values.let; }
	abstract() { return values.var; }
	override() { return values.declare; }
	accessor() { return values.namespace; }
	declare() { return values.module; }
	function(value: number): number { return value; }
	import: number = values.import;
	export = values.export;
}`;

		expect(stripCompactTypes(source, "contextual-names.ts")).toBe(
			stripTypesWithTypeScript(source, "contextual-names.ts"),
		);
	});

	test("stops assertions before runtime operators", () => {
		const source = `const logical = input as boolean && fallback;
const union = input as string | undefined || fallback;
const intersection = input as Left & Right && fallback;
const comparison = input as number < limit;
const inequality = input as number !== limit;
const membership = input as PropertyKey in object;
const instance = input as object instanceof Constructor;
const negative = input as -1;
const numeric = input as 1;
const emptyObject = input as {};
const emptyTuple = input as [];
const callable = input as (() => void) && fallback;
const bareCallable = input as () => void;
const constructable = input as new () => object;
const conditional = input as T extends U ? X : Y;
const nestedConditional = input as T extends U ? X extends Y ? A : B : C;
const conditionalRuntime = input as T extends U ? X : Y && fallback;
const voidDivision = input as void / divisor;
const genericDivision = input as Array<string> / divisor;
const genericMembership = input as Array<string> in object;
const generic = input as Array<string> && fallback;
const greater = input as number >= limit;
const less = input as number <= limit;
const qualified = input as Namespace.as;
const unionContextual = input as string | as;
const chained = input as unknown as string;
const checked = input satisfies boolean && fallback;
const exported = input as import("package").Model as object;
const template = input as \`literal\`;`;
		const stripped = stripCompactTypes(source, "assertion-operators.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "assertion-operators.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("strips chained assertions whose union starts on the next line", () => {
		const source = `const assignmentPattern = element as unknown as
	| ESTree.AssignmentPattern
	| null
	| undefined;`;
		const stripped = stripCompactTypes(source, "multiline-assertion.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "multiline-assertion.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("allows an object method named constructor to use typed parameters", () => {
		const source = `const factory = {
	constructor(public: string) {
		return public;
	},
};`;

		expect(stripCompactTypes(source, "object-constructor.ts")).toBe(
			stripTypesWithTypeScript(source, "object-constructor.ts"),
		);
	});

	test("does not pair comparisons with later nested arrow tokens", () => {
		const source = `interface Projection { readonly value: number }
interface Service { readonly create: () => Projection }
const choose = (first: number, second: number) => {
	if (first < 1 || second < 2) return "low";
	return "high";
};
export const createService = (initial: number): Service => {
	const create = (): Projection => ({ value: initial });
	return { create };
};`;
		const stripped = stripCompactTypes(source, "nested-concise-factory.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "nested-concise-factory.ts"));
		expect(() =>
			parseScript(stripped.replace("export ", ""), { strict: true }),
		).not.toThrow();
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

	test("preserves logical negation after expression-prefix keywords", () => {
		const source = `const locked = (access: { isUnlocked: boolean }) => {
	return !access.isUnlocked;
};
const direct = !locked({ isUnlocked: true });
const asserted = access!.isUnlocked;`;

		expect(stripCompactTypes(source, "logical-not.ts")).toBe(
			stripTypesWithTypeScript(source, "logical-not.ts"),
		);
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
		[
			"multiline literal-union return",
			`const resolve = (
	name: string,
): Binding | null | "ambiguous" => name as never;`,
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
			"function declaration object return types",
			`function terminalConditional(
	block: IRFunction["blocks"][number],
): { condition: number; ifTrue: number; ifFalse: number } | undefined {
	return block.condition;
}`,
		],
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

	test("preserves class field initializers containing calls", () => {
		const source = `class Writer {
	private buf = new ArrayBuffer(1024);
	private view = new DataView(this.buf);
	private pos = 0;
}`;

		expect(stripCompactTypes(source, "class-fields.ts")).toBe(
			stripTypesWithTypeScript(source, "class-fields.ts"),
		);
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

	test("does not treat ternary call expressions as method annotations", () => {
		const source = `function choose(flag: boolean, input: Input): number {
	return flag ? compileStaticString(input.name) : -1;
}`;
		const stripped = stripCompactTypes(source, "ternary-call.ts");

		expect(stripped).toBe(stripTypesWithTypeScript(source, "ternary-call.ts"));
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("strips typed async arrow properties without erasing the arrow", () => {
		const source = `export const store = {
	load: async (name: string): Promise<number | undefined> => name.length,
	insert: async (name: string, value: number): Promise<number> => value,
};
`;
		expect(stripCompactTypes(source, "object-arrows.ts")).toBe(
			stripTypesWithTypeScript(source, "object-arrows.ts"),
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
