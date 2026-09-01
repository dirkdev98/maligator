import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
	CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreCanonicalValueRoots } from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreLocalExceptionFlows } from "../src/compiler/core/core-ir-exception-flow.ts";
import { analyzeCoreLoopInductions } from "../src/compiler/core/core-ir-loops.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "control-flow-passes.js",
		moduleEvaluationOrder: ["control-flow-passes.js"],
		sourceFiles: [{ path: "control-flow-passes.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

function definingInstruction(fn: CoreFunctionStore, value: CoreValueId) {
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction") throw new Error("expected instruction value");
	return definition.instruction;
}

describe("Core control-flow analyses and passes", () => {
	it("classifies a multi-entry cycle without inventing a natural loop", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const exit = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.setTerminator(left, { kind: "jump", edge: { block: right, arguments: [] } });
		builder.setTerminator(right, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: condition });
		const finished = builder.finish(entry);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.loops).toEqual([]);
		expect(cfg.irreducibleCycles).toHaveLength(1);
		expect([...cfg.irreducibleCycles[0]!.entries]).toEqual([left, right]);
	});

	it("models only actually throwing handler edges and proves local throw flow", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception" }]);
		const [thrown] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "throw", value: thrown! });
		builder.setTerminator(handler, {
			kind: "return",
			value: builder.blockParameters(handler)[0]!.value,
		});
		const finished = builder.finish(entry);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.successors[entry]).toMatchObject([
			{ from: entry, to: handler, kind: "exceptional", arguments: [] },
		]);
		expect(
			analyzeCoreLocalExceptionFlows(program.function(finished.function), cfg),
		).toMatchObject([{ source: entry, handler, thrownValue: thrown }]);
	});

	it("does not reuse a protected-block value after an exceptional join", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([{ role: "exception" }]);
		const join = builder.createBlock();
		const callee = builder.blockParameters(entry)[0]!.value;
		builder.appendInstruction(entry, "call", [callee, callee]);
		const [protectedValue] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		const [joinedValue] = builder.appendInstruction(join, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(join, { kind: "return", value: joinedValue! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(fn.isValueLive(protectedValue!)).toBe(false);
		expect(fn.isValueLive(joinedValue!)).toBe(true);
	});

	it("recognizes canonical induction ranges and loop nesting metadata", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const header = builder.createBlock([{ representation: "f64" }]);
		const latch = builder.createBlock([{ representation: "f64" }]);
		const exit = builder.createBlock();
		const [zero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		});
		const [ten] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 10 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [zero!] },
		});
		const counter = builder.blockParameters(header)[0]!.value;
		const [condition] = builder.appendInstruction(header, "binary", [counter, ten!], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: latch, arguments: [counter] },
			alternate: { block: exit, arguments: [] },
		});
		const latchCounter = builder.blockParameters(latch)[0]!.value;
		const [next] = builder.appendInstruction(latch, "unary", [latchCounter], {
			attributes: { operator: "increment" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(latch, {
			kind: "jump",
			edge: { block: header, arguments: [next!] },
		});
		builder.setTerminator(exit, { kind: "return", value: counter });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const cfg = buildCoreControlFlow(program, finished.function);
		expect(cfg.loops).toMatchObject([
			{ header, preheader: entry, depth: 1, canonical: true },
		]);
		const loops = analyzeCoreLoopInductions(fn, cfg, coreCanonicalValueRoots(fn, cfg));
		expect(loops.induction(counter)).toMatchObject({
			step: 1,
			range: { first: 0, last: 9, finalUpdate: 10 },
		});
	});

	it("derives exact ranges only for safe additive block-argument inductions", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const build = (initial: number, representation: "f64" | "i32") => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const header = builder.createBlock([{ representation }]);
			const body = builder.createBlock();
			const exit = builder.createBlock([{ representation }]);
			const [seed] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: initial },
				outputRepresentations: [representation],
			});
			const [bound] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: 10 },
				outputRepresentations: [representation],
			});
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: header, arguments: [seed!] },
			});
			const counter = builder.blockParameters(header)[0]!.value;
			const [condition] = builder.appendInstruction(header, "binary", [counter, bound!], {
				attributes: { operator: "<" },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(header, {
				kind: "branch",
				condition: condition!,
				consequent: { block: body, arguments: [] },
				alternate: { block: exit, arguments: [counter] },
			});
			const [next] = builder.appendInstruction(body, "unary", [counter], {
				attributes: { operator: "increment" },
				outputRepresentations: [representation],
			});
			builder.setTerminator(body, {
				kind: "jump",
				edge: { block: header, arguments: [next!] },
			});
			builder.setTerminator(exit, {
				kind: "return",
				value: builder.blockParameters(exit)[0]!.value,
			});
			return { function: builder.finish(entry).function, counter };
		};
		const negativeZero = build(-0, "f64");
		const negativeZeroFunction = program.function(negativeZero.function);
		const negativeZeroCfg = buildCoreControlFlow(program, negativeZero.function);
		expect(
			analyzeCoreLoopInductions(
				negativeZeroFunction,
				negativeZeroCfg,
				coreCanonicalValueRoots(negativeZeroFunction, negativeZeroCfg),
			).induction(negativeZero.counter)?.range,
		).toBeUndefined();
		const int32 = build(0, "i32");
		const int32Function = program.function(int32.function);
		const int32Cfg = buildCoreControlFlow(program, int32.function);
		expect(
			analyzeCoreLoopInductions(
				int32Function,
				int32Cfg,
				coreCanonicalValueRoots(int32Function, int32Cfg),
			).induction(int32.counter),
		).toMatchObject({
			representation: "i32",
			range: { minimum: 0, maximum: 9, finalUpdate: 10 },
		});
	});

	it("applies only representation-proven numeric identities", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const build = (
			operator: string,
			constantValue: number | undefined,
			options: { readonly self?: boolean; readonly constantLeft?: boolean } = {},
		) => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{ representation: "boolean" }]);
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock([{ representation: "f64" }]);
			const condition = builder.blockParameters(entry)[0]!.value;
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			const [leftValue] = builder.appendInstruction(left, "createF64", [], {
				attributes: { value: -2 },
				outputRepresentations: ["f64"],
			});
			const [rightValue] = builder.appendInstruction(right, "createF64", [], {
				attributes: { value: 3 },
				outputRepresentations: ["f64"],
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [leftValue!] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [rightValue!] },
			});
			const dynamic = builder.blockParameters(join)[0]!.value;
			const constant =
				constantValue === undefined
					? dynamic
					: builder.appendInstruction(join, "createF64", [], {
							attributes: { value: constantValue },
							outputRepresentations: ["f64"],
						})[0]!;
			const comparison = ["<", "<=", ">", ">="].includes(operator);
			const inputs = options.self
				? [dynamic, dynamic]
				: options.constantLeft
					? [constant, dynamic]
					: [dynamic, constant];
			const [result] = builder.appendInstruction(join, "binary", inputs, {
				attributes: { operator },
				outputRepresentations: [comparison ? "boolean" : "f64"],
			});
			builder.setTerminator(join, { kind: "return", value: result! });
			return builder.finish(entry).function;
		};
		const functions = [
			build("+", -0),
			build("+", 0),
			build("*", 1),
			build("&", 0),
			build("<", undefined, { self: true }),
			build("<", 5, { constantLeft: true }),
		];
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const binaries = (index: number) => {
			const fn = optimized.function(functions[index]!);
			return [...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "binary",
			);
		};
		expect(binaries(0)).toHaveLength(0);
		expect(binaries(1)).toHaveLength(1);
		expect(binaries(2)).toHaveLength(0);
		expect(binaries(3)).toHaveLength(0);
		expect(binaries(4)).toHaveLength(0);
		expect(binaries(5)).toHaveLength(1);
		expect(
			optimized.function(functions[5]!).instructionAttributes(binaries(5)[0]!).operator,
		).toBe(">");
	});

	it("reselects an exact numeric join after algebraic simplification", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftValue] = builder.appendInstruction(left, "createF64", [], {
			attributes: { value: -2 },
			outputRepresentations: ["f64"],
		});
		const [rightValue] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 3 },
			outputRepresentations: ["f64"],
		});
		const [leftBoxed] = builder.appendInstruction(left, "move", [leftValue!], {
			outputRepresentations: ["boxed"],
		});
		const [rightBoxed] = builder.appendInstruction(right, "move", [rightValue!], {
			outputRepresentations: ["boxed"],
		});
		const joined = builder.appendBlockParameter(join);
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftBoxed!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightBoxed!] },
		});
		const [negativeZero] = builder.appendInstruction(join, "createF64", [], {
			attributes: { value: -0 },
			outputRepresentations: ["f64"],
		});
		const [sum] = builder.appendInstruction(join, "binary", [joined, negativeZero!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(join, { kind: "return", value: sum! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(fn.valueRepresentation(joined)).toBe("i32");
		expect(
			[...fn.instructionIds()].some(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "binary" &&
					fn.instructionAttributes(instruction).operator === "+",
			),
		).toBe(false);
	});

	it("hoists pure loop invariants while retaining observable identity creation", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [constant] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [sine] = builder.appendInstruction(body, "mathUnaryNumber", [constant!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [sine!], {
			attributes: { index: 0 },
		});
		const [object] = builder.appendInstruction(body, "createObject", []);
		builder.appendInstruction(body, "storeGlobal", [object!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: condition });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(fn.instructionBlock(definingInstruction(fn, constant!))).toBe(entry);
		expect(fn.instructionBlock(definingInstruction(fn, sine!))).toBe(entry);
		expect(fn.instructionBlock(definingInstruction(fn, object!))).toBe(body);
	});

	it("canonicalizes multiple latches and shared exits", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boolean" },
			{ representation: "boolean" },
			{ representation: "boolean" },
		]);
		const [path, iterate, latchCondition] = builder
			.blockParameters(entry)
			.map(({ value }) => value);
		const bypass = builder.createBlock();
		const header = builder.createBlock();
		const body = builder.createBlock();
		const leftLatch = builder.createBlock();
		const rightLatch = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: path!,
			consequent: { block: header, arguments: [] },
			alternate: { block: bypass, arguments: [] },
		});
		builder.setTerminator(bypass, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: iterate!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(body, {
			kind: "branch",
			condition: latchCondition!,
			consequent: { block: leftLatch, arguments: [] },
			alternate: { block: rightLatch, arguments: [] },
		});
		for (const latch of [leftLatch, rightLatch]) {
			builder.setTerminator(latch, {
				kind: "jump",
				edge: { block: header, arguments: [] },
			});
		}
		builder.setTerminator(exit, { kind: "return", value: path! });
		const function_ = builder.finish(entry).function;
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const cfg = buildCoreControlFlow(optimized, function_);
		expect(cfg.loops).toHaveLength(1);
		expect(cfg.loops[0]).toMatchObject({ canonical: true });
		expect(cfg.loops[0]!.preheader).toBeDefined();
		expect(cfg.loops[0]!.latches.size).toBe(1);
		expect(cfg.loops[0]!.exits.every(({ dedicated }) => dedicated)).toBe(true);
	});

	it("hoists only exact load partitions unchanged by the loop", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [changing] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 0 },
			outputRepresentations: ["f64"],
		});
		const [stable] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 1 },
			outputRepresentations: ["f64"],
		});
		const [result] = builder.appendInstruction(
			header,
			"mathBinaryNumber",
			[changing!, stable!],
			{ attributes: { operation: "Math.max" }, outputRepresentations: ["f64"] },
		);
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.appendInstruction(body, "storeGlobal", [changing!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: result! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(fn.instructionBlock(definingInstruction(fn, changing!))).toBe(header);
		expect(fn.instructionBlock(definingInstruction(fn, stable!))).toBe(entry);
	});

	it("hoists the stable length of a contained array", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			globalCount: 1,
			stringConstants: [[..."length"].map((unit) => unit.codePointAt(0)!)],
		});
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		const [array] = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 3 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [length] = builder.appendInstruction(header, "loadPropertyStatic", [array!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.appendInstruction(body, "storeGlobal", [length!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: length! });
		const function_ = builder.finish(entry).function;
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const fn = optimized.function(function_);
		expect(fn.instructionBlock(definingInstruction(fn, length!))).toBe(entry);
		const loop = buildCoreControlFlow(optimized, function_).loops[0];
		expect(loop).toBeDefined();
		expect(loop!.blocks.has(entry)).toBe(false);
	});

	it("eliminates partial redundancy on non-speculative merge edges", () => {
		const registry = new CoreOpcodeRegistry();
		registry.define({
			opcode: "purePair",
			inputs: coreArity(2),
			outputs: coreArity(1),
			effects: CORE_NO_EFFECTS,
			discardable: true,
		});
		registry.define({
			opcode: "keep",
			inputs: coreArity(1),
			outputs: coreArity(0),
			effects: CORE_NO_EFFECTS,
			discardable: false,
		});
		const program = new CoreProgram(registry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boolean" },
		]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const [first, second, condition] = builder
			.blockParameters(entry)
			.map(({ value }) => value);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [available] = builder.appendInstruction(left, "purePair", [first!, second!]);
		builder.appendInstruction(left, "keep", [available!]);
		builder.setTerminator(left, { kind: "jump", edge: { block: merge, arguments: [] } });
		builder.appendInstruction(right, "keep", [first!]);
		builder.setTerminator(right, { kind: "jump", edge: { block: merge, arguments: [] } });
		const [redundant] = builder.appendInstruction(merge, "purePair", [first!, second!]);
		builder.setTerminator(merge, { kind: "return", value: redundant! });
		const finished = builder.finish(entry);
		const optimized = optimizeCore({ program, context });
		const fn = optimized.compilation.program.function(finished.function);
		expect(fn.blockParameters(merge)).toHaveLength(1);
		expect([...fn.bodyInstructionIds(merge)]).toEqual([]);
		expect(
			optimized.report.passes.find(
				({ pass }) => pass === "partial-redundancy-elimination",
			),
		).toMatchObject({ changedItems: 1 });
	});

	it("removes a merge expression already available on every incoming path", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		const [operand] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		for (const branch of [left, right]) {
			const [available] = builder.appendInstruction(
				branch,
				"mathUnaryNumber",
				[operand!],
				{
					attributes: { operation: "Math.sin" },
					outputRepresentations: ["f64"],
				},
			);
			builder.appendInstruction(branch, "storeGlobal", [available!], {
				attributes: { index: 0 },
			});
			builder.setTerminator(branch, {
				kind: "jump",
				edge: { block: merge, arguments: [] },
			});
		}
		const [redundant] = builder.appendInstruction(merge, "mathUnaryNumber", [operand!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(merge, { kind: "return", value: redundant! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "mathUnaryNumber",
			),
		).toHaveLength(2);
	});

	it("does not resurrect a dead predecessor expression for PRE", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const merge = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		const [operand] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.appendInstruction(left, "mathUnaryNumber", [operand!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: merge, arguments: [] },
		});
		builder.appendInstruction(right, "storeGlobal", [condition], {
			attributes: { index: 0 },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: merge, arguments: [] },
		});
		const [result] = builder.appendInstruction(merge, "mathUnaryNumber", [operand!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(merge, { kind: "return", value: result! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "mathUnaryNumber",
			),
		).toHaveLength(1);
	});

	it("numbers pure values through the dominator tree", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [input, condition] = builder.blockParameters(entry).map(({ value }) => value);
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const [numeric] = builder.appendInstruction(entry, "move", [input!], {
			outputRepresentations: ["f64"],
		});
		const [dominating] = builder.appendInstruction(entry, "mathUnaryNumber", [numeric!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(entry, "storeGlobal", [dominating!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [redundant] = builder.appendInstruction(body, "mathUnaryNumber", [numeric!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(body, { kind: "return", value: redundant! });
		builder.setTerminator(exit, { kind: "return", value: dominating! });
		const function_ = builder.finish(entry).function;

		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		const numbered = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "mathUnaryNumber",
		);
		expect(numbered).toHaveLength(1);
		const result = fn.instructionResults(numbered[0]!)[0];
		expect(result).toBeDefined();
		for (const block of fn.blockIds()) {
			const terminator = fn.terminatorPayload(fn.blockTerminator(block));
			if (terminator.kind === "return") expect(terminator.value).toBe(result);
		}
	});

	it("hoists invariants after canonicalizing multiple latches", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [continueLoop, chooseLatch] = builder
			.blockParameters(entry)
			.map(({ value }) => value);
		const header = builder.createBlock();
		const body = builder.createBlock();
		const leftLatch = builder.createBlock();
		const rightLatch = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: continueLoop!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [constant] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [sine] = builder.appendInstruction(body, "mathUnaryNumber", [constant!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [sine!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "branch",
			condition: chooseLatch!,
			consequent: { block: leftLatch, arguments: [] },
			alternate: { block: rightLatch, arguments: [] },
		});
		for (const latch of [leftLatch, rightLatch]) {
			builder.setTerminator(latch, {
				kind: "jump",
				edge: { block: header, arguments: [] },
			});
		}
		builder.setTerminator(exit, { kind: "return", value: continueLoop! });
		const function_ = builder.finish(entry).function;
		const before = buildCoreControlFlow(program, function_);
		expect(before.loops[0]!.latches).toEqual(new Set([leftLatch, rightLatch]));

		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const fn = optimized.function(function_);
		const cfg = buildCoreControlFlow(optimized, function_);
		expect(cfg.loops).toHaveLength(1);
		expect(cfg.loops[0]).toMatchObject({ canonical: true });
		expect(cfg.loops[0]!.latches.size).toBe(1);
		expect(cfg.loops[0]!.preheader).toBeDefined();
		const hoisted = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				["createF64", "mathUnaryNumber"].includes(fn.instructionOpcodeName(instruction)),
		);
		expect(hoisted).toHaveLength(2);
		for (const instruction of hoisted) {
			expect(fn.instructionBlock(instruction)).toBe(cfg.loops[0]!.preheader);
		}
	});

	it("reuses the real CFG analysis across operand-only rewrites", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.blockParameters(entry)[0]!.value;
		const [copy] = builder.appendInstruction(entry, "move", [parameter]);
		const target = builder.createBlock([{ representation: "boxed" }]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [copy!] },
		});
		builder.setTerminator(target, {
			kind: "return",
			value: builder.blockParameters(target)[0]!.value,
		});
		const finished = builder.finish(entry);
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const first = analyses.get(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS, {
			scope: "function",
			function: finished.function,
		});
		expect(
			analyses.get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, {
				scope: "function",
				function: finished.function,
			}),
		).toBe(first);
		const definition = program.function(finished.function).valueDefinition(copy!);
		if (definition.kind !== "instruction") throw new Error("Expected move result");
		const editor = CoreEditor.open(program, finished.function);
		editor.replaceValueUses(copy!, parameter);
		editor.removeInstruction(definition.instruction);
		const changes = editor.commit();
		expect(changes.domains).not.toContain("cfg");
		const second = analyses.get(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS, {
			scope: "function",
			function: finished.function,
		});
		expect(second).toBe(first);
		expect(second.successors[entry]![0]!.arguments).toEqual([parameter]);
		expect(second.predecessors[target]![0]!.arguments).toEqual([parameter]);
		const result = report.finish(program, { directEntries: [], specializations: [] });
		expect(result.analyses).toMatchObject([
			{ analysis: "exception-control-flow", queries: 3, hits: 2, recomputations: 1 },
		]);
	});
});
