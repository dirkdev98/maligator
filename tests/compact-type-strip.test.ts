import { describe, expect, test } from "vitest";
import { stripCompactTypes } from "../src/compact-type-strip.ts";
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

	test("does not treat TypeScript contextual words as declarations", () => {
		const source =
			"const enumValue = { enum: 1, namespace: 2, module: 3, declare: 4 }; const pattern = /as string satisfies Type/;";
		expect(stripCompactTypes(source, "ordinary.ts")).toBe(source);
	});

	test.each([
		["enums", "enum Mode { One }"],
		["decorators", "@sealed class Box {}"],
	])("rejects unsupported %s syntax", (_name, source) => {
		expect(() => stripCompactTypes(source, "bad.ts")).toThrow(/does not support/);
	});
});
