import { describe, expect, it } from "vitest";
import { emitBatch, emitVmDefinition } from "../src/emit-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "../src/lower-vm.ts";

const instructions: Array<VmInstruction> = [
	{ opcode: "CREATE_F64", dst: 0, value: -0 },
	{ opcode: "CREATE_F64", dst: 0, value: Number.POSITIVE_INFINITY },
	{ opcode: "CREATE_F64", dst: 0, value: Number.NaN },
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 1,
		count: 2,
		keyStringIndices: [1, 2],
		valueRegisters: [3, 4],
	},
	{ opcode: "CREATE_MODULE_NAMESPACE", dst: 2, nameIndices: [1, 2], slots: [5, 6] },
	{
		opcode: "CREATE_TEMPLATE_OBJECT",
		dst: 3,
		cacheSlot: 1,
		cookedIndices: [1, -1],
		rawIndices: [2, 3],
	},
	{
		opcode: "CALL",
		dst: 4,
		callee: 5,
		thisValue: 6,
		argumentCount: 2,
		arguments: [7, 8],
	},
	{ opcode: "CONSTRUCT", dst: 5, callee: 6, argumentCount: 1, arguments: [9] },
	{
		opcode: "COPY_DATA_PROPERTIES",
		dst: 6,
		src: 7,
		excludedCount: 2,
		excluded: [10, 11],
	},
	{ opcode: "RETURN", value: 6 },
];

const fn: VmFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	length: 0,
	registerCount: 12,
	capturedCount: 0,
	strict: true,
	needsArguments: false,
	isDerivedConstructor: false,
	isClassConstructor: false,
	hasPrototype: false,
	instructions,
	handlers: [],
	fileIndex: 0,
	positions: [],
};

const definition: VmDefinition = {
	functionCount: 1,
	functions: [fn],
	stringConstants: [[], ["a".charCodeAt(0)], ["b".charCodeAt(0)], ["c".charCodeAt(0)]],
	bigintConstants: [],
	literalTemplateData: [],
	globalCount: 7,
	files: [],
	sourcePositions: [],
	cjsModuleFunctionIndices: [],
	hostInstalls: [],
};

describe("emit-vm instruction packing", () => {
	it("emits one flattened side table and raw f64 words", () => {
		const output = emitVmDefinition(definition, { compiled: false });
		expect(output).toContain(
			"static const i32 mal_function_0_instruction_data[] = { 2, 1, 2, 3, 4, 2, 1, 2, 5, 6, 2, 1, -1, 2, 3, 2, 7, 8, 1, 9, 2, 10, 11 };",
		);
		for (const offset of [0, 5, 10, 15, 18, 20]) {
			expect(output).toContain(`.data_offset = ${offset}`);
		}
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x80000000u");
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x7ff00000u");
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x7ff80000u");
		expect(output).toContain(".instruction_data = mal_function_0_instruction_data");
		expect(output).toContain(".instruction_data_count = 23");
	});

	it("emits and references shared side tables in batches", () => {
		const output = emitBatch([definition, definition], { compiled: false });
		expect(output).toContain("static const i32 mal_shared_insn_data_");
		expect(output.match(/\.instruction_data = mal_shared_insn_data_/g)).toHaveLength(2);
	});

	it("uses a null side table when a function has no variable operands", () => {
		const simple = {
			...definition,
			functions: [{ ...fn, instructions: [{ opcode: "RETURN", value: 0 } as const] }],
		};
		expect(emitVmDefinition(simple, { compiled: false })).toContain(
			".instruction_data_count = 0,\n        .instruction_data = nullptr",
		);
	});
});
