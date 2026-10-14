import { describe, expect, it } from "vitest";
import {
	finishDirectCoreFunction,
	initializeDirectCoreFunction,
} from "../src/compiler/core/core-frontend-construction.ts";
import type {
	CoreConstructionBlock,
	CoreConstructionFunction,
	CoreInstructionEmitter,
} from "../src/compiler/core/core-frontend-construction.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
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

const unboundEmitter: CoreInstructionEmitter = {
	emit() {
		throw new Error("Unbound construction block");
	},
	emitLiteralSwitch() {
		throw new Error("Unbound construction block");
	},
	last() {
		return undefined;
	},
};

function directConstruction(blockCount: number) {
	const semantic = analyzeSourceAndRunSemanticAnalysis("", "core-chain.js");
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
	const fn: CoreConstructionFunction = {
		semanticFile: semantic.files[0]!,
		functionIndex: 0,
		nameStringIndex: 0,
		parameterCount: 1,
		length: 1,
		nextCapturedIndex: 0,
		blocks: [],
	};
	initializeDirectCoreFunction(program, fn);
	const blocks: Array<CoreConstructionBlock> = Array.from({ length: blockCount }, () => ({
		emitter: unboundEmitter,
	}));
	fn.blocks.push(...blocks);
	return { program, fn, blocks };
}

describe("pruned SSA construction", () => {
	it("bypasses long single-predecessor chains without recursive walks or extra phis", () => {
		const { program, fn, blocks } = directConstruction(5_000);
		for (const [index, block] of blocks.entries()) {
			if (index + 1 < blocks.length)
				block.emitter.emit({ type: "jump", blocks: [index + 1] });
			else block.emitter.emit({ type: "return", registers: [0] });
		}
		const id = finishDirectCoreFunction(fn);
		verifyCoreFunction(program, id);
		const stored = program.function(id);
		const last = [...stored.blockIds()].at(-1)!;
		const returned = inspectCoreTerminatorPayload(stored, stored.blockTerminator(last));
		expect(returned).toEqual({
			kind: "return",
			value: inspectCoreBlockParameters(stored, stored.entry)[0]!.value,
		});
		expect(program.constructionStatistics.virtualPhisCreated).toBe(1);
		expect(program.constructionStatistics.materializedBlockParameters).toBe(0);
	});

	it("stops a predecessor walk at the last reaching definition", () => {
		const { program, fn, blocks } = directConstruction(64);
		for (const [index, block] of blocks.entries()) {
			if (index === 32)
				block.emitter.emit({ type: "createNumber", registers: [0], value: 9 });
			if (index + 1 < blocks.length)
				block.emitter.emit({ type: "jump", blocks: [index + 1] });
			else block.emitter.emit({ type: "return", registers: [0] });
		}
		const id = finishDirectCoreFunction(fn);
		verifyCoreFunction(program, id);
		const stored = program.function(id);
		const last = [...stored.blockIds()].at(-1)!;
		const returned = inspectCoreTerminatorPayload(stored, stored.blockTerminator(last));
		if (returned.kind !== "return") throw new Error("Missing return");
		const definition = coreInstructionId(
			stored.kernel.valueDefinitionOwner(returned.value),
		);
		expect(stored.instructionOpcodeName(definition)).toBe("createNumber");
		expect(stored.instructionAttributes(definition)).toEqual({ value: 9 });
		expect(program.constructionStatistics.virtualPhisCreated).toBe(1);
	});

	it("anchors disconnected single-predecessor cycles when they feed a join", () => {
		const { program, fn, blocks } = directConstruction(4);
		blocks[0]!.emitter.emit({ type: "jump", blocks: [3] });
		blocks[1]!.emitter.emit({ type: "jump", blocks: [2] });
		blocks[2]!.emitter.emit(
			{ type: "createBoolean", registers: [1], value: true },
			{ type: "jumpIf", registers: [1], blocks: [1] },
			{ type: "jump", blocks: [3] },
		);
		blocks[3]!.emitter.emit({ type: "return", registers: [0] });
		const id = finishDirectCoreFunction(fn);
		expect(() => verifyCoreFunction(program, id)).not.toThrow();
		expect(program.constructionStatistics.virtualPhisCreated).toBe(2);
	});

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
