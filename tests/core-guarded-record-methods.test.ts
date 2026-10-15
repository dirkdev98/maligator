import { describe, expect, it } from "vitest";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import { projectCoreSpecializationRecipes } from "../src/compiler/core/core-specialization-recipes.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

function compile(source: string) {
	let program: CoreProgram | undefined;
	let plan: CoreOptimizationPlan | undefined;
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, "guarded-record-methods.js"),
		{
			afterCoreOptimization(optimized, _context, _report, selected) {
				program = optimized;
				plan = selected;
			},
		},
	);
	if (program === undefined || plan === undefined) throw new Error("Missing Core plan");
	return { program, image, recipes: projectCoreSpecializationRecipes(plan.recipes) };
}

describe("guarded object data-member calls", () => {
	it.each([false, true])(
		"plans captured record members with accessor literal=%s",
		(accessor) => {
			const { program, image, recipes } = compile(`
				function makeRecord(seed) {
					let total = seed;
					const update = (value) => { total += value; return total; };
					const retained = () => update;
					return { update, retained ${accessor ? ", get current() { return total; }" : ""} };
				}
				function useRecord(record, count) {
					let total = 0;
					for (let index = 0; index < count; index++) total += record.update(index);
					return total;
				}
				useRecord(makeRecord(1), 4);
			`);
			const caller = coreFunctionNamed(program, "useRecord")!;
			const target = coreFunctionNamed(program, "update")!;
			const operations = coreOperations(caller);
			const selected = recipes.find(
				(recipe) =>
					recipe.kind === "guarded-direct-call" &&
					recipe.function === caller.id &&
					recipe.targetFunctions.includes(target.id),
			);
			expect(selected).toBeDefined();
			expect(operations.some(({ opcode }) => opcode === "loadPropertyStatic")).toBe(true);
			expect(operations.some(({ opcode }) => opcode === "call")).toBe(true);
			expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(
				false,
			);
			expect(emitProgramImage(image, { debugInfo: false })).toContain(
				"mal_vm_call_exact_script_compiled_callback(",
			);
		},
	);

	it("keeps data-member nominees bounded and reserves existing class nominees", () => {
		const { program, recipes } = compile(`
			${Array.from(
				{ length: 6 },
				(_, index) => `
				function makeRecord${index}(seed) {
					let total = seed;
					const update${index} = (value) => { total += value; return total; };
					return { update: update${index} };
				}
			`,
			).join("\n")}
			function makeClass(seed) {
				class ClassRecord { update(value) { return value + seed; } }
				return new ClassRecord();
			}
			function useRecord(record, count) {
				let total = 0;
				for (let index = 0; index < count; index++) total += record.update(index);
				return total;
			}
			useRecord(makeClass(1), 4);
			${Array.from({ length: 6 }, (_, index) => `useRecord(makeRecord${index}(1), 4);`).join("\n")}
		`);
		const caller = coreFunctionNamed(program, "useRecord")!;
		const target = coreFunctionNamed(program, "update")!;
		const selected = recipes.filter(
			(recipe) => recipe.kind === "guarded-direct-call" && recipe.function === caller.id,
		);
		expect(selected).toHaveLength(1);
		expect(selected[0]!.targetFunctions).toContain(target.id);
		expect(selected[0]!.targetFunctions).toHaveLength(4);
	});

	it("keeps record-only nominees out of calls outside loops", () => {
		const { program, recipes } = compile(`
			function makeRecord(seed) {
				let total = seed;
				return { update(value) { total += value; return total; } };
			}
			function useRecord(record, value) { return record.update(value); }
			useRecord(makeRecord(1), 4);
		`);
		const caller = coreFunctionNamed(program, "useRecord")!;
		expect(
			recipes.some(
				(recipe) =>
					recipe.kind === "guarded-direct-call" && recipe.function === caller.id,
			),
		).toBe(false);
	});
});
