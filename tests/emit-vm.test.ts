import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	directBuiltinOperationIds,
	exactBuiltinCallDescriptor,
} from "../src/builtin-registry.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler-facts.ts";
import { emitBatch, emitVmDefinition, emitVmTranslationUnits } from "../src/emit-vm.ts";
import { vmRegionLicense, vmSemanticProtectorGuard } from "../src/lower-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "../src/lower-vm.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";
import { deserializeVmDefinition, serializeVmDefinition } from "../src/serialize-vm.ts";

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
	registerRepresentations: Array.from({ length: 12 }, () => "boxed"),
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
	it("combines semantic dependencies with one retained region twin", () => {
		const license = vmRegionLicense(
			[
				{
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback"],
				},
				{
					dependencies: [
						{ kind: "epoch", family: "watched-methods" },
						{ kind: "epoch", family: "primitive-methods" },
					],
					obligations: ["fallback"],
				},
			],
			"on-demand",
		);
		expect(license).toEqual({
			guard: {
				dependencies: [
					{ kind: "epoch", family: "primitive-methods" },
					{ kind: "epoch", family: "watched-methods" },
				],
				obligations: ["fallback", "materialize"],
			},
			genericTwin: "retained",
			materialization: "on-demand",
		});
	});

	it("validates program semantic facts through one query surface", () => {
		const locked = {
			dependencies: [{ kind: "world" as const, fact: "primordials.locked" as const }],
			obligations: ["fallback" as const],
		};
		expect(
			vmSemanticProtectorGuard(
				[{ family: "array-elements", guard: locked }],
				"array-elements",
			),
		).toBe(locked);
		expect(() =>
			vmSemanticProtectorGuard(
				[
					{ family: "array-elements", guard: locked },
					{ family: "array-elements", guard: locked },
				],
				"array-elements",
			),
		).toThrow("Duplicate array-elements semantic facts");
		expect(() =>
			vmSemanticProtectorGuard(
				[
					{
						family: "array-elements",
						guard: {
							dependencies: [{ kind: "epoch", family: "watched-methods" }],
							obligations: ["fallback"],
						},
					},
				],
				"array-elements",
			),
		).toThrow("array-elements semantic fact has a mismatched dependency");
	});

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

	it("emits every registered direct builtin operation into interpreted C", () => {
		for (const operation of directBuiltinOperationIds) {
			const emitted = emitVmDefinition(
				{
					...definition,
					functions: [
						{
							...fn,
							instructions: [
								{
									opcode: "CALL_BUILTIN",
									dst: 0,
									thisValue: 1,
									argumentCount: 1,
									arguments: [2],
									operation,
								},
							],
						},
					],
				},
				{ compiled: false },
			);
			expect(emitted).toContain(
				`.operation = ${exactBuiltinCallDescriptor(operation)!.cOperation}`,
			);
		}
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
				functions: [
					{
						...fn,
						capturedCount: 0,
						registerCount: 3,
						registerRepresentations: Array.from({ length: 3 }, () => "boxed"),
						instructions,
					},
				],
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
	function lower(source: string): VmDefinition {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"update-expression-representation.js",
			parseScript(source, { strict: false }),
		);
		return compileSemanticProgramToVmDefinition(semantic);
	}

	function emit(source: string): string {
		return emitVmDefinition(lower(source), { compiled: true });
	}

	function emitLocked(source: string): string {
		return emitVmDefinition(lockedDefinition(source), { compiled: true });
	}

	function lockedDefinition(source: string): VmDefinition {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"locked-native-representation.js",
			parseScript(source, { strict: false }),
		);
		return compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
	}

	it("keeps loop updates generic until Core proves their representation", () => {
		const output = emit(
			`"use strict"; function sum(array) { let total = 0; for (let i = 0; i < array.length; i++) total += array[i]; return total; } globalThis.sum = sum;`,
		);
		expect(output).toContain("mal_vm_object_try_load(");
		expect(output).toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).toContain("MAL_UNARY_INCREMENT");
		expect(output).toContain("if (mal_gc_poll) mal_gc_safepoint(vm);");
	});

	it("rejects a tagged region when its common control-flow envelope is incomplete", () => {
		const definition = lockedDefinition(`
			function summarize() {
				const rows = [];
				for (let index = 0; index < 8; index++) rows.push({ x: index, y: index + 1 });
				let total = 0;
				for (let index = 0; index < 8; index++) {
					const row = rows[index];
					total += row.x + row.y;
				}
				return total;
			}
			globalThis.summarize = summarize;
		`);
		const functionIndex = definition.functions.findIndex(
			(fn) => (fn.regions?.length ?? 0) > 0,
		);
		expect(functionIndex).toBeGreaterThanOrEqual(0);
		const fn = definition.functions[functionIndex]!;
		const region = fn.regions![0]!;
		const malformed: VmDefinition = {
			...definition,
			functions: definition.functions.with(functionIndex, {
				...fn,
				regions: [
					{
						...region,
						controlFlow: {
							...region.controlFlow,
							ordinaryBlockIps: [],
						},
					},
				],
			}),
		};
		expect(() => serializeVmDefinition(malformed)).toThrow(/invalid region envelope/);
	});

	it("pre-reserves a pristine canonical indexed fill without replacing its stores", () => {
		const output = emit(
			`"use strict"; function fill() { const array = []; for (let i = 0; i < 1000; i++) array[i] = i; return array; } globalThis.fill = fill;`,
		);
		expect(output).toContain("mal_vm_try_fresh_dense_indexed_fill_reserve(vm");
		expect(output).toContain(", 1000);");
		expect(output).toContain("mal_vm_object_try_store(");
		expect(output).toContain("if (mal_gc_poll) mal_gc_safepoint(vm);");
	});

	it.each([
		[
			"a pre-loop escape",
			`function fill(observe) { const array = []; observe(array); for (let i = 0; i < 8; i++) array[i] = i; return array; }`,
		],
		[
			"an alternate producer path",
			`function fill(skip) { const array = []; for (let i = 0; i < 8; i++) { if (skip && i === 2) continue; array[i] = i; } return array; }`,
		],
		[
			"an offset index",
			`function fill() { const array = []; for (let i = 0; i < 8; i++) array[i + 1] = i; return array; }`,
		],
		[
			"a dynamic bound",
			`function fill(length) { const array = []; for (let i = 0; i < length; i++) array[i] = i; return array; }`,
		],
		[
			"a reentrant RHS call",
			`function fill(value) { const array = []; for (let i = 0; i < 8; i++) array[i] = value(i); return array; }`,
		],
		[
			"an allocating RHS",
			`function fill() { const array = []; for (let i = 0; i < 8; i++) array[i] = { value: i }; return array; }`,
		],
		[
			"a potentially coercive RHS",
			`function fill(value) { const array = []; for (let i = 0; i < 8; i++) array[i] = value + i; return array; }`,
		],
		[
			"an explicit throw path",
			`function fill() { const array = []; for (let i = 0; i < 8; i++) { if (i === 4) throw new Error("stop"); array[i] = i; } return array; }`,
		],
	])("keeps %s on geometric allocation", (_name, source) => {
		const output = emit(`"use strict"; ${source} globalThis.fill = fill;`);
		expect(output).not.toContain("mal_vm_try_fresh_dense_indexed_fill_reserve(vm");
	});

	it("keeps iterator execution generic until Core owns a cursor region", () => {
		const source = `"use strict"; function sum(values) { let total = 0; for (const value of values) total += value; return total; } globalThis.sum = sum;`;
		const definition = lower(source);
		expect(deserializeVmDefinition(serializeVmDefinition(definition))).toEqual(
			definition,
		);
		const output = emitVmDefinition(definition, { compiled: true });
		expect(output).not.toContain("MalIteratorObject *__dense_iter_");
		expect(output).not.toContain("mal_vm_iterator_step_dense_array_cursor(vm,");
		expect(output).toContain("mal_vm_iterator_step_fast(vm,");
	});

	it("does not retain raw dense iterator cursors across generator suspension", () => {
		const output = emit(
			`"use strict"; function* values() { for (const value of [1, 2]) yield value; } globalThis.values = values;`,
		);
		expect(output).not.toContain("MalIteratorObject *__dense_iter_");
		expect(output).not.toContain("mal_vm_iterator_step_dense_array_cursor(vm,");
		expect(output).toContain("mal_vm_iterator_step_fast(vm,");
	});

	it("retains the boxed coercion path for unproven Number or BigInt operands", () => {
		const output = emit(
			`"use strict"; function increment(value) { return value++; } globalThis.increment = increment;`,
		);
		expect(output).toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).toContain("MAL_UNARY_INCREMENT");
		expect(output).not.toContain("+= 1.0;");
	});

	it("keeps unknown property-key parameters boxed", () => {
		const output = emit(
			`"use strict"; function load(array, index) { return array[index]; } globalThis.load = load;`,
		);
		expect(output).toContain("mal_vm_object_try_load(");
		expect(output).toContain("mal_vm_op_load_property_ic(");
	});

	it("keeps unknown property-key stores boxed", () => {
		const output = emit(
			`"use strict"; function store(array, index, value) { array[index] = value; } globalThis.store = store;`,
		);
		expect(output).toContain("mal_vm_object_try_store(");
		expect(output).toContain("mal_vm_op_store_property_ic(");
	});

	it("does not invent a recursive numeric ABI from VM use sites", () => {
		const output = emit(
			`"use strict"; function recurse(value, depth, callback) { if (depth === 0) return value * value; return callback(value - 1, depth - 1, callback); } globalThis.recurse = recurse;`,
		);
		expect(output).toContain("static MalValue mal_compiled_1(");
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_SUB");
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

	it("keeps unbounded literal concatenation on the generic operator", () => {
		const output = emit(
			`"use strict"; function key(value) { return "p" + value; } globalThis.key = key;`,
		);
		expect(output).not.toContain("__finite_string_");
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_ADD");
	});

	it("keeps in-place updates boxed until Core proves the loop value", () => {
		const output = emit(
			`"use strict"; function count(limit) { let value = 0; while (value < limit) value++; return value; } globalThis.count = count;`,
		);
		expect(output).toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).toContain("MAL_UNARY_INCREMENT");
	});

	it("takes a dense own-element fast path for the in operator", () => {
		const output = emit(
			`"use strict"; function has(array, index) { return index in array; } globalThis.has = has;`,
		);
		expect(output).toContain("mal_vm_array_try_has");
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_IN");
	});

	it("keeps initialized locals correct across exception edges", () => {
		const output = emit(
			`"use strict"; function classify(value) { let errors = 0; try { value.x; } catch { errors = errors + 1; } return errors + 1; } globalThis.classify = classify;`,
		);
		expect(output).toContain("static MalValue mal_compiled_1(");
		expect(output).not.toContain("mal_vm_op_throw_if_tdz");
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_ADD");
	});

	it("emits independent per-site property guards without backend regions", () => {
		const staticOutput = emit(
			`"use strict"; function read(object) { object.a = object.a + 1; return object.a + object.b; } globalThis.read = read;`,
		);
		expect(staticOutput).toContain("mal_vm_object_try_load_static(");
		expect(staticOutput).toContain("mal_vm_object_try_store_static(");
		expect(staticOutput).not.toContain("mal_perf_ic_load_region_hit");
		expect(staticOutput).not.toContain("mal_perf_ic_store_region_hit");

		const dynamicOutput = emit(
			`"use strict"; function read(object, key) { return object.a + object[key]; } globalThis.read = read;`,
		);
		expect(dynamicOutput).toContain("mal_vm_object_try_load(");
		expect(dynamicOutput).not.toMatch(/__rg\d+_c->keys\[/);
	});

	it("uses key-free probes only for non-consolidated static property sites", () => {
		const staticOutput = emit(
			`"use strict"; function load(object) { return object.value; } function store(object, value) { object.value = value; } globalThis.keep = [load, store];`,
		);
		expect(staticOutput).toContain("mal_vm_object_try_load_static(");
		expect(staticOutput).toContain("mal_vm_inherited_try_load_static(");
		expect(staticOutput).toContain("mal_vm_object_try_store_static(");
		expect(staticOutput).not.toContain("mal_vm_local_inherited_value_try_load_static(");
		expect(staticOutput).not.toContain(
			"mal_vm_local_watched_inherited_value_try_load_static(",
		);

		const loopSource = `"use strict"; function load(object, count, initial) { let value = initial; for (let i = 0; i < count; i++) value = object.value; return value; } globalThis.load = load;`;
		const loopDefinition = lower(loopSource);
		expect(deserializeVmDefinition(serializeVmDefinition(loopDefinition))).toEqual(
			loopDefinition,
		);
		const loopOutput = emitVmDefinition(loopDefinition, { compiled: true });
		expect(loopOutput).not.toContain("__inherited_loop_");
		expect(loopOutput).not.toContain("mal_perf_inherited_loop_summary");
		expect(loopOutput).toContain("mal_vm_object_try_load_static(");
		expect(loopOutput).toContain("mal_vm_inherited_try_load_static(");

		const dynamicOutput = emit(
			`"use strict"; function load(object, key) { return object[key]; } function store(object, key, value) { object[key] = value; } globalThis.keep = [load, store];`,
		);
		expect(dynamicOutput).toContain("mal_vm_object_try_load(");
		expect(dynamicOutput).toContain("mal_vm_object_try_store(");
		expect(dynamicOutput).not.toContain("mal_vm_object_try_load_static(");
		expect(dynamicOutput).not.toContain("mal_vm_local_inherited_value_try_load_static(");
		expect(dynamicOutput).not.toContain(
			"mal_vm_local_watched_inherited_value_try_load_static(",
		);
	});

	it("does not synthesize watched epochs for ordinary resumable property loads", () => {
		const output = emit(
			`"use strict"; async function read(object) { for (let i = 0; i < 2; i++) { await 0; object.value; } } globalThis.read = read;`,
		);
		const dispatch = output.indexOf("switch (resume_state->frame.instruction_pointer)");
		expect(dispatch).toBeGreaterThanOrEqual(0);
		expect(output).not.toContain("u64 __watched_methods_epoch = ");
	});

	it("does not consolidate property regions in the backend", () => {
		const pureOutput = emit(
			`"use strict"; function read(object) { return object.a + object.b; } globalThis.read = read;`,
		);
		expect(pureOutput).not.toContain("mal_perf_ic_load_region_hit");
		expect(pureOutput).not.toMatch(/__rg\d+_ok = __rg\d+_slp != nullptr &&/);

		const effectfulOutput = emit(
			`"use strict"; function read(object, callback) { const first = object.a; callback(); return first + object.b; } globalThis.read = read;`,
		);
		expect(effectfulOutput).not.toMatch(/__rg\d+_ok = __rg\d+_slp != nullptr &&/);
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
		const source = `"use strict"; function calculate(a, b) { return Math.round(a) + Math.max(a, b); } function constants() { const a = 1.25; const b = -0; return Math.floor(a) + Math.max(a, b); } globalThis.keep = [calculate, constants];`;
		const definition = lower(source);
		expect(deserializeVmDefinition(serializeVmDefinition(definition))).toEqual(
			definition,
		);
		const output = emitVmDefinition(definition, { compiled: true });
		expect(output).toContain("mal_builtin_math_unary_fast");
		expect(output).toContain("mal_builtin_math_binary_fast");
		expect(output).not.toContain("mal_builtin_math_unary_number_known");
		expect(output).not.toContain("mal_builtin_math_binary_number_known");

		const lockedOutput = emitLocked(source);
		expect(lockedOutput).toContain("mal_builtin_math_unary_number_known");
		expect(lockedOutput).toContain("mal_builtin_math_binary_number_known");
	});

	it("erases locked Math property Gets only for no-fallback numeric calls", () => {
		const source = `"use strict"; function calculate() { return Math.floor(1.25); } globalThis.keep = calculate;`;
		const mutableOutput = emit(source);
		expect(mutableOutput).toContain("mal_vm_op_load_property_ic");
		expect(mutableOutput).toMatch(/r\d+ = vm->intrinsics\[MAL_INTRINSIC_MATH\];/);

		const lockedOutput = emitLocked(source);
		expect(lockedOutput).toContain("mal_builtin_math_unary_number_known");
		expect(lockedOutput).not.toContain("mal_vm_op_load_property_ic");
		expect(lockedOutput).not.toMatch(/r\d+ = vm->intrinsics\[MAL_INTRINSIC_MATH\];/);
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

	it("uses the canonical boxed ABI for exact script calls", () => {
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
		expect(output).toContain(", 3, nullptr);");
	});

	it("emits the generic String charCodeAt dispatch until Core owns a fusion", () => {
		const code = `
			function codeUnit(value, index) {
				return value.charCodeAt(index);
			}
			globalThis.codeUnit = codeUnit;
		`;
		const definition = lower(code);
		expect(deserializeVmDefinition(serializeVmDefinition(definition))).toEqual(
			definition,
		);
		const output = emitVmDefinition(definition, { compiled: true });
		expect(output).not.toContain("mal_vm_local_watched_primitive_value_try_load_static");
		expect(output).not.toContain("mal_builtin_string_char_code_at_number(");
		expect(output).toContain("mal_vm_op_load_property_ic(vm,");
		expect(output).toContain("mal_builtin_string_char_code_at_direct(vm, &__cc_");
		expect(output).toContain(", 1);");

		const semantic = analyzeSourceAndRunSemanticAnalysis(
			code,
			"locked-string-char-code-at.js",
			parseScript(code, { strict: false }),
		);
		const lockedOutput = emitVmDefinition(
			compileSemanticProgramToVmDefinition(semantic, {
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			}),
			{ compiled: true },
		);
		expect(lockedOutput).not.toContain(
			"mal_vm_local_watched_primitive_value_try_load_static",
		);
		expect(lockedOutput).not.toContain("mal_builtin_string_char_code_at_number(");
		expect(lockedOutput).toContain("mal_vm_op_load_property_ic(vm,");
		expect(lockedOutput).toContain("mal_builtin_string_char_code_at_direct(vm, &__cc_");
	});

	it("does not rediscover a bounded String charCodeAt loop in the backend", () => {
		const output = emit(`
			function checksum(value) {
				let result = 0;
				for (let index = 0; index < value.length; index++) {
					result += value.charCodeAt(index);
				}
				return result;
			}
			globalThis.checksum = checksum;
		`);
		expect(output).not.toContain("mal_builtin_string_char_code_at_in_bounds(");
		expect(output).toContain("mal_builtin_string_char_code_at_direct(");
		expect(output).toContain(
			"mal_value_from_i32((i32) mal_string_length(mal_value_to_string(",
		);
	});

	it("does not transfer a String length bound across receivers", () => {
		const output = emit(`
			function checksum(bound, value) {
				let result = 0;
				for (let index = 0; index < bound.length; index++) {
					result += value.charCodeAt(index);
				}
				return result;
			}
			globalThis.checksum = checksum;
		`);
		expect(output).not.toContain("mal_builtin_string_char_code_at_in_bounds(");
	});

	it("projects closed String split results and fuses slice into Number", () => {
		const code = `
			function parse(value) {
				const fields = value.split(";");
				return Number(fields[1].slice(2)) + fields[0].length + fields.length;
			}
			globalThis.parse = parse;
		`;
		const output = emit(code);
		expect(output).toContain("mal_builtin_string_split_projection(vm,");
		expect(output).toContain("mal_builtin_string_slice_to_number_direct(vm,");

		const lockedOutput = emitLocked(code);
		expect(lockedOutput).toContain("mal_builtin_string_split_projection_locked(vm,");
		expect(lockedOutput).toContain(
			"mal_builtin_string_slice_to_number_direct_locked(vm,",
		);
		expect(lockedOutput).not.toContain("mal_builtin_string_split_projection(vm,");
		expect(lockedOutput).not.toContain("mal_builtin_string_slice_to_number_direct(vm,");
		// The adjacent property Get is absent from the hot attempt and reconstructed
		// inside the local-guard fallback before the ordinary call.
		expect(lockedOutput).toMatch(
			/mal_builtin_string_split_projection_locked\([^\n]+\);[\s\S]*?else \{\n\s+r\d+ = mal_vm_op_load_property_ic\(/,
		);
		expect(lockedOutput).toMatch(
			/mal_builtin_string_slice_to_number_direct_locked\([^\n]+\);[\s\S]*?else \{\n\s+r\d+ = mal_vm_op_load_property_ic\(/,
		);
	});

	it("carries Core-selected split projection licenses through lowering", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`globalThis.project = function project(value) {
				const fields = value.split(";");
				return fields[1] + fields[0] + fields.length;
			};`,
			"split-projection-lowering.js",
			parseScript(
				`globalThis.project = function project(value) {
					const fields = value.split(";");
					return fields[1] + fields[0] + fields.length;
				};`,
				{ strict: false },
			),
		);
		const lowered = compileSemanticProgramToVmDefinition(semantic);
		const projections = lowered.functions.flatMap(
			(fn) =>
				fn.regions?.filter((region) => region.kind === "string-split-projection") ?? [],
		);
		expect(projections).toHaveLength(1);
		expect(projections[0]).toMatchObject({
			kind: "string-split-projection",
			representation: "projected-elements",
			license: {
				genericTwin: "retained",
				materialization: "whole-region",
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});

		const cached = deserializeVmDefinition(
			serializeVmDefinition(lowered, { debugInfo: false }),
		);
		expect(
			cached.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "string-split-projection") ?? [],
			),
		).toEqual(projections);
		expect(emitVmDefinition(cached, { compiled: true })).toContain(
			"mal_builtin_string_split_projection(vm,",
		);

		const functionIndex = lowered.functions.findIndex((fn) =>
			fn.regions?.some((region) => region.kind === "string-split-projection"),
		);
		const owner = lowered.functions[functionIndex]!;
		const regionIndex = owner.regions!.findIndex(
			(region) => region.kind === "string-split-projection",
		);
		const region = owner.regions![regionIndex]!;
		if (region.kind !== "string-split-projection") {
			throw new Error("missing split projection region");
		}
		const malformed: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: owner.regions!.with(regionIndex, {
					...region,
					loads: region.loads.with(0, { ...region.loads[0]!, dst: -1 }),
				}),
			}),
		};
		expect(() => serializeVmDefinition(malformed)).toThrow(
			/invalid String\.split projection region metadata/,
		);
		const invalidForEmission: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: owner.regions!.with(regionIndex, { ...region, loads: [] }),
			}),
		};
		expect(() => emitVmDefinition(invalidForEmission, { compiled: true })).toThrow(
			/Invalid Core string-split projection/,
		);
	});

	it("carries Core-selected RegExp.exec projections through lowering and wire", () => {
		const source = `globalThis.parse = function parse(regexp, value) {
			const match = regexp.exec(value);
			if (match === null) return -1;
			return Number(match[1]);
		};`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"regexp-exec-projection-lowering.js",
			parseScript(source, { strict: false }),
		);
		const lowered = compileSemanticProgramToVmDefinition(semantic);
		const projections = lowered.functions.flatMap(
			(fn) =>
				fn.regions?.filter((region) => region.kind === "regexp-exec-projection") ?? [],
		);
		expect(projections).toHaveLength(1);
		expect(projections[0]).toMatchObject({
			kind: "regexp-exec-projection",
			representation: "regexp-capture-spans",
			lastIndexEffect: "retained-call-twin",
			license: {
				genericTwin: "retained",
				materialization: "whole-region",
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		expect(projections[0]!.nullChecks).toHaveLength(1);
		expect(projections[0]!.loads[0]?.consumer?.kind).toBe("number");

		const cached = deserializeVmDefinition(
			serializeVmDefinition(lowered, { debugInfo: false }),
		);
		expect(
			cached.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "regexp-exec-projection") ?? [],
			),
		).toEqual(projections);
		expect(emitVmDefinition(cached, { compiled: true })).toContain(
			"mal_regexp_exec_capture_projection(vm,",
		);

		const functionIndex = lowered.functions.findIndex((fn) =>
			fn.regions?.some((region) => region.kind === "regexp-exec-projection"),
		);
		const owner = lowered.functions[functionIndex]!;
		const regionIndex = owner.regions!.findIndex(
			(region) => region.kind === "regexp-exec-projection",
		);
		const region = owner.regions![regionIndex]!;
		if (region.kind !== "regexp-exec-projection") {
			throw new Error("missing RegExp.exec projection region");
		}
		const malformed: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: owner.regions!.with(regionIndex, {
					...region,
					lastIndexEffect: "broken" as never,
				}),
			}),
		};
		expect(() => serializeVmDefinition(malformed)).toThrow(
			/invalid RegExp\.exec projection region/,
		);
		const invalidForEmission: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: owner.regions!.with(regionIndex, { ...region, loads: [] }),
			}),
		};
		expect(() => emitVmDefinition(invalidForEmission, { compiled: true })).toThrow(
			/Invalid Core RegExp\.exec projection/,
		);
	});

	it("carries Core-selected String.slice Number regions through lowering and wire", () => {
		const source = `globalThis.parse = function parse(value) {
			try {
				return Number(value.slice(1));
			} catch {
				return -1;
			}
		};`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"string-slice-number-lowering.js",
			parseScript(source, { strict: false }),
		);
		const lowered = compileSemanticProgramToVmDefinition(semantic);
		const regions = lowered.functions.flatMap(
			(fn) => fn.regions?.filter((region) => region.kind === "string-slice-number") ?? [],
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			kind: "string-slice-number",
			representation: "primitive-string-span-number",
			sliceStart: 1,
			license: {
				genericTwin: "retained",
				materialization: "none",
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback"],
				},
			},
		});
		expect(regions[0]!.controlFlow.exceptionalHandlerIps).not.toHaveLength(0);

		const cached = deserializeVmDefinition(
			serializeVmDefinition(lowered, { debugInfo: false }),
		);
		expect(
			cached.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "string-slice-number") ?? [],
			),
		).toEqual(regions);
		expect(emitVmDefinition(cached, { compiled: true })).toContain(
			"mal_builtin_string_slice_to_number_direct(vm,",
		);

		const functionIndex = lowered.functions.findIndex((fn) =>
			fn.regions?.some((region) => region.kind === "string-slice-number"),
		);
		const owner = lowered.functions[functionIndex]!;
		const regionIndex = owner.regions!.findIndex(
			(region) => region.kind === "string-slice-number",
		);
		const region = owner.regions![regionIndex]!;
		if (region.kind !== "string-slice-number") {
			throw new Error("missing String.slice Number region");
		}
		const malformed: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: owner.regions!.with(regionIndex, {
					...region,
					sliceStart: Number.POSITIVE_INFINITY,
				}),
			}),
		};
		expect(() => serializeVmDefinition(malformed)).toThrow(
			/invalid String\.slice Number region/,
		);
	});

	it("carries Core-selected RegExp iterator projections through lowering and wire", () => {
		const source = `globalThis.total = function total(value, regexp) {
			let sum = 0;
			for (const match of value.matchAll(regexp)) sum += Number(match[1]);
			return sum;
		};`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"regexp-iterator-projection-lowering.js",
			parseScript(source, { strict: false }),
		);
		const lowered = compileSemanticProgramToVmDefinition(semantic);
		const projections = lowered.functions.flatMap(
			(fn) =>
				fn.regions?.filter((region) => region.kind === "regexp-iterator-projection") ??
				[],
		);
		expect(projections).toHaveLength(1);
		expect(projections[0]).toMatchObject({
			kind: "regexp-iterator-projection",
			representation: "regexp-iterator-capture-spans",
			statefulEffect: "iterator-last-index-retained-step",
			runtimeGuard: "exact-brand-next-realm-regexp",
			license: {
				genericTwin: "retained",
				materialization: "on-demand",
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		expect(projections[0]!.controlFlow.exceptionalHandlerIps).not.toHaveLength(0);

		const cached = deserializeVmDefinition(
			serializeVmDefinition(lowered, { debugInfo: false }),
		);
		expect(
			cached.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "regexp-iterator-projection") ??
					[],
			),
		).toEqual(projections);
		expect(emitVmDefinition(cached, { compiled: true })).toContain(
			"mal_regexp_try_exact_iterator_capture_projection(vm,",
		);

		const functionIndex = lowered.functions.findIndex((fn) =>
			fn.regions?.some((region) => region.kind === "regexp-iterator-projection"),
		);
		const owner = lowered.functions[functionIndex]!;
		const regionIndex = owner.regions!.findIndex(
			(region) => region.kind === "regexp-iterator-projection",
		);
		const region = owner.regions![regionIndex]!;
		if (region.kind !== "regexp-iterator-projection") {
			throw new Error("missing RegExp iterator projection region");
		}
		const malformed: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: owner.regions!.with(regionIndex, {
					...region,
					runtimeGuard: "broken" as never,
				}),
			}),
		};
		expect(() => serializeVmDefinition(malformed)).toThrow(
			/invalid RegExp iterator projection region/,
		);
		const invalidForEmission: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: owner.regions!.with(regionIndex, { ...region, loads: [] }),
			}),
		};
		expect(() => emitVmDefinition(invalidForEmission, { compiled: true })).toThrow(
			/Invalid Core RegExp iterator projection/,
		);
	});

	it("carries Core-selected split cursor licenses through lowering", () => {
		const source = `globalThis.sum = function sum(value, separator) {
			const parts = value.split(separator);
			let total = 0;
			for (let index = 0; index < parts.length; index++) {
				const part = parts[index].trim();
				total += part.length;
			}
			return total;
		};`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"split-cursor-lowering.js",
			parseScript(source, { strict: false }),
		);
		const lowered = compileSemanticProgramToVmDefinition(semantic);
		const cursors = lowered.functions.flatMap(
			(fn) => fn.regions?.filter((region) => region.kind === "string-split-cursor") ?? [],
		);
		expect(cursors).toHaveLength(1);
		expect(cursors[0]).toMatchObject({
			kind: "string-split-cursor",
			representation: "split-cursor-spans",
			license: {
				genericTwin: "retained",
				materialization: "on-demand",
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		expect(cursors[0]?.primitiveStringLengthIps).toHaveLength(1);

		const cached = deserializeVmDefinition(
			serializeVmDefinition(lowered, { debugInfo: false }),
		);
		expect(
			cached.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "string-split-cursor") ?? [],
			),
		).toEqual(cursors);
		const functionIndex = lowered.functions.findIndex((fn) =>
			fn.regions?.some((region) => region.kind === "string-split-cursor"),
		);
		const owner = lowered.functions[functionIndex]!;
		const cursor = owner.regions!.find(
			(region) => region.kind === "string-split-cursor",
		)!;
		const element = owner.instructions[cursor.elementIp]!;
		expect(element.opcode).toBe("LOAD_PROPERTY");
		if (element.opcode !== "LOAD_PROPERTY")
			throw new Error("expected cursor element load");
		expect(owner.registerRepresentations[element.key]).toBe("boxed");
		const emitted = emitVmDefinition(cached, { compiled: true });
		expect(emitted).toContain("mal_builtin_string_split_cursor_init(vm,");
		expect(emitted).toContain(
			`mal_vm_array_fast_load(vm, r${element.object}, r${element.key}, &__property_ic[${element.icIndex}])`,
		);
		expect(emitted).not.toContain(
			`mal_vm_array_try_load(__property_receiver_${cursor.elementIp}, r${element.key}`,
		);
		const duplicate: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...owner,
				regions: [...owner.regions!, cursor],
			}),
		};
		expect(() => emitVmDefinition(duplicate, { compiled: true })).toThrow(
			/Duplicate Core string-split cursor/,
		);
	});

	it("emits exact locked primitive String split calls without dynamic dispatch", () => {
		const code = `
			function make(separator, limit) {
				return "alpha,beta".split(separator, limit);
			}
			globalThis.make = make;
		`;
		const mutableOutput = emit(code);
		expect(mutableOutput).not.toContain("mal_builtin_string_split_direct(vm,");

		const lockedOutput = emitLocked(code);
		expect(lockedOutput).toContain("mal_builtin_string_split_direct(vm,");
		expect(lockedOutput).not.toContain("mal_vm_call_cached(vm,");
	});

	it("projects exact locked primitive String split calls after Core dispatch erasure", () => {
		const code = `
			function first() {
				return "alpha,beta".split(",")[0];
			}
			globalThis.first = first;
		`;
		const lockedOutput = emitLocked(code);
		expect(lockedOutput).toContain("mal_builtin_string_split_projection_locked(vm,");
		expect(lockedOutput).toContain("mal_builtin_string_split_direct(vm,");
		expect(lockedOutput).not.toContain("mal_vm_call_cached(vm,");
	});

	it("streams a closed indexed String split loop directly into trim", () => {
		const code = `
			function sum(value, separator) {
				const parts = value.split(separator);
				let total = 0;
				for (let index = 0; index < parts.length; index++) {
					const part = parts[index].trim();
					total += part.length;
				}
				return total;
			}
			globalThis.sum = sum;
		`;
		const output = emit(code);
		expect(output).toContain("mal_builtin_string_split_cursor_init(vm,");
		expect(output).toContain("mal_builtin_string_split_cursor_next(");
		expect(output).toContain("mal_builtin_string_trim_identity(vm,");
		expect(output).toContain("mal_builtin_string_trim_span_direct_licensed(vm,");
		expect(output).toMatch(
			/mal_vm_semantic_dependencies_validate\(vm, MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS, __string_split_cursor_\d+_semantic_epoch\) && mal_builtin_string_trim_span_direct_licensed/,
		);
		expect(output).toContain("mal_builtin_string_split_cursor_materialize(vm,");

		const lockedOutput = emitLocked(code);
		expect(lockedOutput).toContain("mal_builtin_string_split_cursor_init_locked(vm,");
		expect(lockedOutput).toContain("mal_builtin_string_trim_span_direct_locked(vm,");
		expect(lockedOutput).not.toContain("mal_builtin_string_split_cursor_init(vm,");
		expect(lockedOutput).not.toContain(
			"mal_vm_local_watched_primitive_value_try_load_static",
		);
		expect(lockedOutput).not.toContain(
			"mal_primitive_method_protector && __watched_methods_epoch",
		);
		expect(lockedOutput).toMatch(
			/mal_builtin_string_split_cursor_init_locked\([^\n]+\);[\s\S]*?else \{\n\s+r\d+ = mal_vm_op_load_property_ic\(/,
		);

		const directLockedOutput = emitLocked(`
			function sum(separator) {
				const parts = " alpha ; beta ".split(separator);
				let total = 0;
				for (let index = 0; index < parts.length; index++) {
					total += parts[index].trim().length;
				}
				return total;
			}
			globalThis.sum = sum;
		`);
		expect(directLockedOutput).toContain(
			"mal_builtin_string_split_cursor_init_locked(vm,",
		);
		expect(directLockedOutput).toContain("mal_builtin_string_split_direct(vm,");
		expect(directLockedOutput).not.toContain("mal_builtin_string_split_cursor_init(vm,");
		expect(directLockedOutput).toMatch(
			/mal_builtin_string_split_cursor_init_locked\([^\n]+\);[\s\S]*?else \{\n\s+r\d+ = mal_builtin_string_split_direct\(/,
		);
	});

	it("keeps an indexed split loop generic when its Array escapes", () => {
		const output = emit(`
			function sum(value, separator) {
				const parts = value.split(separator);
				globalThis.parts = parts;
				let total = 0;
				for (let index = 0; index < parts.length; index++) {
					total += parts[index].trim().length;
				}
				return total;
			}
			globalThis.sum = sum;
		`);
		expect(output).not.toContain("mal_builtin_string_split_cursor_init(vm,");
	});

	it("rejects split cursors whose zero index does not dominate the loop", () => {
		const output = emit(`
			function sum(value, separator, skip) {
				const parts = value.split(separator);
				let index;
				if (skip) index = 10;
				else index = 0;
				let total = 0;
				for (; index < parts.length; index++) total += parts[index].trim().length;
				return total;
			}
			globalThis.sum = sum;
		`);
		expect(output).not.toContain("mal_builtin_string_split_cursor_init(vm,");
	});

	it("rejects split cursors when the split call does not dominate the loop", () => {
		const output = emit(`
			function sum(value, separator, splitNow) {
				let parts = ["old"];
				if (splitNow) parts = value.split(separator);
				let total = 0;
				for (let index = 0; index < parts.length; index++) {
					total += parts[index].trim().length;
				}
				return total;
			}
			globalThis.sum = sum;
		`);
		expect(output).not.toContain("mal_builtin_string_split_cursor_init(vm,");
	});

	it("rejects one-shot split cursors when the consumer loop can run twice", () => {
		const output = emit(`
			function sum(value, separator) {
				const parts = value.split(separator);
				let total = 0;
				for (let outer = 0; outer < 2; outer++) {
					for (let index = 0; index < parts.length; index++) {
						total += parts[index].trim().length;
					}
				}
				return total;
			}
			globalThis.sum = sum;
		`);
		expect(output).not.toContain("mal_builtin_string_split_cursor_init(vm,");
	});

	it("rejects split cursors whose alternate exit can reenter the consumer loop", () => {
		const output = emit(`
			function sum(value, separator) {
				const parts = value.split(separator);
				let total = 0;
				outer: for (let outer = 0; outer < 2; outer++) {
					for (let index = 0; index < parts.length; index++) {
						total += parts[index].trim().length;
						if (outer === 0) continue outer;
					}
					return total;
				}
				return total;
			}
			globalThis.sum = sum;
		`);
		expect(output).not.toContain("mal_builtin_string_split_cursor_init(vm,");
	});

	it("rejects split cursor regions protected by an exception handler", () => {
		const output = emit(`
			function sum(value, separator) {
				const parts = value.split(separator);
				let total = 0;
				try {
					for (let index = 0; index < parts.length; index++) {
						total += parts[index].trim().length;
					}
				} catch {}
				return total;
			}
			globalThis.sum = sum;
		`);
		expect(output).not.toContain("mal_builtin_string_split_cursor_init(vm,");
	});

	it("keeps slice materialized when its result has another use", () => {
		const output = emit(`
			function parse(value) {
				const tail = value.slice(1);
				return Number(tail) + tail.length;
			}
			globalThis.parse = parse;
		`);
		expect(output).not.toContain("mal_builtin_string_slice_to_number_direct(vm,");
	});

	it("projects selected captures from a closed RegExp exec result", () => {
		const output = emit(`
			function parse(regexp, value) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				return match[1].length + match[2].charCodeAt(0);
			}
			globalThis.parse = parse;
		`);
		expect(output).toContain("mal_regexp_exec_capture_projection(vm,");
		expect(output).toContain("__regexp_exec_");
		expect(output).toContain("_starts[");
		expect(output).toContain("mal_vm_local_watched_primitive_value_try_load_static");
		expect(output).toContain("mal_vm_call_cached(vm,");
	});

	it("removes locked exec identity checks for a fresh unaliased RegExp literal", () => {
		const output = emitLocked(`
			function parse(value) {
				const match = /([a-z]+)=([0-9]+)/.exec(value);
				if (match === null) return -1;
				return match[1].length + Number(match[2]);
			}
			globalThis.parse = parse;
		`);
		expect(output).toContain("mal_regexp_exec_capture_projection_locked(vm,");
		expect(output).not.toContain("mal_regexp_exec_capture_projection(vm,");
	});

	it("summarizes a closed ASCII capture case chain to its terminal length", () => {
		const output = emit(`
			function normalizedLength(regexp, value) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				const normalized = match[1].toUpperCase().toLowerCase();
				return normalized.length;
			}
			globalThis.normalizedLength = normalizedLength;
		`);
		expect(output).toContain("mal_regexp_exec_capture_projection(vm,");
		expect(output).toContain("mal_builtin_string_ascii_case_chain_length_span(vm,");
		expect(output).toContain("mal_regexp_materialize_capture_span(vm,");
		expect(output).toContain("mal_vm_call_cached(vm,");
	});

	it("keeps capture case intermediates materialized when they escape", () => {
		const output = emit(`
			function normalizedLength(regexp, value, consume) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				const upper = match[1].toUpperCase();
				consume(upper);
				return upper.toLowerCase().length;
			}
			globalThis.normalizedLength = normalizedLength;
		`);
		expect(output).not.toContain("mal_builtin_string_ascii_case_chain_length_span(vm,");
	});

	it("rejects a capture case summary when control can skip its producer", () => {
		const output = emit(`
			function normalizedLength(regexp, values) {
				let normalized = "old";
				let total = 0;
				for (let index = 0; index < values.length; index++) {
					const match = regexp.exec(values[index]);
					if (match === null) continue;
					if (index === 0) normalized = match[1].toUpperCase().toLowerCase();
					total += normalized.length;
				}
				return total;
			}
			globalThis.normalizedLength = normalizedLength;
		`);
		expect(output).not.toContain("mal_builtin_string_ascii_case_chain_length_span(vm,");
	});

	it("keeps RegExp capture strings materialized when scalar results have another use", () => {
		const output = emit(`
			function parse(regexp, value) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				const capture = match[1];
				return capture.length + capture;
			}
			globalThis.parse = parse;
		`);
		expect(output).toContain("mal_regexp_exec_capture_projection(vm,");
		expect(output).toContain(", 0, __regexp_exec_");
	});

	it("parses a closed RegExp capture span through the exact Number intrinsic", () => {
		const output = emit(`
			function parse(regexp, value) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				return Number(match[1]);
			}
			globalThis.parse = parse;
		`);
		expect(output).toContain("mal_regexp_exec_capture_projection(vm,");
		expect(output).toContain("mal_ops_string_units_to_number(");
	});

	it("keeps RegExp exec results materialized when identity escapes", () => {
		const output = emit(`
			function parse(regexp, value) {
				const match = regexp.exec(value);
				return match;
			}
			globalThis.parse = parse;
		`);
		expect(output).not.toContain("mal_regexp_exec_capture_projection(vm,");
	});

	it("rejects RegExp exec projection across an ambiguous result alias", () => {
		const output = emit(`
			function parse(regexp, value, replace) {
				const match = regexp.exec(value);
				let alias = match;
				if (replace) alias = { 1: "replacement" };
				return alias[1];
			}
			globalThis.parse = parse;
		`);
		expect(output).not.toContain("mal_regexp_exec_capture_projection(vm,");
	});

	it("rejects RegExp exec projection when a branch enters after the call", () => {
		const output = emit(`
			function parse(regexp, value, replace) {
				let match = { 1: "old" };
				if (replace) match = { 1: "replacement" };
				else match = regexp.exec(value);
				return match[1];
			}
			globalThis.parse = parse;
		`);
		expect(output).not.toContain("mal_regexp_exec_capture_projection(vm,");
	});

	it("projects closed matchAll captures directly through Number", () => {
		const output = emit(`
			function total(value, regexp) {
				let sum = 0;
				for (const match of value.matchAll(regexp)) sum += Number(match[1]);
				return sum;
			}
			globalThis.total = total;
		`);
		expect(output).toContain("mal_regexp_try_exact_iterator_capture_projection(vm,");
		expect(output).toContain("mal_ops_string_units_to_number(");
		expect(output).toContain("mal_vm_iterator_step_fast(vm,");
	});

	it("keeps matchAll results materialized when capture identity escapes", () => {
		const output = emit(`
			function collect(value, regexp) {
				const results = [];
				for (const match of value.matchAll(regexp)) results.push(match);
				return results;
			}
			globalThis.collect = collect;
		`);
		expect(output).not.toContain("mal_regexp_try_exact_iterator_capture_projection(vm,");
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

	it("keeps source typeof narrowing local without inventing a numeric ABI", () => {
		const output = emit(`
			"use strict";
			function square(value) {
				if (typeof value !== "number") return -1;
				return value * value;
			}
			globalThis.square = square;
		`);

		expect(output).toContain("static MalValue mal_compiled_1(");
		expect(output.match(/mal_vm_typeof_compare/g)).toHaveLength(1);
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_MUL");
	});
});
