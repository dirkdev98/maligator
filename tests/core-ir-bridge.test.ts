import { describe, expect, it } from "vitest";
import {
	coreProgramToIntermediate,
	intermediateProgramToCore,
} from "../src/core-ir-bridge.ts";
import { coreOpcodeRegistry } from "../src/core-ir-opcodes.ts";
import { verifyCoreFunction } from "../src/core-ir-verifier.ts";
import { formatCoreFunction } from "../src/core-ir.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { allocateDevelopmentRegisters } from "../src/register-alloc.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function bridge(source: string) {
	const program = compileSemanticProgramToIr(
		analyzeSourceAndRunSemanticAnalysis(source, "core-bridge.js"),
	);
	return intermediateProgramToCore(program);
}

describe("Core IR semantic bridge", () => {
	it("constructs explicit SSA block parameters for mutable control flow", () => {
		const converted = bridge(`
			function choose(flag) {
				let value = 1;
				if (flag) value = 2;
				else value = 3;
				return value;
			}
			choose(true);
		`);
		for (const fn of converted.core.functions) {
			expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
		}
		const printed = converted.core.functions
			.map((fn) => formatCoreFunction(fn))
			.join("\n");
		expect(printed).toMatch(/b\d+\(%\d+: boxed/);
		expect(printed).toContain("branch");
	});

	it("makes exceptional control flow explicit and round-trips to VM handlers", () => {
		const converted = bridge(`
			function read(object) {
				let before = 4;
				try { return object.value + before; }
				catch (error) { return before + String(error).length; }
			}
			read({ value: 2 });
		`);
		const exceptional = converted.core.functions.flatMap((fn) =>
			fn.blocks.filter(({ handler }) => handler !== undefined),
		);
		expect(exceptional.length).toBeGreaterThan(0);

		const lowered = coreProgramToIntermediate(converted);
		allocateDevelopmentRegisters(lowered);
		const vm = lowerIrProgramToVmDefinition(lowered);
		expect(vm.functions.some(({ handlers }) => handlers.length > 0)).toBe(true);
	});

	it("round-trips loops, calls, and multiple-result operations to VM form", () => {
		const converted = bridge(`
			let total = 0;
			for (const value of [1, 2, 3]) total += value;
			console.log(total);
		`);
		const lowered = coreProgramToIntermediate(converted);
		allocateDevelopmentRegisters(lowered);
		const vm = lowerIrProgramToVmDefinition(lowered);
		expect(vm.functions.length).toBeGreaterThan(0);
		expect(
			vm.functions.flatMap(({ instructions }) => instructions).length,
		).toBeGreaterThan(10);
	});

	it("models captured private-name batches as result-free writes", () => {
		const converted = bridge(`
			function make() {
				return class { #value; read() { return this.#value; } };
			}
			make();
		`);
		const batches = converted.core.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) =>
				block.instructions.filter(({ opcode }) => opcode === "createPrivateNames"),
			),
		);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.outputs).toEqual([]);
		expect(coreOpcodeRegistry.require("createPrivateNames").effects.writes).toContain(
			"captured-slot",
		);
	});

	it("expands optimized call immediates into explicit SSA producers", () => {
		const program = compileSemanticProgramToIr(
			analyzeSourceAndRunSemanticAnalysis(
				`
				function invoke(fn) {
					return fn(undefined, null, false, 42, "value");
				}
				globalThis.invoke = invoke;
				`,
				"core-immediates.js",
			),
		);
		executeIROptimizations(program);
		const converted = intermediateProgramToCore(program);
		const call = converted.core.functions
			.flatMap((fn) => fn.blocks)
			.flatMap((block) => block.instructions)
			.find((instruction) => instruction.opcode === "call" && instruction.inputs.length > 2);

		expect(call?.inputs).toHaveLength(7);
		expect(call?.payload).not.toMatchObject({
			fields: { immediateValues: expect.anything() },
		});
		const opcodes = converted.core.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) => block.instructions.map(({ opcode }) => opcode)),
		);
		expect(opcodes).toEqual(
			expect.arrayContaining([
				"createUndefined",
				"createNull",
				"createBoolean",
				"createNumber",
				"createString",
			]),
		);
	});
});
