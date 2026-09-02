import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { CORE_LOCAL_CANONICALIZATION_PASSES } from "../src/compiler/core/core-local-passes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CorePassManager } from "../src/compiler/core/core-pass-manager.ts";
import type { CoreFunctionStore, CoreProgram } from "../src/compiler/core/core-store.ts";
import { CoreProgram as MutableCoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreInstructionOperands,
	inspectCoreTerminatorPayload,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

interface Fixture {
	readonly program: MutableCoreProgram;
	readonly function: CoreFunctionId;
}

function fixture(parameterCount = 0): {
	readonly program: MutableCoreProgram;
	readonly builder: CoreFunctionBuilder;
} {
	const program = new MutableCoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
	return { program, builder: new CoreFunctionBuilder(program, { parameterCount }) };
}

function parameters(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
): ReadonlyArray<CoreValueId> {
	return inspectCoreBlockParameters(builder, block).map(({ value }) => value);
}

function optimized(source: Fixture): {
	readonly program: CoreProgram;
	readonly fn: CoreFunctionStore;
} {
	const result = optimizeCore(
		{ program: source.program, context: programAnalysisContext() },
		{ verification: "per-pass" },
	);
	return {
		program: result.compilation.program,
		fn: result.compilation.program.function(source.function),
	};
}

function blocks(fn: CoreFunctionStore) {
	return [...fn.blockIds()];
}

function functionWithForwardedArguments(): Fixture {
	const { program, builder } = fixture(1);
	const entry = builder.createBlock([{}]);
	const flag = parameters(builder, entry)[0]!;
	const [left] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [right] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 2 },
	});
	const consequent = builder.createBlock([{}]);
	const alternate = builder.createBlock([{}]);
	const join = builder.createBlock([{}]);
	builder.setTerminator(entry, {
		kind: "branch",
		condition: flag,
		consequent: { block: consequent, arguments: [left!] },
		alternate: { block: alternate, arguments: [right!] },
	});
	builder.setTerminator(consequent, {
		kind: "jump",
		edge: { block: join, arguments: [parameters(builder, consequent)[0]!] },
	});
	builder.setTerminator(alternate, {
		kind: "jump",
		edge: { block: join, arguments: [parameters(builder, alternate)[0]!] },
	});
	builder.setTerminator(join, {
		kind: "return",
		value: parameters(builder, join)[0]!,
	});
	return { program, function: builder.finish(entry).function };
}

