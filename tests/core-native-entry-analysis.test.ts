import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreBlockId } from "../src/compiler/core/core-ir.ts";
import { analyzeCoreNativeEntry } from "../src/compiler/core/core-native-entry-analysis.ts";
import { coreReadOnlyNumericParameterFields } from "../src/compiler/core/core-native-field-analysis.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";

describe("reachable native-entry annotations", () => {
	it("retains arithmetic and fixed-arity proofs in reachable handlers but omits disconnected blocks", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception", representation: "boxed" }]);
		const dead = builder.createBlock();
		builder.appendInstruction(entry, "loadGlobalProperty", [], {
			attributes: { stringIndex: 0 },
		});
		builder.setHandler(entry, handler);
		const comparison = (block: CoreBlockId) => {
			const [count] = builder.appendInstruction(block, "loadArgumentCount", []);
			const [zero] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 0 },
			});
			const [result] = builder.appendInstruction(block, "binary", [count!, zero!], {
				attributes: { operator: ">" },
			});
			const instruction = builder.bodyInstructionIds(block).at(-1)!;
			builder.setTerminator(block, { kind: "return", value: result! });
			return instruction;
		};
		const liveComparison = comparison(entry);
		const handlerComparison = comparison(handler);
		comparison(dead);
		const id = builder.finish(entry).function;
		const cfg = buildCoreControlFlow(program, id, { exceptions: true });
		expect(cfg.reachable.has(handler)).toBe(true);
		expect(cfg.reachable.has(dead)).toBe(false);
		const result = analyzeCoreNativeEntry(program.function(id), cfg, [], ["f64"], []);
		const expected = new Set([liveComparison, handlerComparison]);
		expect(new Set(result.operatorInputs?.map(({ instruction }) => instruction))).toEqual(
			expected,
		);
		expect(
			new Set(result.constantBooleans?.map(({ instruction }) => instruction)),
		).toEqual(expected);
		expect(
			result.operatorInputs?.every(({ masks }) =>
				masks.every((mask) => mask === COMPILER_VALUE_KIND_NUMBER),
			),
		).toBe(true);
		expect(result.constantBooleans?.every(({ value }) => value)).toBe(true);
	});

	it("does not require fields read only by omitted code", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[], [108, 105, 118, 101], [100, 101, 97, 100]],
		});
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const dead = builder.createBlock();
		const parameter = builder.blockParameterValue(entry, 0);
		const load = (block: CoreBlockId, stringIndex: number) => {
			const [value] = builder.appendInstruction(
				block,
				"loadPropertyStatic",
				[parameter],
				{
					attributes: { stringIndex },
				},
			);
			const instruction = builder.bodyInstructionIds(block).at(-1)!;
			builder.setTerminator(block, { kind: "return", value: value! });
			return instruction;
		};
		const liveLoad = load(entry, 1);
		load(dead, 2);
		const id = builder.finish(entry).function;
		const fields = coreReadOnlyNumericParameterFields(
			program.function(id),
			buildCoreControlFlow(program, id, { exceptions: true }),
		);
		expect(fields).toEqual({ keys: [1], loads: [{ instruction: liveLoad, field: 0 }] });
	});
});
