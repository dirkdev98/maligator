import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreLocalOptimizer } from "../src/compiler/core/core-local-optimizer.ts";
import type { CoreLocalInstructionRule } from "../src/compiler/core/core-local-optimizer.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
} from "./helpers/core-inspection.ts";

function moveChainProgram(): CoreProgram {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const [source] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 42 },
	});
	const [first] = builder.appendInstruction(entry, "move", [source!]);
	const [second] = builder.appendInstruction(entry, "move", [first!]);
	builder.setTerminator(entry, { kind: "return", value: second! });
	builder.finish(entry);
	return program;
}

describe("CoreLocalOptimizer", () => {
	it("propagates rewrite chains and removes newly dead producers in one edit session", () => {
		const program = moveChainProgram();
		const fn = program.function(0 as never);
		const initialInstructions = fn.instructionCapacity;
		const initialBodyVersion = fn.versions.body;
		const result = new CoreLocalOptimizer(program, fn.id).run();
		const operations = [...fn.bodyInstructionIds(fn.entry)];

		expect(
			operations.map((instruction) => fn.instructionOpcodeName(instruction)),
		).toEqual(["createNumber"]);
		const terminator = inspectCoreTerminatorPayload(fn, fn.blockTerminator(fn.entry));
		expect(terminator).toMatchObject({ kind: "return" });
		if (terminator.kind !== "return") throw new Error("Expected return terminator");
		expect(terminator.value).toBe(
			fn.kernel.resultAt(fn.kernel.instructionResultStart(operations[0]!)),
		);
		expect(result.statistics).toMatchObject({
			editSessions: 1,
			rulesApplied: 2,
			workBudgetExhausted: false,
			editBudgetExhausted: false,
		});
		expect(result.changes?.edits).toBeGreaterThanOrEqual(4);
		expect(fn.versions.body).toBe(initialBodyVersion + 1);
		expect(result.statistics.instructionQueuePops).toBeLessThanOrEqual(
			initialInstructions + 6 * result.statistics.edits,
		);
	});

	it("does not enqueue work for an unrelated opcode rule", () => {
		const baseline = new CoreLocalOptimizer(moveChainProgram(), 0 as never).run();
		const unrelated: CoreLocalInstructionRule = {
			name: "unrelated-call-rule",
			opcodes: [coreOpcodeRegistry.require("call").id],
			run() {
				throw new Error("Unrelated rule must not run");
			},
		};
		const withRule = new CoreLocalOptimizer(moveChainProgram(), 0 as never, {
			additionalRules: [unrelated],
		}).run();

		expect(withRule.statistics.instructionQueuePushes).toBe(
			baseline.statistics.instructionQueuePushes,
		);
		expect(withRule.statistics.instructionQueuePops).toBe(
			baseline.statistics.instructionQueuePops,
		);
	});

	it("retains values referenced only by exception-handler arguments", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const handler = builder.createBlock([
			{ role: "exception", representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [handlerOnly] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 42 },
		});
		const [returned] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setHandler(entry, handler, [handlerOnly!]);
		builder.setTerminator(entry, { kind: "return", value: returned! });
		builder.setTerminator(handler, {
			kind: "return",
			value: inspectCoreBlockParameters(builder, handler)[1]!.value,
		});
		const fn = program.function(builder.finish(entry).function);
		const definition = [...fn.bodyInstructionIds(entry)].find(
			(instruction) => fn.instructionOpcodeName(instruction) === "createNumber",
		)!;

		new CoreLocalOptimizer(program, fn.id).run();

		expect(fn.isInstructionLive(definition)).toBe(true);
	});

	it("folds a dirty block and immediately removes its dead condition producer", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const taken = builder.createBlock();
		const skipped = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: taken, arguments: [] },
			alternate: { block: skipped, arguments: [] },
		});
		const [one] = builder.appendInstruction(taken, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [zero] = builder.appendInstruction(skipped, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.setTerminator(taken, { kind: "return", value: one! });
		builder.setTerminator(skipped, { kind: "return", value: zero! });
		const fn = program.function(builder.finish(entry).function);
		const conditionInstruction = [...fn.bodyInstructionIds(entry)][0]!;

		const result = new CoreLocalOptimizer(program, fn.id).run();

		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
			kind: "jump",
			edge: { block: taken, arguments: [] },
		});
		expect(fn.isInstructionLive(conditionInstruction)).toBe(false);
		expect(result.statistics.blockQueuePops).toBe(3);
		expect(result.statistics.editSessions).toBe(1);
	});

	it("eliminates equivalent local expressions before their consumer is drained", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "f64" }]);
		const input = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [first] = builder.appendInstruction(entry, "mathUnaryNumber", [input], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		const [second] = builder.appendInstruction(entry, "mathUnaryNumber", [input], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		const [combined] = builder.appendInstruction(
			entry,
			"mathBinaryNumber",
			[first!, second!],
			{
				attributes: { operation: "Math.max" },
				outputRepresentations: ["f64"],
			},
		);
		builder.setTerminator(entry, { kind: "return", value: combined! });
		const fn = program.function(builder.finish(entry).function);
		const instructions = [...fn.bodyInstructionIds(entry)];

		const optimized = new CoreLocalOptimizer(program, fn.id).run();

		expect(fn.isInstructionLive(instructions[1]!)).toBe(false);
		const comparisonOperands = Array.from(
			{ length: fn.kernel.instructionOperandCount(instructions[2]!) },
			(_, index) =>
				fn.kernel.operandAt(
					fn.kernel.instructionOperandStart(instructions[2]!) + index,
				),
		);
		expect(comparisonOperands).toEqual([first, first]);
		expect(optimized.statistics.editSessions).toBe(1);
		expect(optimized.statistics.rulesApplied).toBeGreaterThanOrEqual(1);
	});

	it("folds a constant producer-consumer chain before folding its branch", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const taken = builder.createBlock();
		const skipped = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [sum] = builder.appendInstruction(entry, "binary", [one!, two!], {
			attributes: { operator: "+" },
		});
		const [three] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 3 },
		});
		const [condition] = builder.appendInstruction(entry, "binary", [sum!, three!], {
			attributes: { operator: "===" },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: taken, arguments: [] },
			alternate: { block: skipped, arguments: [] },
		});
		const [answer] = builder.appendInstruction(taken, "createNumber", [], {
			attributes: { value: 42 },
		});
		const [fallback] = builder.appendInstruction(skipped, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.setTerminator(taken, { kind: "return", value: answer! });
		builder.setTerminator(skipped, { kind: "return", value: fallback! });
		const fn = program.function(builder.finish(entry).function);

		const result = new CoreLocalOptimizer(program, fn.id).run();

		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
			kind: "jump",
			edge: { block: taken, arguments: [] },
		});
		expect([...fn.bodyInstructionIds(entry)]).toEqual([]);
		expect(result.statistics.editSessions).toBe(1);
		expect(result.statistics.rulesApplied).toBeGreaterThanOrEqual(7);
	});

	it("reports work-budget exhaustion without opening another edit session", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [result] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		builder.finish(entry);

		const optimized = new CoreLocalOptimizer(program, 0 as never, {
			maxWorkItems: 1,
		}).run();

		expect(optimized.statistics).toMatchObject({
			instructionQueuePops: 1,
			editSessions: 1,
			workBudgetExhausted: true,
		});
	});

	it("fails a required optimizer when its work budget is exhausted", () => {
		expect(() =>
			new CoreLocalOptimizer(moveChainProgram(), 0 as never, {
				maxWorkItems: 1,
				budgetExhaustion: "error",
			}).run(),
		).toThrow("Required Core local optimizer exhausted its budget");
	});
});