describe("Core empty forwarding blocks", () => {
	it("substitutes edge arguments through a forwarding block", () => {
		const { program, fn } = optimized(functionWithForwardedArguments());
		const terminator = inspectCoreTerminatorPayload(fn, fn.blockTerminator(fn.entry));
		expect(terminator.kind).toBe("branch");
		if (terminator.kind !== "branch") throw new Error("expected a branch");
		expect(terminator.consequent.block).toBe(terminator.alternate.block);
		expect(terminator.consequent.arguments).not.toEqual(terminator.alternate.arguments);
		expect(blocks(fn)).toHaveLength(2);
		expect(() => verifyCoreProgram(program, { stage: "pre-target" })).not.toThrow();
	});

	it("collapses a chain of forwarding blocks", () => {
		const { program, builder } = fixture();
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const first = builder.createBlock([{}]);
		const second = builder.createBlock([{}]);
		const exit = builder.createBlock([{}]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: first, arguments: [value!] },
		});
		builder.setTerminator(first, {
			kind: "jump",
			edge: { block: second, arguments: [parameters(builder, first)[0]!] },
		});
		builder.setTerminator(second, {
			kind: "jump",
			edge: { block: exit, arguments: [parameters(builder, second)[0]!] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: parameters(builder, exit)[0]!,
		});
		const result = optimized({ program, function: builder.finish(entry).function });
		expect(blocks(result.fn).length).toBeLessThan(4);
		expect(() =>
			verifyCoreProgram(result.program, { stage: "pre-target" }),
		).not.toThrow();
	});

	it("terminates on a forwarding cycle and preserves the cycle", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const flag = parameters(builder, entry)[0]!;
		const spin = builder.createBlock();
		const other = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: spin, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(spin, {
			kind: "jump",
			edge: { block: other, arguments: [] },
		});
		builder.setTerminator(other, {
			kind: "jump",
			edge: { block: spin, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: flag });
		const finished = builder.finish(entry);
		const result = optimized({ program, function: finished.function });
		const cfg = buildCoreControlFlow(result.program, finished.function);
		expect(cfg.loops).toHaveLength(1);
		expect(() =>
			verifyCoreProgram(result.program, { stage: "pre-target" }),
		).not.toThrow();
	});

	it("preserves a reachable self-targeting empty branch", () => {
		const { program, builder } = fixture();
		const entry = builder.createBlock();
		const [truthy] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		const decision = builder.createBlock([{ representation: "boolean" }]);
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: decision, arguments: [truthy!] },
		});
		builder.setTerminator(decision, {
			kind: "branch",
			condition: parameters(builder, decision)[0]!,
			consequent: { block: decision, arguments: [truthy!] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: truthy! });
		const finished = builder.finish(entry);
		const result = optimized({ program, function: finished.function });
		const cfg = buildCoreControlFlow(result.program, finished.function);
		expect(cfg.loops).toHaveLength(1);
		expect(() =>
			verifyCoreProgram(result.program, { stage: "pre-target" }),
		).not.toThrow();
	});

	it("never folds a handler entry whose parameter the unwinder binds", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const object = parameters(builder, entry)[0]!;
		const handler = builder.createBlock([{ role: "exception" }]);
		const rethrow = builder.createBlock([{}]);
		const [value] = builder.appendInstruction(entry, "loadPropertyStatic", [object], {
			attributes: { stringIndex: 0 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "return", value: value! });
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: rethrow, arguments: [parameters(builder, handler)[0]!] },
		});
		builder.setTerminator(rethrow, {
			kind: "throw",
			value: parameters(builder, rethrow)[0]!,
		});
		const result = optimized({ program, function: builder.finish(entry).function });
		const protectedBlock = blocks(result.fn).find(
			(block) => inspectCoreBlockHandler(result.fn, block) !== undefined,
		)!;
		const handlerEntry = inspectCoreBlockHandler(result.fn, protectedBlock)!.block;
		expect(inspectCoreBlockParameters(result.fn, handlerEntry)[0]?.role).toBe(
			"exception",
		);
		expect([...result.fn.bodyInstructionIds(handlerEntry)]).toHaveLength(0);
	});

	it("retains a forwarding phi used by a dominated block", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const flag = parameters(builder, entry)[0]!;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const forward = builder.createBlock([{}]);
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [one] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(right, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: forward, arguments: [one!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: forward, arguments: [two!] },
		});
		builder.setTerminator(forward, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		const phi = parameters(builder, forward)[0]!;
		builder.setTerminator(exit, { kind: "return", value: phi });
		const result = optimized({ program, function: builder.finish(entry).function });
		expect(result.fn.isValueLive(phi)).toBe(true);
		expect(() =>
			verifyCoreProgram(result.program, { stage: "pre-target" }),
		).not.toThrow();
	});

	it("threads edge-specific constants through an empty branch", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const flag = parameters(builder, entry)[0]!;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const decision = builder.createBlock([{ representation: "boolean" }]);
		const success = builder.createBlock();
		const failure = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [truthy] = builder.appendInstruction(left, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		const [falsy] = builder.appendInstruction(right, "createBoolean", [], {
			attributes: { value: false },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: decision, arguments: [truthy!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: decision, arguments: [falsy!] },
		});
		builder.setTerminator(decision, {
			kind: "branch",
			condition: parameters(builder, decision)[0]!,
			consequent: { block: success, arguments: [] },
			alternate: { block: failure, arguments: [] },
		});
		const [one] = builder.appendInstruction(success, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [zero] = builder.appendInstruction(failure, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.setTerminator(success, { kind: "return", value: one! });
		builder.setTerminator(failure, { kind: "return", value: zero! });
		const result = optimized({ program, function: builder.finish(entry).function });
		const branches = blocks(result.fn).filter(
			(block) =>
				inspectCoreTerminatorPayload(result.fn, result.fn.blockTerminator(block)).kind ===
				"branch",
		);
		expect(branches).toHaveLength(1);
	});

	it("combines long observable linear chains", () => {
		const { program, builder } = fixture();
		const entry = builder.createBlock();
		const [returned] = builder.appendInstruction(entry, "createUndefined", []);
		let current = entry;
		for (let index = 0; index < 20; index++) {
			const next = builder.createBlock();
			builder.setTerminator(current, {
				kind: "jump",
				edge: { block: next, arguments: [] },
			});
			builder.appendInstruction(next, "createObject", []);
			current = next;
		}
		builder.setTerminator(current, { kind: "return", value: returned! });
		const function_ = builder.finish(entry).function;
		const optimization = optimizeCore(
			{ program, context: programAnalysisContext() },
			{ verification: "per-pass", instrumentation: "full" },
		);
		const result = {
			program: optimization.compilation.program,
			fn: optimization.compilation.program.function(function_),
		};
		expect(blocks(result.fn)).toHaveLength(1);
		expect(
			[...result.fn.bodyInstructionIds(result.fn.entry)].filter(
				(instruction) => result.fn.instructionOpcodeName(instruction) === "createObject",
			),
		).toHaveLength(20);
		const merging = optimization.report.passes.find(
			({ pass }) => pass === "linear-block-merging",
		);
		expect(merging?.changedItems).toBeLessThanOrEqual(6);
	});

	it("rewrites dominated uses when a linear merge deletes a narrowed phi", () => {
		const { program, builder } = fixture();
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		const target = builder.createBlock([{ representation: "boolean" }]);
		const exit = builder.createBlock();
		const parameter = parameters(builder, target)[0]!;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [value!] },
		});
		builder.setTerminator(target, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: parameter });
		const result = optimized({ program, function: builder.finish(entry).function });
		expect(blocks(result.fn)).toHaveLength(1);
		expect(
			inspectCoreTerminatorPayload(result.fn, result.fn.blockTerminator(result.fn.entry)),
		).toEqual({
			kind: "return",
			value,
		});
		expect(result.fn.isValueLive(parameter)).toBe(false);
	});

	it("preserves parameter substitutions across disjoint linear pairs", () => {
		const { program, builder } = fixture();
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		const first = builder.createBlock([{ representation: "boolean" }]);
		const middle = builder.createBlock();
		const exit = builder.createBlock([{ representation: "boolean" }]);
		const firstParameter = parameters(builder, first)[0]!;
		const exitParameter = parameters(builder, exit)[0]!;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: first, arguments: [value!] },
		});
		builder.appendInstruction(first, "createObject", []);
		builder.setTerminator(first, {
			kind: "jump",
			edge: { block: middle, arguments: [] },
		});
		builder.appendInstruction(middle, "createObject", []);
		builder.setTerminator(middle, {
			kind: "jump",
			edge: { block: exit, arguments: [firstParameter] },
		});
		builder.setTerminator(exit, { kind: "return", value: exitParameter });
		const function_ = builder.finish(entry).function;
		const context = programAnalysisContext();
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const pass = CORE_LOCAL_CANONICALIZATION_PASSES.find(
			({ name }) => name === "linear-block-merging",
		)!;
		new CorePassManager(program, context, analyses, report, {
			verification: "per-pass",
		}).runStage("canonicalize", [pass]);
		verifyCoreProgram(program, { stage: "pre-target" }, context);
		const result = { program, fn: program.function(function_) };

		expect(blocks(result.fn)).toHaveLength(1);
		expect(
			inspectCoreTerminatorPayload(result.fn, result.fn.blockTerminator(result.fn.entry)),
		).toEqual({ kind: "return", value });
		expect(result.fn.isValueLive(firstParameter)).toBe(false);
		expect(result.fn.isValueLive(exitParameter)).toBe(false);
	});

	it("substitutes a linear block parameter in every call operand", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const value = parameters(builder, entry)[0]!;
		const target = builder.createBlock([{}]);
		const parameter = parameters(builder, target)[0]!;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [value] },
		});
		const [result] = builder.appendInstruction(target, "call", [parameter, parameter]);
		builder.setTerminator(target, { kind: "return", value: result! });
		const result_ = optimized({
			program,
			function: builder.finish(entry).function,
		});
		const call = [...result_.fn.bodyInstructionIds(result_.fn.entry)].find(
			(instruction) => result_.fn.instructionOpcodeName(instruction) === "call",
		)!;
		expect(blocks(result_.fn)).toHaveLength(1);
		expect(inspectCoreInstructionOperands(result_.fn, call)).toEqual([value, value]);
		expect(result_.fn.isValueLive(parameter)).toBe(false);
	});

	it("leaves no forwarding candidates at the optimizer boundary", () => {
		const result = optimized(functionWithForwardedArguments());
		const { fn } = result;
		const cfg = buildCoreControlFlow(result.program, fn.id);
		const forwarding = blocks(fn).filter((block) => {
			if (block === fn.entry || [...fn.bodyInstructionIds(block)].length !== 0)
				return false;
			const terminator = inspectCoreTerminatorPayload(fn, fn.blockTerminator(block));
			return (
				terminator.kind === "jump" &&
				(cfg.predecessors[block] ?? []).every(({ kind }) => kind === "ordinary")
			);
		});
		expect(forwarding).toEqual([]);
	});
});

