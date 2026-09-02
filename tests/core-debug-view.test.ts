import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	coreBlockHandler,
	coreBlockLayout,
	coreBlockParameters,
	coreFunctionParameters,
	coreInstructionLayout,
	coreInstructionOperands,
	coreInstructionResults,
	coreTerminatorPayload,
	coreUseLayout,
	coreUses,
	coreValueDefinition,
	coreValueLayout,
} from "../src/compiler/core/core-debug-view.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";

describe("Core debug view", () => {
	it("builds immutable snapshots without making them authoritative", () => {
		const registry = new CoreOpcodeRegistry();
		registry.define({
			opcode: "identity",
			inputs: coreArity(1),
			outputs: coreArity(1),
			effects: CORE_NO_EFFECTS,
			discardable: true,
		});
		const program = new CoreProgram(registry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [result] = builder.appendInstruction(entry, "identity", [parameter]);
		const handler = builder.createBlock([
			{ representation: "boxed", role: "exception" },
			{ representation: "boxed" },
		]);
		const handlerValue = inspectCoreBlockParameters(builder, handler)[1]!.value;
		builder.setHandler(entry, handler, [result!]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		builder.setTerminator(handler, { kind: "return", value: handlerValue });
		const fn = program.function(builder.finish(entry).function);
		const operation = [...fn.bodyInstructionIds(entry)][0]!;
		const terminator = fn.blockTerminator(entry);

		const parameters = coreFunctionParameters(fn);
		const blockParameters = coreBlockParameters(fn, handler);
		const handlerSnapshot = coreBlockHandler(fn, entry)!;
		const operands = coreInstructionOperands(fn, operation);
		const results = coreInstructionResults(fn, operation);
		const payload = coreTerminatorPayload(fn, terminator);
		const uses = coreUses(fn, result!);

		expect(parameters).toEqual([parameter]);
		expect(blockParameters).toEqual([
			{
				value: fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(handler)),
				representation: "boxed",
				role: "exception",
			},
			{ value: handlerValue, representation: "boxed", role: "value" },
		]);
		expect(handlerSnapshot).toEqual({ block: handler, arguments: [result] });
		expect(operands).toEqual([parameter]);
		expect(results).toEqual([result]);
		expect(payload).toEqual({ kind: "return", value: result });
		expect(coreValueDefinition(fn, result!)).toEqual({
			kind: "instruction",
			instruction: operation,
			index: 0,
		});
		expect(uses).toEqual([{ instruction: terminator, operand: 0 }]);
		expect(coreBlockLayout(fn, entry).live).toBe(true);
		expect(coreInstructionLayout(fn, operation).operandCount).toBe(1);
		expect(coreValueLayout(fn, result!).useCount).toBe(1);
		expect(coreUseLayout(fn, fn.kernel.valueFirstUse(result!)).live).toBe(true);

		for (const snapshot of [
			parameters,
			blockParameters,
			handlerSnapshot,
			handlerSnapshot.arguments,
			operands,
			results,
			payload,
			uses,
		]) {
			expect(Object.isFrozen(snapshot)).toBe(true);
		}
		expect(Object.isFrozen(blockParameters[0])).toBe(true);
		expect(Object.isFrozen(uses[0])).toBe(true);
	});
});
