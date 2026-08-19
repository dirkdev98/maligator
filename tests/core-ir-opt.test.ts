import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { coreOpcodeRegistry } from "../src/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/core-ir-opt.ts";
import { verifyCoreFunction } from "../src/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/core-ir.ts";
import type { CoreFunction, CoreProgram } from "../src/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function programWithConstants(): CoreProgram {
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
	return coreProgram([core]);
}

function coreProgram(functions: ReadonlyArray<CoreFunction>): CoreProgram {
	return {
		functions,
		stringConstants: [],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 0,
	};
}

describe("Core IR optimizer", () => {
	it("eliminates copies, locally numbers values, and removes dead producers", () => {
		const result = executeCoreOptimizations(programWithConstants());
		const fn = result.program.functions[0]!;
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

	it("folds primitive control and removes unreachable blocks", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const dead = builder.createBlock();
		const body = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			payload: { fields: { value: true } },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: dead, arguments: [] },
		});
		const [deadValue] = builder.appendInstruction(dead, "createNumber", [], {
			payload: { fields: { value: 1 } },
		});
		builder.setTerminator(dead, { kind: "return", value: deadValue! });
		const [result] = builder.appendInstruction(body, "createNumber", [], {
			payload: { fields: { value: 2 } },
		});
		builder.setTerminator(body, { kind: "return", value: result! });
		const original = builder.finish(entry);
		const program = coreProgram([{ ...original, bodyEntry: body }]);

		const fn = executeCoreOptimizations(program).program.functions[0]!;
		expect(fn.blocks).toHaveLength(2);
		expect(fn.bodyEntry).toBe(1);
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "jump",
			edge: { block: 1 },
		});
		expect(fn.blocks[0]!.instructions).toHaveLength(0);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("folds a primitive switch with JavaScript strict equality", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const one = builder.createBlock();
		const two = builder.createBlock();
		const fallback = builder.createBlock();
		const [discriminant] = builder.appendInstruction(entry, "createNumber", [], {
			payload: { fields: { value: 2 } },
		});
		builder.setTerminator(entry, {
			kind: "switch",
			discriminant: discriminant!,
			cases: [
				{ value: { kind: "number", value: 1 }, edge: { block: one, arguments: [] } },
				{ value: { kind: "number", value: 2 }, edge: { block: two, arguments: [] } },
			],
			default: { block: fallback, arguments: [] },
		});
		for (const [block, value] of [
			[one, 1],
			[two, 2],
			[fallback, 3],
		] as const) {
			const [result] = builder.appendInstruction(block, "createNumber", [], {
				payload: { fields: { value } },
			});
			builder.setTerminator(block, { kind: "return", value: result! });
		}

		const fn = executeCoreOptimizations(
			coreProgram([builder.finish(entry)]),
		).program.functions[0]!;
		expect(fn.blocks).toHaveLength(2);
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "jump",
			edge: { block: 1 },
		});
		expect(fn.blocks[1]!.instructions[0]).toMatchObject({
			opcode: "createNumber",
			payload: { fields: { value: 2 } },
		});
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});
});