describe("Core SSA and CFG cleanup", () => {
	it("removes a join parameter when every reachable edge provides one value", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const flag = parameters(builder, entry)[0]!;
		const [value] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{}]);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [value!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [value!] },
		});
		builder.setTerminator(join, {
			kind: "return",
			value: parameters(builder, join)[0]!,
		});
		const result = optimized({ program, function: builder.finish(entry).function });
		expect(blocks(result.fn)).toHaveLength(1);
		expect(
			inspectCoreTerminatorPayload(result.fn, result.fn.blockTerminator(result.fn.entry)),
		).toEqual({
			kind: "return",
			value,
		});
	});

	it("substitutes every redundant parameter in one join", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const flag = parameters(builder, entry)[0]!;
		const [first] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const [second] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 9 },
		});
		const join = builder.createBlock([{}, {}]);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: join, arguments: [first!, second!] },
			alternate: { block: join, arguments: [first!, second!] },
		});
		const [firstParameter, secondParameter] = parameters(builder, join);
		const [result] = builder.appendInstruction(join, "call", [
			firstParameter!,
			secondParameter!,
		]);
		builder.setTerminator(join, { kind: "return", value: result! });
		const optimizedResult = optimized({
			program,
			function: builder.finish(entry).function,
		});
		const call = [
			...optimizedResult.fn.bodyInstructionIds(optimizedResult.fn.entry),
		].find(
			(instruction) => optimizedResult.fn.instructionOpcodeName(instruction) === "call",
		)!;
		expect(inspectCoreInstructionOperands(optimizedResult.fn, call)).toEqual([
			first,
			second,
		]);
		expect(optimizedResult.fn.isValueLive(firstParameter!)).toBe(false);
		expect(optimizedResult.fn.isValueLive(secondParameter!)).toBe(false);
	});

	it("materializes equivalent join constants before their first use", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const condition = parameters(builder, entry)[0]!;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{}]);
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftUndefined] = builder.appendInstruction(left, "createUndefined", []);
		const [rightUndefined] = builder.appendInstruction(right, "createUndefined", []);
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftUndefined!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightUndefined!] },
		});
		const parameter = parameters(builder, join)[0]!;
		const [callResult] = builder.appendInstruction(join, "call", [parameter, parameter]);
		builder.setTerminator(join, { kind: "return", value: callResult! });
		const result = optimized({
			program,
			function: builder.finish(entry).function,
		});
		const call = [...result.fn.instructionIds()].find(
			(instruction) =>
				result.fn.instructionKind(instruction) === "operation" &&
				result.fn.instructionOpcodeName(instruction) === "call",
		)!;
		const [first, second] = inspectCoreInstructionOperands(result.fn, call);
		expect(first).toBe(second);
		expect(inspectCoreValueDefinition(result.fn, first!).kind).toBe("instruction");
		expect(result.fn.isValueLive(parameter)).toBe(false);
	});

	it("removes unused parameters and their mismatched incoming arguments", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const flag = parameters(builder, entry)[0]!;
		const [leftValue] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [rightValue] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const join = builder.createBlock([{}]);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: join, arguments: [leftValue!] },
			alternate: { block: join, arguments: [rightValue!] },
		});
		builder.setTerminator(join, { kind: "return", value: flag });
		const result = optimized({ program, function: builder.finish(entry).function });
		expect(blocks(result.fn)).toHaveLength(1);
		expect(
			inspectCoreTerminatorPayload(result.fn, result.fn.blockTerminator(result.fn.entry)),
		).toEqual({
			kind: "return",
			value: flag,
		});
		expect(result.fn.isValueLive(leftValue!)).toBe(false);
		expect(result.fn.isValueLive(rightValue!)).toBe(false);
	});

	it("drops an exceptional edge when its protected block can no longer throw", () => {
		const { program, builder } = fixture(1);
		const entry = builder.createBlock([{}]);
		const handler = builder.createBlock([{ role: "exception" }]);
		const value = parameters(builder, entry)[0]!;
		builder.appendInstruction(entry, "unary", [value], {
			attributes: { operator: "typeof" },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "return", value });
		builder.setTerminator(handler, {
			kind: "throw",
			value: parameters(builder, handler)[0]!,
		});
		const result = optimized({ program, function: builder.finish(entry).function });
		expect(blocks(result.fn)).toHaveLength(1);
		expect(inspectCoreBlockHandler(result.fn, result.fn.entry)).toBeUndefined();
	});
});

describe("Core to target boundary", () => {
	it("keeps frontend forwarding explicit until Core optimization", () => {
		const constructed = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.pick = function pick(flag) {
					if (flag) {} else {}
					return flag;
				};`,
				"forwarding-boundary.js",
			),
		);
		const owner = [...constructed.program.functionIds()]
			.map((functionId) => constructed.program.function(functionId))
			.find((fn) =>
				blocks(fn).some((block) => {
					const terminator = inspectCoreTerminatorPayload(fn, fn.blockTerminator(block));
					return (
						block !== fn.entry &&
						[...fn.bodyInstructionIds(block)].length === 0 &&
						inspectCoreBlockHandler(fn, block) === undefined &&
						terminator.kind === "jump"
					);
				}),
			)!;
		expect(owner).toBeDefined();
		const optimized = optimizeCore(constructed).compilation;
		const optimizedOwner = optimized.program.function(owner.id);
		const lowered = lowerCoreCompilationToExecution(optimized);
		expect(lowered.functions[owner.id]!.blocks.length).toBeGreaterThanOrEqual(
			blocks(optimizedOwner).length,
		);
	});
});
