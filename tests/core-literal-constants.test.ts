import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";

function compile(body: string, locked = true) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function test(x, from) { ${body} } globalThis.test = test;`,
			"literal-constant.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: locked ? "locked" : "mutable" } }),
			),
		},
	);
}
function constants(image: ReturnType<typeof compile>) {
	return image.runtime.functions.flatMap((fn) =>
		fn.instructions.filter(
			(i) => i.opcode === "INSTANTIATE_LITERAL_TEMPLATE" && i.cacheSlot !== undefined,
		),
	);
}

describe("Core literal constants", () => {
	it.each([
		'return ["foo", "bar"].includes(x, from);',
		"return [null, false, true, -0, 2.5, 5n].includes(x);",
		'return [, "bar"].includes(x);',
		"return ({a: [1, {b: false}]}).hasOwnProperty(x);",
		"return [1,2,3].slice(x);",
		'return [{a: [1, {b: "two"}]}, [3, 4]].includes(x);',
		`return [${Array.from({ length: 200 }, (_, i) => i).join(",")}].includes(x);`,
	])("pools recursively static nonescaping search receivers: %s", (body) => {
		const image = compile(body);
		expect(constants(image)).toHaveLength(1);
		expect(
			image.runtime.functions
				.flatMap((fn) => fn.instructions)
				.some((i) => i.opcode === "CALL_LITERAL_METHOD"),
		).toBe(true);
		expect(
			constants(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(constants(image));
	});
	it.each([
		'const a = ["foo", "bar"]; globalThis.a = a; return a.includes(x);',
		'const a = ["foo", "bar"]; a[0] = x; return a.includes(x);',
		'const a = ["foo", "bar"]; a.includes(x); return a;',
		'const a = ["foo", "bar"]; a.includes = x; return a.includes(x);',
		'return [x, "bar"].includes(x);',
		'return [/foo/, "bar"].includes(x);',
		"const child = {}; const a = [child]; a.includes(x); return child;",
	])("retains fresh allocation when mutation or identity can be observed: %s", (body) => {
		expect(constants(compile(body))).toHaveLength(0);
	});
	it.each([
		'return "hello".slice(x);',
		"return (42).toString(x);",
		"return true.toString();",
		"return [1,2].map(x);",
		"return [1,2].push(x);",
		"return [1,2][Symbol.iterator]();",
	])("resolves canonical prototype methods: %s", (body) => {
		const image = compile(body);
		expect(
			image.runtime.functions
				.flatMap((fn) => fn.instructions)
				.some((i) => i.opcode === "CALL_LITERAL_METHOD"),
		).toBe(true);
	});
	it.each([
		"return ({hasOwnProperty: 1, nested: {x: [1,2]}}).hasOwnProperty(x);",
		'return ({toString: "no"}).toString();',
		"return ({__proto__: null, a: [1]}).toString();",
	])("preserves literal own properties shadowing methods: %s", (body) => {
		const image = compile(body);
		expect(
			image.runtime.functions
				.flatMap((fn) => fn.instructions)
				.some((i) => i.opcode === "CALL_LITERAL_METHOD"),
		).toBe(false);
	});
	it("retains ordinary dispatch when Array.prototype can be replaced", () => {
		expect(constants(compile('return ["foo", "bar"].includes(x);', false))).toHaveLength(
			0,
		);
	});
});
