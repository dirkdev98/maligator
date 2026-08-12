import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { emitCompiledFunction } from "../src/emit-c.ts";
import { emitBatch, emitVmDefinition, emitVmTranslationUnits } from "../src/emit-vm.ts";
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
		shapeCacheIndex: 0,
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
	entrypointPath: "/fixture/entry.mjs",
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

	it("splits compiled functions into bounded external translation units", () => {
		const functions = Array.from({ length: 12 }, (_, index) => ({
			...fn,
			isAsync: index === 1,
			instructions: [...fn.instructions],
		}));
		const splitDefinition = {
			...definition,
			functionCount: functions.length,
			functions,
		};
		const budget = 20_000;
		const units = emitVmTranslationUnits(splitDefinition, {}, budget);

		expect(units.length).toBeGreaterThan(2);
		expect(units.every((unit) => unit.length <= budget)).toBe(true);
		expect(units[0]).toContain("#define MAL_DECLARE_COMPILED(name)");
		expect(units[0]).toContain("MAL_DECLARE_COMPILED(mal_compiled_0);");
		expect(units[0]).not.toContain(
			"MalValue mal_compiled_0(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state) {",
		);
		expect(units.slice(1).join("\n")).toContain(
			"MalValue mal_compiled_0(MalVm *vm, MalValue this_value",
		);
		const metadataUnit = units.find((unit) =>
			unit.includes("const MalFunction mal_functions[]"),
		);
		expect(metadataUnit).toContain("MAL_DECLARE_COMPILED(mal_compiled_0);");
		expect(units.slice(1).join("\n")).not.toContain(
			"static MalValue mal_compiled_0(MalVm *vm",
		);
		expect(units[0]).toContain("MAL_DECLARE_COMPILED(mal_compiled_1);");
		expect(units.slice(1).join("\n")).toContain("MalValue mal_compiled_1(MalVm *vm");
		expect(units.slice(1).join("\n")).not.toContain(
			"static MalValue mal_compiled_1(MalVm *vm",
		);
	});

	it("charges split units only for declarations they reference", () => {
		const functions = Array.from({ length: 100 }, () => ({
			...fn,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 } as const,
				{ opcode: "RETURN", value: 0 } as const,
			],
		}));
		const stringConstants = Array.from({ length: 300 }, (_, index) =>
			[...String(index).padEnd(40, "x")].map((character) => character.charCodeAt(0)),
		);
		const budget = 100_000;
		const units = emitVmTranslationUnits(
			{
				...definition,
				functionCount: functions.length,
				functions,
				stringConstants,
			},
			{},
			budget,
		);
		const metadataUnits = units.filter(
			(unit) =>
				unit.includes("const MalFunction mal_functions[] =") ||
				unit.includes("void mal_initialize_mal_functions_chunk_"),
		);

		expect(units.every((unit) => unit.length <= budget)).toBe(true);
		expect(metadataUnits.length).toBeGreaterThan(0);
		expect(
			metadataUnits.some(
				(unit) => !unit.includes("extern const c16 mal_string_0_code_units[];"),
			),
		).toBe(true);
	});

	it("gives split async functions external linkage", () => {
		const asyncFunction: VmFunction = {
			...fn,
			isAsync: true,
			registerCount: 1,
			instructions: [
				{ opcode: "ASYNC_START" },
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{ opcode: "RETURN", value: 0 },
			],
		};
		const units = emitVmTranslationUnits(
			{ ...definition, functions: [asyncFunction] },
			{},
			Number.MAX_SAFE_INTEGER,
		);
		expect(units.slice(1).join("\n")).toContain("MalValue mal_compiled_0(MalVm *vm");
		expect(units.slice(1).join("\n")).not.toContain(
			"static MalValue mal_compiled_0(MalVm *vm",
		);
	});

	it("splits bytecode and debug leaf arrays into bounded translation units", () => {
		const functions = Array.from({ length: 20 }, () => ({
			...fn,
			instructions: [...fn.instructions],
			positions: instructions.map((_, index) => index),
		}));
		const splitDefinition = {
			...definition,
			functionCount: functions.length,
			functions,
			sourcePositions: instructions.map((_, index) => ({
				line: index + 1,
				column: index,
			})),
		};
		const budget = 30_000;
		const units = emitVmTranslationUnits(splitDefinition, { compiled: false }, budget);
		const data = units.slice(1).join("\n");

		expect(units.length).toBeGreaterThan(2);
		expect(units.every((unit) => unit.length <= budget)).toBe(true);
		expect(units[0]).toContain(
			"extern const MalInstruction mal_function_0_instructions[];",
		);
		expect(units[0]).not.toContain(
			"static const MalInstruction mal_function_0_instructions[] = {",
		);
		expect(data).toContain("const MalInstruction mal_function_0_instructions[] = {");
		expect(data).not.toContain(
			"static const MalInstruction mal_function_0_instructions[] = {",
		);
		expect(units[0]).toContain("extern const MalSourcePos mal_source_positions[];");
		expect(data).toContain("const MalSourcePos mal_source_positions[] = {");
	});

	it("splits oversized aggregate metadata into bounded initializers", () => {
		const functions = Array.from({ length: 400 }, () => ({
			...fn,
			instructions: [...fn.instructions],
		}));
		const sourcePositions = Array.from({ length: 800 }, (_, index) => ({
			line: index + 1,
			column: index % 80,
		}));
		const stringConstants = Array.from({ length: 800 }, (_, index) =>
			[...String(index).padEnd(80, "x")].map((character) => character.charCodeAt(0)),
		);
		const budget = 100_000;
		const units = emitVmTranslationUnits(
			{
				...definition,
				functionCount: functions.length,
				functions,
				sourcePositions,
				stringConstants,
			},
			{},
			budget,
		);
		const definitionUnit = units[0]!;
		const dataUnits = units.slice(1).join("\n");

		expect(units.every((unit) => unit.length <= budget)).toBe(true);
		expect(definitionUnit).toContain("MalFunction mal_functions[400];");
		expect(definitionUnit).toContain("MalString mal_strings[800];");
		expect(definitionUnit).toContain("MalSourcePos mal_source_positions[800];");
		expect(definitionUnit).toContain(
			".initialize_generated_data = mal_initialize_generated_data",
		);
		expect(dataUnits).toContain("void mal_initialize_mal_functions_chunk_0(");
		expect(dataUnits).toContain("void mal_initialize_mal_strings_chunk_0(");
		expect(dataUnits).toContain("void mal_initialize_mal_source_positions_chunk_0(");
		expect(dataUnits).not.toContain("const MalFunction mal_functions[] =");
	});

	it("keeps an oversized compiled function as bounded bytecode", () => {
		const instructions = [
			...Array.from({ length: 200 }, () => ({
				opcode: "CALL" as const,
				dst: 0,
				callee: 1,
				thisValue: 2,
				argumentCount: 0,
				arguments: [],
			})),
			{ opcode: "RETURN" as const, value: 0 },
		];
		const units = emitVmTranslationUnits(
			{
				...definition,
				functions: [{ ...fn, capturedCount: 0, registerCount: 3, instructions }],
			},
			{},
			20_000,
		);
		const output = units.join("\n");

		expect(units.every((unit) => unit.length <= 20_000)).toBe(true);
		expect(output).not.toContain("MalValue mal_compiled_0(MalVm *vm");
		expect(output).toContain("MalInstruction mal_function_0_instructions[201]");
		expect(output).toContain("void mal_initialize_mal_function_0_instructions_chunk_0(");
		expect(output).toContain(".compiled = nullptr");
	});

	it("rejects an invalid translation-unit budget", () => {
		expect(() => emitVmTranslationUnits(definition, {}, 0)).toThrow(/positive integer/);
		expect(() => emitVmTranslationUnits(definition, {}, 100)).toThrow(
			/generated definition translation unit/,
		);
	});

	it("uses a null side table when a function has no variable operands", () => {
		const simple = {
			...definition,
			functions: [{ ...fn, instructions: [{ opcode: "RETURN", value: 0 } as const] }],
		};
		expect(emitVmDefinition(simple, { compiled: false })).toContain(
			".instruction_data_count = 0, .instruction_data = nullptr",
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
							inputPath: "/unused/compiler.malw",
							size: 825_000,
							digest: "digest",
							embeddedSymbol: "mal_compiler_wire_data",
						},
					],
				},
			],
		});
		expect(output).toContain("extern const u8 mal_compiler_wire_data[];");
		expect(output).toContain(
			".data = mal_compiler_wire_data, .source_path = nullptr, .length = 825000",
		);
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
		expect(output).toContain("+= 1.0;");
		expect(output).not.toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).not.toContain("MAL_UNARY_INCREMENT");
	});

	it("validates a dense Array-values iterator once per iterator record", () => {
		const output = emit(
			`"use strict"; function sum(values) { let total = 0; for (const value of values) total += value; return total; } globalThis.sum = sum;`,
		);
		expect(output).toContain("MalIteratorObject *__dense_iter_0 = nullptr;");
		expect(output).toContain("mal_vm_iterator_dense_array_cursor(&iter_rec_");
		expect(output).toContain(
			"mal_vm_iterator_step_dense_array_cursor(vm, __dense_iter_0",
		);
		expect(output).toContain(": mal_vm_iterator_step_fast(vm,");
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

	it("tracks guarded numeric parameters through physical register reuse", () => {
		const reused: VmFunction = {
			...fn,
			parameterCount: 1,
			registerCount: 5,
			capturedCount: 0,
			instructions: [
				{ opcode: "MOVE", dst: 1, src: 0 },
				{ opcode: "CREATE_NUMBER", dst: 2, value: 3 },
				{ opcode: "BINARY", dst: 3, left: 1, right: 2, operator: "*" },
				{
					opcode: "CREATE_OBJECT",
					dst: 4,
					nativeFiniteConstruction: {
						icIndex: 0,
						numberGuards: [1],
						keyStringIndices: [1],
					},
				},
				{ opcode: "CREATE_OBJECT", dst: 1 },
				{
					opcode: "LOAD_PROPERTY_STATIC",
					dst: 2,
					object: 1,
					stringIndex: 1,
					icIndex: 1,
				},
				{ opcode: "RETURN", value: 3 },
			],
		};
		const output = emitVmDefinition({
			...definition,
			functions: [reused],
			stringConstants: [[], ["x".charCodeAt(0)]],
		});

		expect(output).toContain("MalValue p0 = arg_count > 0 ? args[0]");
		expect(output).toContain("if (!mal_ops_is_number(p0))");
		expect(output).toContain("return mal_compiled_0_boxed");

		const nativeTarget = emitCompiledFunction(
			reused,
			0,
			"",
			false,
			undefined,
			"static",
			new Map([[0, 1]]),
		);
		expect(nativeTarget?.nativeNumberArgumentCount).toBe(1);
		expect(nativeTarget?.source).toContain("MalValue mal_compiled_0_native_numbers(");
		expect(nativeTarget?.source).toContain("r0 = native_arg0;");
		expect(nativeTarget?.source).toContain("if (entry_state != nullptr)");
		expect(nativeTarget?.source).toContain(
			"return mal_compiled_0_native_numbers(vm, this_value, args",
		);

		const caller: VmFunction = {
			...fn,
			parameterCount: 0,
			registerCount: 3,
			capturedCount: 0,
			instructions: [
				{ opcode: "LOAD_GLOBAL", dst: 0, index: 0 },
				{ opcode: "CREATE_NUMBER", dst: 1, value: 7 },
				{
					opcode: "CALL",
					dst: 2,
					callee: 0,
					thisValue: 0,
					argumentCount: 1,
					arguments: [1],
					directFunctionIndex: 0,
				},
				{ opcode: "RETURN", value: 2 },
			],
		};
		const nativeCaller = emitCompiledFunction(
			caller,
			1,
			"",
			false,
			undefined,
			"static",
			new Map([[0, 1]]),
		);
		expect(nativeCaller?.source).toMatch(
			/mal_compiled_0_native_numbers\(vm,[^\n]+\(void \*\) vm, r1, 0\.0, 0\.0, 0\.0\)/,
		);

		const observingArguments = emitCompiledFunction(
			{ ...reused, needsArguments: true },
			0,
			"",
			false,
			undefined,
			"static",
			new Map([[0, 1]]),
		);
		expect(observingArguments?.nativeNumberArgumentCount).toBe(0);
		expect(observingArguments?.source).not.toContain("native_numbers");
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

	it("keeps arithmetic results native through comparisons", () => {
		const output = emit(
			`"use strict"; function divisible(value) { return value % 7 === 0; } globalThis.divisible = divisible;`,
		);
		expect(output).toMatch(/__nf_(\d+)_value = mal_number_remainder/);
		expect(output).toMatch(/__nf_\d+_value == r\d+/);
	});

	it("selects proven finite loop strings from the program image", () => {
		const output = emit(
			`"use strict"; function keys() { const out = []; for (let i = 0; i < 8; i++) out.push("p" + i, "q" + (i % 3)); return out; } globalThis.keys = keys;`,
		);
		expect(output).toContain("static const i32 __finite_string_");
		expect(output).toMatch(
			/mal_value_from_string\(&mal_strings\[__finite_string_\d+\[\(i32\)/,
		);
	});

	it("keeps unbounded literal concatenation on the generic operator", () => {
		const output = emit(
			`"use strict"; function key(value) { return "p" + value; } globalThis.key = key;`,
		);
		expect(output).not.toContain("__finite_string_");
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_ADD");
	});

	it("loads a finite selector domain through one shape-slot vector", () => {
		const output = emit(
			`"use strict"; function sum(source) { let total = 0; for (let i = 0; i < 8; i++) total += source["p" + (i % 4)]; return total; } globalThis.sum = sum;`,
		);
		expect(output).toContain("static const i32 __finite_property_keys_");
		expect(output).toContain("mal_vm_finite_property_try_load");
		expect(output).toContain("mal_vm_finite_property_load(vm");
	});

	it("guards and bulk-shapes a closed finite-key construction loop", () => {
		const output = emit(
			`"use strict"; function build(seed) { const out = {}; for (let i = 0; i < 8; i++) out["p" + i] = (seed * (i + 1)) % 251; return out; } globalThis.build = build;`,
		);
		expect(output).toContain("static const i32 __finite_construction_keys_");
		expect(output).toContain("mal_vm_create_object_finite_construction");
		expect(output).toContain("mal_ops_is_number(");
		expect(output).toContain("mal_vm_finite_property_try_store");
		expect(output).toContain("mal_vm_finite_property_store(vm");
	});

	it("keeps an unobserved finite record in rooted compiler slots", () => {
		const output = emit(
			`"use strict"; function consume(seed) { const out = {}; for (let i = 0; i < 8; i++) out["p" + i] = (seed * (i + 1)) % 251; let total = 0; for (let i = 0; i < 8; i++) total += out["p" + i]; return total; } globalThis.consume = consume;`,
		);
		expect(output).toContain("mal_vm_prepare_object_finite_construction");
		expect(output).toMatch(/__finite_record_\d+_fast/);
		expect(output).toMatch(/__gc_slots\[\d+ \+ __finite_property_ordinal_\d+\]/);
		expect(output).not.toContain("mal_vm_create_object_finite_construction");
	});

	it("uses compound assignments for in-place numeric updates", () => {
		const output = emit(
			`"use strict"; function count(limit) { let value = 0; while (value < limit) value++; return value; } globalThis.count = count;`,
		);
		expect(output).toMatch(/r\d+ \+= 1\.0;/);
	});

	it("takes a dense own-element fast path for the in operator", () => {
		const output = emit(
			`"use strict"; function has(array, index) { return index in array; } globalThis.has = has;`,
		);
		expect(output).toContain("mal_vm_array_try_has");
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_IN");
	});

	it("keeps initialized numeric locals native across exception edges", () => {
		const output = emit(
			`"use strict"; function classify(value) { let errors = 0; try { value.x; } catch { errors = errors + 1; } return errors + 1; } globalThis.classify = classify;`,
		);
		expect(output).toContain("static MalValue mal_compiled_1(");
		expect(output).not.toContain("mal_vm_op_throw_if_tdz");
		expect(output).toMatch(/double r\d+;/);
		expect(output).not.toContain("mal_vm_binary_op");
	});

	it("omits consolidated key guards only for static property sites", () => {
		const staticOutput = emit(
			`"use strict"; function read(object) { object.a = object.a + 1; return object.a + object.b; } globalThis.read = read;`,
		);
		expect(staticOutput).not.toContain("static MalInlineCache");
		expect(staticOutput).toContain("vm->property_cache[");
		expect(staticOutput).toMatch(/\.property_ic_count = [1-9]/);
		expect(staticOutput).toContain("mal_perf_ic_load_region_hit");
		expect(staticOutput).toContain("mal_perf_ic_store_region_hit");
		expect(staticOutput).toMatch(
			/else if \(!\(__rg\d+_o && mal_vm_object_try_store_static/,
		);
		expect(staticOutput).not.toMatch(/&& .* == __rg\d+_key\[/);

		const dynamicOutput = emit(
			`"use strict"; function read(object, key) { return object.a + object[key]; } globalThis.read = read;`,
		);
		expect(dynamicOutput).toMatch(/&& .* == __rg\d+_c->keys\[/);
	});

	it("uses key-free probes only for non-consolidated static property sites", () => {
		const staticOutput = emit(
			`"use strict"; function load(object) { return object.value; } function store(object, value) { object.value = value; } globalThis.keep = [load, store];`,
		);
		expect(staticOutput).toContain("mal_vm_object_try_load_static(");
		expect(staticOutput).toContain("mal_vm_inherited_try_load_static(");
		expect(staticOutput).toContain("mal_vm_object_try_store_static(");
		expect(staticOutput).not.toContain("mal_vm_local_inherited_value_try_load_static(");

		const loopOutput = emit(
			`"use strict"; function load(object, count) { let value; for (let i = 0; i < count; i++) value = object.value; return value; } globalThis.load = load;`,
		);
		expect(loopOutput).toContain("mal_vm_local_inherited_value_try_load_static(");
		expect(loopOutput).toContain("mal_vm_object_try_load_static(");
		expect(loopOutput).toContain("mal_vm_inherited_try_load_static(");

		const dynamicOutput = emit(
			`"use strict"; function load(object, key) { return object[key]; } function store(object, key, value) { object[key] = value; } globalThis.keep = [load, store];`,
		);
		expect(dynamicOutput).toContain("mal_vm_object_try_load(");
		expect(dynamicOutput).toContain("mal_vm_object_try_store(");
		expect(dynamicOutput).not.toContain("mal_vm_object_try_load_static(");
		expect(dynamicOutput).not.toContain("mal_vm_local_inherited_value_try_load_static(");
	});

	it("revalidates consolidated regions only after observable gaps", () => {
		const pureOutput = emit(
			`"use strict"; function read(object) { return object.a + object.b; } globalThis.read = read;`,
		);
		expect(pureOutput).toContain("mal_perf_ic_load_region_hit");
		expect(pureOutput).not.toMatch(/__rg\d+_ok = __rg\d+_slp != nullptr &&/);

		const effectfulOutput = emit(
			`"use strict"; function read(object, callback) { const first = object.a; callback(); return first + object.b; } globalThis.read = read;`,
		);
		expect(effectfulOutput).toMatch(/__rg\d+_ok = __rg\d+_slp != nullptr &&/);
	});

	it("checks completion only inside speculative numeric slow paths", () => {
		const output = emit(
			`"use strict"; function calculate(value) { return value + 1; } globalThis.calculate = calculate;`,
		);
		expect(output).toMatch(
			/if \(mal_ops_is_number\([^\n]+\) \{[\s\S]*?\} else \{[\s\S]*?mal_vm_binary_op[\s\S]*?completion\.kind/,
		);
		expect(output).not.toMatch(
			/\?[^\n]*mal_vm_binary_op[^\n]*;\n\s+if \(vm->completion\.kind/,
		);
	});

	it("returns directly from non-constructible functions", () => {
		const output = emit(
			`"use strict"; const explicit = (value) => value + 1; const fallthrough = () => {}; globalThis.keep = [explicit, fallthrough];`,
		);
		const explicit = output.slice(
			output.indexOf("static MalValue mal_compiled_1("),
			output.indexOf("static MalValue mal_compiled_2("),
		);
		expect(explicit).toMatch(/return r\d+;/);
		expect(explicit).not.toContain("mal_ops_construct_result");
		const fallthrough = output.slice(output.indexOf("static MalValue mal_compiled_2("));
		expect(fallthrough).toContain("return MAL_VALUE_UNDEFINED;");
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

	it("emits guarded direct calls for residual exact script functions", () => {
		const output = emit(`
			"use strict";
			const values = [3, 5];
			const large = function large(index) {
				let total = 0;
				for (let i = 0; i < 24; i++) total += values[index];
				return total + index;
			};
			globalThis.result = large(1);
		`);
		expect(output).toContain("mal_vm_call_direct(vm,");
		expect(output).toContain(", 1,");
		expect(output).toContain("mal_vm_callee_has_index(vm,");
		expect(output).toMatch(/MalValue __direct_value_\d+ = mal_compiled_1\(vm,/);
		expect(output).toContain("mal_vm_enter_compiled(vm, 1)");
		expect(output).toContain("mal_vm_leave_compiled(vm)");
	});

	it("keeps argument-observing exact targets on the boxed ABI", () => {
		const output = emit(`
			"use strict";
			const values = [3, 5];
			const large = function large(index) {
				let total = 0;
				for (let i = 0; i < 24; i++) total += values[index];
				return total + index + arguments.length;
			};
			globalThis.result = large(1);
		`);
		expect(output).toMatch(/MalValue __direct_value_\d+ = mal_compiled_1\(vm,/);
		expect(output).not.toContain("mal_compiled_1_native_numbers");
	});

	it("emits guarded Function.prototype.call flattening with a shifted exact target", () => {
		const output = emit(`
			const target = function target(value) { "use strict"; return this === null ? value : 0; };
			globalThis.result = target.call(null, 1);
		`);
		expect(output).toContain("mal_vm_call_function_call_direct(vm, &__cc_");
		expect(output).toMatch(/mal_vm_call_function_call_direct\(vm, &__cc_\d+, 1,/);
		expect(output).not.toMatch(
			/mal_vm_call_function_call_direct\([^\n]+\);[\s\S]{0,80}mal_vm_call_cached/,
		);
	});

	it("emits generic target dispatch for an intrinsic method alias call", () => {
		const output = emit(`
			const slice = Array.prototype.slice;
			globalThis.result = slice.call([1, 2], 1);
		`);
		expect(output).toMatch(/mal_vm_call_function_call_direct\(vm, &__cc_\d+, -1,/);
	});

	it("emits guarded direct construction for exact ordinary script constructors", () => {
		const output = emit(`
			const Exact = function Exact(value) { this.value = value; };
			globalThis.result = new Exact(1);
		`);
		expect(output).toContain("mal_vm_construct_direct(vm, 1,");
	});

	it("emits guarded dense Array push dispatch from call metadata", () => {
		const output = emit(`
			const values = [];
			globalThis.length = values.push(1, 2, 3);
		`);
		expect(output).toContain("mal_builtin_array_push_direct(vm, &__cc_");
		expect(output).toContain(", 3);");
	});

	it("emits guarded primitive String charCodeAt dispatch from call metadata", () => {
		const output = emit(`
			function codeUnit(value, index) {
				return value.charCodeAt(index);
			}
			globalThis.codeUnit = codeUnit;
		`);
		expect(output).toContain("mal_builtin_string_char_code_at_direct(vm, &__cc_");
		expect(output).toContain(", 1);");
	});

	it("emits guarded direct collection dispatch from call metadata", () => {
		const output = emit(`
			function update(map, set, key, value) {
				const previous = map.get(key);
				map.set(key, value);
				set.add(key);
				return previous;
			}
			globalThis.update = update;
		`);
		expect(output).toContain("mal_builtin_collection_direct(vm, &__cc_");
		expect(output).toContain("MAL_BUILTIN_COLLECTION_MAP_GET");
		expect(output).toContain("MAL_BUILTIN_COLLECTION_MAP_SET");
		expect(output).toContain("MAL_BUILTIN_COLLECTION_SET_ADD");
	});
});

describe("native static typeof facts", () => {
	function emit(source: string): string {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"static-typeof-facts.js",
			parseScript(source, { strict: false }),
		);
		return emitVmDefinition(compileSemanticProgramToVmDefinition(semantic), {
			compiled: true,
		});
	}

	it("folds typeof over proven native number and boolean representations", () => {
		const output = emit(`
			"use strict";
			function numberResult(value) { return typeof (value - 1) === "number"; }
			function booleanResult(value) { return typeof (value < 1) !== "number"; }
			globalThis.keep = [numberResult, booleanResult];
		`);

		// The promoted numeric version folds both checks. Its boxed fallback still
		// classifies the subtraction result, while the comparison result is a proven
		// native boolean in every version.
		expect(output.match(/mal_vm_typeof_compare/g)).toHaveLength(1);
		expect(output).toContain("= true;");
		expect(output).not.toContain("MAL_TYPEOF_BOOLEAN");
	});

	it("retains generic typeof classification for an unknown boxed value", () => {
		const output = emit(`
			"use strict";
			function classify(value) { return typeof value === "number"; }
			globalThis.classify = classify;
		`);

		expect(output).toContain("mal_vm_typeof_compare");
		expect(output).toContain("MAL_TYPEOF_NUMBER");
	});

	it("uses a source typeof guard in a numeric parameter specialization", () => {
		const output = emit(`
			"use strict";
			function square(value) {
				if (typeof value !== "number") return -1;
				return value * value;
			}
			globalThis.square = square;
		`);

		expect(output).toContain("static MalValue mal_compiled_1_boxed(");
		expect(output).toContain("if (!mal_ops_is_number(p0))");
		expect(output.match(/mal_vm_typeof_compare/g)).toHaveLength(1);
		expect(output).toMatch(/r\d+ = r\d+ \* r\d+;/);
	});
});
