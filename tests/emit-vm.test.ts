import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	directBuiltinOperationIds,
	exactBuiltinCallDescriptor,
	mathUnaryOperationKeys,
} from "../src/builtin-registry.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler-facts.ts";
import { emitCompiledFunction } from "../src/emit-c.ts";
import { emitBatch, emitVmDefinition, emitVmTranslationUnits } from "../src/emit-vm.ts";
import { vmRegionLicense, vmSemanticProtectorGuard } from "../src/lower-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "../src/lower-vm.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/semantic-program.ts";
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

const numericHofRegions = (definition: VmDefinition) =>
	definition.functions.flatMap(
		(fn) => fn.regions?.filter((region) => region.kind === "numeric-hof") ?? [],
	);

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

	it("keeps proven numeric loop updates on dense array paths", () => {
		const output = emit(
			`"use strict"; function sum(array) { let total = 0; for (let i = 0; i < array.length; i++) total += array[i]; return total; } globalThis.sum = sum;`,
		);
		expect(output).toContain("mal_vm_array_try_load");
		expect(output).toContain("+= 1.0;");
		expect(output).not.toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).not.toContain("MAL_UNARY_INCREMENT");
	});

	it("reads stable complete fresh-Array loops from dense storage with a table fallback", () => {
		const source = `let total = 0; [1, 2, 3].forEach((value) => { total += value; }); globalThis.total = total;`;
		const lockedOutput = emitLocked(source);
		expect(lockedOutput).toMatch(
			/if \(__exact_fresh_array_\d+->elements != nullptr\) \{\n\s+r\d+ = __exact_fresh_array_\d+->elements\[\(u32\) r\d+\];/,
		);
		expect(lockedOutput).toMatch(/else \{\n\s+r\d+ = mal_vm_array_fast_load_index\(vm,/);
		expect(emit(source)).not.toContain("__exact_fresh_array_");
	});

	it("uses closed dense and own-slot proofs across record-Array loop regions", () => {
		const source = `
			function summarize() {
				const rows = [];
				for (let index = 0; index < 4; index++) {
					rows.push({ x: index, y: index + 1 });
				}
				let total = 0;
				for (let round = 0; round < 3; round++) {
					for (let index = 0; index < 4; index++) {
						const row = rows[index];
						row.y = row.x + row.y;
						total += row.y;
					}
				}
				return total;
			}
			globalThis.summarize = summarize;
		`;
		const lockedOutput = emitLocked(source);
		expect(lockedOutput).toMatch(
			/MalArrayObject \*__exact_fresh_array_\d+ = mal_value_to_array_object/,
		);
		expect(lockedOutput).toMatch(
			/MalObject \*__closed_record_\d+_o = mal_value_to_object\(r\d+\);/,
		);
		expect(lockedOutput).toMatch(/__closed_record_\d+_o->slots\[0\]/);
		expect(lockedOutput).toMatch(/__closed_record_\d+_o->slots\[1\]/);
		expect(lockedOutput).toMatch(/mal_vm_object_slot_store\(__closed_record_\d+_o, 1,/);
		expect(emit(source)).not.toContain("__closed_record_");
	});

	it("selects multiple disjoint IR regions and preserves them through the wire", () => {
		const source = `
			function summarize() {
				const left = [];
				for (let index = 0; index < 8; index++) left.push({ x: index, y: index + 1 });
				let total = 0;
				for (let index = 0; index < 8; index++) {
					const row = left[index];
					total += row.x + row.y;
				}
				const right = [];
				for (let index = 0; index < 4; index++) right.push({ p: index, q: index + 2 });
				for (let index = 0; index < 4; index++) {
					const row = right[index];
					row.q = row.p + row.q;
					total += row.q;
				}
				return total;
			}
			globalThis.summarize = summarize;
		`;
		const lowered = lockedDefinition(source);
		const loweredRegions = lowered.functions.flatMap(
			(fn) => fn.regions?.filter((region) => region.kind === "closed-record-array") ?? [],
		);
		expect(loweredRegions.map((region) => region.length).sort((a, b) => a - b)).toEqual([
			4, 8,
		]);
		for (const region of loweredRegions) {
			expect(region.anchors).toHaveLength(2);
			expect(region.anchors.every((ip) => region.claimedIps.includes(ip))).toBe(true);
			expect(region.controlFlow.ordinaryBlockIps.length).toBeGreaterThan(0);
			expect(region.controlFlow.exceptionalHandlerIps).toEqual([]);
			expect(region.cost.score).toBeGreaterThan(0);
			expect(region.cost.metadataOperations).toBe(
				region.elementLoadIps.length + region.accesses.length,
			);
		}

		const restored = deserializeVmDefinition(serializeVmDefinition(lowered));
		const restoredRegions = restored.functions.flatMap(
			(fn) => fn.regions?.filter((region) => region.kind === "closed-record-array") ?? [],
		);
		expect(restoredRegions).toEqual(loweredRegions);
		const output = emitVmDefinition(restored, { compiled: true });
		expect(
			output.match(/MalObject \*__closed_record_\d+_o/g)?.length,
		).toBeGreaterThanOrEqual(2);
	});

	it("shares one region table across disjoint record, split, builtin, and numeric proofs", () => {
		const source = `
			function summarize(value, separator) {
				const rows = [];
				for (let index = 0; index < 4; index++) {
					rows.push({ x: index, y: index + 1 });
				}
				let total = 0;
				for (let index = 0; index < 4; index++) {
					const row = rows[index];
					total += row.x + row.y;
				}
				const parts = value.split(separator);
				for (let index = 0; index < parts.length; index++) {
					total += parts[index].trim().length;
				}
				const values = [];
				for (let index = 0; index < 8; index++) values.push(index - 4);
				total += values.reduce((sum, value) => sum + Math.abs(value), 0);
				const projected = value.split("|");
				total += projected[0].length;
				return total;
			}
			globalThis.summarize = summarize;
		`;
		const lowered = lockedDefinition(source);
		const fn = lowered.functions.find(
			(candidate) =>
				candidate.regions?.some((region) => region.kind === "closed-record-array") ===
				true,
		);
		expect(fn).toBeDefined();
		const functionIndex = lowered.functions.indexOf(fn!);
		expect(functionIndex).toBeGreaterThanOrEqual(0);
		expect(fn!.regions?.map((region) => region.kind).sort()).toEqual([
			"closed-record-array",
			"known-builtin-producers",
			"numeric-fusion",
			"numeric-hof",
			"string-split-cursor",
			"string-split-projection",
		]);
		const claimedIps = fn!
			.regions!.filter((region) => region.composition !== "overlay")
			.flatMap((region) => region.claimedIps);
		expect(new Set(claimedIps).size).toBe(claimedIps.length);

		const restored = deserializeVmDefinition(
			serializeVmDefinition(lowered, { debugInfo: false }),
		);
		expect(restored.functions[functionIndex]?.regions).toEqual(fn!.regions);
		const output = emitVmDefinition(restored, { compiled: true });
		expect(output).toContain("__closed_record_");
		expect(output).toContain("mal_builtin_string_split_cursor_init_locked(vm,");
		expect(output).toContain("mal_builtin_string_split_projection_locked(vm,");
		expect(output).toContain("mal_builtin_array_numeric_fold_local_admit(");

		const cursorIndex = fn!.regions!.findIndex(
			(region) => region.kind === "string-split-cursor",
		);
		const cursor = fn!.regions![cursorIndex]!;
		if (cursor.kind !== "string-split-cursor") throw new Error("missing cursor region");
		const malformed: VmDefinition = {
			...lowered,
			functions: lowered.functions.with(functionIndex, {
				...fn!,
				regions: fn!.regions!.with(cursorIndex, {
					...cursor,
					anchors: cursor.anchors.with(1, cursor.anchors[2]! + 1),
				}),
			}),
		};
		expect(() => serializeVmDefinition(malformed)).toThrow(
			/invalid String\.split cursor region metadata/,
		);
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

	it("admits only one certificate when two candidates share a consumer loop", () => {
		const definition = lockedDefinition(`
			function summarize() {
				const left = [];
				for (let index = 0; index < 4; index++) left.push({ x: index, y: index + 1 });
				const right = [];
				for (let index = 0; index < 4; index++) right.push({ x: index, y: index + 2 });
				let total = 0;
				for (let index = 0; index < 4; index++) {
					const a = left[index];
					const b = right[index];
					total += a.x + a.y + b.x + b.y;
				}
				return total;
			}
			globalThis.summarize = summarize;
		`);
		expect(
			definition.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "closed-record-array") ?? [],
			),
		).toHaveLength(1);
	});

	it("keeps incomplete record-Array loop proofs on ordinary property paths", () => {
		const escaped = emitLocked(`
			let escaped;
			function build() {
				const rows = [];
				for (let index = 0; index < 4; index++) rows.push({ x: index, y: index });
				for (let index = 0; index < 4; index++) {
					const row = rows[index];
					escaped = row;
					row.x = row.y;
				}
			}
			globalThis.build = build;
		`);
		expect(escaped).not.toContain("__closed_record_");

		const conditionalFill = emitLocked(`
			function build() {
				const rows = [];
				for (let index = 0; index < 4; index++) {
					if ((index & 1) === 0) rows.push({ x: index, y: index });
				}
				let total = 0;
				for (let index = 0; index < 4; index++) total += rows[index].x;
				return total;
			}
			globalThis.build = build;
		`);
		expect(conditionalFill).not.toContain("__closed_record_");

		const earlyExit = emitLocked(`
			function build() {
				const rows = [];
				for (let index = 0; index < 4; index++) {
					rows.push({ x: index, y: index + 1 });
					if (index === 2) break;
				}
				let total = 0;
				for (let index = 0; index < 4; index++) {
					total += rows[index].x;
					total += rows[index].y;
				}
				return total;
			}
			globalThis.build = build;
		`);
		expect(earlyExit).not.toContain("__closed_record_");

		const shapeMutation = emitLocked(`
			function build() {
				const rows = [];
				for (let index = 0; index < 4; index++) rows.push({ x: index, y: index });
				for (let index = 0; index < 4; index++) {
					const row = rows[index];
					row.extra = index;
					row.x = row.y;
				}
			}
			globalThis.build = build;
		`);
		expect(shapeMutation).not.toContain("__closed_record_");
	});

	it("pre-reserves a pristine canonical indexed fill without replacing its stores", () => {
		const output = emit(
			`"use strict"; function fill() { const array = []; for (let i = 0; i < 1000; i++) array[i] = i; return array; } globalThis.fill = fill;`,
		);
		expect(output).toContain("mal_vm_try_fresh_dense_indexed_fill_reserve(vm");
		expect(output).toContain(", 1000);");
		expect(output).toContain("mal_vm_array_try_store");
		expect(output).toContain("if (mal_gc_poll) mal_gc_safepoint(vm);");
	});

	it("lowers region facts through one semantic-dependency admission bridge", () => {
		const source = `
			function summarize(seed) {
				const rows = [];
				for (let i = 0; i < 6; i++) rows.push({ index: i, value: seed + i });
				return rows.length;
			}
			globalThis.summarize = summarize;
		`;
		const mutableOutput = emit(source);
		expect(mutableOutput).toContain(
			"mal_vm_semantic_dependencies_admit(vm, MAL_SEMANTIC_DEPENDENCY_ARRAY_ELEMENTS | MAL_SEMANTIC_DEPENDENCY_PRIMITIVE_METHODS | MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS",
		);
		expect(mutableOutput).toContain("mal_builtin_array_push_virtual_guard(vm)");

		const lockedOutput = emitLocked(source);
		expect(lockedOutput).toContain("mal_vm_materialize_virtual_record_array");
		expect(lockedOutput).toMatch(/__cardinality_\d+_fast = true;/);
		expect(lockedOutput).not.toContain("mal_vm_semantic_dependencies_admit(vm,");
		expect(lockedOutput).not.toContain("mal_builtin_array_push_virtual_guard(vm)");
	});

	it.each([
		[
			"one consumer",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) a[i] = i; let sum = 0; for (let i = 0; i < 8; i++) sum += a[i]; return sum; }`,
			1,
		],
		[
			"three consumers",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) a[i] = i; let sum = 0; for (let i = 0; i < 8; i++) sum += a[i]; for (let i = 0; i < 8; i++) sum += a[(i * 3) % 8]; for (let i = 0; i < 8; i++) sum += a[(i + 1) % 8]; return sum; }`,
			3,
		],
	])("virtualizes a closed identity range with %s", (_name, kernel, loadCount) => {
		const output = emit(`"use strict"; ${kernel} globalThis.rangeKernel = rangeKernel;`);
		expect(output).toContain("mal_gc_preempt_hook == nullptr");
		expect(output).toContain(
			"mal_vm_semantic_dependencies_admit(vm, MAL_SEMANTIC_DEPENDENCY_ARRAY_ELEMENTS, nullptr)",
		);
		expect(output).toContain("array_affine_range_allocations_elided");
		expect(output.match(/array_affine_range_stores_elided/g)).toHaveLength(1);
		expect(output.match(/array_affine_range_loads_elided/g)).toHaveLength(loadCount);
		// The generic allocation, stores, loads, and original backedge polls remain
		// present as the scheduler/protector fallback.
		expect(output).toContain("mal_vm_op_create_array");
		expect(output).toContain("mal_vm_array_try_store");
		expect(output).toContain("mal_vm_array_try_load");
		expect(output).toContain("if (mal_gc_poll) mal_gc_safepoint(vm);");
	});

	it("erases the affine-range semantic guard in a locked world", () => {
		const output = emitLocked(`
			function rangeKernel() {
				const array = [];
				for (let i = 0; i < 8; i++) array[i] = i;
				let total = 0;
				for (let i = 0; i < 8; i++) total += array[i];
				return total;
			}
			globalThis.rangeKernel = rangeKernel;
		`);
		expect(output).toContain("array_affine_range_allocations_elided");
		expect(output).toContain("= mal_gc_preempt_hook == nullptr;");
		expect(output).not.toContain("mal_vm_semantic_dependencies_admit(vm,");
	});

	it("reselects affine ranges from semantic facts after a wire round trip", () => {
		const source = `
			function rangeKernel() {
				const array = [];
				for (let i = 0; i < 8; i++) array[i] = i;
				let total = 0;
				for (let i = 0; i < 8; i++) total += array[i];
				return total;
			}
			globalThis.rangeKernel = rangeKernel;
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"affine-range-wire-facts.js",
			parseScript(source, { strict: false }),
		);
		const lowered = compileSemanticProgramToVmDefinition(semantic);
		const cached = deserializeVmDefinition(
			serializeVmDefinition(lowered, { debugInfo: false }),
		);
		expect(cached.semanticProtectors).toContainEqual({
			family: "array-elements",
			guard: {
				dependencies: [{ kind: "epoch", family: "array-elements" }],
				obligations: ["fallback"],
			},
		});
		expect(emitVmDefinition(cached, { compiled: true })).toContain(
			"array_affine_range_allocations_elided",
		);
		const affineRegions = cached.functions.flatMap(
			(fn) =>
				fn.regions?.filter((region) => region.kind === "affine-range-virtualization") ??
				[],
		);
		expect(affineRegions).toHaveLength(1);
		expect(affineRegions[0]).toMatchObject({
			representation: "private-identity-index-range",
			composition: "overlay",
			length: 8,
			license: {
				guard: {
					dependencies: [{ kind: "epoch", family: "array-elements" }],
					obligations: ["fallback"],
				},
				genericTwin: "retained",
				materialization: "none",
			},
		});
		const restored = deserializeVmDefinition(
			serializeVmDefinition(cached, { debugInfo: false }),
		);
		expect(
			restored.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "affine-range-virtualization") ??
					[],
			),
		).toEqual(affineRegions);
	});

	it.each([
		[
			"a non-identity producer",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) a[i] = i * 2; let sum = 0; for (let i = 0; i < 8; i++) sum += a[i]; return sum; }`,
		],
		[
			"an out-of-range consumer",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) a[i] = i; let sum = 0; for (let i = 0; i < 8; i++) sum += a[i + 1]; return sum; }`,
		],
		[
			"a partially completed producer",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) { if (i === 4) break; a[i] = i; } let sum = 0; for (let i = 0; i < 8; i++) sum += a[i]; return sum; }`,
		],
		[
			"a consumer load after pre-increment",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) a[i] = i; let sum = 0; for (let i = 0; i < 8;) { i++; sum += a[i]; } return sum; }`,
		],
		[
			"an aggregate escape",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) a[i] = i; return a; }`,
		],
		[
			"a possible reentrant call",
			`function rangeKernel() { const a = []; for (let i = 0; i < 8; i++) a[i] = i; unknown(); let sum = 0; for (let i = 0; i < 8; i++) sum += a[i]; return sum; }`,
		],
	])("does not virtualize %s", (_name, kernel) => {
		const output = emit(`"use strict"; ${kernel} globalThis.rangeKernel = rangeKernel;`);
		expect(output).not.toContain("array_affine_range_allocations_elided");
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
			registerCount: 6,
			capturedCount: 0,
			instructions: [
				{ opcode: "MOVE", dst: 1, src: 0 },
				{ opcode: "CREATE_NUMBER", dst: 2, value: 3 },
				{ opcode: "BINARY", dst: 3, left: 1, right: 2, operator: "*" },
				{ opcode: "CREATE_STRING", dst: 5, stringIndex: 0 },
				{
					opcode: "BINARY",
					dst: 2,
					left: 5,
					right: 2,
					operator: "+",
				},
				{ opcode: "CREATE_OBJECT", dst: 4 },
				{
					opcode: "STORE_PROPERTY",
					object: 4,
					key: 2,
					value: 3,
					icIndex: 0,
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
			regions: [
				{
					kind: "finite-property-selector",
					license: {
						guard: { dependencies: [], obligations: ["fallback"] },
						genericTwin: "retained",
						materialization: "none",
					},
					representation: "finite-property-domain",
					composition: "overlay",
					anchors: [4],
					claimedIps: [4, 6],
					controlFlow: { ordinaryBlockIps: [0], exceptionalHandlerIps: [] },
					cost: { score: 2, metadataOperations: 2 },
					runtimeGuard: "integer-domain-and-shape-or-generic-access",
					selectors: [
						{
							producerIp: 4,
							ordinal: 2,
							minimum: 3,
							stringIndices: [1],
							accesses: [{ ip: 6, kind: "store" }],
						},
					],
				},
				{
					kind: "finite-object-construction",
					license: {
						guard: { dependencies: [], obligations: ["fallback", "materialize"] },
						genericTwin: "retained",
						materialization: "on-demand",
					},
					representation: "finite-key-object-slots",
					anchors: [5, 6],
					claimedIps: [5, 6],
					controlFlow: { ordinaryBlockIps: [0], exceptionalHandlerIps: [] },
					cost: { score: 1, metadataOperations: 2 },
					allocationIp: 5,
					storeIp: 6,
					icIndex: 0,
					numberGuards: [1],
					keyStringIndices: [1],
					virtualRecord: false,
					accessIps: [],
					runtimeGuard: "number-leaves-and-prototype-shape",
				},
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

	it("emits synthetic globals with a materializing finite-table fallback", () => {
		const output = emit(`
			"use strict";
			const table = {};
			function update(seed, other) {
				const key = seed & 7;
				const previous = table[key];
				table[key] = seed;
				if (other !== undefined) table[other] = seed + 1;
				return previous;
			}
			globalThis.update = update;
		`);
		expect(output).toContain(
			"mal_vm_semantic_dependencies_admit(vm, MAL_SEMANTIC_DEPENDENCY_ARRAY_ELEMENTS, nullptr)",
		);
		expect(output).not.toContain("mal_array_elements_protector");
		expect(output).toContain("MAL_VALUE_EMPTY");
		expect(output).toContain("mal_vm_closed_global_table_deopt");
		expect(output).toMatch(/vm->globals\[\d+ \+ \(i32\) /);
		expect(output).toContain("mal_vm_op_store_property_ic");

		const lockedOutput = emitLocked(`
			"use strict";
			const table = {};
			function update(seed) {
				const key = seed & 7;
				const previous = table[key];
				table[key] = seed;
				return previous;
			}
			globalThis.update = update;
		`);
		expect(lockedOutput).toContain("mal_vm_closed_global_table_deopt");
		expect(lockedOutput).not.toContain("mal_vm_semantic_dependencies_admit(vm,");
		expect(lockedOutput).not.toContain("mal_array_elements_protector");
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
		expect(staticOutput).not.toContain(
			"mal_vm_local_watched_inherited_value_try_load_static(",
		);

		const loopSource = `"use strict"; function load(object, count) { let value; for (let i = 0; i < count; i++) value = object.value; return value; } globalThis.load = load;`;
		const loopOutput = emit(loopSource);
		expect(loopOutput).toContain("mal_vm_local_inherited_value_try_load_static(");
		expect(loopOutput).toContain("mal_vm_local_watched_inherited_value_try_load_static(");
		expect(loopOutput).toContain(
			"mal_vm_semantic_dependencies_admit(vm, MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS, nullptr) ? vm->semantic_epochs.watched_methods : 0",
		);
		expect(loopOutput).not.toContain("mal_primitive_method_protector ?");

		const lockedLoopOutput = emitLocked(loopSource);
		expect(lockedLoopOutput).toContain(
			"u64 __watched_methods_epoch = vm->semantic_epochs.watched_methods;",
		);
		expect(lockedLoopOutput).not.toContain(
			"mal_vm_semantic_dependencies_admit(vm, MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS",
		);
		expect(lockedLoopOutput).not.toContain("mal_primitive_method_protector ?");
		expect(loopOutput).toContain("__inherited_loop_");
		expect(loopOutput).toMatch(/goto LF\d+/);
		expect(loopOutput).toMatch(/goto LG\d+/);
		expect(loopOutput).toMatch(/bool __inherited_loop_\d+_loaded = false/);
		expect(loopOutput).toMatch(/__inherited_loop_\d+_loaded = true/);
		expect(loopOutput).toMatch(/if \(__inherited_loop_\d+_loaded\) \{/);
		expect(loopOutput).toMatch(/r\d+ = __property_ic\[\d+\]\.value/);
		expect(loopOutput).toContain("if (mal_gc_poll) {");
		expect(loopOutput).toMatch(
			/pos_id = \d+;\s+mal_gc_safepoint\(vm\);\s+if \(!\(mal_vm_local_inherited_value_try_load_static/s,
		);
		expect(loopOutput).toContain("mal_vm_object_try_load_static(");
		expect(loopOutput).toContain("mal_vm_inherited_try_load_static(");
		expect(loopOutput).toMatch(
			/if \(mal_gc_preempt_hook == nullptr && r\d+ > 0\.0 && isfinite\(r\d+\) && trunc\(r\d+\) == r\d+ && r\d+ <= 9007199254740992\.0\)/,
		);
		expect(loopOutput).toMatch(/mal_perf_inherited_loop_summary\(\(u64\) r\d+\)/);
		expect(loopOutput).toMatch(
			/r\d+ = __inherited_loop_\d+_probe;\s+r\d+ = 1\.0;\s+if \(mal_gc_poll\)[\s\S]*?mal_gc_safepoint\(vm\);\s+if \(r\d+ > 1\.0\)[\s\S]*?if \(!\(mal_vm_local_inherited_value_try_load_static[\s\S]*?goto LG\d+;[\s\S]*?r\d+ = __inherited_loop_\d+_probe;[\s\S]*?r\d+ = false;[\s\S]*?r\d+ = r\d+;[\s\S]*?goto L\d+;/,
		);

		const effectfulLoopOutput = emit(
			`"use strict"; function load(object, count, mutate) { let value; for (let i = 0; i < count; i++) { value = object.value; mutate(); } return value; } globalThis.load = load;`,
		);
		expect(effectfulLoopOutput).not.toContain("__inherited_loop_");
		expect(effectfulLoopOutput).not.toMatch(/goto LF\d+/);

		const nonCanonicalLoopOutput = emit(
			`"use strict"; function load(object, count) { let value; for (let i = 1; i < count; i++) value = object.value; return value; } globalThis.load = load;`,
		);
		expect(nonCanonicalLoopOutput).toContain("__inherited_loop_");
		expect(nonCanonicalLoopOutput).not.toContain("9007199254740992.0");

		const observableBodyOutput = emit(
			`"use strict"; function load(object, count) { let value; let sum = 0; for (let i = 0; i < count; i++) { value = object.value; sum += i; } return [value, sum]; } globalThis.load = load;`,
		);
		expect(observableBodyOutput).not.toContain("9007199254740992.0");

		const wrongInductionOutput = emit(
			`"use strict"; function load(object, count) { let value; let other = 0; for (let i = 0; other < count; i++) value = object.value; return value; } globalThis.load = load;`,
		);
		expect(wrongInductionOutput).not.toContain("9007199254740992.0");

		// The trunc guard deliberately sends fractional bounds through the existing
		// per-iteration twin; the summary only models an exact integral final index.
		expect(loopOutput).toMatch(/trunc\(r\d+\) == r\d+/);

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
		const source = `"use strict"; function calculate(a, b) { return Math.round(a) + Math.max(a, b); } function constants() { const a = 1.25; const b = -0; return Math.floor(a) + Math.max(a, b); } globalThis.keep = [calculate, constants];`;
		const output = emit(source);
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
		expect(output).toContain(", 3, nullptr);");
	});

	it("emits guarded primitive String charCodeAt dispatch from call metadata", () => {
		const code = `
			function codeUnit(value, index) {
				return value.charCodeAt(index);
			}
			globalThis.codeUnit = codeUnit;
		`;
		const output = emit(code);
		expect(output).toContain(
			"mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING",
		);
		expect(output).toContain("mal_builtin_string_char_code_at_number(");
		// The original Get+Call remains in the cold arm for non-String receivers,
		// coercible arguments, cold ICs, and invalidated watched-method epochs.
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
		expect(lockedOutput).toContain("if (mal_value_is_string(");
		// Non-String receivers and coercible positions retain the exact Get+Call twin.
		expect(lockedOutput).toContain("mal_vm_op_load_property_ic(vm,");
		expect(lockedOutput).toContain("mal_builtin_string_char_code_at_direct(vm, &__cc_");
	});

	it("emits an activation-local memo for a private dense Number reducer", () => {
		const output = emit(`
			function control() {
				function classify(values) {
					let sum = 0;
					let errors = 0;
					for (const value of values) {
						try {
							if (value % 7 === 0) throw "div7";
							sum += value % 100;
						} catch (error) {
							errors = errors + 1;
						}
					}
					return sum + errors * 1000;
				}
				const data = [];
				for (let index = 0; index < 20; index++) data.push(index * 31 + 1);
				let result = 0;
				for (let round = 0; round < 4; round++) result += classify(data);
				return result;
			}
			globalThis.result = control();
		`);
		expect(output).toContain("MalPrivateAggregateMemo __private_aggregate_memo_");
		expect(output).toContain("mal_builtin_array_private_aggregate_memo_init");
		expect(output).toContain("mal_builtin_array_private_aggregate_memo_note_push");
		expect(output).toContain("mal_builtin_array_private_aggregate_memo_probe");
		expect(output).toContain("mal_builtin_array_private_aggregate_memo_fill");
	});

	it("carries a trusted numeric reduce plan through lowering and the wire", () => {
		const source = `
			function run() {
				const values = [];
				for (let i = 0; i < 20; i++) values.push(i / 20);
				let result = 0;
				for (let round = 0; round < 4; round++) {
					result += values.reduce(
						(sum, value) => sum + Math.sqrt(value) * Math.sin(value) + Math.abs(value - 0.5),
						0,
					);
				}
				return result;
			}
			globalThis.result = run();
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"numeric-hof-plan.js",
			parseScript(source, { strict: false }),
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		const regions = numericHofRegions(definition);
		expect(regions).toHaveLength(1);
		expect(regions[0]?.operations.map((operation) => operation.type)).toEqual([
			"math",
			"math",
			"binary",
			"binary",
			"constant",
			"binary",
			"math",
			"binary",
		]);
		const decoded = deserializeVmDefinition(serializeVmDefinition(definition));
		expect(numericHofRegions(decoded)).toEqual(regions);
		const emitted = emitVmDefinition(decoded, { compiled: true });
		const region = regions[0]!;
		const regionOwner = definition.functions.find((fn) => fn.regions?.includes(region))!;
		const loopExit = regionOwner.instructions[region.anchors[3]!]!;
		expect(loopExit.opcode).toBe("JUMP");
		const completionIp = loopExit.opcode === "JUMP" ? loopExit.targetIp : -1;
		const regionEntryIp =
			region.dispatch.kind === "guarded"
				? region.dispatch.guardCallIp
				: region.anchors[0]!;
		const mutableAdmission = emitted
			.split("\n")
			.find((line) => line.includes("mal_builtin_array_numeric_fold_local_admit"));
		expect(mutableAdmission).toContain("mal_vm_semantic_dependencies_admit(vm,");
		expect(mutableAdmission).toContain(`r${region.receiver}`);
		// The whole callback becomes straight-line f64 arithmetic, and a completed
		// fold rejoins the untouched region at its accumulator read.
		expect(emitted).toContain(`sqrt(__fold_${regionEntryIp}_element)`);
		expect(emitted).toContain(`sin(__fold_${regionEntryIp}_element)`);
		expect(emitted).toContain(`fabs(__fold_${regionEntryIp}_op5)`);
		expect(emitted).toContain(`goto L${completionIp};`);
		expect(emitted).toContain(
			`mal_perf_numeric_fold_region(__fold_${regionEntryIp}_index, __fold_${regionEntryIp}_length, 3)`,
		);
		const lockedDefinition = compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const lockedEmission = emitVmDefinition(lockedDefinition, { compiled: true });
		const lockedAdmission = lockedEmission
			.split("\n")
			.find((line) => line.includes("mal_builtin_array_numeric_fold_local_admit"));
		expect(lockedAdmission).toBeDefined();
		expect(lockedAdmission).not.toContain("mal_vm_semantic_dependencies_admit");
		const forgedRegion = numericHofRegions(decoded)[0]!;
		(forgedRegion as unknown as { operations: Array<{ type: string }> }).operations = [
			{ type: "bogus" },
		];
		(forgedRegion as unknown as { resultOperand: number }).resultOperand = 0;
		expect(() => serializeVmDefinition(decoded)).toThrow(/numeric-HOF expression plan/);
	});

	it("admits every registered unary Math operation to numeric reduce plans", () => {
		const admitted = mathUnaryOperationKeys.flatMap(([, operation], index) => {
			const source = `
				function run() {
					const values = [];
					for (let i = 0; i < 20; i++) values.push(i / 20);
					let result = 0;
					for (let round = 0; round < 4; round++) {
						result += values.reduce((sum, value) => sum + Math.${operation}(value), 0);
					}
					return result;
				}
				globalThis.result = run();
			`;
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				source,
				`numeric-hof-complete-math-${index}.js`,
				parseScript(source, { strict: false }),
			);
			return numericHofRegions(compileSemanticProgramToVmDefinition(semantic))
				.flatMap((region) => region.operations)
				.filter((candidate) => candidate.type === "math")
				.map((candidate) => candidate.operation);
		});
		expect(admitted).toEqual(mathUnaryOperationKeys.map(([, operation]) => operation));
	});

	it("round-trips a closed locked numeric reduce without method dispatch", () => {
		const source = `
			globalThis.result = [0.25, 1, 4].reduce(
				(sum, value) => sum + Math.sqrt(value),
				0,
			);
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"numeric-hof-closed.js",
			parseScript(source, { strict: false }),
		);
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const regions = numericHofRegions(definition);
		expect(regions).toHaveLength(1);
		expect(regions[0]?.dispatch.kind).toBe("closed");
		expect(regions[0]?.anchors).toHaveLength(4);
		expect(
			definition.functions.some((fn) =>
				fn.instructions.some(
					(instruction) =>
						instruction.opcode === "LOAD_INTRINSIC" &&
						instruction.intrinsic === "__arrayIterationEligible",
				),
			),
		).toBe(false);
		const decoded = deserializeVmDefinition(serializeVmDefinition(definition));
		expect(numericHofRegions(decoded)).toEqual(regions);
		const emitted = emitVmDefinition(decoded, { compiled: true });
		const admission = emitted
			.split("\n")
			.find((line) => line.includes("mal_builtin_array_numeric_fold_local_admit"));
		expect(admission).toBeDefined();
		expect(admission).not.toContain("mal_vm_semantic_dependencies_admit");
	});

	it("rejects stale numeric reduce certificates and unsupported empty plans", () => {
		const source = `
			function run() {
				const values = [];
				for (let i = 0; i < 20; i++) values.push(i);
				let result = 0;
				for (let round = 0; round < 4; round++) {
					result += values.reduce((sum, value) => sum + Math.abs(value), 0);
				}
				return result;
			}
			globalThis.result = run();
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"numeric-hof-invalid.js",
			parseScript(source, { strict: false }),
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		const region = numericHofRegions(definition)[0];
		expect(region).toBeDefined();
		(region as unknown as { anchors: Array<number> }).anchors[3] = -1;
		expect(() => serializeVmDefinition(definition)).toThrow(/invalid region envelope/);

		const zeroSource = `
			function run() {
				const values = [];
				for (let index = 0; index < 20; index++) values.push(index);
				let result = 0;
				for (let round = 0; round < 4; round++) {
					result += values.reduce((sum, value) => sum, 0);
				}
				return result;
			}
			globalThis.result = run();
		`;
		const zeroSemantic = analyzeSourceAndRunSemanticAnalysis(
			zeroSource,
			"numeric-hof-zero.js",
			parseScript(zeroSource, { strict: false }),
		);
		const zeroDefinition = compileSemanticProgramToVmDefinition(zeroSemantic);
		expect(numericHofRegions(zeroDefinition)).toHaveLength(0);
	});

	it("serializes a numeric reduce proof with a non-immediate initial value", () => {
		const source = `
			function run() {
				const values = [];
				for (let index = 0; index < 20; index++) values.push(index);
				let result = 0;
				for (let round = 0; round < 4; round++) {
					result += values.reduce((sum, value) => sum + value, 0.5);
				}
				return result;
			}
			globalThis.result = run();
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"numeric-hof-f64-initial.js",
			parseScript(source, { strict: false }),
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		expect(numericHofRegions(definition)).toHaveLength(1);
		expect(() => serializeVmDefinition(definition)).not.toThrow();
	});

	it("recomputes and persists private aggregate regions after a wire round trip", () => {
		const source = `
			function control() {
				function classify(values) {
					let sum = 0, errors = 0;
					for (const value of values) {
						try { if (value % 7 === 0) throw "div7"; sum += value % 100; }
						catch (error) { errors = errors + 1; }
					}
					return sum + errors * 1000;
				}
				const data = [];
				for (let index = 0; index < 20; index++) data.push(index * 31 + 1);
				let result = 0;
				for (let round = 0; round < 4; round++) result += classify(data);
				return result;
			}
			globalThis.result = control();
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"private-aggregate-wire.js",
			parseScript(source, { strict: false }),
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		const decoded = deserializeVmDefinition(serializeVmDefinition(definition));
		const output = emitVmDefinition(decoded, { compiled: true });
		expect(output).toContain("MalPrivateAggregateMemo __private_aggregate_memo_");
		const regions = decoded.functions.flatMap(
			(fn) =>
				fn.regions?.filter((region) => region.kind === "private-aggregate-memo") ?? [],
		);
		expect(regions).toHaveLength(1);
		const region = regions[0]!;
		expect(region.claimedIps).toEqual([
			region.allocationIp,
			...region.constructionPushIps,
			region.callIp,
		]);
		expect(region.license.guard.dependencies).toEqual([
			{ kind: "epoch", family: "array-elements" },
			{ kind: "epoch", family: "primitive-methods" },
			{ kind: "epoch", family: "watched-methods" },
		]);
		const persisted = deserializeVmDefinition(
			serializeVmDefinition(decoded, { debugInfo: false }),
		);
		expect(
			persisted.functions.flatMap(
				(fn) =>
					fn.regions?.filter(
						(candidate) => candidate.kind === "private-aggregate-memo",
					) ?? [],
			),
		).toEqual([region]);
		expect(emitVmDefinition(persisted, { compiled: true })).toContain(
			"MalPrivateAggregateMemo __private_aggregate_memo_",
		);
	});

	it("rejects observable reducers and aggregate aliases", () => {
		const output = emit(`
			let calls = 0;
			function control(leak) {
				function classify(values) {
					let sum = 0;
					for (const value of values) { calls++; sum += value; }
					return sum;
				}
				const data = [];
				for (let index = 0; index < 20; index++) data.push(index);
				leak.value = data;
				let result = 0;
				for (let round = 0; round < 4; round++) result += classify(data);
				return result;
			}
			globalThis.control = control;
		`);
		expect(output).not.toContain("MalPrivateAggregateMemo __private_aggregate_memo_");
	});

	it("rejects mixed caught payloads used as Numbers", () => {
		const output = emit(`
			function control() {
				function classify(values) {
					let sum = 0;
					for (const value of values) {
						try {
							if (value % 2 === 0) throw 1;
							throw "not-a-number";
						} catch (error) {
							sum = sum + error;
						}
					}
					return sum;
				}
				const data = [];
				for (let index = 0; index < 20; index++) data.push(index);
				let result = 0;
				for (let round = 0; round < 4; round++) result = result + classify(data);
				return result;
			}
			globalThis.result = control();
		`);
		expect(output).not.toContain("MalPrivateAggregateMemo __private_aggregate_memo_");
	});

	it("uses a relational loop proof for bounded primitive String charCodeAt", () => {
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
		expect(output).toContain("mal_builtin_string_char_code_at_in_bounds(");
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

	it("summarizes a closed inlined String scan allocation region", () => {
		const program = loadEntrypointAndRunSemanticAnalysis(path.resolve("bench/gc/cli.js"));
		const definition = compileSemanticProgramToVmDefinition(program);
		const output = emitVmDefinition(definition, {
			compiled: true,
		});
		const owner = definition.functions.find((fn) =>
			fn.regions?.some((region) => region.kind === "string-scan-summary"),
		);
		expect(owner).toBeDefined();
		const region = owner!.regions!.find(
			(candidate) => candidate.kind === "string-scan-summary",
		)!;
		if (region.kind !== "string-scan-summary")
			throw new Error("missing String scan region");
		expect(region.claimedIps).toEqual([
			...Array.from(
				{ length: region.exitIp - region.entryIp },
				(_unused, offset) => region.entryIp + offset,
			),
			region.lengthLoadIp,
		]);
		expect(region.controlFlow.exceptionalHandlerIps).toEqual([]);
		expect(region.license.guard.dependencies).toEqual([
			{ kind: "epoch", family: "array-elements" },
			{ kind: "epoch", family: "primitive-methods" },
			{ kind: "epoch", family: "watched-methods" },
		]);
		const restored = deserializeVmDefinition(
			serializeVmDefinition(definition, { debugInfo: false }),
		);
		expect(
			restored.functions.flatMap(
				(fn) =>
					fn.regions?.filter((candidate) => candidate.kind === "string-scan-summary") ??
					[],
			),
		).toEqual([region]);
		expect(output).toContain("mal_vm_try_string_scan_summary(vm,");
		expect(output).toMatch(/if \(__string_scan_\d+_fast\) \{/);
		expect(output).toMatch(/goto L\d+;/);

		const regionIndex = owner!.regions!.indexOf(region);
		const functionIndex = definition.functions.indexOf(owner!);
		const malformed: VmDefinition = {
			...definition,
			functions: definition.functions.with(functionIndex, {
				...owner!,
				regions: owner!.regions!.with(regionIndex, {
					...region,
					claimedIps: region.claimedIps.slice(1),
				}),
			}),
		};
		expect(() => serializeVmDefinition(malformed)).toThrow(
			/invalid region envelope|invalid String scan region/,
		);
	});

	it("keeps an inlined String scan generic when an aggregate record escapes", () => {
		const output = emit(`
			const tokenize = function tokenize(line) {
				const out = [];
				let count = 0;
				for (let index = 0; index < line.length; index++) {
					const code = line.charCodeAt(index);
					if (code === 32) {
						out.push({ kind: "separator", index });
						count++;
					} else {
						out.push({ kind: "character", code, index });
					}
				}
				return { tokens: out, count };
			};
			let checksum = 0;
			for (let iteration = 0; iteration < 6000; iteration++) {
				const result = tokenize("a b " + iteration);
				checksum += result.tokens[0].index + result.count;
			}
			globalThis.checksum = checksum;
		`);
		expect(output).not.toContain("mal_vm_try_string_scan_summary(vm,");
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

	it("carries IR-selected split projection licenses through lowering", () => {
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
	});

	it("carries IR-selected RegExp.exec projections through lowering and wire", () => {
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
	});

	it("carries IR-selected String.slice Number regions through lowering and wire", () => {
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

	it("carries IR-selected RegExp iterator projections through lowering and wire", () => {
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
	});

	it("carries IR-selected split cursor licenses through lowering", () => {
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
		expect(emitVmDefinition(cached, { compiled: true })).toContain(
			"mal_builtin_string_split_cursor_init(vm,",
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

	it("projects exact locked primitive String split calls after IR dispatch erasure", () => {
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

	it("fuses a closed String search over a fresh RegExp literal", () => {
		const source = `
			function locate(value) {
				return value.search(/needle=/);
			}
			globalThis.locate = locate;
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"string-search-regexp-region.js",
			parseScript(source, { strict: false }),
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		const output = emitVmDefinition(definition, { compiled: true });
		expect(output).toContain("mal_builtin_string_search_literal_direct(vm,");
		expect(output).toContain("mal_builtin_string_search_regexp_direct(vm,");
		expect(output).toContain("mal_vm_construct_value(vm,");
		expect(output).toContain("mal_vm_call_cached(vm,");
		const regions = definition.functions.flatMap(
			(fn) =>
				fn.regions?.filter((region) => region.kind === "string-search-regexp") ?? [],
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			representation: "fresh-regexp-string-search",
			composition: "overlay",
			license: {
				guard: { dependencies: [], obligations: ["fallback", "materialize"] },
				genericTwin: "retained",
				materialization: "on-demand",
			},
		});
		const restored = deserializeVmDefinition(
			serializeVmDefinition(definition, { debugInfo: false }),
		);
		expect(
			restored.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "string-search-regexp") ?? [],
			),
		).toEqual(regions);
	});

	it("keeps RegExp literals materialized when fixed search proof does not apply", () => {
		for (const source of [
			`function locate(value) { return value.search(/need.e=/); }`,
			`function locate(value) { return value.search(/needle=/i); }`,
			`function locate(value) { return value.search(/needle\\=/); }`,
			`function locate(value) { const regexp = /needle=/; consume(regexp); return value.search(regexp); }`,
		]) {
			const output = emit(`${source} globalThis.locate = locate;`);
			expect(output).not.toContain("mal_builtin_string_search_literal_direct(vm,");
		}
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

describe("activation-local invariant JSON.parse templates", () => {
	function compile(source: string): { definition: VmDefinition; output: string } {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"invariant-json-parse-cache.js",
			parseScript(source, { strict: false }),
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		return {
			definition,
			output: emitVmDefinition(definition, { compiled: true }),
		};
	}

	it("emits a dedicated rooted template for an exact no-reviver parse loop", () => {
		const { definition, output } = compile(`
			"use strict";
			function repeated(text) {
				let total = 0;
				for (let index = 0; index < 4; index++) total += JSON.parse(text)[0].id;
				return total;
			}
			globalThis.repeated = repeated;
		`);

		expect(output).toContain("MalInvariantJsonParseCache __invariant_json_parse_");
		expect(output).toContain("mal_builtin_json_parse_cache_try_clone");
		expect(output).toContain("mal_builtin_json_parse_cache_fill");
		const regions = definition.functions.flatMap(
			(fn) =>
				fn.regions?.filter((region) => region.kind === "invariant-json-parse-cache") ??
				[],
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			representation: "activation-local-json-parse-template",
			composition: "overlay",
			license: {
				guard: { dependencies: [], obligations: ["fallback"] },
				genericTwin: "retained",
				materialization: "none",
			},
		});
		const restored = deserializeVmDefinition(
			serializeVmDefinition(definition, { debugInfo: false }),
		);
		expect(
			restored.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "invariant-json-parse-cache") ??
					[],
			),
		).toEqual(regions);
	});

	it("rejects reviver calls and one-shot parse sites", () => {
		const { definition, output } = compile(`
			"use strict";
			function revived(text, callback) { return JSON.parse(text, callback); }
			function once(text) { return JSON.parse(text); }
			globalThis.keep = [revived, once];
		`);

		expect(output).not.toContain("MalInvariantJsonParseCache __invariant_json_parse_");
		expect(output).not.toContain("mal_builtin_json_parse_cache_try_clone");
		expect(
			definition.functions.some((fn) =>
				fn.regions?.some((region) => region.kind === "invariant-json-parse-cache"),
			),
		).toBe(false);
	});
});

describe("linked invariant JSON.parse map templates", () => {
	const projection = `
		function factory(rate = 0) {
			return function normalize({
				id, customer = "guest", qty = 1, price = 0, discount = 0, meta, ...rest
			}) {
				return {
					...rest, id, customer, qty,
					net: Math.round((qty * price - discount) * (1 + rate)),
					region: meta?.region ?? "unknown",
				};
			};
		}
	`;

	function annotated(source: string): VmDefinition {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"invariant-json-map-template.js",
			parseScript(source, { strict: false }),
		);
		const compiled = compileSemanticProgramToVmDefinition(semantic);
		const postWire = deserializeVmDefinition(serializeVmDefinition(compiled));
		emitVmDefinition(postWire, { compiled: true });
		return deserializeVmDefinition(serializeVmDefinition(postWire));
	}

	const templateCount = (definition: VmDefinition) =>
		definition.functions.reduce(
			(count, fn) =>
				count +
				(fn.regions?.filter((region) => region.kind === "invariant-json-map-template")
					.length ?? 0),
			0,
		);

	it("recomputes and persists one exact post-wire primitive projection region", () => {
		const definition = annotated(`${projection}
			function repeated(text) {
				const normalize = factory(0.1);
				let total = 0;
				for (let index = 0; index < 4; index++) {
					const rows = JSON.parse(text).map(normalize);
					total += rows.length;
				}
				return total;
			}
			globalThis.repeated = repeated;
		`);
		expect(templateCount(definition)).toBe(1);
		const template = definition.functions
			.flatMap((fn) => fn.regions ?? [])
			.find((region) => region.kind === "invariant-json-map-template");
		if (template?.kind !== "invariant-json-map-template") {
			throw new Error("missing invariant JSON map template region");
		}
		expect(template.representation).toBe("activation-local-json-map-template");
		expect(template.license.materialization).toBe("whole-region");
		expect(template.license.guard.obligations).toEqual(["fallback", "materialize"]);
		expect(template.anchors).toEqual([template.parseCallIp, template.mapCallIp]);
		expect(template.claimedIps).toEqual([
			template.parseCallIp,
			template.mapLoadIp,
			template.mapCallIp,
		]);
		expect(template.captures).toHaveLength(1);
		expect(template.primitiveRowStringIndices).toHaveLength(5);
		expect(template.excludedStringIndices).toHaveLength(6);
		expect(template.rowPropertyLoads).toBe(7);
		const output = emitVmDefinition(definition, { compiled: true });
		expect(output).toContain("MalInvariantJsonMapTemplate __invariant_json_map_");
		expect(output).toContain("mal_builtin_json_map_template_try_clone");
		expect(output).toContain("mal_builtin_json_map_template_fill");
		expect(output).toContain("vm->intrinsics[MAL_INTRINSIC_JSON]");
	});

	it("rejects object-producing effects and capture writers after closure creation", () => {
		const effectful = annotated(`
			function factory(rate) {
				return function normalize({id, customer, qty, price, discount, meta, ...rest}) {
					return {...rest, id, customer, qty,
						net: Math.round((qty * price - discount) * (1 + rate.valueOf())),
						region: meta?.region ?? "unknown"};
				};
			}
			function repeated(text) {
				const normalize = factory({valueOf() { globalThis.effect = 1; return 0; }});
				for (let index = 0; index < 4; index++) JSON.parse(text).map(normalize);
			}
		`);
		expect(templateCount(effectful)).toBe(0);

		const writtenCapture = annotated(`
			function factory(rate = 0) {
				const callback = function normalize({
					id, customer = "guest", qty = 1, price = 0, discount = 0, meta, ...rest
				}) {
					return {...rest, id, customer, qty,
						net: Math.round((qty * price - discount) * (1 + rate)),
						region: meta?.region ?? "unknown"};
				};
				rate = 2;
				return callback;
			}
			function repeated(text) {
				const normalize = factory(0.1);
				for (let index = 0; index < 4; index++) JSON.parse(text).map(normalize);
			}
		`);
		expect(templateCount(writtenCapture)).toBe(0);
	});

	it("rejects a published parse result and a loop-carried callback overwrite", () => {
		const published = annotated(`${projection}
			let leaked;
			function repeated(text) {
				const normalize = factory(0.1);
				for (let index = 0; index < 4; index++) {
					const parsed = JSON.parse(text);
					leaked = parsed;
					parsed.map(normalize);
				}
			}
		`);
		expect(templateCount(published)).toBe(0);

		const overwritten = annotated(`${projection}
			function repeated(text) {
				let normalize = factory(0.1);
				for (let index = 0; index < 4; index++) {
					JSON.parse(text).map(normalize);
					normalize = (row) => row;
				}
			}
		`);
		expect(templateCount(overwritten)).toBe(0);
	});
});
