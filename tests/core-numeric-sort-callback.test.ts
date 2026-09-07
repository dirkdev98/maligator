import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import type {
	NativeInstructionPlan,
	ProgramImage,
} from "../src/compiler/target/program-image.ts";

function compile(
	body = "return a - b;",
	operation = "sort",
	receiver = "new Float64Array([3, 1, 2])",
) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`
		function compare(a, b) { ${body} }
		globalThis.result = ${receiver}.${operation}(compare);
	`,
			"numeric-sort-callback.js",
		),
	);
}

function callbackPlans(image: ProgramImage) {
	return image.native.functions.flatMap((fn) =>
		fn.instructions.filter(
			(plan): plan is Extract<NativeInstructionPlan, { kind: "call" }> =>
				plan?.kind === "call" && plan.numericSortCallback !== undefined,
		),
	);
}

describe("numeric sort callback entries", () => {
	it.each(["sort", "toSorted"])(
		"carries %s's checked numeric callback contract through the codec and emitter",
		(operation) => {
			const image = deserializeCompilerArtifact(
				serializeCompilerArtifact(compile(undefined, operation)),
			);
			const plans = callbackPlans(image);
			expect(plans).toHaveLength(1);
			const callback = plans[0]!.numericSortCallback!;
			const entry =
				image.native.functions[callback.functionIndex]!.directEntries[callback.entryId]!;
			expect(entry.parameterRepresentations).toEqual(["number", "number"]);
			expect(entry.resultRepresentation).toBe("number");
			expect(plans[0]!.directFunctionIndex).toBeUndefined();
			const output = emitProgramImage(image, { debugInfo: false });
			expect(output).toContain("mal_builtin_sort_numeric(vm,");
			expect(output).toContain(
				`mal_direct_${callback.functionIndex}_${callback.entryId}`,
			);
		},
	);

	it.each([
		"array.sort.call(array, compare)",
		"array['toSorted']['call'](array, compare)",
		"Array.prototype.sort.call(array, compare)",
		"(() => { const sort = array.sort; return sort.call(array, compare); })()",
	])("certifies detached builtin invocation: %s", (expression) => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(
				compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(
						`
				function compare(a, b) { return a - b; }
				const array = [3, 1, 2];
				globalThis.result = ${expression};
			`,
						"detached-sort.js",
					),
				),
			),
		);
		const plans = callbackPlans(image);
		expect(plans.length).toBeGreaterThan(0);
		expect(plans.every((plan) => plan.numericSortCallback!.viaCall === true)).toBe(true);
		expect(emitProgramImage(image, { debugInfo: false })).toContain(
			"mal_builtin_sort_numeric(vm,",
		);
	});

	it("selects the same guarded contract for numeric and mixed Arrays", () => {
		for (const receiver of ["[3, 1, 2]", "[3, '1', 2]"]) {
			const image = compile(undefined, "sort", receiver);
			expect(callbackPlans(image)).toHaveLength(1);
			expect(emitProgramImage(image, { debugInfo: false })).toContain(
				"mal_builtin_sort_numeric(vm,",
			);
		}
	});

	it.each([
		"return arguments.length;",
		"return a > b ? 'yes' : 'no';",
		"return () => a;",
	])("keeps unsupported comparator contracts generic: %s", (body) => {
		expect(callbackPlans(compile(body))).toEqual([]);
	});

	it.each(["a", "a, b, extra", "...args"])(
		"does not force comparator parameters %s into the two-number ABI",
		(parameters) => {
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`
				function compare(${parameters}) { return 1; }
				const array = [3, 1, 2];
				globalThis.result = array.sort.call(array, compare);
			`,
					"unsupported-sort-arity.js",
				),
			);
			expect(callbackPlans(image)).toEqual([]);
		},
	);

	it("rejects forged numeric callback ABI coordinates", () => {
		const image = compile();
		const callback = callbackPlans(image)[0]!.numericSortCallback!;
		for (const altered of [
			{ ...callback, functionIndex: image.runtime.functions.length },
			{ ...callback, entryId: 9 },
			{ ...callback, viaCall: false as unknown as true },
		]) {
			const forged = {
				...image,
				native: {
					...image.native,
					functions: image.native.functions.map((fn) => ({
						...fn,
						instructions: fn.instructions.map((plan) =>
							plan?.kind === "call" && plan.numericSortCallback !== undefined
								? { ...plan, numericSortCallback: altered }
								: plan,
						),
					})),
				},
			};
			expect(() => serializeCompilerArtifact(forged)).toThrow(/numeric sort callback/);
		}
	});
});
