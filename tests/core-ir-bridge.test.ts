import { describe, expect, it } from "vitest";
import {
	coreProgramToIntermediate,
	intermediateProgramToCore,
} from "../src/core-ir-bridge.ts";
import { coreOpcodeRegistry } from "../src/core-ir-opcodes.ts";
import { verifyCoreFunction } from "../src/core-ir-verifier.ts";
import { formatCoreFunction } from "../src/core-ir.ts";
import { executeIRDevelopmentOptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { allocateDevelopmentRegisters } from "../src/register-alloc.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function bridge(source: string) {
	const program = compileSemanticProgramToIr(
		analyzeSourceAndRunSemanticAnalysis(source, "core-bridge.js"),
	);
	executeIRDevelopmentOptimizations(program);
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
		for (const { core } of converted.functions) {
			expect(() => verifyCoreFunction(core, coreOpcodeRegistry)).not.toThrow();
		}
		const printed = converted.functions
			.map(({ core }) => formatCoreFunction(core))
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
		const exceptional = converted.functions.flatMap(({ core }) =>
			core.blocks.filter(({ handler }) => handler !== undefined),
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
});
