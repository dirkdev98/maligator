import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";

function kernelOpcodes(body: string, primordials: "locked" | "mutable" = "locked") {
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel=function(a,b,f,g){${body}};`,
			"/spread-literal.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
	return image.native.functions[1]!.body.instructions;
}

const spreadsIterable = (body: string, primordials?: "locked" | "mutable") =>
	kernelOpcodes(body, primordials).some((op) => op.opcode === "CALL_SPREAD_ITERABLE");

describe("spread of Array literal arguments", () => {
	it("passes a locked literal's elements positionally without allocating it", () => {
		const instructions = kernelOpcodes("return f(1,...[a,b,3]);");
		expect(instructions.map((op) => op.opcode)).not.toContain("CALL_SPREAD_ITERABLE");
		expect(instructions.map((op) => op.opcode)).not.toContain("CREATE_ARRAY");
		expect(
			instructions.find((op) => op.opcode === "CALL" && op.argumentCount === 4),
		).toBeDefined();
	});

	it("keeps the iterator protocol while primordials are mutable", () => {
		expect(spreadsIterable("return f(1,...[a,b,3]);", "mutable")).toBe(true);
	});

	it.each([
		["a hole", "return f(...[a,,b]);"],
		["an escaping literal", "const l=[a,b];g(l);return f(...l);"],
		["a mutated literal", "const l=[a];l.push(b);return f(...l);"],
		[
			"a literal past the element limit",
			`return f(...[${Array(17).fill("a").join(",")}]);`,
		],
	])("keeps the iterator protocol for %s", (_name, body) => {
		expect(spreadsIterable(body)).toBe(true);
	});
});
