import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import type { CoreProgramBridge } from "../src/core-ir-bridge.ts";
import { coreOpcodeRegistry } from "../src/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/core-ir-opt.ts";
import { verifyCoreFunction } from "../src/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function programWithConstants(): CoreProgramBridge {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [first] = builder.appendInstruction(entry, "createNumber", [], {
		payload: { value: 1 },
	});
	const [duplicate] = builder.appendInstruction(entry, "createNumber", [], {
		payload: { value: 1 },
	});
	const [unused] = builder.appendInstruction(entry, "createNumber", [], {
		payload: { value: 2 },
	});
	const [moved] = builder.appendInstruction(entry, "move", [duplicate!]);
	void first;
	void unused;
	builder.setTerminator(entry, { kind: "return", value: moved! });
	const core = builder.finish(entry);
	return {
		source: {} as CoreProgramBridge["source"],
		functions: [
			{
				core,
				legacy: {} as CoreProgramBridge["functions"][number]["legacy"],
				instructionOrigins: new Map(),
				legacyRegisters: new Map(),
				legacyBlockByCoreBlock: new Map(),
			},
		],
	};
}

describe("Core IR optimizer", () => {
	it("eliminates copies, locally numbers values, and removes dead producers", () => {
		const result = executeCoreOptimizations(programWithConstants());
		const fn = result.program.functions[0]!.core;
		expect(result.changed).toBe(true);
		expect(fn.blocks[0]!.instructions).toHaveLength(1);
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "createNumber",
			payload: { value: 1 },
		});
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: fn.blocks[0]!.instructions[0]!.outputs[0],
		});
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
		expect(result.passes.some(({ changed }) => changed)).toBe(true);
	});

	it("folds exact string property keys on the development Core path", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"function read(object) { object.answer = 1; return object.answer; }",
			"core-static-property.js",
		);
		let opcodes: Array<string> = [];
		compileSemanticProgramToVmDefinition(semantic, {
			optimization: "development",
			afterOptimization(program) {
				opcodes = program.functions.flatMap((fn) =>
					fn.blocks.flatMap((block) => block.instructions.map(({ type }) => type)),
				);
			},
		});

		expect(opcodes).toContain("storePropertyStatic");
		expect(opcodes).toContain("loadPropertyStatic");
	});
});
