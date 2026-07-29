import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { emitBatch, emitVmDefinition } from "../src/emit-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "../src/lower-vm.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

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
	{
		opcode: "INIT_GLOBAL_VARS",
		nameStringIndices: [0, 2, 3],
		declarationConfigurable: true,
	},
	{ opcode: "CREATE_PRIVATE_NAMES", ownerFunctionIndex: 0, capturedIndices: [1, 4] },
	{ opcode: "INIT_PRIVATE_FIELDS", object: 6, keyRegisters: [8, 9] },
	{ opcode: "TYPEOF_COMPARE", dst: 7, src: 6, expected: "number", negated: true },
	{ opcode: "RETURN", value: 6 },
];

const fn: VmFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 0,
	registerCount: 12,
	capturedCount: 5,
	strict: true,
	needsArguments: false,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
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
	it("emits complete data-property descriptor attributes", () => {
		const descriptorDefinition = {
			...definition,
			functions: [
				{
					...fn,
					instructions: [
						{
							opcode: "DEFINE_PROPERTY" as const,
							object: 1,
							key: 2,
							value: 3,
							enumerable: true,
							writable: false,
							configurable: false,
						},
					],
				},
			],
		};
		expect(emitVmDefinition(descriptorDefinition, { compiled: false })).toContain(
			".as.define_property = { .object = 1, .key = 2, .value = 3, .enumerable = true, .writable = false, .configurable = false }",
		);
	});

	it("emits one flattened side table and raw f64 words", () => {
		const output = emitVmDefinition(definition, { compiled: false });
		expect(output).toContain(
			"static const i32 mal_function_0_instruction_data[] = { 2, 1, 2, 3, 4, 2, 1, 2, 5, 6, 2, 1, -1, 2, 3, 2, 7, 8, 1, 9, 2, 10, 11, 3, 0, 2, 3, 2, 1, 4, 2, 8, 9 };",
		);
		for (const offset of [0, 5, 10, 15, 18, 20, 23, 27, 30]) {
			expect(output).toContain(`.data_offset = ${offset}`);
		}
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x80000000u");
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x7ff00000u");
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x7ff80000u");
		expect(output).toContain(".instruction_data = mal_function_0_instruction_data");
		expect(output).toContain(".instruction_data_count = 33");
		expect(output).toContain(".argument_snapshot_count = 0");
		expect(output).toContain(".argument_snapshot_plan_count = 0");
		expect(output).toContain(".argument_snapshot_plan = nullptr");
		expect(output).toContain(
			".as.init_global_vars = { .data_offset = 23, .declaration_configurable = true }",
		);
		expect(output).toContain(
			".as.create_private_names = { .owner_function_index = 0, .data_offset = 27 }",
		);
		expect(output).toContain(
			".as.init_private_fields = { .object = 6, .data_offset = 30 }",
		);
		expect(output).toContain(
			".as.typeof_compare = { .dst = 7, .src = 6, .expected = MAL_TYPEOF_NUMBER, .negated = true }",
		);
	});

	it("emits terminal yields for interpreted and compiled generators", () => {
		const terminal = {
			...definition,
			functions: [
				{
					...fn,
					isGenerator: true,
					instructions: [
						{ opcode: "GENERATOR_START" },
						{ opcode: "TERMINAL_YIELD", yieldedSrc: 6 },
					] as Array<VmInstruction>,
				},
			],
		};
		expect(emitVmDefinition(terminal, { compiled: false })).toContain(
			".opcode = MAL_OP_TERMINAL_YIELD, .as.terminal_yield = { .yielded_src = 6 }",
		);
		expect(emitVmDefinition(terminal)).toContain("mal_vm_op_terminal_yield_compiled");
	});

	it("emits and references shared side tables in batches", () => {
		const output = emitBatch([definition, definition], { compiled: false });
		expect(output).toContain("static const i32 mal_shared_insn_data_");
		expect(output.match(/\.instruction_data = mal_shared_insn_data_/g)).toHaveLength(2);
	});

	it("emits native bulk-private helper calls", () => {
		const output = emitVmDefinition(definition);
		expect(output).toContain("mal_vm_op_create_private_names(vm, env, 0, 2");
		expect(output).toContain("mal_vm_op_init_private_fields(vm, r6, 2");
		expect(output).toContain("mal_vm_typeof_compare(r6, MAL_TYPEOF_NUMBER)");
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

	it("aliases an asset to existing linked immutable bytes", () => {
		const output = emitVmDefinition(definition, {
			compiled: false,
			assets: [
				{
					name: "compilerWire",
					type: "file",
					hash: "hash",
					version: "1",
					files: [
						{
							path: "compiler.malw",
							sourcePath: "/unused/compiler.malw",
							size: 825_000,
							digest: "digest",
							embeddedSymbol: "mal_compiler_wire_data",
						},
					],
				},
			],
		});
		expect(output).toContain("extern const u8 mal_compiler_wire_data[];");
		expect(output).toContain(".data = mal_compiler_wire_data, .length = 825000");
		expect(output).not.toContain('#embed "/unused/compiler.malw"');
	});
});

