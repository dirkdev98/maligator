import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreLocalOptimizer } from "../src/compiler/core/core-local-optimizer.ts";
import type { CoreLocalInstructionRule } from "../src/compiler/core/core-local-optimizer.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { builtinWorldAssumptions } from "../src/compiler/shared/builtin-assumptions.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
} from "./helpers/core-inspection.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

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
	it("folds a changed branch from incremental edits", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const input = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const taken = builder.createBlock(),
			skipped = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "unary", [input], {
			attributes: { operator: "!" },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: taken, arguments: [] },
			alternate: { block: skipped, arguments: [] },
		});
		builder.setTerminator(taken, { kind: "return", value: input });
		builder.setTerminator(skipped, { kind: "return", value: condition! });
		const fn = program.function(builder.finish(entry).function);
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceInstruction(
			coreInstructionId(fn.kernel.valueDefinitionOwner(condition!)),
			"createBoolean",
			[],
			{ attributes: { value: true } },
		);
		const changes = editor.commit();
		new CoreLocalOptimizer(program, fn.id).run([changes]);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
			kind: "jump",
			edge: { block: taken, arguments: [] },
		});
	});

	it.each([true, false])(
		"eliminates the conditional empty-spread source with locked=%s",
		(locked) => {
			const inspected = inspectStaticValueFunction(
				`function probe(value, sink) {
					const previous = undefined;
					const record = {value, ...(previous === undefined ? {} : {previous})};
					sink(record);
					return record.value;
				} globalThis.probe = probe;`,
				"probe",
				{ locked },
			);
			expect(
				inspected.core.some((operation) => operation.opcode === "mergeDataProperties"),
			).toBe(false);
			expect(inspected.structure.allocations).toBe(1);
			expect(inspected.structure.genericCalls).toBe(1);
		},
	);

	it.each(["createObject", "createObjectShaped"] as const)(
		"eliminates a sole merge from an empty %s source",
		(sourceOpcode) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [destination] = builder.appendInstruction(entry, "createObject", []);
			const [source] = builder.appendInstruction(entry, sourceOpcode, [], {
				attributes: sourceOpcode === "createObjectShaped" ? { keyStringIndices: [] } : {},
			});
			builder.appendInstruction(entry, "mergeDataProperties", [destination!, source!]);
			builder.setTerminator(entry, { kind: "return", value: destination! });
			const fn = program.function(builder.finish(entry).function);

			new CoreLocalOptimizer(program, fn.id).run();

			expect(
				[...fn.bodyInstructionIds(entry)].map((instruction) =>
					fn.instructionOpcodeName(instruction),
				),
			).toEqual(["createObject"]);
		},
	);

	it("retains an empty source shared by multiple merges", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [left] = builder.appendInstruction(entry, "createObject", []);
		const [right] = builder.appendInstruction(entry, "createObject", []);
		const [source] = builder.appendInstruction(entry, "createObject", []);
		builder.appendInstruction(entry, "mergeDataProperties", [left!, source!]);
		builder.appendInstruction(entry, "mergeDataProperties", [right!, source!]);
		builder.setTerminator(entry, { kind: "return", value: left! });
		const fn = program.function(builder.finish(entry).function);

		new CoreLocalOptimizer(program, fn.id).run();

		expect(
			[...fn.bodyInstructionIds(entry)].filter(
				(instruction) => fn.instructionOpcodeName(instruction) === "mergeDataProperties",
			),
		).toHaveLength(2);
	});

	it.each(["!", "typeof", "+", "-", "~"])(
		"removes only noncoercing dead %s operators while retaining their producer",
		(operator) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const callback = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
			const [value] = builder.appendInstruction(entry, "call", [callback, receiver!]);
			builder.appendInstruction(entry, "unary", [value!], { attributes: { operator } });
			builder.setTerminator(entry, { kind: "return", value: receiver! });
			const fn = program.function(builder.finish(entry).function);
			new CoreLocalOptimizer(program, fn.id).run();
			const opcodes = [...fn.bodyInstructionIds(entry)].map((instruction) =>
				fn.instructionOpcodeName(instruction),
			);
			expect(opcodes.filter((opcode) => opcode === "call")).toHaveLength(1);
			expect(opcodes.filter((opcode) => opcode === "unary")).toHaveLength(
				operator === "!" || operator === "typeof" ? 0 : 1,
			);
		},
	);

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

	it("seeds queues from live IDs rather than tombstoned capacity", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [source] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 42 },
		});
		for (let index = 0; index < 2_000; index++) {
			builder.appendInstruction(entry, "move", [source!]);
		}
		builder.setTerminator(entry, { kind: "return", value: source! });
		const fn = program.function(builder.finish(entry).function);
		const removed = [...fn.bodyInstructionIds(entry)].filter(
			(instruction) => fn.instructionOpcodeName(instruction) === "move",
		);
		const editor = CoreEditor.open(program, fn.id);
		for (const instruction of removed) editor.removeInstruction(instruction);
		editor.commit();
		const liveInstructions = [...fn.instructionIds()].length;
		expect(fn.instructionCapacity).toBeGreaterThan(liveInstructions * 100);

		const result = new CoreLocalOptimizer(program, fn.id).run();

		expect(result.statistics.instructionQueuePushes).toBe(1);
		expect(result.statistics.blockQueuePushes).toBe([...fn.blockIds()].length);
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
			attributes: {
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
				metadata: { left: 1, right: 2 },
			},
			outputRepresentations: ["f64"],
		});
		const [second] = builder.appendInstruction(entry, "mathUnaryNumber", [input], {
			attributes: {
				metadata: { right: 2, left: 1 },
				operation: "Math.sin",
				worldAssumptions: {
					...builtinWorldAssumptions("Math.sin", "exact-builtin-proof"),
				},
			},
			outputRepresentations: ["f64"],
		});
		const [combined] = builder.appendInstruction(
			entry,
			"mathBinaryNumber",
			[first!, second!],
			{
				attributes: {
					operation: "Math.max",
					worldAssumptions: {
						...builtinWorldAssumptions("Math.max", "exact-builtin-proof"),
					},
				},
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
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(instructions[2]!) + index),
		);
		expect(comparisonOperands).toEqual([first, first]);
		expect(optimized.statistics.editSessions).toBe(1);
		expect(optimized.statistics.rulesApplied).toBeGreaterThanOrEqual(1);
	});

	it("keeps local value numbers separate across representations", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const merge = builder.createBlock([{ representation: "boxed" }]);
		const [represented] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: false },
			outputRepresentations: ["boolean"],
		});
		builder.appendInstruction(entry, "rootUse", [represented!]);
		const [boxed] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: false },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: merge, arguments: [boxed!] },
		});
		const parameter = inspectCoreBlockParameters(builder, merge)[0]!.value;
		builder.setTerminator(merge, { kind: "return", value: parameter });
		const fn = program.function(builder.finish(entry).function);

		new CoreLocalOptimizer(program, fn.id).run();

		const terminator = inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry));
		expect(terminator).toMatchObject({ kind: "jump" });
		if (terminator.kind !== "jump") throw new Error("Expected jump terminator");
		expect(fn.valueRepresentation(terminator.edge.arguments[0]!)).toBe("boxed");
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

	it("removes represented ToNumeric without requesting value-kind analysis", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "f64" }]);
		const input = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [coerced] = builder.appendInstruction(entry, "unary", [input], {
			attributes: { operator: "tonumeric" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, { kind: "return", value: coerced! });
		const fn = program.function(builder.finish(entry).function);
		const coercion = [...fn.bodyInstructionIds(entry)][0]!;

		new CoreLocalOptimizer(program, fn.id).run();

		expect(fn.isInstructionLive(coercion)).toBe(false);
		expect(inspectCoreTerminatorPayload(fn, fn.blockTerminator(entry))).toEqual({
			kind: "return",
			value: input,
		});
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
