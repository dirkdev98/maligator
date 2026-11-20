import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { projectCoreSpecializationRecipes } from "../src/compiler/core/core-specialization-recipes.ts";
import { DEFAULT_CORE_SPECIALIZATION_BUDGETS } from "../src/compiler/core/core-transform-candidates.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";

describe("iterator cursor discovery priority", () => {
	it("fits a single for-of cursor ahead of a deeper indexed loop under a tight budget", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`
			globalThis.indexed = function indexed(values, rounds) {
				let sum = 0;
				for (let first = 0; first < rounds; first++)
					for (let second = 0; second < rounds; second++)
						for (let index = 0; index < values.length; index++)
							sum += values[index];
				return sum;
			};
			globalThis.walk = function walk(values) {
				let total = 0;
				for (const value of values) total += value;
				return total;
			};`,
			"iterator-priority.js",
		);
		const { program, context } = optimizeSemanticProgramToCore(
			semantic,
			{},
			(_phase, run) => run(),
		);
		const functions = [...program.functionIds()].filter((id) => {
			const name = program.stringConstantText(
				program.function(id).metadata.nameStringIndex,
			);
			return name === "indexed" || name === "walk";
		});
		const analyses = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
		const full = buildCoreOptimizationPlan(program, analyses, summaries, functions, {
			context,
		});
		const regions = projectCoreSpecializationRecipes(full.recipes);
		const cursor = regions.find(
			(region) => region.kind === "array-values-iterator-cursor",
		)!;
		const indexed = regions.find((region) => region.kind === "indexed-length-loop")!;
		const limited = buildCoreOptimizationPlan(program, analyses, summaries, functions, {
			context,
			budgets: {
				...DEFAULT_CORE_SPECIALIZATION_BUDGETS,
				programGeneratedCode: Math.max(
					cursor.cost.generatedCode,
					indexed.cost.generatedCode,
				),
			},
		});
		expect(
			projectCoreSpecializationRecipes(limited.recipes).map((region) => region.id),
		).toEqual([cursor.id]);
	});
});
