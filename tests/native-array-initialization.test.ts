import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.classify=function(source,escape,observe){${body}};`,
			"/split-span.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
describe("fresh Array initialization regions", () => {
	it.each(["mutable", "locked"] as const)(
		"initializes prepared values under %s primordials",
		(mode) => {
			const image = compile("return [source,escape,observe];", mode);
			expect(
				image.native.functions[1]!.storage!.arrayInitializations[0]!.values,
			).toHaveLength(3);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("consumes the existing folded push sequence", () => {
		const image = compile(
			"const result=[];result.push(source);result.push(escape);result.push(observe);return result;",
			"locked",
		);
		expect(image.native.functions[1]!.storage!.arrayInitializations).toHaveLength(1);
	});
	it("rejects initialization moved across effects or holes", () => {
		for (const body of [
			"return [observe(),source,escape];",
			"return [source,,escape];",
		]) {
			expect(compile(body).native.functions[1]!.storage!.arrayInitializations).toEqual(
				[],
			);
		}
	});
	it("rejects forged initialization inputs", () => {
		const image = compile("return [source,escape,observe];"),
			native = image.native.functions[1]!;
		const plan = native.storage!.arrayInitializations[0]!;
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...native,
						storage: {
							...native.storage!,
							arrayInitializations: [{ ...plan, values: plan.values.slice(1) }],
						},
					}),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});
});
