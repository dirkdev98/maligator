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
