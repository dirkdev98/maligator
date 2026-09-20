import { describe, expect, it } from "vitest";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import type { SealedCoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import type {
	NativeInstructionPlan,
	ProgramImage,
} from "../src/compiler/target/program-image.ts";

function directCallbackPlans(image: ProgramImage) {
	return image.native.functions.flatMap((fn) =>
		fn.instructions.filter(
			(plan): plan is Extract<NativeInstructionPlan, { kind: "call" }> =>
				plan?.kind === "call" && plan.directCallbackFunctionIndex !== undefined,
		),
	);
}

describe("direct builtin callback targets", () => {
	it("carries an exact created closure through the array callback bridge", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`const threshold = 2;
				globalThis.result = [1, 2, 3].some((value) => value > threshold);`,
				"direct-array-callback.js",
			),
		);
		const plans = directCallbackPlans(image);
		expect(plans).toHaveLength(1);
		const target = plans[0]!.directCallbackFunctionIndex!;
		expect(target).toBeGreaterThanOrEqual(0);
		const output = emitProgramImage(image, { debugInfo: false });
		expect(output).toContain(
			`MAL_BUILTIN_ARRAY_ITERATION_SOME, ${target}, mal_compiled_${target}`,
		);
		expect(output).toContain("MAL_INTRINSIC_ARRAY_ITERATION_ELIGIBLE");
		expect(output.match(new RegExp(`mal_compiled_${target}\\(`, "g"))).toHaveLength(2);
	});

	it("keeps callbacks from an open argument generic", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function test(callback) { return [1, 2, 3].some(callback); }
				globalThis.test = test;`,
				"open-array-callback.js",
			),
		);
		expect(directCallbackPlans(image)).toEqual([]);
	});

	it("rejects a callback plan whose target no longer matches the operand", () => {
		let program: SealedCoreProgram | undefined;
		let plan: CoreOptimizationPlan | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.result = [1].some((value) => value === 1);`,
				"forged-array-callback.js",
			),
			{
				afterCoreOptimization(optimized, _context, _report, optimizedPlan) {
					program = optimized;
					plan = optimizedPlan;
				},
			},
		);
		expect(program).toBeDefined();
		expect(plan?.directBuiltinCallbacks).toHaveLength(1);
		const callback = plan!.directBuiltinCallbacks![0]!;
		expect(() =>
			verifyCoreOptimizationPlan(program!, {
				...plan!,
				directBuiltinCallbacks: [{ ...callback, target: callback.caller }],
			}),
		).toThrow(/no current exact target proof/);
	});
});