describe("native update-expression representation", () => {
	function emit(source: string): string {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"update-expression-representation.js",
			parseScript(source, { strict: false }),
		);
		return emitVmDefinition(compileSemanticProgramToVmDefinition(semantic), {
			compiled: true,
		});
	}

	it("keeps proven numeric loop updates on dense array paths", () => {
		const output = emit(
			`"use strict"; function sum(array) { let total = 0; for (let i = 0; i < array.length; i++) total += array[i]; return total; } globalThis.sum = sum;`,
		);
		expect(output).toContain("mal_vm_array_try_load");
		expect(output).toContain("+ 1.0;");
		expect(output).not.toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).not.toContain("MAL_UNARY_INCREMENT");
	});

	it("retains the boxed coercion path for unproven Number or BigInt operands", () => {
		const output = emit(
			`"use strict"; function increment(value) { return value++; } globalThis.increment = increment;`,
		);
		expect(output).toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).toContain("MAL_UNARY_INCREMENT");
		expect(output).toContain("+ 1.0;");
	});

	it("guards numeric property-key parameters before using dense array access", () => {
		const output = emit(
			`"use strict"; function load(array, index) { return array[index]; } globalThis.load = load;`,
		);
		expect(output).toContain("MalValue p1 = arg_count > 1 ? args[1]");
		expect(output).toContain("if (!mal_ops_is_number(p1))");
		expect(output).toContain("return mal_compiled_1_boxed");
		expect(output).toContain("mal_vm_array_try_load");
	});

	it("guards numeric property-key stores before dense array access", () => {
		const output = emit(
			`"use strict"; function store(array, index, value) { array[index] = value; } globalThis.store = store;`,
		);
		expect(output).toContain("MalValue p1 = arg_count > 1 ? args[1]");
		expect(output).toContain("if (!mal_ops_is_number(p1))");
		expect(output).toContain("mal_vm_array_try_store");
	});

	it("retains boxed recursive re-entry for promoted numeric parameters", () => {
		const output = emit(
			`"use strict"; function recurse(value, depth, callback) { if (depth === 0) return value * value; return callback(value - 1, depth - 1, callback); } globalThis.recurse = recurse;`,
		);
		expect(output).toContain("static MalValue mal_compiled_1_boxed(");
		expect(output).toContain("return mal_compiled_1_boxed");
		expect(output).toContain("!mal_ops_is_number(p0)");
		expect(output).toContain("!mal_ops_is_number(p1)");
	});

	it("keeps one-use numeric arithmetic intermediates unboxed", () => {
		const output = emit(
			`"use strict"; function sum(object) { return object.a + object.b + object.c; } globalThis.sum = sum;`,
		);
		expect(output).toContain("bool __nf_");
		expect(output).toContain("f64 __nf_");
		expect(output).toContain("mal_ops_number_as_f64");
		expect(output).toMatch(
			/mal_ops_number_value\(__nf_\d+_value \+ mal_ops_number_as_f64/,
		);
	});

	it("omits consolidated key guards only for static property sites", () => {
		const staticOutput = emit(
			`"use strict"; function read(object) { object.a = object.a + 1; return object.a + object.b; } globalThis.read = read;`,
		);
		expect(staticOutput).toContain("mal_perf_ic_load_region_hit");
		expect(staticOutput).toContain("mal_perf_ic_store_region_hit");
		expect(staticOutput).not.toMatch(/&& .* == __rg\d+_key\[/);

		const dynamicOutput = emit(
			`"use strict"; function read(object, key) { return object.a + object[key]; } globalThis.read = read;`,
		);
		expect(dynamicOutput).toMatch(/&& .* == __rg\d+_key\[/);
	});

	it("guards direct unary and binary Math calls by exact callbacks", () => {
		const output = emit(
			`"use strict"; function calculate(a, b) { return Math.round(a) + Math.max(a, b); } globalThis.calculate = calculate;`,
		);
		expect(output).toContain("mal_builtin_math_unary_fast");
		expect(output).toContain("mal_builtin_math_binary_fast");
	});

	it("publishes positions at observable seams and guards residual TDZ helpers", () => {
		const output = emit(
			`"use strict"; globalThis.read = function read() { return value; }; let value = 1;`,
		);
		expect(output).toContain("vm->native_frames[vm->native_frame_count - 1].pos_id");
		expect(output).not.toContain("__current_pos_id");
		expect(output).toContain("if (mal_value_is_empty(");
		expect(output).toContain("mal_vm_op_throw_if_tdz");
	});
});
