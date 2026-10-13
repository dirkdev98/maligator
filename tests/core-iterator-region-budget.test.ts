import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { discoverCoreLocalSpecializationCandidates } from "../src/compiler/core/core-ir-provenance.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import {
	buildCoreSpecializationRecipeTable,
	projectCoreSpecializationRecipes,
} from "../src/compiler/core/core-specialization-recipes.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

const config = resolveBuildConfig({ engine: { primordials: "mutable" } });

function compile(source: string) {
	return optimizeSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "iterator-regions.js"),
		{ facts: compilerProgramFactsFromConfig(config) },
		(_phase, run) => run(),
	);
}

const separateProtocols = `
	function visit(left, right) {
		const [first, second] = left;
		for (const value of right) globalThis.observe(value);
		return first + second;
	}
	globalThis.visit = visit;
`;

describe("iterator region budget ownership", () => {
	it("costs each iterator/next protocol independently while retaining its adjacent steps", () => {
		const compilation = compile(separateProtocols);
		const regions = projectCoreSpecializationRecipes(compilation.plan.recipes).filter(
			(region) => region.kind === "iterator-result-virtualization",
		);
		expect(
			regions.map((region) => region.iteratorResultVirtualization.steps.length).sort(),
		).toEqual([1, 2]);
		for (const region of regions) {
			const fn = compilation.program.function(region.function);
			const protocols = new Set(
				region.iteratorResultVirtualization.steps.map((step) => {
					const start = fn.kernel.instructionOperandStart(step);
					return `${fn.kernel.operandAt(start)}:${fn.kernel.operandAt(start + 1)}`;
				}),
			);
			expect(protocols.size).toBe(1);
		}
	});

	it("retains the bounded shards for a long single protocol", () => {
		const compilation = compile(`
			globalThis.visit = function visit(values) {
				const [${Array.from({ length: 70 }, (_, index) => `v${index}`).join(",")}] = values;
				return v0 + v69;
			};
		`);
		const candidates = [...compilation.program.functionIds()]
			.flatMap(
				(id) =>
					discoverCoreLocalSpecializationCandidates(
						compilation.program,
						id,
						new Set(["iterator-result-virtualization"]),
					).candidates,
			)
			.filter((candidate) => candidate.kind === "iterator-result-virtualization");
		expect(
			candidates.map((candidate) => candidate.steps.length).sort((a, b) => a - b),
		).toEqual([6, 64]);
	});

	it("rejects a forged certificate pooling steps from separate protocols", () => {
		const compilation = compile(separateProtocols);
		const regions = projectCoreSpecializationRecipes(compilation.plan.recipes);
		const results = regions.filter(
			(region) => region.kind === "iterator-result-virtualization",
		);
		expect(results).toHaveLength(2);
		const [first, second] = results;
		const steps = [
			...first!.iteratorResultVirtualization.steps,
			...second!.iteratorResultVirtualization.steps,
		];
		const forged = {
			...first!,
			claimedInstructions: steps,
			ordinaryBlocks: [
				...new Set([...first!.ordinaryBlocks, ...second!.ordinaryBlocks]),
			].sort((a, b) => a - b),
			exceptionalBlocks: [
				...new Set([...first!.exceptionalBlocks, ...second!.exceptionalBlocks]),
			].sort((a, b) => a - b),
			iteratorResultVirtualization: { ...first!.iteratorResultVirtualization, steps },
		};
		expect(() =>
			verifyCoreOptimizationPlan(compilation.program, {
				...compilation.plan,
				recipes: buildCoreSpecializationRecipeTable(
					regions
						.filter((region) => region !== second)
						.map((region) => (region === first ? forged : region)),
				),
			}),
		).toThrow(/invalid iterator-result certificate/);
	});

	it("admits composed entry pairs in the bundled collection fixture under the default budget", () => {
		const semantic = loadEntrypointAndRunSemanticAnalysis(
			resolve("tests/local/collection-direct.js"),
			{
				buildConfig: config,
				stripTypes: stripCompactTypes,
			},
		);
		const image = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(config),
		});
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(decoded).toEqual(image);
		const owners = decoded.native.functions.flatMap((fn, index) =>
			fn.specializations.some(
				(region) => region.kind === "iterator-entry-pair-virtualization",
			)
				? [{ fn, index }]
				: [],
		);
		expect(owners.length).toBeGreaterThan(0);
		for (const { fn, index } of owners) {
			const output = emitCompiledFunction(fn, index, "", false)!.source;
			expect(output).toContain("mal_vm_iterator_step_entry_pair_protocol_cursor(");
			expect(output).toContain("mal_vm_iterator_step(vm,");
		}
	});
});
