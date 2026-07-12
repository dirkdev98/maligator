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

	test("rejects unsupported non-braced import type declarations", () => {
		expect(() =>
			stripCompactTypes('import type Model from "./model.js";', "bad.ts"),
		).toThrow(/non-braced import type declarations/);
	});

	test.each([
		["generics", "function id<T>(value: T): T { return value; }"],
		["assertions", "const value = input as string;"],
		["non-null", "const value = input!.name;"],
		["satisfies", "const value = input satisfies Shape;"],
		["optionals", "function f(value?: string): void {}"],
		["enums", "enum Mode { One }"],
		["namespaces", "namespace N { export const x = 1; }"],
		["decorators", "@sealed class Box {}"],
		["class fields", "class Box { value: string; }"],
	])("rejects unsupported %s syntax", (_name, source) => {
		expect(() => stripCompactTypes(source, "bad.ts")).toThrow(/does not support/);
	});
});
