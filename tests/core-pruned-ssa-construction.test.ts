import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
} from "./helpers/core-inspection.ts";

function construct(source: string, evalDirect = false) {
	const compilation = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "core-pruned-ssa.js"),
		{ evalDirect },
	);
	for (const functionId of compilation.program.functionIds()) {
		expect(() => verifyCoreFunction(compilation.program, functionId)).not.toThrow();
	}
	return compilation;
}

describe("pruned SSA construction", () => {
	it("collapses an unchanged diamond and materializes a genuinely differing value", () => {
		const unchanged = construct(`
			function choose(flag) {
				let value = 1;
				if (flag) globalThis.left = 1;
				else globalThis.right = 2;
				return value;
			}
			choose(true);
		`).program.constructionStatistics;
		const differing = construct(`
			function choose(flag) {
				let value = 1;
				if (flag) value = 2;
				else value = 3;
				return value;
			}
			choose(true);
		`).program.constructionStatistics;

		expect(unchanged.virtualPhisCreated).toBeGreaterThan(0);
		expect(unchanged.virtualPhisCollapsed).toBe(unchanged.virtualPhisCreated);
		expect(unchanged.materializedBlockParameters).toBe(0);
		expect(unchanged.edgeArgumentsEmitted).toBe(0);
		expect(differing.materializedBlockParameters).toBe(1);
		expect(differing.edgeArgumentsEmitted).toBe(2);
	});

	it("resolves loop-carried, self-referential, and mutually dependent phis", () => {
		const carried = construct(`
			function sum(count) {
				let value = 0;
				while (count > 0) {
					value += count;
					count--;
				}
				return value;
			}
			sum(3);
		`).program.constructionStatistics;
		const selfReferential = construct(`
			function retain(count) {
				const value = {};
				while (count > 0) {
					count--;
					globalThis.count = count;
				}
				return value;
			}
			retain(3);
		`).program.constructionStatistics;
		const mutuallyDependent = construct(`
			function swap(left, right, count) {
				while (count > 0) {
					const temporary = left;
					left = right;
					right = temporary;
					count--;
				}
				return left === right;
			}
			swap({}, {}, 2);
		`).program.constructionStatistics;

		expect(carried.materializedBlockParameters).toBe(2);
		expect(selfReferential.materializedBlockParameters).toBe(1);
		expect(selfReferential.virtualPhisCollapsed).toBeGreaterThan(
			selfReferential.materializedBlockParameters,
		);
		expect(mutuallyDependent.materializedBlockParameters).toBeGreaterThan(1);
		expect(mutuallyDependent.aliasResolutions).toBeGreaterThan(0);
	});

	it("transports only demanded nontrivial values into exception handlers", () => {
		const compilation = construct(`
			function preserve(object, callback) {
				let demanded = object;
				let undemanded = 1;
				try {
					undemanded = 2;
					callback();
				} catch (error) {
					return demanded;
				}
				return undemanded;
			}
			preserve({}, () => {});
		`);
		const handlerParameters = [...compilation.program.functionIds()].flatMap(
			(functionId) => {
				const fn = compilation.program.function(functionId);
				return [...fn.blockIds()].flatMap((block) => {
					const handler = inspectCoreBlockHandler(fn, block);
					return handler === undefined
						? []
						: [inspectCoreBlockParameters(fn, handler.block)];
				});
			},
		);

		expect(handlerParameters.length).toBeGreaterThan(0);
		expect(handlerParameters.every((parameters) => parameters.length === 1)).toBe(true);
		expect(
			handlerParameters.every((parameters) => parameters[0]?.role === "exception"),
		).toBe(true);
		expect(
			compilation.program.constructionStatistics.definitionSnapshotEntriesCopied,
		).toBe(0);
	});

	it("handles nested finally, suspension, eval, and captured iteration environments", () => {
		const cases = [
			`function nested(value) {
				try { try { value++; } finally { value += 2; } }
				finally { value += 3; }
				return value;
			}`,
			`async function suspended(value) {
				let result = value;
				result += await Promise.resolve(value);
				return result;
			}
			function* generated(value) { yield value; return value + 1; }
			async function* asyncGenerated(value) { yield await Promise.resolve(value); }`,
			`function argumentsCases(value) {
				function mapped(argument) { argument++; return arguments[0]; }
				function unmapped(argument) { "use strict"; argument++; return arguments[0]; }
				return mapped(value) + unmapped(value) + new Function("return 1")();
			}`,
			`function closures() {
				const callbacks = [];
				for (let index = 0; index < 3; index++) callbacks.push(() => index);
				return callbacks;
			}`,
		];
		for (const source of cases) {
			const statistics = construct(source).program.constructionStatistics;
			expect(statistics.definitionSnapshotEntriesCopied).toBe(0);
		}
		const directEval = construct(
			`function evaluated(flag) {
				let value = 1;
				if (flag) value = 2;
				eval("value += 3");
				return value;
			}`,
			true,
		).program.constructionStatistics;
		expect(directEval.definitionSnapshotEntriesCopied).toBe(0);
	});

	it("keeps edge transport independent of unrelated environment size", () => {
		const source = (count: number): string => {
			const definitions = Array.from(
				{ length: count },
				(_, index) => `let value${index} = ${index};`,
			).join("\n");
			const uses = Array.from({ length: count }, (_, index) => ` + value${index}`).join(
				"",
			);
			return `function choose(flag) {
				${definitions}
				let selected;
				if (flag) selected = 1;
				else selected = 2;
				return selected${uses};
			}
			choose(true);`;
		};
		const small = construct(source(10)).program.constructionStatistics;
		const large = construct(source(100)).program.constructionStatistics;

		expect(large.virtualPhisCreated).toBeGreaterThan(small.virtualPhisCreated * 5);
		expect(large.materializedBlockParameters).toBe(small.materializedBlockParameters);
		expect(large.edgeArgumentsEmitted).toBe(small.edgeArgumentsEmitted);
		expect(large.definitionSnapshotEntriesCopied).toBe(0);
	});

	it("publishes construction statistics in instrumented optimizer reports", () => {
		const compilation = construct(`
			function choose(flag) {
				let value = 1;
				if (flag) value = 2;
				else value = 3;
				return value;
			}
		`);
		const statistics = compilation.program.constructionStatistics;
		const result = optimizeCore(compilation, { instrumentation: "phases" });

		expect(result.report.construction).toEqual(statistics);
		expect(result.report.construction.virtualPhisCreated).toBeGreaterThan(0);
		expect(result.report.construction.definitionSnapshotEntriesCopied).toBe(0);
	});
});
