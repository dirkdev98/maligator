import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/core-frontend.ts";
import {
	lowerCoreProgramToRegisters,
} from "../src/core-ir-lowering.ts";
import { coreOpcodeRegistry } from "../src/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/core-ir-opt.ts";
import { verifyCoreFunction } from "../src/core-ir-verifier.ts";
import { formatCoreFunction } from "../src/core-ir.ts";
import { lowerCoreProgramToVmDefinition } from "../src/lower-vm.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function lower(source: string) {
	return lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "core-lowering.js"),
	);
}

describe("Core IR lowering", () => {
	it("constructs explicit SSA block parameters for mutable control flow", () => {
		const converted = lower(`
			function choose(flag) {
				let value = 1;
				if (flag) value = 2;
				else value = 3;
				return value;
			}
			choose(true);
		`);
		for (const fn of converted.functions) {
			expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
		}
		const printed = converted.functions
			.map((fn) => formatCoreFunction(fn))
			.join("\n");
		expect(printed).toMatch(/b\d+\(%\d+: boxed/);
		expect(printed).toContain("branch");
	});

	it("makes exceptional control flow explicit and round-trips to VM handlers", () => {
		const converted = lower(`
			function read(object) {
				let before = 4;
				try { return object.value + before; }
				catch (error) { return before + String(error).length; }
			}
			read({ value: 2 });
		`);
		const exceptional = converted.functions.flatMap((fn) =>
			fn.blocks.filter(({ handler }) => handler !== undefined),
		);
		expect(exceptional.length).toBeGreaterThan(0);

		const lowered = lowerCoreProgramToRegisters(converted);
		const vm = lowerCoreProgramToVmDefinition(lowered);
		expect(vm.functions.some(({ handlers }) => handlers.length > 0)).toBe(true);
	});

	it("round-trips loops, calls, and multiple-result operations to VM form", () => {
		const converted = lower(`
			let total = 0;
			for (const value of [1, 2, 3]) total += value;
			console.log(total);
		`);
		const lowered = lowerCoreProgramToRegisters(converted);
		const vm = lowerCoreProgramToVmDefinition(lowered);
		expect(vm.functions.length).toBeGreaterThan(0);
		expect(
			vm.functions.flatMap(({ instructions }) => instructions).length,
		).toBeGreaterThan(10);
	});

	it("models captured private-name batches as result-free writes", () => {
		const converted = lower(`
			function make() {
				return class { #value; read() { return this.#value; } };
			}
			make();
		`);
		const batches = converted.functions.flatMap((fn) =>
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

	it("represents call operands as explicit SSA producers", () => {
		const converted = lowerSemanticProgramToCore(
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
		const call = converted.functions
			.flatMap((fn) => fn.blocks)
			.flatMap((block) => block.instructions)
			.find((instruction) => instruction.opcode === "call" && instruction.inputs.length > 2);

		expect(call?.inputs).toHaveLength(7);
		expect(call?.attributes).not.toHaveProperty("immediateValues");
		const opcodes = converted.functions.flatMap((fn) =>
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

	it("lowers Core switches with strict-equality case selection", () => {
		const converted = lower(`
			function pick(value) {
				if (value) return 1;
				return 2;
			}
			pick(true);
		`);
		const functionIndex = converted.functions.findIndex((fn) =>
			fn.blocks.some(({ terminator }) => terminator.kind === "branch"),
		);
		const fn = converted.functions[functionIndex]!;
		const blockIndex = fn.blocks.findIndex(
			({ terminator }) => terminator.kind === "branch",
		);
		const block = fn.blocks[blockIndex]!;
		if (block.terminator.kind !== "branch") throw new Error("missing branch fixture");
		const switchBlock = {
			...block,
			terminator: {
				id: block.terminator.id,
				kind: "switch" as const,
				discriminant: block.terminator.condition,
				cases: [
					{ value: { kind: "boolean" as const, value: true }, edge: block.terminator.consequent },
				],
				default: block.terminator.alternate,
			},
		};
		const switched = {
			...converted,
			functions: converted.functions.map((candidate, index) =>
				index === functionIndex
					? {
							...candidate,
							blocks: candidate.blocks.map((candidateBlock, index) =>
								index === blockIndex ? switchBlock : candidateBlock,
							),
						}
					: candidate,
			),
		};

		const lowered = lowerCoreProgramToRegisters(switched);
		const instructions = lowered.functions[functionIndex]!.blocks.flatMap(
			({ instructions }) => instructions,
		);
		expect(instructions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "createBoolean", value: true }),
				expect.objectContaining({ type: "binary", operator: "===" }),
			]),
		);
	});

	it("lowers explicit super current-this through the VM two-address constraint", () => {
		const converted = lower(`
			class Parent {}
			class Child extends Parent {
				constructor() {
					super();
					this.repeat = () => super();
				}
			}
			new Child();
		`);
		const lowered = lowerCoreProgramToRegisters(
			executeCoreOptimizations(converted).program,
		);
		const instructions = lowered.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) => block.instructions),
		);
		const constructIndex = instructions.findIndex(
			(instruction) => instruction.type === "constructSuperExplicit",
		);
		const construct = instructions[constructIndex]!;
		if (construct.type !== "constructSuperExplicit") {
			throw new Error("missing explicit super construction");
		}

		expect(construct.registers[0]).toBe(construct.registers[4]);
		const move = instructions[constructIndex - 1]!;
		expect(move.type).toBe("move");
		if (move.type !== "move") throw new Error("missing target-constraint move");
		expect(move.registers[0]).toBe(construct.registers[0]);
	});
});
