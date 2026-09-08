import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { coreMaterializationPlan } from "../src/compiler/core/core-materialization-demands.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";

describe("materialization contracts", () => {
	it("propagates a nested child's escape to its containing graph", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[120]] });
		const builder = new CoreFunctionBuilder(program);
		const block = builder.createBlock();
		const [child] = builder.appendInstruction(block, "createObject", []);
		const [parent] = builder.appendInstruction(block, "createObjectShaped", [child!], {
			attributes: { keyStringIndices: [0] },
		});
		builder.appendInstruction(block, "callKnown", [parent!], {
			attributes: { operation: "Object.prototype.hasOwnProperty" },
		});
		builder.setTerminator(block, { kind: "return", value: child! });
		const fn = program.function(builder.finish(block).function);
		const plan = coreMaterializationPlan(fn, parent!, {
			graphAllocations: new Set(
				[child!, parent!].map((value) =>
					coreInstructionId(fn.kernel.valueDefinitionOwner(value)),
				),
			),
		});
		expect(plan.choice).toBe("fresh");
		expect(plan.demands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					value: child,
					kind: "identity",
					reason: "returned-value",
				}),
			]),
		);
	});
	it.each([
		["Array.prototype.includes", "private-read-only", "content"],
		["Array.prototype.push", "fresh", "mutation"],
		["Array.prototype.map", "fresh", "identity"],
	] as const)("classifies %s receiver observation", (operation, choice, kind) => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const block = builder.createBlock();
		const [array] = builder.appendInstruction(block, "createArray", []);
		const [alias] = builder.appendInstruction(block, "move", [array!]);
		const [result] = builder.appendInstruction(block, "callKnown", [alias!], {
			attributes: { operation },
		});
		builder.setTerminator(block, { kind: "return", value: result! });
		const fn = program.function(builder.finish(block).function);
		const plan = coreMaterializationPlan(fn, array!, { shallow: true });
		expect(plan.choice).toBe(choice);
		expect(plan.demands.map((demand) => demand.kind)).toEqual(["alias", kind]);
	});

	it("propagates escaped aliases back to their dynamic allocation", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const block = builder.createBlock();
		const [first] = builder.appendInstruction(block, "createObject", []);
		const [second] = builder.appendInstruction(block, "createObject", []);
		const [alias] = builder.appendInstruction(block, "move", [first!]);
		builder.appendInstruction(block, "storeGlobal", [alias!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(block, { kind: "return", value: alias! });
		const fn = program.function(builder.finish(block).function);
		const escaping = coreMaterializationPlan(fn, first!);
		const dead = coreMaterializationPlan(fn, second!);
		expect(escaping.choice).toBe("fresh");
		expect(escaping.demands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "identity", reason: "returned-value" }),
				expect.objectContaining({
					kind: "identity",
					reason: "identity-or-storage-exposure",
				}),
			]),
		);
		expect(dead.choice).toBe("virtual");
		expect(dead.identity).not.toEqual(escaping.identity);
	});

	it("shares immutable recipe words without assigning fresh instances a cache identity", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const block = builder.createBlock();
		const [value] = builder.appendInstruction(block, "createUndefined", []);
		builder.setTerminator(block, { kind: "return", value: value! });
		const fn = program.function(builder.finish(block).function);
		const editor = CoreEditor.open(program, fn.id);
		const first = editor.appendLiteralTemplate([8, 1, 3, 42], false);
		const second = editor.appendLiteralTemplate([8, 1, 3, 42], false);
		const pooled = editor.appendLiteralTemplate([8, 1, 3, 42], true);
		const samePool = editor.appendLiteralTemplate([8, 1, 3, 42], true);
		editor.commit();
		expect(first.templateOffset).toBe(second.templateOffset);
		expect(first.cacheSlot).toBeUndefined();
		expect(second.cacheSlot).toBeUndefined();
		expect(pooled.templateOffset).toBe(first.templateOffset);
		expect(pooled.cacheSlot).toBeDefined();
		expect(samePool.cacheSlot).toBe(pooled.cacheSlot);
		expect(program.literalTemplateData).toEqual([8, 1, 3, 42]);
	});
});
