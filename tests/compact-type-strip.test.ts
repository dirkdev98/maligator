import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { parseModule, parseScript } from "../src/compiler/frontend/parser.ts";

function blank(length: number): string {
	return " ".repeat(length);
}

/** State what survived a line without restating the column it survived at. */
function code(line: string): string {
	return line.replace(/ {2,}/g, " ").trim();
}

/**
 * Tokens the stripper may write into an erased span instead of a space: a
 * relocated parameter-list bracket, or a terminator that keeps the statement
 * before an erased declaration closed. Everything else must survive untouched at
 * its original index, because debug info and stack traces report original `.ts`
 * positions without a source map.
 */
const substitutions = new Set(["(", ")", ";"]);

/** Strip and assert the blank-in-place contract. */
function strip(source: string, filePath = "fixture.ts"): string {
	const stripped = stripCompactTypes(source, filePath);
	expect(stripped).toHaveLength(source.length);
	const moved: Array<number> = [];
	for (let index = 0; index < source.length; index++) {
		const before = source[index]!;
		const after = stripped[index]!;
		if (after === before) continue;
		if (before === "\n" || (after !== " " && !substitutions.has(after))) {
			moved.push(index);
		}
	}
	expect(moved).toEqual([]);
	expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
	return stripped;
}

