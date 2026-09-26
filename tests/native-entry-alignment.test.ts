import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	emitProgramImage,
	emitProgramTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

const image = compileSemanticProgramToProgramImage(
	analyzeSourceAndRunSemanticAnalysis(
		`
		class Price { quote(order) { return order.net + 7; } }
		const price = new Price();
		for (let i = 0; i < 3; i++) globalThis.result = price.quote({net: i});
		function* sequence(value) { yield value; return value + 1; }
		async function settle(value) { return value; }
		globalThis.sequence = sequence;
		globalThis.settle = settle;
		`,
		"native-entry-alignment.js",
	),
	{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
);

function alignedDefinitions(source: string): Array<string> {
	const definitions = source
		.split("\n")
		.filter((line) => /\bmal_(?:compiled|direct)_\w+\([^;]*\) \{$/.test(line));
	expect(definitions.length).toBeGreaterThan(0);
	for (const definition of definitions)
		expect(definition).toContain("__attribute__((aligned(64)))");
	return definitions;
}

describe("native entry alignment contract", () => {
	it.each(["static", "external"] as const)(
		"aligns boxed, typed, numeric-leaf and resumable definitions with %s linkage",
		(linkage) => {
			const definitions: Array<string> = [];
			let resumable = 0;
			for (const [index, fn] of image.runtime.functions.entries()) {
				const emitted = emitCompiledFunction(
					fn,
					image.native.functions[index]!,
					index,
					"",
					false,
					linkage,
				)!;
				expect(emitted).not.toBeNull();
				definitions.push(...alignedDefinitions(emitted.source));
				for (const entry of emitted.directEntries)
					definitions.push(...alignedDefinitions(entry.source));
				if (fn.isGenerator || fn.isAsync) resumable++;
			}
			expect(resumable).toBe(2);
			expect(definitions.some((line) => /\bmal_direct_\d+_\d+\(/.test(line))).toBe(true);
			expect(definitions.some((line) => /\bmal_direct_\d+_\d+_leaf\(/.test(line))).toBe(
				true,
			);
		},
	);

	it("retains alignment through monolithic and partitioned program emission", () => {
		for (const debugInfo of [false, true]) {
			alignedDefinitions(emitProgramImage(image, { compiled: true, debugInfo }));
			const units = emitProgramTranslationUnits(image, { compiled: true, debugInfo });
			alignedDefinitions(units.map((unit) => unit.source).join("\n"));
		}
	});
});
