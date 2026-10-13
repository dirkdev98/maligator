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
const body = `const part=source.split('|')[1]; const size=part.length;
 if(part==='if')return size+10; if(escape)return observe(part); return size;`;
describe("span continuations from split projections", () => {
	it.each(["mutable", "locked"] as const)(
		"composes branching consumers under %s primordials",
		(mode) => {
			const image = compile(body, mode),
				native = image.native.functions[1]!;
			expect(native.storage!.spanContinuations).toHaveLength(1);
			expect(
				native.storage!.spanContinuations[0]!.consumers.map((value) => value.kind).sort(),
			).toEqual(["equal", "length", "materialize"]);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("materializes at a character-access region boundary", () => {
		const image = compile(
			"const part=source.split('|')[1];if(part.length===2)return part==='if';return part.charCodeAt(0);",
		);
		const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
		expect(plan.consumers.map((value) => value.kind)).toContain("materialize");
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it("rejects omitted observers and a forged producer lifetime", () => {
		const image = compile(body),
			native = image.native.functions[1]!,
			plan = native.storage!.spanContinuations[0]!;
		for (const forged of [
			{ ...plan, consumers: plan.consumers.slice(0, 1) },
			{ ...plan, splitCallIp: plan.producerIp },
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it("materializes before an observing store while retaining projected reads", () => {
		const image = compile(
			"const part=source.split('|')[1];observe.saved=part;return part.length;",
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations[0]!.consumers.map(
				(value) => value.kind,
			),
		).toEqual(["materialize", "length"]);
	});
});
