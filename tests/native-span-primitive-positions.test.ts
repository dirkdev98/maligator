import { readFileSync } from "node:fs";
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
const fixture = "tests/local/string-span-primitive-positions.js";
describe("primitive string span operand transport", () => {
	it.each(["mutable", "locked"] as const)(
		"retains all producer families and character/search calls under %s primordials",
		(primordials) => {
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(readFileSync(fixture, "utf8"), fixture),
				{
					facts: compilerProgramFactsFromConfig(
						resolveBuildConfig({ engine: { primordials } }),
					),
				},
			);
			for (const name of [
				"primitiveSlice",
				"primitiveSubstring",
				"primitiveSubstr",
				"primitiveNested",
				"primitiveSplit",
				"primitiveCapture",
			]) {
				const fn = image.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
				const consumers = [
					...fn.specializations
						.filter((region) => region.kind === "string-span")
						.flatMap((region) => region.consumers),
					...fn.storage!.spanContinuations.flatMap((plan) => plan.consumers),
				].map((consumer) => consumer.kind);
				expect(consumers, name).toEqual(
					expect.arrayContaining(
						name === "primitiveSlice"
							? ["charAtCall", "atCall", "charCodeAtCall", "codePointAtCall"]
							: [
									"indexOfCall",
									"lastIndexOfCall",
									"includesCall",
									"startsWithCall",
									"endsWithCall",
								],
					),
				);
			}
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
});
