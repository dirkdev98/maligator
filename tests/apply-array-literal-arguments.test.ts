import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";

function instructions(body: string, primordials: "locked" | "mutable" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel=function(a,b,f,g){${body}};`,
			"/apply-literal.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	).native.functions[1]!.body.instructions;
}
const guarded = (body: string, primordials?: "locked" | "mutable") =>
	instructions(body, primordials).some(
		(op) => op.opcode === "LOAD_INTRINSIC" && op.intrinsic === "__functionPrototypeApply",
	);

describe("apply of private dense Array literals", () => {
	it.each(["locked", "mutable"] as const)(
		"guards the loaded method and passes elements positionally under %s primordials",
		(primordials) => {
			const ops = instructions("return f.apply(g,[a,b,3]);", primordials);
			expect(
				ops.some(
					(op) =>
						op.opcode === "LOAD_INTRINSIC" && op.intrinsic === "__functionPrototypeApply",
				),
			).toBe(true);
			expect(ops.some((op) => op.opcode === "CALL" && op.argumentCount === 3)).toBe(true);
			expect(ops.some((op) => op.opcode === "CREATE_ARRAY")).toBe(true);
		},
	);
	it.each([
		["a hole", "return f.apply(g,[a,,b]);"],
		["an escaping literal", "const l=[a,b];g(l);return f.apply(g,l);"],
		["a mutated literal", "const l=[a];l.push(b);return f.apply(g,l);"],
		["a reused literal", "const l=[a,b];f.apply(g,l);return f.apply(g,l);"],
		["a cross-block literal", "const l=[a,b];if(g) return f.apply(g,l);return 0;"],
		["an extra argument", "return f.apply(g,[a,b],3);"],
		[
			"a literal past the element limit",
			`return f.apply(g,[${Array(17).fill("a").join(",")}]);`,
		],
	])("keeps ordinary apply for %s", (_name, body) => {
		expect(guarded(body)).toBe(false);
	});
});