describe("stripCompactTypes", () => {
	test("erases numeric literal annotations while preserving signed runtime values", () => {
		const source = `function pick(unit: -1 | 1): 42 { return 42; } const input: -1 = -1; globalThis.stripResult = pick(input) + input;`;
		const stripped = strip(source);
		expect(() => parseModule(stripped)).not.toThrow();
		expect(runInNewContext(stripped)).toBe(41);
	});
	test("preserves loop comparisons before a later generic constructor", () => {
		const source = `let sum = 0; for (let index = 0; index < 4; index++) { sum += index; } const cache = new Map<string, number>(); globalThis.stripResult = sum;`;
		const stripped = strip(source);
		expect(() => parseModule(stripped)).not.toThrow();
		const result: unknown = runInNewContext(stripped);
		expect(result).toBe(6);
	});

	test("erases type spans in place, keeping length, newlines, and columns", () => {
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
		const lines = source.split("\n");

		expect(strip(source, "fixture.mts").split("\n")).toEqual([
			blank(lines[0]!.length),
			blank(lines[1]!.length),
			blank(lines[2]!.length),
			blank(lines[3]!.length),
			blank(lines[4]!.length),
			`const count${blank(8)} = 2;`,
			`let label${blank(8)} = "type Fake = number;";`,
			`function render(model${blank(7)}, prefix${blank(8)})${blank(8)} {`,
			lines[8]!,
			lines[9]!,
			lines[10]!,
			lines[11]!,
		]);
	});

	test("keeps the line and column of runtime code after erased spans", () => {
		const source = `interface Boom {
	readonly code: string;
}
function boom(value: number): never {
	throw new Error("trace");
}
boom(1 as number);`;
		const stripped = strip(source, "trace.ts");
		const strippedLines = stripped.split("\n");
		const sourceLines = source.split("\n");

		expect(strippedLines[4]).toBe(sourceLines[4]);
		expect(strippedLines[4]!.indexOf("throw")).toBe(sourceLines[4]!.indexOf("throw"));
		expect(strippedLines[3]).toBe(`function boom(value${blank(8)})${blank(7)} {`);
		expect(strippedLines[6]).toBe(`boom(1${blank(10)});`);
	});

	test("erases type-only imports, exports, and inline specifiers", () => {
		const source = `import type { Model } from "./model.ts";
export type * from "./types.ts";
export type { Model } from "./model.ts";
import DefaultModel, { type Model, value } from "./default-model.ts";
import { type Other as Alias, second } from "./model.ts";
export { type Model, value };
`;
		const lines = source.split("\n");
		const stripped = strip(source, "imports.ts").split("\n");

		expect(stripped.slice(0, 3)).toEqual([
			blank(lines[0]!.length),
			blank(lines[1]!.length),
			blank(lines[2]!.length),
		]);
		expect(code(stripped[3]!)).toBe(
			'import DefaultModel, { value } from "./default-model.ts";',
		);
		expect(code(stripped[4]!)).toBe('import { second } from "./model.ts";');
		expect(code(stripped[5]!)).toBe("export { value };");
	});

	test("keeps erased spans parseable by relocating brackets and terminators", () => {
		const generic = strip(
			`function recurseAst<
	Args extends Array<unknown>,
>(node: Node, ...args: Args): void {
	callback(node, ...args);
}`,
			"generic-callback.ts",
		);
		// The parameter list must stay attached to the name, so the multiline type
		// parameter list keeps its opening bracket as `(` and the real `(` is erased.
		expect(generic.split("\n")[0]).toBe("function recurseAst(");
		expect(generic.split("\n")[2]).toBe(
			`${blank(2)}node${blank(6)}, ...args${blank(6)})${blank(6)} {`,
		);

		const arrow = strip(
			`const createValue = (): Result<
	{ ok: true }
> => ({ ok: true });`,
			"multiline-return.ts",
		);
		// JavaScript forbids a line terminator between `)` and `=>`, so the erased
		// closing parenthesis is relocated to the last erased type token.
		expect(arrow.split("\n")[0]).toBe(`const createValue = (${blank(10)}`);
		expect(arrow.split("\n")[2]).toBe(") => ({ ok: true });");

		const boundary = strip(
			`function runtime() {}
interface Model {
	value: number;
}
const value = runtime();`,
			"asi.ts",
		);
		// `}` before an erased declaration would otherwise continue the statement.
		expect(boundary.split("\n")[1]).toBe(`;${blank(16)}`);
	});

	test("erases annotations, assertions, satisfies, and non-null operators", () => {
		const source = `function identity<Value>(value?: Value): Value | undefined {
	return value;
}
const arrow = <Value,>(value: Value): Value => value;
const selected = identity<string>("ok") as string satisfies string;
const length = selected!.length;
const specialized = identity<string>;
`;
		const lines = source.split("\n");
		const stripped = strip(source, "erasable.ts");

		expect(stripped.split("\n")).toEqual([
			`function identity${blank(7)}(value${blank(8)})${blank(19)} {`,
			lines[1]!,
			lines[2]!,
			`const arrow = ${blank(8)}(value${blank(7)})${blank(7)} => value;`,
			`const selected = identity${blank(8)}("ok")${blank(27)};`,
			"const length = selected .length;",
			`const specialized = identity${blank(8)};`,
			lines[7]!,
		]);
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("erases catch binding annotations without treating catch methods as clauses", () => {
		const source = `try {
	throw new Error("trace");
} catch (error: unknown) {
	console.log((error as Error).stack);
}
promise.catch((error: Error): void => report(error));`;
		const stripped = strip(source, "catch.ts");
		const lines = stripped.split("\n");

		expect(lines[2]).toBe(`} catch (error${blank(9)}) {`);
		expect(lines[3]).toBe(`\tconsole.log((error${blank(9)}).stack);`);
		expect(lines[5]).toBe(
			`promise.catch((error${blank(7)})${blank(6)} => report(error));`,
		);
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test.each([
		["type assignment", "let type; type = sideEffect();"],
		["default import named type", 'import type from "./type.js";'],
		["export named type", "const type = 1; export { type };"],
		[
			"contextual words",
			"const enumValue = { enum: 1, namespace: 2, module: 3, declare: 4 }; const pattern = /as string satisfies Type/;",
		],
	])("preserves ordinary JavaScript %s", (_name, source) => {
		expect(stripCompactTypes(source, "ordinary.mjs")).toBe(source);
	});

	test("only strips an exact top-level type alias declaration", () => {
		const source = "type Result = string;\ntype = sideEffect();\n";
		const stripped = strip(source, "mixed.ts");

		expect(stripped.split("\n")[0]).toBe(blank(21));
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
		const stripped = strip(source, "local-types.ts");

		expect(stripped).not.toMatch(/interface|Extract/);
		expect(stripped.split("\n")[5]).toBe(
			`	const candidate${blank(11)} = { value: values[0]${blank(1)} };`,
		);
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("preserves statement boundaries before later type declarations", () => {
		const source = `function runtime() {}
export interface Model {
	value: number;
}
type Result = Model | undefined;
const value = runtime();`;
		const stripped = strip(source, "type-boundary.ts");

		expect(stripped.split("\n")[0]).toBe("function runtime() {}");
		expect(stripped.split("\n")[5]).toBe("const value = runtime();");
		expect(stripped).not.toMatch(/interface|Result/);
	});

	test.each([
		[
			"typed destructured arrow parameters",
			`interface Dependencies {
	readonly service: Service;
}
export const createController = ({ service }: Dependencies) => service;`,
		],
		[
			"literal unions in later arrow parameters",
			`const identity = (
	value: string,
	role: "admin" | "teacher",
) => \`${"${value}:${role}"}\`;`,
		],
		[
			"multiline return types",
			`type Result<E, T> = { error: E; ok: false } | { ok: true; value: T };
const createValue = (): Result<
	{ type: "missing" } | { type: "taken" },
	{ value: string }
> => ({ ok: true, value: { value: "ready" } });`,
		],
		[
			"generic declarations with compound types",
			`export type Result<ErrorType, ValueType> =
	| { ok: true; value: ValueType }
	| { ok: false; error: ErrorType };
interface Container<ValueType> extends Iterable<ValueType> {
	readonly value?: ValueType;
}`,
		],
		[
			"generic function boundaries containing callback arrows",
			`function recurseAst<
	Args extends Array<unknown>,
	Callback extends (node: ESTree.Node, ...args: Args) => void,
>(node: ESTree.Node, callback: Callback, ...args: Args): void {
	callback(node, ...args);
}`,
		],
		[
			"const type parameters",
			`export type Result<ErrorType, ValueType> =
	| { readonly ok: true; readonly value: ValueType }
	| { readonly error: ErrorType; readonly ok: false };
export const ok = <const ValueType>(value: ValueType): Result<never, ValueType> => ({
	ok: true,
	value,
});`,
		],
		[
			"const assertions",
			`const parseWidget = (valid: boolean) => {
	if (!valid) {
		return { found: false as const, invalid: true as const };
	}
	return { found: true as const, value: "ok" };
};
console.log(parseWidget(false));`,
		],
		[
			"for-of header boundaries",
			`function visit(values: readonly string[]): void {
	for (const value of values) use(value);
}
function immediateValue(
	instruction: IRInstruction | undefined,
): IRImmediateValue | undefined {
	if (instruction === undefined) return undefined;
	return { kind: "undefined" };
}`,
		],
		[
			"chained assertions whose union starts on the next line",
			`const assignmentPattern = element as unknown as
	| ESTree.AssignmentPattern
	| null
	| undefined;`,
		],
		[
			"comparisons before later nested arrow tokens",
			`interface Projection { readonly value: number }
interface Service { readonly create: () => Projection }
const choose = (first: number, second: number) => {
	if (first < 1 || second < 2) return "low";
	return "high";
};
export const createService = (initial: number): Service => {
	const create = (): Projection => ({ value: initial });
	return { create };
};`,
		],
		[
			"logical negation after expression-prefix keywords",
			`const locked = (access: { isUnlocked: boolean }) => {
	return !access.isUnlocked;
};
const direct = !locked({ isUnlocked: true });
const asserted = access!.isUnlocked;`,
		],
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
		["class method declarations", `class Box { method?(value: string): number; }`],
		[
			"object method parameters and return annotations",
			`export const store = {
	set(name: string, value: number): void {
		void name;
		void value;
	},
	async load(name: string): Promise<number | undefined> {
		return name.length;
	},
};`,
		],
		[
			"typed async arrow properties",
			`export const store = {
	load: async (name: string): Promise<number | undefined> => name.length,
	insert: async (name: string, value: number): Promise<number> => value,
};`,
		],
		[
			"ternary call expressions",
			`function choose(flag: boolean, input: Input): number {
	return flag ? compileStaticString(input.name) : -1;
}`,
		],
		[
			"generic class syntax",
			`abstract class Box<Value> extends Base<Value> implements Container<Value> {
	readonly value!: Value;
	protected count: number = 0;
	abstract parse<Input>(input?: Input): Input;
	public map<Output>(callback: (value: Value) => Output): Output {
		return callback(this.value);
	}
}`,
		],
		[
			"class field initializers containing calls",
			`class Writer {
	private buf = new ArrayBuffer(1024);
	private view = new DataView(this.buf);
	private pos = 0;
}`,
		],
		[
			"ambient and type-only namespaces",
			`declare const ambient: string;
export declare function load<Value>(value: Value): Value;
export namespace Types {
	export type Item<Value> = { value: Value };
	export interface Named {
		readonly name: string;
	}
}`,
		],
	])("erases %s in place and leaves parsable JavaScript", (_name, source) => {
		const stripped = strip(source, "erasable-matrix.ts");

		expect(() =>
			parseScript(stripped.replaceAll("export ", blank(7)), { strict: true }),
		).not.toThrow();
	});

	test("allows an object method named constructor to use typed parameters", () => {
		// `public` is only a modifier in a class constructor; here it is a sloppy-mode
		// parameter name the stripper must keep.
		const source = `const factory = {
	constructor(public: string) {
		return public;
	},
};`;
		const stripped = strip(source, "object-constructor.ts");

		expect(stripped.split("\n")[1]).toBe(`	constructor(public${blank(8)}) {`);
		expect(stripped.split("\n")[2]).toBe("		return public;");
	});

	test("erases body-less function declarations whole", () => {
		const source = `export function arity(exact: number): Arity;
export function arity(minimum: number, maximum: number): Arity;
export function arity(minimum: number, maximum = minimum): Arity {
	return { minimum, maximum };
}
declare function ambient(value: string): void;
export declare function exported<Value>(value: Value): Value;
export function untyped(value: string);`;
		const stripped = strip(source, "overloads.ts");
		const strippedLines = stripped.split("\n");
		const sourceLines = source.split("\n");

		// Keeping an overload header would rebind the implementation's parameters, so
		// every signature line must retain nothing but an optional terminator.
		for (const index of [0, 1, 5, 6, 7]) {
			expect(code(strippedLines[index]!)).toMatch(/^;?$/);
			expect(strippedLines[index]).toHaveLength(sourceLines[index]!.length);
		}
		expect(strippedLines[2]).toBe(
			`export function arity(minimum${blank(8)}, maximum = minimum)${blank(7)} {`,
		);
		expect(() =>
			parseScript(stripped.replaceAll("export ", blank(7)), { strict: true }),
		).not.toThrow();
	});

	test("erases interface heritage that carries object type arguments", () => {
		const source = `export interface Region extends Envelope<
	"projection",
	readonly [
		Extract<Instruction, { type: "call" }>,
		Extract<Instruction, { type: "loadProperty" }>,
	]
> {
	readonly separator: number;
}
const region = { separator: 1 };`;
		const stripped = strip(source, "heritage.ts");

		expect(stripped.split("\n").slice(0, 8).join("")).toMatch(/^\s*$/);
		expect(stripped.split("\n")[9]).toBe("const region = { separator: 1 };");
	});

	test("keeps a hashbang and a relational comparison before a parenthesized operand", () => {
		const source = `#!/usr/bin/env node
const biased = (limit: number): boolean =>
	limit > (limit / 1000) * 4 || count < 20 && other < 20;`;
		const stripped = strip(source, "hashbang.ts");

		expect(stripped.split("\n")[0]).toBe("#!/usr/bin/env node");
		expect(stripped.split("\n")[2]).toBe(source.split("\n")[2]);
	});

	test("preserves a property named function", () => {
		const source = `const shifted = (instruction: Instruction, base: Bases): Instruction => ({
	...instruction,
	functionIndex: instruction.functionIndex + base.function,
});`;
		const stripped = strip(source, "member-function.ts");

		expect(stripped.split("\n")[2]).toBe(source.split("\n")[2]);
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test("erases every compiler source into parsable JavaScript", () => {
		const files: Array<string> = [];
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const full = path.join(directory, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.(?:ts|mts|cts)$/.test(entry.name)) files.push(full);
			}
		};
		walk(path.resolve("src"));

		const failures: Array<string> = [];
		for (const file of files) {
			const source = readFileSync(file, "utf-8");
			try {
				const stripped = strip(source, file);
				// Declaration files hold only ambient declarations; nothing ever loads
				// them as JavaScript, so erasure leaves their headers behind.
				if (!/\.d\.[cm]?ts$/.test(file)) parseModule(stripped);
			} catch (error) {
				failures.push(
					`${path.relative(process.cwd(), file)}: ${(error as Error).message}`,
				);
			}
		}

		expect(failures).toEqual([]);
		expect(files.length).toBeGreaterThan(50);
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
		const stripped = strip(source, "assertion-operators.ts");

		expect(stripped.split("\n")[0]).toBe(
			`const logical = input${blank(11)} && fallback;`,
		);
		expect(stripped.split("\n")[3]).toBe(`const comparison = input${blank(10)} < limit;`);
		expect(stripped.split("\n")[25]).toBe(`const chained = input${blank(21)};`);
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
		const stripped = strip(source, "contextual-names.ts");
		const strippedLines = stripped.split("\n");
		const sourceLines = source.split("\n");

		expect(strippedLines.slice(1, 11)).toEqual(sourceLines.slice(1, 11));
		expect(strippedLines[11]).toBe(
			`	function(value${blank(8)})${blank(8)} { return value; },`,
		);
		expect(strippedLines[24]).toBe(`	import${blank(8)} = values.import;`);
		expect(strippedLines[25]).toBe("	export = values.export;");
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
		const stripped = strip(source, "content-validation.ts");

		expect(stripped).toContain('case "matching":');
		expect(stripped).toContain('case "ordering":');
		expect(stripped).toContain('case "text_input":');
		expect(stripped).toContain("return issues;");
		expect(() => parseScript(stripped, { strict: true })).not.toThrow();
	});

	test.each([
		["enums", "enum Mode { One }", /enums/],
		["decorators", "@sealed class Box {}", /decorators/],
		[
			"auto-accessor class fields",
			`class Box { accessor value: string = "x"; }`,
			/auto-accessor class fields/,
		],
		[
			"class parameter properties",
			"class Box { constructor(readonly value: string) {} }",
			/class parameter properties/,
		],
		[
			"runtime namespaces",
			"namespace Runtime { export const value = 1; }",
			/namespaces with runtime code/,
		],
		["import aliases", 'import legacy = require("./legacy.cjs");', /import aliases/],
		["export assignments", "export = value;", /export assignments/],
	])("rejects unsupported %s", (_name, source, message) => {
		expect(() => stripCompactTypes(source, "unsupported.ts")).toThrow(message);
		expect(() => stripCompactTypes(source, "unsupported.ts")).toThrow(SyntaxError);
	});
});
