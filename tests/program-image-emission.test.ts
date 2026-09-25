import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { directBuiltinOperationIds } from "../src/compiler/shared/builtin-registry.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { knownOperationIndex } from "../src/compiler/shared/known-operations.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	DEFAULT_TRANSLATION_UNIT_POLICY,
	emitBatch,
	emitProgramImage,
	emitProgramTranslationUnits,
	emitRelocatableNativeOverlayTranslationUnits,
} from "../src/compiler/target/emit-program-image.ts";
import {
	vmRegionActions,
	vmRegionLicense,
	vmSemanticProtectorGuard,
} from "../src/compiler/target/program-image.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import {
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { vmSafepointRootMapsAreTrusted } from "../src/compiler/target/runtime-image.ts";
import { testProgramImage, withNativeFunctionPlan } from "./helpers/program-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function emitProgramTranslationUnitSources(
	image: ProgramImage,
	options: Parameters<typeof emitProgramTranslationUnits>[1] = {},
	maximum?: number,
): Array<string> {
	return emitProgramTranslationUnits(
		image,
		options,
		maximum === undefined
			? undefined
			: { targetCodeUnits: maximum, hardMaximumCodeUnits: maximum },
	).map((unit) => unit.source);
}

function malFunctionRows(source: string): Array<Array<string>> {
	return [...source.matchAll(/^\s+MAL_FUNCTION_ROW\((.*)\),$/gm)].map((match) =>
		match[1]!.split(", "),
	);
}

const instructions: Array<BytecodeInstruction> = [
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
	{
		opcode: "CREATE_MODULE_NAMESPACE",
		cacheSlot: -1,
		dst: 2,
		nameIndices: [1, 2],
		slots: [5, 6],
	},
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
	{
		opcode: "CREATE_PRIVATE_NAMES",
		ownerFunctionIndex: 0,
		capturedIndices: [1, 4],
	},
	{ opcode: "INIT_PRIVATE_FIELDS", object: 6, keyRegisters: [8, 9] },
	{
		opcode: "TYPEOF_COMPARE",
		dst: 7,
		src: 6,
		expected: "number",
		negated: true,
	},
	{ opcode: "RETURN", value: 6 },
];

const fn: BytecodeFunction = {
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
	constructorSlotReserve: 0,
	hasPrototype: false,
	literalShapeCount: 1,
	instructions,
	handlers: [],
	fileIndex: 0,
	positions: [],
};

const definition: ProgramImage = testProgramImage({
	entrypointPath: "/fixture/entry.mjs",
	functionCount: 1,
	functions: [fn],
	stringConstants: [[], ["a".charCodeAt(0)], ["b".charCodeAt(0)], ["c".charCodeAt(0)]],
	bigintConstants: [],
	literalTemplateData: [],
	precompiledLiteralShapes: [],
	globalCount: 7,
	files: [],
	sourcePositions: [],
	cjsModuleFunctionIndices: [],
	hostInstalls: [],
});

function nativeEntryBudgetImage(): ProgramImage {
	const seed = { ...fn, capturedCount: 0, registerCount: 3 };
	const functions: Array<BytecodeFunction> = [
		{
			...seed,
			instructions: [
				{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 1 },
				{ opcode: "CREATE_UNDEFINED", dst: 1 },
				{
					opcode: "CALL",
					dst: 2,
					callee: 0,
					thisValue: 1,
					argumentCount: 0,
					arguments: [],
					exactFunctionIndex: 1,
				},
				{ opcode: "RETURN", value: 2 },
			],
		},
		{
			...seed,
			instructions: [
				{ opcode: "CREATE_F64", dst: 0, value: 3 },
				{ opcode: "CREATE_F64", dst: 1, value: 7 },
				...Array.from(
					{ length: 150 },
					() => ({ opcode: "BINARY", operator: "+", dst: 0, left: 0, right: 1 }) as const,
				),
				{ opcode: "RETURN", value: 0 },
			],
		},
	];
	let image = testProgramImage({ ...definition.runtime, functions, functionCount: 2 });
	image = withNativeFunctionPlan(image, 0, (plan) => ({
		...plan,
		instructions: plan.instructions.with(2, {
			kind: "call",
			directFunctionIndex: 1,
			directEntryId: 0,
		}),
	}));
	image = withNativeFunctionPlan(image, 1, (plan) => ({
		...plan,
		registerRepresentations: ["number", "number", "boxed"],
		gc: { safepoints: [] },
		directEntries: [
			{
				id: 0,
				parameterRepresentations: [],
				resultRepresentation: "number",
				registerRepresentations: ["boxed", "boxed", "boxed"],
				gc: plan.gc,
			},
		],
	}));
	return image;
}

function specializations(definition: ProgramImage) {
	return definition.native.functions.flatMap((fn) => fn.specializations);
}

function classConstructorSlotReserve(source: string): number {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"constructor-slot-reserve.js",
		parseScript(source, { strict: false }),
	);
	const constructors = compileSemanticProgramToProgramImage(
		semantic,
	).runtime.functions.filter((fn) => fn.isClassConstructor);
	expect(constructors).toHaveLength(1);
	return constructors[0]!.constructorSlotReserve;
}

function withSpecializations(
	definition: ProgramImage,
	functionIndex: number,
	next: ProgramImage["native"]["functions"][number]["specializations"],
): ProgramImage {
	const owner = definition.native.functions[functionIndex]!;
	return {
		...definition,
		native: {
			...definition.native,
			functions: definition.native.functions.with(functionIndex, {
				...owner,
				specializations: next,
				regionActions: vmRegionActions(next),
			}),
		},
	};
}

describe("emit-program-image instruction packing", () => {
	it("reserves slots for base constructor own-property writes", () => {
		expect(
			classConstructorSlotReserve(`
				class Record {
					constructor(value) {
						this.first = value;
						this.second = value + 1;
						this.first = value + 2;
					}
				}
				globalThis.Record = Record;
			`),
		).toBe(2);
		expect(
			classConstructorSlotReserve(`
				class Record {
					first = 1;
					second = 2;
				}
				globalThis.Record = Record;
			`),
		).toBe(2);
		expect(
			classConstructorSlotReserve(`
				class Record extends Object {
					constructor(value) {
						super();
						this.first = value;
					}
				}
				globalThis.Record = Record;
			`),
		).toBe(0);
	});

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
			{ anchorIp: 0, mode: "per-use" },
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
			admission: { anchorIp: 0, mode: "per-use" },
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
			runtime: {
				...definition.runtime,
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
			},
		};
		expect(emitProgramImage(descriptorDefinition, { compiled: false })).toContain(
			".as.define_property = { .object = 1, .key = 2, .value = 3, .enumerable = true, .writable = false, .configurable = false }",
		);
	});

	it("uses static define helpers only for non-index string keys", () => {
		const emitDefine = (key: string): string => {
			const defineInstructions: Array<BytecodeInstruction> = [
				{ opcode: "CREATE_OBJECT", dst: 0 },
				{ opcode: "CREATE_UNDEFINED", dst: 2 },
				{ opcode: "CREATE_STRING", dst: 1, stringIndex: 0 },
				{
					opcode: "DEFINE_PROPERTY",
					object: 0,
					key: 1,
					value: 2,
					enumerable: true,
					writable: true,
					configurable: true,
				},
				{ opcode: "RETURN", value: 0 },
			];
			const defineFunction: BytecodeFunction = {
				...fn,
				capturedCount: 0,
				registerCount: 3,
				literalShapeCount: 0,
				instructions: defineInstructions,
				positions: defineInstructions.map(() => 0),
			};
			const image = testProgramImage({
				entrypointPath: "/fixture/static-define.mjs",
				functionCount: 1,
				functions: [defineFunction],
				stringConstants: [[...key].map((unit) => unit.charCodeAt(0))],
				bigintConstants: [],
				literalTemplateData: [],
				precompiledLiteralShapes: [],
				globalCount: 0,
				files: [],
				sourcePositions: [],
				cjsModuleFunctionIndices: [],
				hostInstalls: [],
			});
			return emitProgramImage(
				{ ...image, native: createConservativeNativePlan([defineFunction]) },
				{ compiled: true },
			);
		};

		expect(emitDefine("field")).toContain("mal_vm_op_define_property_static_cached(");
		expect(emitDefine("0")).not.toContain("mal_vm_op_define_property_static_cached(");
		expect(emitDefine("4294967294")).not.toContain(
			"mal_vm_op_define_property_static_cached(",
		);
		expect(emitDefine("4294967295")).toContain(
			"mal_vm_op_define_property_static_cached(",
		);
	});

	it("emits every registered direct builtin operation into interpreted C", () => {
		for (const operation of directBuiltinOperationIds) {
			const emitted = emitProgramImage(
				{
					...definition,
					runtime: {
						...definition.runtime,
						functions: [
							{
								...fn,
								instructions: [
									{
										opcode: "CALL_KNOWN",
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
				},
				{ compiled: false },
			);
			expect(emitted).toContain(`.operation = ${knownOperationIndex(operation)! << 4} }`);
		}
	});

	it("emits one flattened side table and raw f64 words", () => {
		const output = emitProgramImage(definition, { compiled: false });
		expect(output).toContain(
			"static const i32 mal_function_0_instruction_data[] = { 2, 1, 2, 3, 4, 2, 1, 2, 5, 6, 2, 1, -1, 2, 3, 2, -1, 0, 7, 8, 0, 1, -1, 0, 9, 2, 10, 11, 3, 0, 2, 3, 2, 1, 4, 2, 8, 9 };",
		);
		for (const offset of [0, 5, 10, 15, 21, 25, 28, 32, 35]) {
			expect(output).toContain(`.data_offset = ${offset}`);
		}
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x80000000u");
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x7ff00000u");
		expect(output).toContain(".bits_low = 0x00000000u, .bits_high = 0x7ff80000u");
		const [functionRow] = malFunctionRows(output);
		expect(functionRow?.[3]).toBe("mal_function_0_instruction_data");
		expect(functionRow?.[22]).toBe("38");
		expect(functionRow?.[12]).toBe("0");
		expect(functionRow?.[13]).toBe("0");
		expect(functionRow?.[0]).toBe("nullptr");
		expect(output).toContain(
			".as.init_global_vars = { .data_offset = 28, .declaration_configurable = true }",
		);
		expect(output).toContain(
			".as.create_private_names = { .owner_function_index = 0, .data_offset = 32 }",
		);
		expect(output).toContain(
			".as.init_private_fields = { .object = 6, .data_offset = 35 }",
		);
		expect(output).toContain(
			".as.typeof_compare = { .dst = 7, .src = 6, .expected = MAL_TYPEOF_NUMBER, .negated = true }",
		);
	});

	it("emits guarded known-own-slot accesses in monolithic and split outputs", () => {
		const specializedInstructions: Array<BytecodeInstruction> = [
			{
				opcode: "CREATE_OBJECT_SHAPED",
				dst: 1,
				count: 2,
				keyStringIndices: [1, 2],
				valueRegisters: [3, 4],
				shapeCacheIndex: 0,
			},
			{
				opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
				dst: 5,
				object: 1,
				stringIndex: 2,
				icIndex: 0,
				candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 1 }],
			},
			{
				opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
				object: 1,
				value: 3,
				stringIndex: 2,
				icIndex: 1,
				candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 1 }],
			},
			{ opcode: "RETURN", value: 5 },
		];
		const specializedFunction: BytecodeFunction = {
			...fn,
			instructions: specializedInstructions,
			positions: specializedInstructions.map(() => 0),
		};
		const specialized: ProgramImage = {
			...definition,
			runtime: {
				...definition.runtime,
				precompiledLiteralShapes: [
					{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [1, 2] },
				],
				functions: [specializedFunction],
			},
			native: createConservativeNativePlan([specializedFunction]),
		};
		const interpreted = emitProgramImage(specialized, { compiled: false });
		const compiled = emitProgramImage(specialized, { compiled: true });
		const split = emitProgramTranslationUnitSources(
			specialized,
			{ compiled: true },
			Number.MAX_SAFE_INTEGER,
		).join("\n");
		const splitInterpreted = emitProgramTranslationUnitSources(
			specialized,
			{ compiled: false },
			Number.MAX_SAFE_INTEGER,
		).join("\n");

		for (const output of [interpreted, splitInterpreted]) {
			expect(output).toContain("MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
			expect(output).toContain("MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT");
			expect(output).toContain(".load_property_static_known_own_slot");
			expect(output).toContain(".store_property_static_known_own_slot");
			expect(output).toContain("2, 1, 0, 0, 1");
		}
		for (const output of [interpreted, compiled, split, splitInterpreted]) {
			expect(output).toContain(
				"MalPrecompiledLiteralShape mal_precompiled_literal_shapes",
			);
			expect(output).toContain(".function_index = 0, .shape_cache_index = 0");
			expect(output).toContain(".precompiled_literal_shape_count = 1");
		}
		for (const output of [compiled, split]) {
			// Compiled functions omit bytecode, but their compact seed metadata must
			// remain in the otherwise-unused instruction-data field so the packed
			// MalFunction row does not grow.
			const [functionRow] = malFunctionRows(output);
			expect(functionRow?.[21]).toBe("0");
			expect(functionRow?.[2]).toBe("nullptr");
			expect(functionRow?.[3]).toBe("mal_function_0_instruction_data");
			expect(functionRow?.[22]).toBe("13");
			expect(output).toContain("{ 2, 0, 2, 1, 0, 0, 1, 1, 2, 1, 0, 0, 1 }");
			expect(output).toContain("mal_vm_try_load_known_own_slots(vm,");
			expect(output).toContain(
				"__builtin_expect(vm->property_cache[0].sites == nullptr || vm->literal_shape_cache[0] == nullptr, 0)",
			);
			expect(output).toMatch(
				/mal_vm_try_load_known_own_slots\(vm,[^\n]+&__property_ic\[0\]/,
			);
			expect(output).toContain("mal_vm_op_load_property_ic(vm,");
			expect(output).toContain("mal_vm_try_store_known_own_slots(vm,");
			expect(output).toMatch(
				/mal_vm_try_store_known_own_slots\(vm,[^\n]+&__property_ic\[1\]/,
			);
			expect(output).toContain("mal_vm_op_store_property_ic(vm,");
		}

		const syntheticInstructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_UNDEFINED", dst: 1 },
			{
				opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
				dst: 5,
				object: 1,
				stringIndex: 2,
				icIndex: 0,
				candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 1 }],
			},
			{ opcode: "RETURN", value: 5 },
		];
		const syntheticFunction: BytecodeFunction = {
			...specialized.runtime.functions[0]!,
			literalShapeCount: 1,
			instructions: syntheticInstructions,
			positions: syntheticInstructions.map(() => 0),
		};
		const synthetic: ProgramImage = {
			...specialized,
			runtime: {
				...specialized.runtime,
				functions: [syntheticFunction],
			},
			native: createConservativeNativePlan([syntheticFunction]),
		};
		for (const output of [
			emitProgramImage(synthetic, { compiled: true }),
			emitProgramImage(synthetic, { compiled: false }),
		]) {
			expect(malFunctionRows(output)[0]?.[20]).toBe("1");
			expect(output).toContain(".shape_cache_index = 0");
		}

		const malformed: ProgramImage = {
			...specialized,
			runtime: {
				...specialized.runtime,
				functions: [
					{
						...specialized.runtime.functions[0]!,
						instructions: specializedInstructions.map((instruction) =>
							instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
								? {
										...instruction,
										candidates: [{ ...instruction.candidates[0]!, slot: 0 }],
									}
								: instruction,
						),
					},
				],
			},
		};
		expect(() => emitProgramImage(malformed)).toThrow(/invalid known-own-slot access/);
		expect(() => emitProgramTranslationUnitSources(malformed)).toThrow(
			/invalid known-own-slot access/,
		);

		const duplicateShapeRowInstructions = [
			specializedInstructions[0]!,
			{ ...specializedInstructions[0]!, dst: 2 },
			...specializedInstructions.slice(1),
		] as Array<BytecodeInstruction>;
		const duplicateShapeRowFunction: BytecodeFunction = {
			...specialized.runtime.functions[0]!,
			instructions: duplicateShapeRowInstructions,
			positions: duplicateShapeRowInstructions.map(() => 0),
		};
		const duplicateShapeRow: ProgramImage = {
			...specialized,
			runtime: {
				...specialized.runtime,
				functions: [duplicateShapeRowFunction],
			},
			native: createConservativeNativePlan([duplicateShapeRowFunction]),
		};
		expect(() => emitProgramImage(duplicateShapeRow)).toThrow(/literal shape index/);
	});

	it("emits terminal yields for interpreted and compiled generators", () => {
		const terminal = {
			...definition,
			runtime: {
				...definition.runtime,
				functions: [
					{
						...fn,
						isGenerator: true,
						instructions: [
							{ opcode: "GENERATOR_START" },
							{ opcode: "TERMINAL_YIELD", yieldedSrc: 6 },
						] as Array<BytecodeInstruction>,
					},
				],
			},
			native: createConservativeNativePlan([
				{
					...fn,
					isGenerator: true,
					instructions: [
						{ opcode: "GENERATOR_START" },
						{ opcode: "TERMINAL_YIELD", yieldedSrc: 6 },
					] as Array<BytecodeInstruction>,
				},
			]),
		};
		expect(emitProgramImage(terminal, { compiled: false })).toContain(
			".opcode = MAL_OP_TERMINAL_YIELD, .as.terminal_yield = { .yielded_src = 6 }",
		);
		expect(emitProgramImage(terminal)).toContain("mal_vm_op_terminal_yield_compiled");
	});

	it("emits and references shared side tables in batches", () => {
		const output = emitBatch([definition, definition], { compiled: false });
		expect(output).toContain("static const i32 mal_shared_insn_data_");
		expect(
			malFunctionRows(output).filter((row) =>
				row[3]?.startsWith("mal_shared_insn_data_"),
			),
		).toHaveLength(2);
	});

	it("rejects malformed runtime proofs from ordinary and batch C output", () => {
		const invalidCallFunction: BytecodeFunction = {
			...fn,
			instructions: fn.instructions.map((instruction) =>
				instruction.opcode === "CALL"
					? { ...instruction, callee: fn.registerCount }
					: instruction,
			),
		};
		const invalidCall: ProgramImage = {
			...definition,
			runtime: { ...definition.runtime, functions: [invalidCallFunction] },
			native: createConservativeNativePlan([invalidCallFunction]),
		};

		const exactLengthInstructions: Array<BytecodeInstruction> = [
			{
				opcode: "LOAD_PROPERTY_STATIC_ARRAY_LENGTH",
				dst: 0,
				object: 1,
				stringIndex: 0,
				icIndex: 0,
			},
			{ opcode: "RETURN", value: 0 },
		];
		const invalidLengthFunction: BytecodeFunction = {
			...fn,
			registerCount: 2,
			literalShapeCount: 0,
			instructions: exactLengthInstructions,
			positions: [0, 0],
			handlers: [],
		};
		const invalidLength: ProgramImage = {
			...definition,
			runtime: {
				...definition.runtime,
				stringConstants: [Array.from("other", (unit) => unit.charCodeAt(0))],
				functions: [invalidLengthFunction],
			},
			native: createConservativeNativePlan([invalidLengthFunction]),
		};

		for (const output of [
			(image: ProgramImage) => emitProgramImage(image),
			(image: ProgramImage) => emitBatch([image], { compiled: false }),
		]) {
			expect(() => output(invalidCall)).toThrow(/invalid VM value operand/);
			expect(() => output(invalidLength)).toThrow(/invalid exact Array length operation/);
		}
	});

	it("emits native bulk-private helper calls", () => {
		const output = emitProgramImage(definition);
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
			runtime: {
				...definition.runtime,
				functionCount: functions.length,
				functions,
			},
			native: createConservativeNativePlan(functions),
		};
		const budget = 24_000;
		const units = emitProgramTranslationUnitSources(splitDefinition, {}, budget);

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

	it("locks the measured translation-unit policy independently of scheduling", () => {
		expect(DEFAULT_TRANSLATION_UNIT_POLICY).toEqual({
			targetCodeUnits: 2 * 1024 * 1024,
			hardMaximumCodeUnits: 8 * 1024 * 1024,
		});
	});

	it("keeps emission behavior fixed while the soft target changes", () => {
		const functions = Array.from({ length: 24 }, () => ({
			...fn,
			instructions: [...fn.instructions],
		}));
		const image = {
			...definition,
			runtime: {
				...definition.runtime,
				functionCount: functions.length,
				functions,
			},
			native: createConservativeNativePlan(functions),
		};
		const emit = (targetCodeUnits: number) =>
			emitProgramTranslationUnits(
				image,
				{},
				{
					targetCodeUnits,
					hardMaximumCodeUnits: 200_000,
				},
			);
		const small = emit(12_000);
		const large = emit(80_000);
		const behavior = (units: ReturnType<typeof emit>) => ({
			runtime: units.find((unit) => unit.kind === "runtime-image")!.source,
			definitions: units
				.flatMap((unit) => unit.definitions)
				.map((item) => `${item.kind}:${item.symbol}:${item.sourceCodeUnits}`)
				.sort(),
		});

		expect(behavior(small)).toEqual(behavior(large));
		expect(small.length).toBeGreaterThan(large.length);
		expect(small.some((unit) => unit.kind === "data")).toBe(true);
		expect(small.some((unit) => unit.kind === "code")).toBe(true);
		for (const unit of small) {
			expect(
				unit.definitions.every((definition) =>
					unit.kind === "code"
						? definition.kind === "compiled function"
						: definition.kind === "data array",
				),
			).toBe(true);
		}
	});

	it("keeps a definition above the soft target native and isolated", () => {
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
		const functions = [{ ...fn, capturedCount: 0, registerCount: 3, instructions }];
		const units = emitProgramTranslationUnits(
			{
				...definition,
				runtime: {
					...definition.runtime,
					functionCount: 1,
					functions,
				},
				native: createConservativeNativePlan(functions),
			},
			{},
			{ targetCodeUnits: 20_000, hardMaximumCodeUnits: 200_000 },
		);
		const compiledUnit = units.find((unit) =>
			unit.definitions.some((item) => item.symbol === "mal_compiled_0"),
		)!;

		expect(compiledUnit.source.length).toBeGreaterThan(20_000);
		expect(compiledUnit.definitions).toHaveLength(1);
		expect(compiledUnit.kind).toBe("code");
		expect(units.map((unit) => unit.source).join("\n")).toContain(
			"MalValue mal_compiled_0(MalVm *vm",
		);
	});

	it("keeps hash-partitioned unit identities local when one function grows", () => {
		const functions = Array.from({ length: 64 }, () => ({
			...fn,
			instructions: [...fn.instructions],
		}));
		const image = {
			...definition,
			runtime: {
				...definition.runtime,
				functionCount: functions.length,
				functions,
			},
			native: createConservativeNativePlan(functions),
		};
		const changedFunctions = functions.with(10, {
			...functions[10]!,
			registerCount: 3,
			instructions: [
				...Array.from({ length: 20 }, () => ({
					opcode: "CALL" as const,
					dst: 0,
					callee: 1,
					thisValue: 2,
					argumentCount: 0,
					arguments: [],
				})),
				{ opcode: "RETURN" as const, value: 0 },
			],
		});
		const changed = {
			...image,
			runtime: { ...image.runtime, functions: changedFunctions },
			native: createConservativeNativePlan(changedFunctions),
		};
		const policy = { targetCodeUnits: 16_000, hardMaximumCodeUnits: 200_000 };
		const locations = (value: ProgramImage) =>
			new Map(
				emitProgramTranslationUnits(value, {}, policy).flatMap((unit) =>
					unit.kind === "code"
						? unit.definitions.map((item) => [item.symbol, unit.id] as const)
						: [],
				),
			);
		const before = locations(image);
		const after = locations(changed);
		const following = [...before].filter(([symbol]) => {
			const match = /^mal_compiled_(\d+)$/.exec(symbol);
			return match !== null && Number(match[1]) > 10;
		});
		const stable = following.filter(([symbol, id]) => after.get(symbol) === id);

		expect(stable.length).toBeGreaterThan(0);
		expect(stable.length).toBeGreaterThan(following.length / 2);
	});

	it("keeps named function partition identities local across an insertion", () => {
		const firstNameIndex = definition.runtime.stringConstants.length;
		const names = Array.from({ length: 64 }, (_, index) => `function_${String(index)}`);
		const stringConstants = [
			...definition.runtime.stringConstants,
			...names.map((name) => [...name].map((character) => character.charCodeAt(0))),
			[..."inserted"].map((character) => character.charCodeAt(0)),
		];
		const functions = names.map((_name, index) => ({
			...fn,
			nameStringIndex: firstNameIndex + index,
			instructions: [...fn.instructions],
		}));
		const image = {
			...definition,
			runtime: {
				...definition.runtime,
				functionCount: functions.length,
				functions,
				stringConstants,
			},
			native: createConservativeNativePlan(functions),
		};
		const inserted = {
			...fn,
			nameStringIndex: stringConstants.length - 1,
			instructions: [...fn.instructions],
		};
		const insertedFunctions = [
			...functions.slice(0, 10),
			inserted,
			...functions.slice(10),
		];
		const changed = {
			...definition,
			runtime: {
				...definition.runtime,
				functionCount: insertedFunctions.length,
				functions: insertedFunctions,
				stringConstants,
			},
			native: createConservativeNativePlan(insertedFunctions),
		};
		const policy = { targetCodeUnits: 16_000, hardMaximumCodeUnits: 200_000 };
		const locations = (value: ProgramImage) => {
			const byName = new Map<string, string>();
			for (const unit of emitProgramTranslationUnits(value, {}, policy)) {
				if (unit.kind !== "code") continue;
				for (const item of unit.definitions) {
					const match = /^mal_compiled_(\d+)$/.exec(item.symbol);
					if (match === null) continue;
					const runtimeFunction = value.runtime.functions[Number(match[1])]!;
					const codeUnits =
						value.runtime.stringConstants[runtimeFunction.nameStringIndex]!;
					byName.set(String.fromCharCode(...codeUnits), unit.id);
				}
			}
			return byName;
		};
		const before = locations(image);
		const after = locations(changed);
		const stable = names.filter((name) => before.get(name) === after.get(name));

		expect(stable.length).toBeGreaterThan((names.length * 3) / 4);
	});

	it("keeps repeated data partition identities within filesystem limits", () => {
		const units = emitProgramTranslationUnits(
			{
				...definition,
				runtime: {
					...definition.runtime,
					stringConstants: Array.from({ length: 400 }, () =>
						Array.from({ length: 100 }, () => 120),
					),
				},
			},
			{},
			{ targetCodeUnits: 10_000, hardMaximumCodeUnits: 500_000 },
		);
		const dataUnits = units.filter((unit) => unit.kind === "data");

		expect(dataUnits.length).toBeGreaterThan(1);
		expect(dataUnits.every((unit) => unit.id.length < 128)).toBe(true);
		expect(dataUnits.every((unit) => unit.source.length <= 500_000)).toBe(true);
	});

	it("charges split units only for declarations they reference", () => {
		const functions = Array.from({ length: 400 }, () => ({
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
		const units = emitProgramTranslationUnitSources(
			{
				...definition,
				runtime: {
					...definition.runtime,
					functionCount: functions.length,
					functions,
					stringConstants,
				},
				native: createConservativeNativePlan(functions),
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
		const asyncFunction: BytecodeFunction = {
			...fn,
			isAsync: true,
			registerCount: 1,
			instructions: [
				{ opcode: "ASYNC_START" },
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{ opcode: "RETURN", value: 0 },
			],
		};
		const units = emitProgramTranslationUnitSources(
			{
				...definition,
				runtime: {
					...definition.runtime,
					functionCount: 1,
					functions: [asyncFunction],
				},
				native: createConservativeNativePlan([asyncFunction]),
			},
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
			runtime: {
				...definition.runtime,
				functionCount: functions.length,
				functions,
				sourcePositions: instructions.map((_, index) => ({
					line: index + 1,
					column: index,
				})),
			},
			native: createConservativeNativePlan(functions),
		};
		const budget = 30_000;
		const units = emitProgramTranslationUnitSources(
			splitDefinition,
			{ compiled: false },
			budget,
		);
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
		const sourcePositions = Array.from({ length: 3_000 }, (_, index) => ({
			line: index + 1,
			column: index % 80,
		}));
		const stringConstants = Array.from({ length: 800 }, (_, index) =>
			[...String(index).padEnd(80, "x")].map((character) => character.charCodeAt(0)),
		);
		const budget = 100_000;
		const units = emitProgramTranslationUnitSources(
			{
				...definition,
				runtime: {
					...definition.runtime,
					functionCount: functions.length,
					functions,
					sourcePositions,
					stringConstants,
				},
				native: createConservativeNativePlan(functions),
			},
			{},
			budget,
		);
		const definitionUnit = units[0]!;
		const dataUnits = units.slice(1).join("\n");

		expect(units.every((unit) => unit.length <= budget)).toBe(true);
		expect(definitionUnit).toContain("MalFunction mal_functions[400];");
		expect(definitionUnit).toContain("extern MalString mal_strings[];");
		expect(definitionUnit).toContain("MalSourcePos mal_source_positions[3000];");
		expect(definitionUnit).toContain(
			".initialize_generated_data = mal_initialize_generated_data",
		);
		expect(dataUnits).toContain("void mal_initialize_mal_functions_chunk_0(");
		expect(dataUnits).toContain("MalString mal_strings[] = {");
		expect(dataUnits).not.toContain("void mal_initialize_mal_strings_chunk_0(");
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
		const functions = [
			{
				...fn,
				capturedCount: 0,
				registerCount: 3,
				instructions,
			},
		];
		const units = emitProgramTranslationUnitSources(
			{
				...definition,
				runtime: {
					...definition.runtime,
					functionCount: functions.length,
					functions,
				},
				native: createConservativeNativePlan(functions),
			},
			{},
			20_000,
		);
		const output = units.join("\n");

		expect(units.every((unit) => unit.length <= 20_000)).toBe(true);
		expect(output).not.toContain("MalValue mal_compiled_0(MalVm *vm");
		expect(output).toContain("MalInstruction mal_function_0_instructions[201]");
		expect(output).toContain("void mal_initialize_mal_function_0_instructions_chunk_0(");
		expect(malFunctionRows(output)[0]?.[6]).toBe("nullptr");
	});

	it("keeps canonical and typed entry size limits independent at call sites", () => {
		const image = nativeEntryBudgetImage();
		const emit = (value: ProgramImage, budget: number) =>
			emitProgramTranslationUnitSources(value, {}, budget).join("\n");
		expect(emit(image, 60_000)).toContain("mal_direct_1_0(vm,");
		const bounded = emit(image, 15_000);
		expect(bounded).not.toContain("mal_direct_1_0");
		expect(bounded).toContain("mal_compiled_1(vm,");
		const boxed = withNativeFunctionPlan(image, 1, (plan) => ({
			...plan,
			registerRepresentations: ["boxed", "boxed", "boxed"],
			gc: plan.directEntries[0]!.gc,
		}));
		const rejected = emit(boxed, 15_000);
		expect(rejected).not.toContain("mal_compiled_1");
		expect(rejected).not.toContain("mal_direct_1_0");
		expect(rejected).toContain("mal_vm_call_direct(vm,");
	});

	it("withdraws compiled .call callbacks when the target exceeds the emission budget", () => {
		let image = nativeEntryBudgetImage();
		image = withNativeFunctionPlan(image, 0, (plan) => ({
			...plan,
			instructions: plan.instructions.with(2, {
				kind: "call",
				directFunctionCall: true,
				directCallTargetFunctionIndex: 1,
			}),
		}));
		image = withNativeFunctionPlan(image, 1, (plan) => ({
			...plan,
			registerRepresentations: ["boxed", "boxed", "boxed"],
			gc: plan.directEntries[0]!.gc,
			directEntries: [],
		}));
		const emit = (budget: number) =>
			emitProgramTranslationUnitSources(image, {}, budget).join("\n");
		expect(emit(60_000)).toMatch(
			/mal_vm_call_function_call_direct_compiled\(vm, &__cc_\d+, 1, mal_compiled_1,/,
		);
		const rejected = emit(15_000);
		expect(rejected).not.toContain("mal_compiled_1");
		expect(rejected).not.toContain("mal_vm_call_function_call_direct_compiled(");
		expect(rejected).toMatch(/mal_vm_call_function_call_direct\(vm, &__cc_\d+, 1,/);
	});

	it("reports exact typed calls without inventing a callee identity guard", () => {
		const image = nativeEntryBudgetImage();
		const caller = { ...image.runtime.functions[0]!, profileSiteIds: [-1, -1, 0, -1] };
		const plan = image.native.functions[0]!;
		const entry = image.native.functions[1]!.directEntries[0]!;
		const compiled = emitCompiledFunction(
			caller,
			plan,
			0,
			"",
			false,
			"static",
			new Set([1]),
			[],
			new Map([[directCompiledEntryKey(1, entry.id), entry]]),
		);
		expect(compiled?.profileDecisions).toContainEqual({
			instructionIndex: 2,
			operation: "call",
			code: "call.direct-native",
			outcome: "applied",
			details: { opcode: "CALL" },
		});
		const fallback = emitCompiledFunction(caller, plan, 0, "", false);
		expect(fallback?.profileDecisions).toContainEqual({
			instructionIndex: 2,
			operation: "call",
			code: "call.direct-compiled",
			outcome: "guarded",
			reasonCode: "callee-identity-guard",
			details: { opcode: "CALL" },
		});
	});

	it("rejects an invalid translation-unit budget", () => {
		expect(() => emitProgramTranslationUnitSources(definition, {}, 0)).toThrow(
			/positive integer/,
		);
		expect(() => emitProgramTranslationUnitSources(definition, {}, 100)).toThrow(
			/generated runtime-image translation unit/,
		);
	});

	it("emits a wire-matched native overlay with relocated program coordinates", () => {
		const relocatableInstructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_STRING", dst: 0, stringIndex: 1 },
			{ opcode: "LOAD_GLOBAL", dst: 1, index: 2 },
			{ opcode: "CREATE_FUNCTION", dst: 2, functionIndex: 0 },
			{ opcode: "RETURN", value: 1 },
		];
		const relocatableFunction: BytecodeFunction = {
			...fn,
			registerCount: 3,
			capturedCount: 1,
			instructions: relocatableInstructions,
			positions: [],
		};
		const relocatable: ProgramImage = {
			...definition,
			runtime: {
				...definition.runtime,
				functions: [relocatableFunction],
			},
			native: createConservativeNativePlan([relocatableFunction]),
		};
		const digest = "a".repeat(64);
		const output = emitRelocatableNativeOverlayTranslationUnits(relocatable, digest)
			.map((unit) => unit.source)
			.join("\n");

		expect(output).toContain(`.wire_digest = "${digest}"`);
		expect(output).toContain("mal_eval_compiler_native_entries");
		expect(output).toContain("const MalNativeProgramRelocation *__mal_relocation");
		expect(output).toContain("__mal_relocation->function_base + 0");
		expect(output).toContain("__mal_relocation->global_base + 2");
		expect(output).toContain("__mal_relocation->string_base + 1");
		expect(output).not.toContain("mal_strings_eval_compiler");
		expect(output).not.toContain("mal_direct_");
	});

	it("keeps native-overlay partition identities local across an insertion", () => {
		const firstNameIndex = definition.runtime.stringConstants.length;
		const names = Array.from({ length: 64 }, (_, index) => `overlay_${String(index)}`);
		const stringConstants = [
			...definition.runtime.stringConstants,
			...names.map((name) => [...name].map((character) => character.charCodeAt(0))),
			[..."inserted"].map((character) => character.charCodeAt(0)),
		];
		const functions = names.map((_name, index) => ({
			...fn,
			nameStringIndex: firstNameIndex + index,
			instructions: [...fn.instructions],
		}));
		const image = {
			...definition,
			runtime: {
				...definition.runtime,
				functionCount: functions.length,
				functions,
				stringConstants,
			},
			native: createConservativeNativePlan(functions),
		};
		const insertedFunctions = [
			...functions.slice(0, 10),
			{
				...fn,
				nameStringIndex: stringConstants.length - 1,
				instructions: [...fn.instructions],
			},
			...functions.slice(10),
		];
		const changed = {
			...definition,
			runtime: {
				...definition.runtime,
				functionCount: insertedFunctions.length,
				functions: insertedFunctions,
				stringConstants,
			},
			native: createConservativeNativePlan(insertedFunctions),
		};
		const locations = (value: ProgramImage) => {
			const byName = new Map<string, string>();
			for (const unit of emitRelocatableNativeOverlayTranslationUnits(
				value,
				"a".repeat(64),
				30_000,
			)) {
				for (const item of unit.definitions) {
					const match = /^mal_compiled_(\d+)_eval_compiler$/.exec(item.symbol);
					if (match === null) continue;
					const runtimeFunction = value.runtime.functions[Number(match[1])]!;
					const codeUnits =
						value.runtime.stringConstants[runtimeFunction.nameStringIndex]!;
					byName.set(String.fromCharCode(...codeUnits), unit.id);
				}
			}
			return byName;
		};
		const before = locations(image);
		const after = locations(changed);
		const stable = names.filter((name) => before.get(name) === after.get(name));

		expect(stable.length).toBeGreaterThan((names.length * 3) / 4);
	});

	it("emits trusted portable root tables only for verified in-process lowering", () => {
		const source = `
			function* keep(flag) {
				const live = { value: 42 };
				const dead = { value: 1 };
				if (flag) yield live;
				return live.value + dead.value;
			}
			globalThis.keep = keep;
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"portable-root-maps.js",
			parseScript(source, { strict: false }),
		);
		const output = emitProgramImage(compileSemanticProgramToProgramImage(semantic), {
			compiled: false,
		});
		const trusted = malFunctionRows(output).find((row) => row[30] === "true");
		expect(trusted).toBeDefined();
		expect(output).toMatch(/mal_function_\d+_gc_safepoints\[\] = \{ \d+, \d+/);
		expect(trusted?.[4]).toMatch(/mal_function_\d+_gc_safepoints/);
		expect(Number(trusted?.[23])).toBeGreaterThan(0);
	});

	it.each([
		{ rootCount: 64, liveCounts: [64, 60, 58], scannedSlots: 182 },
		{ rootCount: 70, liveCounts: [70, 66, 64], scannedSlots: 200 },
		{ rootCount: 130, liveCounts: [130, 66, 2], scannedSlots: 262 },
	])(
		"uses the maskable slots for frequently dead roots in a $rootCount-root frame",
		({ rootCount, liveCounts, scannedSlots }) => {
			const call: BytecodeInstruction = {
				opcode: "CALL",
				dst: 1,
				callee: 0,
				thisValue: -1,
				argumentCount: 0,
				arguments: [],
			};
			const wideFunction: BytecodeFunction = {
				...fn,
				capturedCount: 1,
				parameterCount: 2,
				registerCount: rootCount + 3,
				instructions: [call, call, call, { opcode: "RETURN", value: 0 }],
			};
			const safepoints = liveCounts.map((count, instructionIp) => ({
				kind: "operation" as const,
				instructionIp,
				rootRegisters: Array.from({ length: count }, (_, register) => register),
				incomingRootRegisters: Array.from({ length: count }, (_, register) => register),
				outgoingRootRegisters: Array.from({ length: count }, (_, register) => register),
			}));
			const image = withNativeFunctionPlan(
				testProgramImage({ ...definition.runtime, functions: [wideFunction] }),
				0,
				(plan) => ({
					...plan,
					registerRepresentations: [
						...Array.from({ length: rootCount - 1 }, () => "boxed" as const),
						"string",
						"int32",
						"number",
						"boolean",
					],
					gc: { safepoints },
				}),
			);
			const output = emitCompiledFunction(
				wideFunction,
				image.native.functions[0]!,
				0,
				"",
				false,
			)?.source;
			expect(output).toBeDefined();
			const slots = new Map(
				[...output!.matchAll(/#define r(\d+) \(__gc_slots\[(\d+)\]\)/g)].map((match) => [
					Number(match[1]),
					Number(match[2]),
				]),
			);
			const masks: Array<bigint> = [];
			let publishedMask = 0n;
			for (const match of output!.matchAll(
				/MAL_ROOT_MASK\((0x[\da-f]+)\);|mal_vm_call_cached\(/g,
			)) {
				if (match[1] !== undefined) publishedMask = BigInt(match[1]);
				else masks.push(publishedMask);
			}
			expect(new Set(slots.keys())).toEqual(new Set(safepoints[0]!.rootRegisters));
			expect(new Set(slots.values())).toEqual(new Set(safepoints[0]!.rootRegisters));
			expect(slots.get(rootCount - 1)).toBeLessThan(64);
			expect(masks).toHaveLength(safepoints.length);
			let scanned = 0;
			for (const [index, safepoint] of safepoints.entries()) {
				const live = new Set(safepoint.rootRegisters);
				for (const [register, slot] of slots) {
					const inactive = slot < 64 && (masks[index]! & (1n << BigInt(slot))) !== 0n;
					if (!inactive) scanned++;
					if (live.has(register)) expect(inactive).toBe(false);
				}
			}
			expect(scanned).toBe(scannedSlots);
			if (rootCount <= 64) {
				for (const [register, slot] of slots) expect(slot).toBe(register);
			}
			expect(output).toContain("r0 = arg_count > 0 ? args[0] : MAL_VALUE_UNDEFINED;");
			expect(output).toContain("__gc_frame.env = env;");
		},
	);

	it("coalesces straight-line native root masks and republishes them at joins", () => {
		const call = (argument: number): BytecodeInstruction => ({
			opcode: "CALL",
			dst: 3,
			callee: 0,
			thisValue: -1,
			argumentCount: 1,
			arguments: [argument],
		});
		const exactRootFunction: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			registerCount: 4,
			instructions: [
				call(1),
				call(1),
				{ opcode: "JUMP", targetIp: 4 },
				{ opcode: "RETURN", value: 3 },
				call(1),
				call(1),
				{ opcode: "JUMP_IF", cond: 0, targetIp: 4 },
				call(2),
				{ opcode: "RETURN", value: 3 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({
				...definition.runtime,
				functions: [exactRootFunction],
			}),
			0,
			(plan) => ({
				...plan,
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 0,
							rootRegisters: [0, 1, 3],
							incomingRootRegisters: [0, 1, 3],
							outgoingRootRegisters: [0, 1, 3],
						},
						{
							kind: "operation",
							instructionIp: 1,
							rootRegisters: [0, 1, 3],
							incomingRootRegisters: [0, 1, 3],
							outgoingRootRegisters: [0, 1, 3],
						},
						{
							kind: "operation",
							instructionIp: 4,
							rootRegisters: [0, 1, 3],
							incomingRootRegisters: [0, 1, 3],
							outgoingRootRegisters: [0, 1, 3],
						},
						{
							kind: "operation",
							instructionIp: 5,
							rootRegisters: [0, 1, 3],
							incomingRootRegisters: [0, 1, 3],
							outgoingRootRegisters: [0, 1, 3],
						},
						{
							kind: "loop-backedge",
							instructionIp: 6,
							rootRegisters: [0, 2, 3],
							incomingRootRegisters: [0, 2, 3],
							outgoingRootRegisters: [0, 2, 3],
						},
						{
							kind: "operation",
							instructionIp: 7,
							rootRegisters: [0, 2, 3],
							incomingRootRegisters: [0, 2, 3],
							outgoingRootRegisters: [0, 2, 3],
						},
					],
				},
			}),
		);
		const output = emitProgramImage(image, { compiled: true });

		expect(output).toContain(
			"#define MAL_ROOT_MASK(mask) (__gc_frame.inactive_slots = UINT64_C(mask))",
		);
		expect(output.match(/__gc_frame\.inactive_slots = UINT64_C/g)).toHaveLength(1);
		expect(output.match(/MAL_ROOT_MASK\(0x4\);/g)).toHaveLength(2);
		expect(output.match(/MAL_ROOT_MASK\(0x2\);/g)).toHaveLength(2);
		expect(output).toMatch(/L4:;\n {4}MAL_ROOT_MASK\(0x4\);/);
		expect(output).toMatch(
			/if \(mal_gc_poll\) \{ MAL_ROOT_MASK\(0x2\); mal_gc_safepoint\(vm\); \} goto L4;/,
		);
	});

	it("publishes exact TDZ roots only inside the throwing branch", () => {
		const call: BytecodeInstruction = {
			opcode: "CALL",
			dst: 0,
			callee: 1,
			thisValue: -1,
			argumentCount: 0,
			arguments: [],
		};
		const exactTdzFunction: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			registerCount: 2,
			instructions: [
				call,
				{ opcode: "THROW_IF_TDZ", src: 0, nameStringIndex: 1 },
				call,
				{ opcode: "RETURN", value: 0 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({
				...definition.runtime,
				functions: [exactTdzFunction],
			}),
			0,
			(plan) => ({
				...plan,
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 0,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
						{
							kind: "operation",
							instructionIp: 1,
							rootRegisters: [0],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0],
						},
						{
							kind: "operation",
							instructionIp: 2,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
					],
				},
			}),
		);
		const output = emitProgramImage(image, { compiled: true });

		expect(output.match(/MAL_ROOT_MASK\(0x1\);/g)).toHaveLength(2);
		expect(output.match(/MAL_ROOT_MASK\(0x2\);/g)).toHaveLength(1);
		expect(output).toMatch(
			/if \(mal_value_is_empty\(r0\)\) \{\n\s+MAL_ROOT_MASK\(0x2\);\n\s+mal_vm_op_throw_if_tdz/,
		);
		expect(output).toMatch(
			/mal_vm_op_throw_if_tdz[\s\S]*?\n\s+\}\n\s+MAL_ROOT_MASK\(0x1\);/,
		);
	});

	it("publishes exact known-own-slot roots only inside the generic fallback", () => {
		const call: BytecodeInstruction = {
			opcode: "CALL",
			dst: 0,
			callee: 1,
			thisValue: -1,
			argumentCount: 0,
			arguments: [],
		};
		const exactSlotFunction: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			registerCount: 2,
			literalShapeCount: 1,
			instructions: [
				call,
				{
					opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					dst: 0,
					object: 0,
					stringIndex: 1,
					icIndex: 0,
					candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 0 }],
				},
				call,
				{ opcode: "RETURN", value: 0 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({
				...definition.runtime,
				functions: [exactSlotFunction],
				precompiledLiteralShapes: [
					{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [1] },
				],
			}),
			0,
			(plan) => ({
				...plan,
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 0,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
						{
							kind: "operation",
							instructionIp: 1,
							rootRegisters: [0],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0],
						},
						{
							kind: "operation",
							instructionIp: 2,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
					],
				},
			}),
		);
		const output = emitProgramImage(image, { compiled: true });

		expect(output.match(/MAL_ROOT_MASK\(0x1\);/g)).toHaveLength(2);
		expect(output.match(/MAL_ROOT_MASK\(0x2\);/g)).toHaveLength(1);
		expect(output).toMatch(
			/if \(mal_vm_try_load_known_own_slots[^\n]+\) \{[\s\S]*?\} else \{\n\s+MAL_ROOT_MASK\(0x2\);\n\s+r0 = mal_vm_op_load_property_ic/,
		);
		expect(output).toMatch(
			/mal_vm_op_load_property_ic[\s\S]*?\n\s+\}\n\s+MAL_ROOT_MASK\(0x1\);/,
		);
	});

	it("publishes exact static-property roots only inside the generic fallback", () => {
		const call: BytecodeInstruction = {
			opcode: "CALL",
			dst: 0,
			callee: 1,
			thisValue: -1,
			argumentCount: 0,
			arguments: [],
		};
		const exactLoadFunction: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			registerCount: 2,
			instructions: [
				call,
				{
					opcode: "LOAD_PROPERTY_STATIC",
					dst: 0,
					object: 0,
					stringIndex: 1,
					icIndex: 0,
				},
				call,
				{ opcode: "RETURN", value: 0 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({
				...definition.runtime,
				functions: [exactLoadFunction],
			}),
			0,
			(plan) => ({
				...plan,
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 0,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
						{
							kind: "operation",
							instructionIp: 1,
							rootRegisters: [0],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0],
						},
						{
							kind: "operation",
							instructionIp: 2,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
					],
				},
			}),
		);
		const output = emitProgramImage(image, { compiled: true });

		expect(output.match(/MAL_ROOT_MASK\(0x1\);/g)).toHaveLength(2);
		expect(output.match(/MAL_ROOT_MASK\(0x2\);/g)).toHaveLength(1);
		expect(output).toMatch(
			/if \(mal_vm_property_try_load_static[^\n]+\) \{[\s\S]*?\} else \{\n\s+__gc_slots\[0\] = r0;\n\s+MAL_ROOT_MASK\(0x2\);\n\s+r0 = mal_vm_op_load_property_ic/,
		);
		expect(output).toMatch(
			/mal_vm_op_load_property_ic[\s\S]*?\n\s+\}\n\s+MAL_ROOT_MASK\(0x1\);/,
		);
		// Calls bind the reused destination to continuously rooted storage, then
		// restore its private value on either control-flow exit.
		expect(output).toMatch(/#define r0 \(__gc_slots\[0\]\)[\s\S]*?mal_vm_call_cached/);
		expect(output).toMatch(
			/MAL_COMPLETION_THROW\) \{ __private_r0 = __gc_slots\[0\]; goto __throw_exit; \}/,
		);
		expect(output).toMatch(
			/__private_r0 = __gc_slots\[0\];\n#undef r0\n#define r0 \(__private_r0\)/,
		);
	});

	it("keeps chained property hits private and publishes at miss and poll edges", () => {
		const loadFunction: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			parameterCount: 1,
			registerCount: 4,
			instructions: [
				{ opcode: "LOAD_PROPERTY_STATIC", object: 0, dst: 1, stringIndex: 1, icIndex: 0 },
				{ opcode: "LOAD_PROPERTY_STATIC", object: 1, dst: 2, stringIndex: 2, icIndex: 1 },
				{ opcode: "CREATE_OBJECT", dst: 3 },
				{ opcode: "JUMP_IF", cond: 2, targetIp: 0 },
				{ opcode: "RETURN", value: 2 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({ ...definition.runtime, functions: [loadFunction] }),
			0,
			(plan) => ({
				...plan,
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 0,
							rootRegisters: [0, 1],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0, 1],
						},
						{
							kind: "operation",
							instructionIp: 1,
							rootRegisters: [0, 1, 2],
							incomingRootRegisters: [0, 1],
							outgoingRootRegisters: [0, 2],
						},
						{
							kind: "operation",
							instructionIp: 2,
							rootRegisters: [0, 2, 3],
							incomingRootRegisters: [0, 2],
							outgoingRootRegisters: [0, 2, 3],
						},
						{
							kind: "loop-backedge",
							instructionIp: 3,
							rootRegisters: [0, 2],
							incomingRootRegisters: [0, 2],
							outgoingRootRegisters: [0, 2],
						},
					],
				},
			}),
		);
		const output = emitCompiledFunction(
			loadFunction,
			image.native.functions[0]!,
			0,
			"",
			false,
		)!.source;
		for (const register of [0, 1, 2]) {
			expect(output).toContain(`MalValue __private_r${register};`);
			expect(output).toContain(`#define r${register} (__private_r${register})`);
		}
		const hits = [
			...output.matchAll(
				/if \(mal_vm_property_try_load_static[^\n]+\) \{([\s\S]*?)\} else \{/g,
			),
		];
		expect(hits).toHaveLength(2);
		for (const hit of hits) expect(hit[1]).not.toContain("__gc_slots");
		expect(output).toMatch(
			/__gc_slots\[1\] = MAL_VALUE_UNDEFINED;[\s\S]*?r1 = mal_vm_op_load_property_ic_static_miss/,
		);
		expect(output).toMatch(
			/__gc_slots\[1\] = r1;[\s\S]*?__gc_slots\[2\] = MAL_VALUE_UNDEFINED;[\s\S]*?r2 = mal_vm_op_load_property_ic_static_miss/,
		);
		const allocationEnd = output.indexOf("r3 = mal_vm_op_create_object");
		const secondMissEnd = output.indexOf(
			"if (vm->completion.kind",
			output.indexOf("r2 = mal_vm_op_load_property_ic_static_miss"),
		);
		expect(output.slice(secondMissEnd, allocationEnd)).not.toContain("__gc_slots");
		expect(output).toMatch(
			/if \(mal_gc_poll\) \{[^\n]*__gc_slots\[2\] = r2;[^\n]*mal_gc_safepoint\(vm\);/,
		);
	});

	it("publishes live private roots and clears dead private slots beyond the root mask", () => {
		const allRoots = Array.from({ length: 67 }, (_, register) => register);
		const loadFunction: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			parameterCount: 67,
			registerCount: 67,
			instructions: [
				{
					opcode: "CALL",
					dst: 64,
					callee: 0,
					thisValue: -1,
					argumentCount: 66,
					arguments: allRoots.slice(1),
				},
				{ opcode: "MOVE", dst: 65, src: 66 },
				{
					opcode: "LOAD_PROPERTY_STATIC",
					object: 65,
					dst: 66,
					stringIndex: 1,
					icIndex: 0,
				},
				{ opcode: "JUMP_IF", cond: 66, targetIp: 1 },
				{ opcode: "RETURN", value: 66 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({ ...definition.runtime, functions: [loadFunction] }),
			0,
			(plan) => ({
				...plan,
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 0,
							rootRegisters: allRoots,
							incomingRootRegisters: allRoots,
							outgoingRootRegisters: [66],
						},
						{
							kind: "operation",
							instructionIp: 2,
							rootRegisters: [65, 66],
							incomingRootRegisters: [65],
							outgoingRootRegisters: [66],
						},
						{
							kind: "loop-backedge",
							instructionIp: 3,
							rootRegisters: [66],
							incomingRootRegisters: [66],
							outgoingRootRegisters: [66],
						},
					],
				},
			}),
		);
		const output = emitCompiledFunction(
			loadFunction,
			image.native.functions[0]!,
			0,
			"",
			false,
		)!.source;
		for (const register of [65, 66]) {
			expect(output).toContain(`#define r${register} (__private_r${register})`);
			expect(output).toContain(`__gc_slots[${register}] = r${register};`);
		}
		const property = output.match(
			/if \(mal_vm_property_try_load_static[^\n]+\) \{([\s\S]*?)\} else \{([\s\S]*?)\n\s+\}/,
		);
		expect(property).not.toBeNull();
		expect(property![1]).not.toContain("__gc_slots");
		const miss = property![2]!;
		const callOffset = miss.indexOf("r66 = mal_vm_op_load_property_ic_static_miss");
		expect(callOffset).toBeGreaterThanOrEqual(0);
		const incoming = miss.slice(0, callOffset);
		expect(incoming).toContain("__gc_slots[65] = r65;");
		expect(incoming).toContain("__gc_slots[66] = MAL_VALUE_UNDEFINED;");
		const poll = output.match(/if \(mal_gc_poll\) \{([^\n]*)mal_gc_safepoint\(vm\);/);
		expect(poll).not.toBeNull();
		expect(poll![1]).toContain("__gc_slots[65] = MAL_VALUE_UNDEFINED;");
		expect(poll![1]).toContain("__gc_slots[66] = r66;");
		expect(poll![1]).not.toContain("__gc_slots[65] = r65;");
	});

	it.each(["single", "batch"])(
		"revokes portable root-map trust between %s emissions after bytecode mutation",
		(mode) => {
			const source = `
			function* keep(value) {
				const live = { value };
				yield live;
				return live.value;
			}
			globalThis.keep = keep;
		`;
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				source,
				"portable-root-map-mutation.js",
				parseScript(source, { strict: false }),
			);
			const image = compileSemanticProgramToProgramImage(semantic);
			const functionIndex = image.runtime.functions.findIndex(
				(fn) => (fn.gcSafepoints?.length ?? 0) > 0,
			);
			expect(functionIndex).toBeGreaterThanOrEqual(0);
			const fn = image.runtime.functions[functionIndex]!;
			const emit = () =>
				mode === "single"
					? emitProgramImage(image, { compiled: false })
					: emitBatch([image], { compiled: false });
			expect(vmSafepointRootMapsAreTrusted(fn)).toBe(true);
			const trusted = malFunctionRows(emit())[functionIndex]!;
			expect(trusted[30]).toBe("true");
			expect(trusted[4]).not.toBe("nullptr");
			fn.gcSafepoints![0]!.rootRegisters = [];
			delete fn.gcSafepoints![0]!.clearRegisters;
			expect(vmSafepointRootMapsAreTrusted(fn)).toBe(false);

			const untrusted = malFunctionRows(emit())[functionIndex]!;
			expect(untrusted[30]).toBe("false");
			expect(untrusted[4]).toBe("nullptr");
		},
	);

	it("uses a null side table when a function has no variable operands", () => {
		const simple = {
			...definition,
			runtime: {
				...definition.runtime,
				functions: [{ ...fn, instructions: [{ opcode: "RETURN", value: 0 } as const] }],
			},
		};
		const [functionRow] = malFunctionRows(emitProgramImage(simple, { compiled: false }));
		expect(functionRow?.[22]).toBe("0");
		expect(functionRow?.[3]).toBe("nullptr");
	});

	it("aliases an asset to existing linked immutable bytes", () => {
		const output = emitProgramImage(definition, {
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
	function lower(source: string): ProgramImage {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"update-expression-representation.js",
			parseScript(source, { strict: false }),
		);
		return compileSemanticProgramToProgramImage(semantic);
	}

	function emit(source: string): string {
		return emitProgramImage(lower(source), { compiled: true });
	}

	function emitLocked(source: string): string {
		return emitProgramImage(lockedDefinition(source), { compiled: true });
	}

	function lockedDefinition(source: string): ProgramImage {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"locked-native-representation.js",
			parseScript(source, { strict: false }),
		);
		return compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
	}

	it("uses available ordinary compiled entries after a function-family guard", () => {
		const output = emit(`
			function invoke(value) {
				const target = value
					? function first(input) { return input + arguments.length; }
					: function second(input) { return input - arguments.length; };
				return target(value);
			}
			globalThis.invoke = invoke;
		`);
		expect(output).toContain("mal_vm_call_exact_script_compiled_callback(vm,");
		expect(output).toContain(".compiled_callback = mal_compiled_");
		expect(output).toContain("mal_vm_call_cached(vm,");
	});

	it("keeps class-call rejection outside the ordinary compiled-entry path", () => {
		const output = emit(`
			class Target {}
			function invoke() { return Target(); }
			globalThis.invoke = invoke;
		`);
		expect(output).not.toContain("mal_vm_call_exact_script_compiled_callback(vm,");
	});

	it.each([
		"ordinary",
		"exact-typed-array-element",
		"contained-fixed-typed-array-element",
	] as const)("honors int32 index operands in %s native access", (kind) => {
		const indexed: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			parameterCount: 1,
			registerCount: 4,
			instructions: [
				{ opcode: "CREATE_NUMBER", dst: 1, value: 2 },
				{ opcode: "CREATE_NUMBER", dst: 2, value: 17 },
				{ opcode: "STORE_PROPERTY", object: 0, key: 1, value: 2, icIndex: 0 },
				{ opcode: "LOAD_PROPERTY", dst: 3, object: 0, key: 1, icIndex: 1 },
				{ opcode: "RETURN", value: 3 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({ ...definition.runtime, functions: [indexed] }),
			0,
			(plan) => ({
				...plan,
				registerRepresentations: ["boxed", "int32", "int32", "boxed"],
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 2,
							rootRegisters: [0],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0],
						},
						{
							kind: "operation",
							instructionIp: 3,
							rootRegisters: [0],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0],
						},
					],
				},
				instructions: plan.instructions.map((instruction, index) =>
					kind !== "ordinary" && (index === 2 || index === 3)
						? { kind, elementKind: "Uint32Array" }
						: instruction,
				),
			}),
		);
		const output = emitProgramImage(image, { compiled: true });
		if (kind === "ordinary") {
			expect(output).toContain("mal_vm_array_try_get_index(");
			expect(output).toContain("mal_vm_array_try_store(");
			expect(output).toContain("mal_vm_indexed_fast_load_index(");
			expect(output).toContain("mal_vm_indexed_fast_store_index(");
		} else {
			expect(output).toContain(
				kind === "exact-typed-array-element"
					? "mal_vm_exact_numeric_typed_array_load("
					: "mal_vm_contained_fixed_numeric_typed_array_load(",
			);
			if (kind === "contained-fixed-typed-array-element") {
				expect(output).toContain("mal_scalar_store_native_u32(");
				expect(output).not.toContain("mal_vm_numeric_typed_array_store_known_receiver(");
			} else {
				expect(output).toContain("mal_vm_numeric_typed_array_store_known_receiver(");
			}
			expect(output).not.toContain("mal_ops_is_number(");
		}
	});

	it.each(["===", "!=="] as const)(
		"keeps boxed %s comparisons at the pure strict-equality boundary",
		(operator) => {
			const output = emit(
				`globalThis.compare = function compare(left, right) { return left ${operator} right; };`,
			);
			expect(output).toContain("mal_ops_strict_equal_bool(");
			expect(output).not.toMatch(/mal_vm_binary_op\(vm, MAL_BIN_STRICT_(?:EQ|NEQ)/);
		},
	);

	it.each(["int32", "number"] as const)(
		"converts bitwise operands only when their representation is %s",
		(representation) => {
			const bitwise: BytecodeFunction = {
				...fn,
				capturedCount: 0,
				registerCount: 3,
				instructions: [
					{ opcode: "CREATE_NUMBER", dst: 0, value: -1 },
					{ opcode: "CREATE_NUMBER", dst: 1, value: 33 },
					...(["&", "|", "^", "<<", ">>"] as const).map(
						(operator): BytecodeInstruction => ({
							opcode: "BINARY",
							dst: 2,
							left: 0,
							right: 1,
							operator,
						}),
					),
					{ opcode: "RETURN", value: 2 },
				],
			};
			const image = withNativeFunctionPlan(
				testProgramImage({ ...definition.runtime, functions: [bitwise] }),
				0,
				(plan) => ({
					...plan,
					registerRepresentations: [representation, representation, "int32"],
					gc: { safepoints: [] },
				}),
			);
			const output = emitProgramImage(image, { compiled: true });
			if (representation === "int32") {
				expect(output).toMatch(/r\d+ = r\d+ & r\d+;/);
				expect(output).not.toContain("mal_ops_number_to_i32(");
			} else {
				expect(output).toContain("mal_ops_number_to_i32(");
			}
			expect(output).toContain("mal_ops_u32_to_i32((u32)");
			expect(output).toContain("& 0x1F");
		},
	);

	it("folds exact fresh-array lengths into returned portable constants", () => {
		const definition = lower(`
            function readLength() {
                const values = [1, 2, 3];
                return values.length;
            }
            globalThis.readLength = readLength;
        `);
		const fn = definition.runtime.functions.find(
			(fn) =>
				String.fromCharCode(
					...(definition.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "readLength",
		);
		expect(fn).toBeDefined();
		const returned = fn!.instructions.find(
			(instruction) => instruction.opcode === "RETURN",
		);
		expect(returned?.opcode).toBe("RETURN");
		if (returned?.opcode !== "RETURN") throw new Error("missing return");
		expect(fn!.instructions).toContainEqual({
			opcode: "CREATE_NUMBER",
			dst: returned.value,
			value: 3,
		});
		expect(
			fn!.instructions.some((instruction) =>
				instruction.opcode.startsWith("LOAD_PROPERTY"),
			),
		).toBe(false);
	});

	it("carries exact local TypedArray accesses into native code with boxed-key fallbacks", () => {
		const source = `
			function read(key) {
				const values = new Uint32Array(4);
				values[0] = 17;
				return values[key];
			}
			globalThis.result = read(0);
		`;
		const definition = lockedDefinition(source);
		const specialized = definition.runtime.functions.flatMap((fn, functionIndex) =>
			fn.instructions.flatMap((instruction, instructionIndex) => {
				const plan =
					definition.native.functions[functionIndex]!.instructions[instructionIndex];
				return (instruction.opcode === "LOAD_PROPERTY" ||
					instruction.opcode === "STORE_PROPERTY") &&
					plan?.kind === "exact-typed-array-element"
					? [{ opcode: instruction.opcode, plan }]
					: [];
			}),
		);
		expect(specialized).toEqual([
			{
				opcode: "STORE_PROPERTY",
				plan: { kind: "exact-typed-array-element", elementKind: "Uint32Array" },
			},
			{
				opcode: "LOAD_PROPERTY",
				plan: { kind: "exact-typed-array-element", elementKind: "Uint32Array" },
			},
		]);

		const emitted = emitProgramImage(definition, { compiled: true });
		expect(emitted).toContain("mal_vm_exact_numeric_typed_array_load(");
		expect(emitted).toContain("mal_vm_numeric_typed_array_store_known_receiver(");
		expect(emitted).toContain("if (mal_ops_is_number(");
		expect(emitted).toContain("mal_vm_op_load_property_ic(");

		const mutable = lower(source);
		expect(
			mutable.native.functions.some((fn) =>
				fn.instructions.some((plan) => plan?.kind === "exact-typed-array-element"),
			),
		).toBe(false);
	});

	it("emits direct fixed-storage access for an unexposed literal-length TypedArray", () => {
		const definition = lockedDefinition(`
			function sum() {
				const values = new Uint32Array(4);
				let total = 0;
				for (let index = 0; index < values.length; index++) {
					values[index] = index + 1;
					total += values[index];
				}
				return total;
			}
			globalThis.result = sum();
		`);
		const plans = definition.native.functions.flatMap((fn) => fn.instructions);
		expect(
			plans.filter((plan) => plan?.kind === "contained-fixed-typed-array-element"),
		).toHaveLength(2);
		expect(
			plans.filter((plan) => plan?.kind === "contained-fixed-typed-array-length"),
		).toHaveLength(1);
		expect(
			definition.native.functions
				.flatMap((fn) => fn.specializations)
				.some((region) => region.kind === "indexed-length-loop"),
		).toBe(false);

		const emitted = emitProgramImage(definition, { compiled: true });
		expect(
			plans
				.filter((plan) => plan?.kind === "contained-fixed-typed-array-element")
				.every(
					(plan) => plan?.kind === "contained-fixed-typed-array-element" && plan.inBounds,
				),
		).toBe(true);
		expect(emitted).toContain("mal_scalar_load_native_u32(");
		expect(emitted).not.toContain("mal_vm_typed_array_numeric_index(");
		expect(emitted).toContain("mal_value_to_typed_array_object(");
	});

	it("reuses a bounded induction index across sibling fixed TypedArrays", () => {
		const definition = lockedDefinition(`
			function sum() {
				const left = new Uint32Array(8);
				const right = new Uint32Array(8);
				const kinds = new Uint8Array(8);
				let total = 0;
				for (let index = 0; index < left.length; index++) {
					total += left[index] + right[index] + kinds[index];
				}
				return total;
			}
			globalThis.result = sum();
		`);
		const loads = definition.runtime.functions.flatMap((fn, functionIndex) =>
			fn.instructions.flatMap((instruction, instructionIndex) => {
				const plan =
					definition.native.functions[functionIndex]!.instructions[instructionIndex];
				return instruction.opcode === "LOAD_PROPERTY" &&
					plan?.kind === "contained-fixed-typed-array-element"
					? [plan]
					: [];
			}),
		);
		expect(loads).toHaveLength(3);
		expect(loads.every((plan) => plan.inBounds)).toBe(true);

		const emitted = emitProgramImage(definition, { compiled: true });
		expect(emitted).toContain("mal_scalar_load_native_u32(");
		expect(emitted).toContain("mal_scalar_load_native_u8(");
		expect(emitted).not.toContain("mal_vm_contained_fixed_numeric_typed_array_load(");
	});

	it("consumes scalarized and sunk object plans in emitted C", () => {
		const scalarized = emitLocked(`
			function read(value) {
				const object = { value, increment: 1 };
				return object.value + object.increment;
			}
			globalThis.result = read(41);
		`);
		expect(scalarized).not.toContain("mal_vm_create_object_shaped(");
		expect(scalarized).not.toContain("mal_vm_op_load_property_ic(");
		expect(scalarized).not.toContain("__stack_object_");

		const sunk = emitLocked(`
			function choose(value, escape) {
				const object = { value };
				if (escape) return object;
				return object.value;
			}
			globalThis.result = choose(41, true);
		`);
		expect(sunk).toContain("MalObject __stack_object_");
		expect(sunk).toContain("mal_vm_materialize_stack_object(");
		expect(sunk).not.toContain("mal_vm_create_object_shaped(");
	});

	it("keeps scalarized homogeneous fields unboxed until joins require boxing", () => {
		const homogeneousDefinition = lower(`
			function read(flag, count) {
				const object = { value: true };
				for (let i = 0; i < count; i++) {
					if (flag) object.value = true;
					else object.value = false;
				}
				return object.value;
			}
			globalThis.result = read(globalThis.flag, 2);
		`);
		const homogeneous = emitProgramImage(
			deserializeCompilerArtifact(serializeCompilerArtifact(homogeneousDefinition)),
			{ compiled: true },
		);
		expect(homogeneous).not.toContain("__stack_object_");
		expect(homogeneous).toMatch(/bool r\d+;/);
		expect(homogeneous).toMatch(
			/return mal_ops_construct_result\(mal_value_new_boolean\(r\d+\)/,
		);

		const mixed = emit(`
			function read(flag, count) {
				const object = { value: true };
				for (let i = 0; i < count; i++) {
					if (flag) object.value = false;
					else object.value = 1;
				}
				return object.value;
			}
			globalThis.result = read(globalThis.flag, 2);
		`);
		expect(mixed).not.toMatch(/__stack_object_\d+_slot_0/);
		expect(mixed).toMatch(/r\d+ = mal_value_new_boolean\(r\d+\);/);
		expect(mixed).toMatch(/r\d+ = mal_value_from_i32\(r\d+\);/);

		const materialized = emit(`
			function read(flag) {
				const object = { value: true };
				if (flag) object.value = false;
				return object;
			}
			globalThis.result = read(globalThis.flag);
		`);
		expect(materialized).not.toMatch(/__stack_object_\d+_slot_0/);
		expect(materialized).toContain("mal_vm_materialize_stack_object(");
	});

	it("proves numeric induction variables during direct Core construction", () => {
		const image = lower(
			`"use strict"; function sum(array) { let total = 0; for (let i = 0; i < array.length; i++) total += array[i]; return total; } globalThis.sum = sum;`,
		);
		const output = emitProgramImage(image, { compiled: true });
		const increments = image.runtime.functions.flatMap((fn, index) =>
			fn.instructions.flatMap((instruction) =>
				instruction.opcode === "UNARY" && instruction.operator === "increment"
					? [image.native.functions[index]!.registerRepresentations[instruction.dst]]
					: [],
			),
		);
		expect(increments).toEqual(["number"]);
		expect(output).toContain("mal_vm_array_try_get_index(");
		expect(output).not.toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).not.toContain("MAL_UNARY_INCREMENT");
		expect(output).toMatch(
			/if \(mal_gc_poll\) \{ MAL_ROOT_MASK\(0x[0-9a-f]+\); mal_gc_safepoint\(vm\); \}/,
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
		const functionIndex = definition.native.functions.findIndex(
			(fn) => fn.specializations.length > 0,
		);
		expect(functionIndex).toBeGreaterThanOrEqual(0);
		const native = definition.native.functions[functionIndex]!;
		const region = native.specializations[0]!;
		const malformed = withSpecializations(definition, functionIndex, [
			{
				...region,
				controlFlow: {
					...region.controlFlow,
					ordinaryBlockIps: [],
				},
			},
		]);
		expect(() => serializeCompilerArtifact(malformed)).toThrow(/invalid region envelope/);
	});

	it("pre-reserves a pristine indexed fill and retains guarded array stores", () => {
		const output = emit(
			`"use strict"; function fill() { const array = []; for (let i = 0; i < 1000; i++) array[i] = i; return array; } globalThis.fill = fill;`,
		);
		expect(output).toContain("mal_vm_try_fresh_dense_indexed_fill_reserve(vm");
		expect(output).toContain(", 1000);");
		expect(output).toContain("mal_vm_array_try_store(");
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

	it("consumes the Core-owned authoritative Array iterator cursor", () => {
		const source = `"use strict"; function sum(values) { let total = 0; for (const value of values) total += value; return total; } globalThis.sum = sum;`;
		const definition = lower(source);
		const regions = specializations(definition).filter(
			(region) => region.kind === "array-values-iterator-cursor",
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			representation: "array-values-authoritative-cursor",
			protocol: "array-values",
			stateSynchronization: "authoritative-language-object",
			suspension: "forbidden",
		});
		const virtualResults = specializations(definition).filter(
			(region) => region.kind === "iterator-result-virtualization",
		);
		expect(virtualResults).toHaveLength(1);
		expect(virtualResults[0]).toMatchObject({
			representation: "virtual-iterator-result",
			composition: "overlay",
			correspondence: "done-value-observation",
			fallback: "materialize-result-then-observe",
			license: {
				materialization: "on-demand",
				guard: { obligations: ["fallback", "materialize"] },
			},
		});
		const ownerIndex = definition.native.functions.findIndex((fn) =>
			fn.specializations.includes(regions[0]!),
		);
		const owner = definition.native.functions[ownerIndex]!;
		const virtualIndex = owner.specializations.findIndex(
			(region) => region.kind === "iterator-result-virtualization",
		);
		const virtualRegion = owner.specializations[virtualIndex]!;
		if (virtualRegion.kind !== "iterator-result-virtualization") {
			throw new Error("missing iterator-result virtualization region");
		}
		const stepIp = virtualRegion.stepIps[0]!;
		expect(owner.regionActions.filter((action) => action.ip === stepIp)).toMatchObject([
			{ role: "step" },
			{ role: "step" },
		]);
		const staleActions: ProgramImage = {
			...definition,
			native: {
				...definition.native,
				functions: definition.native.functions.with(ownerIndex, {
					...owner,
					regionActions: owner.regionActions.slice(1),
				}),
			},
		};
		expect(() => emitProgramImage(staleActions, { compiled: true })).toThrow(
			/stale region actions/,
		);
		expect(() => serializeCompilerArtifact(staleActions)).toThrow(
			/stale native region actions/,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
			definition,
		);
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("MalIteratorObject *__iter_cursor_");
		expect(output).toContain("mal_vm_iterator_protocol_cursor(");
		expect(output).toContain("mal_vm_iterator_try_dense_array_cursor_step(");
		expect(output).not.toContain("mal_vm_iterator_step_protocol_cursor(vm,");
		expect(output).toContain("mal_vm_iterator_try_dense_array_step(");
		expect(output).toContain("mal_vm_iterator_step(vm,");

		const retainedGeneric = withSpecializations(
			definition,
			ownerIndex,
			owner.specializations.filter(
				(region) =>
					region.kind !== "iterator-result-virtualization" &&
					!region.kind.endsWith("iterator-cursor"),
			),
		);
		const genericOutput = emitProgramImage(retainedGeneric, { compiled: true });
		expect(genericOutput).toContain("mal_vm_iterator_step(vm,");
		expect(genericOutput).not.toContain("mal_vm_iterator_step_fast(vm,");
	});

	it("publishes private static-store inputs and the root mask only after the cache probe misses", () => {
		const definition = lower(`
			"use strict";
			function write(receiver, value) {
				const retained = receiver.child;
				receiver.updated = value;
				return retained.value;
			}
			globalThis.write = write;
		`);
		const ownerIndex = definition.runtime.functions.findIndex(
			(fn) =>
				fn.instructions.filter(
					(instruction) => instruction.opcode === "LOAD_PROPERTY_STATIC",
				).length === 2 &&
				fn.instructions.some(
					(instruction) => instruction.opcode === "STORE_PROPERTY_STATIC",
				),
		);
		expect(ownerIndex).toBeGreaterThanOrEqual(0);
		const fn = definition.runtime.functions[ownerIndex]!;
		const owner = definition.native.functions[ownerIndex]!;
		const storeIp = fn.instructions.findIndex(
			(instruction) => instruction.opcode === "STORE_PROPERTY_STATIC",
		);
		const store = fn.instructions[storeIp]!;
		if (store.opcode !== "STORE_PROPERTY_STATIC") throw new Error("missing static store");
		const output = emitCompiledFunction(fn, owner, ownerIndex, "", false)!.source;
		expect(output).toContain(`#define r${store.object} (__private_r${store.object})`);
		const probe = output.indexOf("mal_vm_object_try_store_static(");
		expect(probe).toBeGreaterThan(0);
		const previousLoadEnd = output.lastIndexOf("\n    }", probe);
		expect(previousLoadEnd).toBeGreaterThan(0);
		expect(output.slice(previousLoadEnd, probe)).not.toMatch(
			/__gc_slots\[\d+\]\s*=|MAL_ROOT_MASK\(/,
		);
		const call = output.indexOf("mal_vm_op_store_property_ic(", probe);
		expect(call).toBeGreaterThan(probe);
		const fallback = output.slice(probe, call);
		expect(fallback).toMatch(new RegExp(`__gc_slots\\[\\d+\\] = r${store.object};`));
		expect(fallback).toContain("MAL_ROOT_MASK(");
	});

	it("publishes private iterator results and the root mask only after the dense probe misses", () => {
		const definition = lower(`
			"use strict";
			function sum(values) {
				let total = 0;
				for (const value of values) total += value.child.meta.value;
				return total;
			}
			globalThis.sum = sum;
		`);
		const ownerIndex = definition.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "array-values-iterator-cursor"),
		);
		const owner = definition.native.functions[ownerIndex]!;
		const fn = definition.runtime.functions[ownerIndex]!;
		const cursor = owner.specializations.find(
			(region) => region.kind === "array-values-iterator-cursor",
		);
		if (cursor?.kind !== "array-values-iterator-cursor")
			throw new Error("missing array cursor");
		const stepIp = cursor.stepIps[0]!;
		const step = fn.instructions[stepIp]!;
		if (step.opcode !== "ITERATOR_STEP") throw new Error("missing iterator step");
		const output = emitCompiledFunction(fn, owner, ownerIndex, "", false)!.source;
		expect(output).toContain(`#define r${step.valueDst} (__private_r${step.valueDst})`);
		const probe = output.indexOf("mal_vm_iterator_try_dense_array_cursor_step(");
		expect(probe).toBeGreaterThan(0);
		const blockStart = output.lastIndexOf("\nL", probe);
		expect(blockStart).toBeGreaterThan(0);
		expect(output.slice(blockStart, probe)).not.toMatch(
			/__gc_slots\[\d+\]\s*=|MAL_ROOT_MASK\(/,
		);
		const result = output.indexOf(`r${step.valueDst} = iter_val_${stepIp};`, probe);
		expect(result).toBeGreaterThan(probe);
		const fallback = output.slice(probe, result);
		expect(fallback).toMatch(/__gc_slots\[\d+\] = MAL_VALUE_UNDEFINED;/);
		const publication = fallback.indexOf("MAL_ROOT_MASK(");
		const call = fallback.indexOf(`mal_vm_iterator_step(vm, &iter_rec_${stepIp},`);
		expect(publication).toBeGreaterThan(0);
		expect(call).toBeGreaterThan(publication);
	});

	it.each([
		["String", `"a😀"`, "string-iterator-cursor"],
		["TypedArray", "new Uint8Array([1, 2])", "typed-array-iterator-cursor"],
		["Map", "new Map([[1, 2]])", "map-iterator-cursor"],
		["Set", "new Set([1, 2])", "set-iterator-cursor"],
	])("selects the %s stateful iterator protocol", (_name, iterable, kind) => {
		const definition = lockedDefinition(
			`"use strict"; function visit() { for (const value of ${iterable}) globalThis.value = value; } globalThis.visit = visit;`,
		);
		expect(specializations(definition).some((region) => region.kind === kind)).toBe(true);
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("mal_vm_iterator_step_protocol_cursor(vm,");
	});

	it("guards constructed iterator entry pairs while retaining materialization fallback", () => {
		const source = `
			function visit() {
				let total = 0;
				for (const [key, value] of new Map([[1, 2], [3, 4]])) total += key + value;
				return total;
			}
			globalThis.visit = visit;
		`;
		const definition = lower(source);
		const regions = specializations(definition).filter(
			(region) => region.kind === "iterator-entry-pair-virtualization",
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			representation: "virtual-iterator-entry-pair",
			composition: "overlay",
			runtimeGuard: "exact-entry-pair-cursor",
			correspondence: "entry-pair-elements",
			stateSynchronization: "authoritative-language-object",
			fallback: "materialize-entry-pair-then-iterate",
			license: {
				materialization: "on-demand",
				admission: { mode: "capture" },
				guard: { obligations: ["fallback", "materialize"] },
			},
		});
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
			definition,
		);
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("mal_vm_iterator_step_entry_pair_protocol_cursor(");
		expect(output).toContain("__iter_entry_pair_");
		expect(output).toContain("mal_vm_iterator_step(vm,");
	});

	it("virtualizes Array entries while retaining the authoritative iterator", () => {
		const definition = lower(`
			function visit() {
				const values = [2, 4, 8];
				let total = 0;
				for (const [index, value] of values.entries()) total += index + value;
				return total;
			}
			globalThis.visit = visit;
		`);
		const regions = specializations(definition).filter(
			(region) => region.kind === "iterator-entry-pair-virtualization",
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			runtimeGuard: "exact-entry-pair-cursor",
			stateSynchronization: "authoritative-language-object",
			fallback: "materialize-entry-pair-then-iterate",
		});
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("mal_vm_iterator_step_entry_pair_protocol_cursor(vm,");
		expect(output).toContain("mal_vm_iterator_step(vm,");
	});

	it.each([
		["Map", 'new Map([["x", [1, 2]]])'],
		["Array entries", "[[1, 2]].entries()"],
		["Object entries", "Object.entries({ x: [1, 2] })"],
	])("retains generic %s pair cleanup across nested destructuring", (_name, iterable) => {
		const definition = lower(`
			for (const [key, [first, second]] of ${iterable}) {
				globalThis.result = key + first + second;
			}
		`);
		expect(
			specializations(definition).filter(
				(region) => region.kind === "iterator-entry-pair-virtualization",
			),
		).toHaveLength(0);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
			definition,
		);
		expect(emitProgramImage(definition, { compiled: true })).toContain(
			"mal_vm_iterator_close(vm,",
		);
	});

	it("consumes the Core-owned indexed length loop region", () => {
		const definition = lower(
			`"use strict"; function sum(values) { let total = 0; for (let index = 0; index < values.length; ++index) total += values[index]; return total; } globalThis.sum = sum;`,
		);
		const regions = specializations(definition).filter(
			(region) => region.kind === "indexed-length-loop",
		);
		expect(regions).toHaveLength(1);
		const region = regions[0];
		if (region?.kind !== "indexed-length-loop") {
			throw new Error("expected indexed length loop region");
		}
		expect(region).toMatchObject({
			representation: "live-indexed-length-loops",
			runtimeGuard: "array-or-numeric-typed-array",
		});
		expect(region.sites).toHaveLength(1);
		expect(Number.isSafeInteger(region.sites[0]!.loadIp)).toBe(true);
		expect(Number.isSafeInteger(region.sites[0]!.comparisonIp)).toBe(true);
		expect(region.sites[0]!.lengthPosition).toBe(2);
		expect(region.sites[0]!.elements).toHaveLength(1);
		expect(region.sites[0]!.elements[0]!.arrayIndexIsUint32).toBe(true);
		expect(
			specializations(deserializeCompilerArtifact(serializeCompilerArtifact(definition))),
		).toEqual(specializations(definition));
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("__indexed_length_");
		expect(output).not.toContain(".mode == MAL_IC_MODE_ARRAY_LENGTH");
		expect(output).toContain("->length");
		expect(output).toMatch(
			/mal_vm_array_try_get_proven_index\(__indexed_length_\d+_array, \(u32\) r\d+, &__indexed_element_\d+\)/,
		);
		expect(output).toContain("mal_vm_admit_numeric_typed_array_length(vm,");
		expect(output).toContain("mal_typed_array_object_get(vm,");
	});

	it("virtualizes the default dense Array protocol for fixed pair destructuring", () => {
		const output = emit(
			`"use strict"; function pair(values) { const [left, right] = values; return left + right; } globalThis.pair = pair;`,
		);
		expect(output).toContain("mal_builtin_array_pair_destructure_try(vm,");
		expect(output).toContain("mal_vm_get_iterator(vm,");
		expect(output).toContain("mal_vm_iterator_close_normal(vm,");

		const effectful = emit(
			`"use strict"; function pair(values) { const [left = sideEffect(), right] = values; return left + right; } globalThis.pair = pair;`,
		);
		expect(effectful).not.toContain("mal_builtin_array_pair_destructure_try(vm,");
	});

	it("does not retain raw dense iterator cursors across generator suspension", () => {
		const output = emit(
			`"use strict"; function* values() { for (const value of [1, 2]) yield value; } globalThis.values = values;`,
		);
		expect(output).not.toContain("MalIteratorObject *__dense_iter_");
		expect(output).not.toContain("mal_vm_iterator_step_dense_array_cursor(vm,");
		expect(output).not.toContain("MalIteratorObject *__iter_cursor_");
		expect(output).not.toContain("mal_vm_iterator_step_protocol_cursor(vm,");
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
		expect(output).toContain("mal_vm_property_try_load_static_number_triple(");
		expect(output).toMatch(/f64 __property_projection_\d+_step_0/);
		expect(output).toMatch(
			/r\d+ = mal_ops_number_value\(__property_projection_\d+_step_1\)/,
		);
	});

	it("keeps arithmetic results native through comparisons", () => {
		const output = emit(
			`"use strict"; function divisible(value) { return value % 7 === 0; } globalThis.divisible = divisible;`,
		);
		expect(output).toMatch(/__nf_(\d+)_value = mal_number_remainder/);
		expect(output).toMatch(/__nf_\d+_value == (?:r\d+|\(f64\) r\d+)/);
		expect(output).not.toContain("mal_ops_number_as_f64(mal_value_from_i32");
	});

	it("preserves int32 tags for guarded boxed numeric addition", () => {
		const output = emit(
			`"use strict"; function read(...values) { return values[0] + values[1] + values[2] + values[3]; } function sum(limit) { let total = 0; for (let index = 0; index < limit; index++) total += read(index & 31, 3, 5, 7); return total; } globalThis.sum = sum;`,
		);
		expect(output).toMatch(/mal_ops_is_number\(r\d+\).*mal_ops_is_number\(r\d+\)/);
		expect(output).toMatch(/mal_ops_add_numbers\(r\d+, r\d+\)/);
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_ADD");
	});

	it("stores fused arithmetic in its unboxed destination representation", () => {
		const output = emit(
			`"use strict"; function sum(count) { let total = 0; for (let index = 0; index < count; index++) total += (index & 31) - 16; return total; } globalThis.sum = sum;`,
		);
		expect(output).toMatch(/r\d+ -= r\d+;/);
		expect(output).not.toMatch(/r\d+ = mal_ops_number_value\([^;]* - [^;]*\);/);
	});

	it("keeps unbounded literal concatenation on the generic operator", () => {
		const output = emit(
			`"use strict"; function key(value) { return "p" + value; } globalThis.key = key;`,
		);
		expect(output).not.toContain("__finite_string_");
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_ADD");
	});

	it("keeps proven numeric loop updates unboxed", () => {
		const output = emit(
			`"use strict"; function count(limit) { let value = 0; while (value < limit) value++; return value; } globalThis.count = count;`,
		);
		expect(output).not.toContain("MAL_UNARY_TO_NUMERIC");
		expect(output).not.toContain("MAL_UNARY_INCREMENT");
		expect(output).toMatch(/r\d+ \+= 1\.0;/);
	});

	it("takes a dense own-element fast path for the in operator", () => {
		const output = emit(
			`"use strict"; function has(array, index) { return index in array; } globalThis.has = has;`,
		);
		expect(output).toMatch(/i32 __array_has_\d+ =/);
		expect(output).toContain("mal_vm_array_try_has");
		expect(output).toMatch(/if \(__array_has_\d+ >= 0\)/);
		expect(output).toContain("mal_vm_binary_op(vm, MAL_BIN_IN");
	});

	it("keeps proven numeric locals unboxed across exception edges", () => {
		const output = emit(
			`"use strict"; function classify(value) { let errors = 0; try { value.x; } catch { errors = errors + 1; } return errors + 1; } globalThis.classify = classify;`,
		);
		expect(output).toContain("static MalValue mal_compiled_1(");
		expect(output).not.toContain("mal_vm_op_throw_if_tdz");
		expect(output).not.toContain("mal_vm_binary_op(vm, MAL_BIN_ADD");
		expect(output).toMatch(/r\d+ \+= r\d+;/);
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
		const guardedMathCalls = definition.runtime.functions.flatMap(({ instructions }) =>
			instructions.flatMap((instruction) =>
				instruction.opcode === "CALL" && instruction.guardedMathCall !== undefined
					? [instruction.guardedMathCall]
					: [],
			),
		);
		expect(guardedMathCalls).toEqual(
			expect.arrayContaining([
				{ kind: "unary", operation: "Math.round" },
				{ kind: "unary", operation: "Math.floor" },
				{ kind: "binary", operation: "Math.max" },
			]),
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
			definition,
		);
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("mal_builtin_math_unary_fast");
		expect(output).toContain("mal_builtin_math_binary_fast");
		expect(output).not.toContain("mal_builtin_math_unary_number_known");
		expect(output).not.toContain("mal_builtin_math_binary_number_known");
		expect(output).not.toMatch(
			/MAL_ROOT_MASK\([^)]+\);\n\s+static MalMath(?:Unary|Binary)Op/,
		);
		expect(output).toMatch(
			/if \(mal_builtin_math_unary_fast[^\n]+\) \{[\s\S]*?\} else \{\n\s+(MAL_ROOT_MASK\(0x[\da-f]+\));\n\s+static MalCallCache[\s\S]*?\n\s+\}\n\s+if \(mal_gc_poll\) \{ \1; mal_gc_safepoint\(vm\); \}/,
		);
		expect(output).toMatch(
			/if \(mal_builtin_math_binary_fast[^\n]+\) \{[\s\S]*?\} else \{\n\s+(MAL_ROOT_MASK\(0x[\da-f]+\));\n\s+static MalCallCache[\s\S]*?\n\s+\}\n\s+if \(mal_gc_poll\) \{ \1; mal_gc_safepoint\(vm\); \}/,
		);

		const lockedOutput = emitLocked(source);
		expect(lockedOutput).not.toContain("mal_builtin_math_unary_number_known");
		expect(lockedOutput).not.toContain("mal_builtin_math_binary_number_known");
	});

	it("publishes locked Math root masks only when polling and forgets conditional state", () => {
		const exactMathFunction: BytecodeFunction = {
			...fn,
			capturedCount: 0,
			registerCount: 4,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{ opcode: "CREATE_UNDEFINED", dst: 1 },
				{ opcode: "CREATE_F64", dst: 2, value: 1.25 },
				{
					opcode: "CALL",
					dst: 0,
					callee: 1,
					thisValue: -1,
					argumentCount: 0,
					arguments: [],
				},
				{
					opcode: "CALL",
					dst: 3,
					callee: 0,
					thisValue: 1,
					argumentCount: 1,
					arguments: [2],
					guardedMathCall: { kind: "unary", operation: "Math.floor" },
				},
				{
					opcode: "CALL",
					dst: 0,
					callee: 1,
					thisValue: -1,
					argumentCount: 0,
					arguments: [],
				},
				{ opcode: "RETURN", value: 3 },
			],
		};
		const image = withNativeFunctionPlan(
			testProgramImage({
				...definition.runtime,
				functions: [exactMathFunction],
			}),
			0,
			(plan) => ({
				...plan,
				registerRepresentations: ["boxed", "boxed", "number", "number"],
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 3,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
						{
							kind: "operation",
							instructionIp: 4,
							rootRegisters: [0],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0],
						},
						{
							kind: "operation",
							instructionIp: 5,
							rootRegisters: [1],
							incomingRootRegisters: [1],
							outgoingRootRegisters: [1],
						},
					],
				},
				instructions: plan.instructions.with(4, {
					kind: "call",
					guardedBuiltinCall: {
						operation: "Math.floor",
						guard: {
							dependencies: [{ kind: "world", fact: "primordials.locked" }],
							obligations: ["fallback"],
						},
					},
				}),
			}),
		);
		const output = emitProgramImage(image, { compiled: true });

		expect(output).toMatch(
			/MAL_ROOT_MASK\(0x1\);[\s\S]*?r3 = floor\(r2\);\n\s+if \(mal_gc_poll\) \{ MAL_ROOT_MASK\(0x2\); mal_gc_safepoint\(vm\); \}\n\s+MAL_ROOT_MASK\(0x1\);/,
		);
	});

	it("carries guarded builtin calls into portable bytecode", () => {
		const definition = lower(`
			function update(key, value) {
				const map = new Map();
				const set = new Set();
				const values = [];
				const previous = map.get(key);
				map.set(key, value);
				set.add(key);
				values.push(value);
				values.push(1, 2, 3, 4, value);
				return [previous, map, set, values];
			}
			globalThis.update = update;
		`);
		const guardedBuiltinCalls = definition.runtime.functions.flatMap(({ instructions }) =>
			instructions.flatMap((instruction) =>
				instruction.opcode === "CALL" && instruction.guardedBuiltinCall !== undefined
					? [instruction.guardedBuiltinCall.operation]
					: [],
			),
		);
		expect(guardedBuiltinCalls).toEqual(
			expect.arrayContaining([
				"Map.prototype.get",
				"Map.prototype.set",
				"Set.prototype.add",
				"Array.prototype.push",
			]),
		);
		expect(
			guardedBuiltinCalls.filter((operation) => operation === "Array.prototype.push"),
		).toHaveLength(1);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
			definition,
		);
	});

	it.each(["isNaN", "isFinite", "isInteger", "isSafeInteger"])(
		"retains fallback for guarded Number.%s with numeric, arbitrary and omitted arguments",
		(method) => {
			const definition = lower(`
				function predicate(value, effect) { return [Number.${method}(value, effect()), Number.${method}(+value), Number.${method}()]; }
				globalThis.predicate = predicate;
			`);
			const calls = definition.runtime.functions.flatMap(({ instructions }) =>
				instructions.filter(
					(instruction) =>
						instruction.opcode === "CALL" &&
						instruction.guardedBuiltinCall?.operation === `Number.${method}`,
				),
			);
			expect(calls).toHaveLength(3);
			for (const argumentCount of [0, 1, 2]) {
				expect(calls).toContainEqual(expect.objectContaining({ argumentCount }));
			}
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
				definition,
			);
			const output = emitProgramImage(definition);
			expect(output).toContain("mal_vm_op_load_property_ic");
			expect(output).toContain("mal_builtin_number_value_is_");
			expect(output).toContain("mal_builtin_number_predicate_callee_matches");
			expect(output).toContain("mal_vm_call_cached");
		},
	);

	it.each(["toFixed", "toExponential", "toPrecision"])(
		"preserves lookup and fallback around guarded numeric %s formatting",
		(method) => {
			const definition = lower(`
				function format(value, digits, effect) { return value.${method}(digits, effect()); }
				globalThis.format = format;
			`);
			const calls = definition.runtime.functions.flatMap(({ instructions }) =>
				instructions.filter(
					(instruction) =>
						instruction.opcode === "CALL" &&
						instruction.guardedBuiltinCall?.operation === `Number.prototype.${method}`,
				),
			);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ argumentCount: 2 });
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
				definition,
			);
			const output = emitProgramImage(definition);
			expect(output).toContain("mal_vm_op_load_property_ic");
			expect(output).toContain("mal_builtin_number_format_try_direct");
			expect(output).toContain("mal_vm_call_cached");
			const prepared = emit(`
				function format(value) { return value.${method}(2); }
				globalThis.format = format;
			`);
			expect(prepared).toContain("mal_vm_op_load_property_ic");
			expect(prepared).toContain("mal_builtin_number_format_callee_matches");
			expect(prepared).toContain("mal_vm_call_cached");
		},
	);

	it("erases locked Math property Gets only for no-fallback numeric calls", () => {
		const source = `"use strict"; function calculate() { return Math.floor(1.25); } globalThis.keep = calculate;`;
		const mutableOutput = emit(source);
		expect(mutableOutput).toContain("mal_vm_op_load_property_ic");
		expect(mutableOutput).toContain("mal_vm_op_load_global_property");
		expect(mutableOutput).not.toMatch(/r\d+ = vm->intrinsics\[MAL_INTRINSIC_MATH\];/);

		const lockedOutput = emitLocked(source);
		expect(lockedOutput).not.toContain("mal_builtin_math_unary_number_known");
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

	it("routes exact class calls through the ordinary-call runtime check", () => {
		const output = emitLocked(`
			"use strict";
			class Example {
				constructor() { return { value: 1 }; }
			}
			globalThis.result = Example();
		`);
		const entry = output.slice(output.indexOf("static MalValue mal_compiled_0("));
		expect(entry).toContain("mal_vm_call_direct(vm,");
		expect(entry).not.toMatch(/MalValue __direct_value_\d+ = mal_compiled_1\(vm,/);
	});

	it("uses the canonical boxed ABI when exact calls enumerate arguments", () => {
		const output = emit(`
			"use strict";
			const values = [3, 5];
			const large = function large(index) {
				let total = 0;
				for (let i = 0; i < 24; i++) total += values[index];
				return total + index + Object.keys(arguments).length;
			};
			globalThis.result = large(1);
		`);
		expect(output).toMatch(/MalValue __direct_value_\d+ = mal_compiled_1\(vm,/);
	});

	it("emits guarded Function.prototype.call flattening with a shifted exact target", () => {
		const output = emitLocked(`
			const target = function target(value) { "use strict"; return this === null ? value : 0; };
			globalThis.result = target.call(null, 1);
		`);
		expect(output).toMatch(
			/mal_vm_call_function_call_direct_compiled\(vm, &__cc_\d+, 1, mal_compiled_1,/,
		);
		expect(output).not.toMatch(
			/mal_vm_call_function_call_direct_compiled\([^\n]+\);[\s\S]{0,80}mal_vm_call_cached/,
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

	it("emits guarded Array at dispatch from call metadata", () => {
		const output = emit(`
			function last(values) { return values.at(-1); }
			globalThis.result = last([1, 2, 3]);
		`);
		expect(output).toContain("mal_builtin_array_at_direct(vm, &__cc_");
	});

	it("consumes the Core-owned String charCodeAt operation chain", () => {
		const code = `
			function codeUnit(value, index) {
				return value.charCodeAt(index);
			}
			globalThis.codeUnit = codeUnit;
		`;
		const definition = lower(code);
		const regions = specializations(definition).filter(
			(region) => region.kind === "string-char-code-at-chain",
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			representation: "primitive-string-code-unit",
			runtimeGuard: "primitive-string-number-position",
			evaluationOrder: "capture-property-before-arguments",
			license: { admission: { mode: "capture" } },
		});
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
			definition,
		);
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("mal_vm_local_watched_primitive_value_try_load_static");
		expect(output).toContain("__string_char_code_at_");
		expect(output).toContain("mal_vm_op_load_property_ic(vm,");
		expect(output).toContain("mal_builtin_string_char_code_at_direct(vm, &__cc_");
		expect(output).toContain(", 1);");

		const semantic = analyzeSourceAndRunSemanticAnalysis(
			code,
			"locked-string-char-code-at.js",
			parseScript(code, { strict: false }),
		);
		const lockedOutput = emitProgramImage(
			compileSemanticProgramToProgramImage(semantic, {
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			}),
			{ compiled: true },
		);
		expect(lockedOutput).not.toContain(
			"mal_vm_local_watched_primitive_value_try_load_static",
		);
		expect(lockedOutput).toContain("mal_builtin_string_char_code_at_known(vm,");
		expect(lockedOutput).toContain("mal_vm_op_load_property_ic(vm,");
		expect(lockedOutput).not.toContain(
			"mal_builtin_string_char_code_at_direct(vm, &__cc_",
		);
	});

	it("consumes the Core-certified bounded String relation in the backend", () => {
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
		expect(output).not.toContain("mal_builtin_string_char_code_at_direct_in_bounds(");
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
		expect(output).not.toContain("mal_builtin_string_char_code_at_direct_in_bounds(");
		expect(output).toContain("mal_builtin_string_char_code_at_direct(vm,");
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
		expect(output).not.toContain("mal_builtin_string_slice_to_number_direct(vm,");

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
		const lowered = compileSemanticProgramToProgramImage(semantic);
		const projections = specializations(lowered).filter(
			(region) => region.kind === "string-split-projection",
		);
		expect(projections).toHaveLength(1);
		expect(projections[0]).toMatchObject({
			kind: "string-split-projection",
			representation: "projected-elements",
			splitIdentity: "runtime-guarded",
			license: {
				genericTwin: "retained",
				materialization: "whole-region",
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		const lockedDefinition = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const lockedProjections = specializations(lockedDefinition).filter(
			(region) => region.kind === "string-split-projection",
		);
		expect(lockedProjections).toHaveLength(1);
		expect(lockedProjections[0]).toMatchObject({
			splitIdentity: "authority-invariant",
			propertyPlacement: "call-fallback",
		});

		const cached = deserializeCompilerArtifact(
			serializeCompilerArtifact(lowered, { debugInfo: false }),
		);
		expect(
			specializations(cached).filter(
				(region) => region.kind === "string-split-projection",
			),
		).toEqual(projections);
		expect(emitProgramImage(cached, { compiled: true })).toContain(
			"mal_builtin_string_split_projection(vm,",
		);

		const functionIndex = lowered.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "string-split-projection"),
		);
		const owner = lowered.native.functions[functionIndex]!;
		const regionIndex = owner.specializations.findIndex(
			(region) => region.kind === "string-split-projection",
		);
		const region = owner.specializations[regionIndex]!;
		if (region.kind !== "string-split-projection") {
			throw new Error("missing split projection region");
		}
		const malformed = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, {
				...region,
				loads: region.loads.with(0, { ...region.loads[0]!, dst: -1 }),
			}),
		);
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid String\.split projection region metadata/,
		);
		const invalidIdentity = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, {
				...region,
				splitIdentity: "authority-invariant",
			}),
		);
		expect(() => serializeCompilerArtifact(invalidIdentity)).toThrow(
			/invalid String\.split projection region metadata/,
		);
		const invalidForEmission = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, { ...region, loads: [] }),
		);
		expect(() => emitProgramImage(invalidForEmission, { compiled: true })).toThrow(
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
		const lowered = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const projections = specializations(lowered).filter(
			(region) => region.kind === "regexp-exec-projection",
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
					dependencies: [{ kind: "world", fact: "primordials.locked" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		expect(projections[0]!.nullChecks).toHaveLength(1);
		expect(projections[0]!.loads[0]?.consumer?.kind).toBe("number");

		const cached = deserializeCompilerArtifact(
			serializeCompilerArtifact(lowered, { debugInfo: false }),
		);
		expect(
			specializations(cached).filter(
				(region) => region.kind === "regexp-exec-projection",
			),
		).toEqual(projections);
		expect(emitProgramImage(cached, { compiled: true })).toContain(
			"mal_regexp_exec_capture_projection(vm,",
		);

		const functionIndex = lowered.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "regexp-exec-projection"),
		);
		const owner = lowered.native.functions[functionIndex]!;
		const regionIndex = owner.specializations.findIndex(
			(region) => region.kind === "regexp-exec-projection",
		);
		const region = owner.specializations[regionIndex]!;
		if (region.kind !== "regexp-exec-projection") {
			throw new Error("missing RegExp.exec projection region");
		}
		const malformed = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, {
				...region,
				lastIndexEffect: "broken" as never,
			}),
		);
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid RegExp\.exec projection region/,
		);
		const invalidForEmission = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, { ...region, loads: [] }),
		);
		expect(() => emitProgramImage(invalidForEmission, { compiled: true })).toThrow(
			/Invalid Core RegExp\.exec projection/,
		);
	});

	it("preserves Core's projected String method-identity decision through wire", () => {
		const source = `globalThis.parse = function parse(regexp, value) {
			const match = regexp.exec(value);
			if (match === null) return -1;
			return match[1].charCodeAt(0) + match[2].toUpperCase().toLowerCase().length;
		};`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"regexp-projected-string-method-identity.js",
			parseScript(source, { strict: false }),
		);
		const projectedIdentities = (lowered: ProgramImage) => {
			const region = lowered.native.functions
				.flatMap((fn) => fn.specializations)
				.find((candidate) => candidate.kind === "regexp-exec-projection");
			if (region?.kind !== "regexp-exec-projection") {
				throw new Error("missing RegExp.exec projection region");
			}
			return {
				region,
				identities: region.loads.flatMap(({ consumer }) =>
					consumer?.kind === "charCodeAtZero" || consumer?.kind === "asciiCaseLength"
						? [consumer.methodIdentity]
						: [],
				),
			};
		};

		const mutable = compileSemanticProgramToProgramImage(semantic);
		const mutableProjection = projectedIdentities(mutable);
		expect(mutableProjection.identities).toEqual(["runtime-guarded", "runtime-guarded"]);

		const locked = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const lockedProjection = projectedIdentities(locked);
		expect(lockedProjection.identities).toEqual([
			"authority-invariant",
			"authority-invariant",
		]);
		expect(
			projectedIdentities(
				deserializeCompilerArtifact(
					serializeCompilerArtifact(locked, { debugInfo: false }),
				),
			).identities,
		).toEqual(lockedProjection.identities);

		const firstLoad = lockedProjection.region.loads[0]!;
		if (firstLoad.consumer?.kind !== "charCodeAtZero") {
			throw new Error("missing charCodeAtZero consumer");
		}
		const charConsumer = firstLoad.consumer;
		const malformed: ProgramImage = {
			...locked,
			native: {
				...locked.native,
				functions: locked.native.functions.map((fn) => ({
					...fn,
					specializations: fn.specializations.map((region) =>
						region === lockedProjection.region
							? {
									...region,
									loads: region.loads.with(0, {
										...firstLoad,
										consumer: {
											...charConsumer,
											methodIdentity: "runtime-guarded",
										},
									}),
								}
							: region,
					),
				})),
			},
		};
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid RegExp\.exec projection region/,
		);

		const ownerIndex = locked.native.functions.findIndex((fn) =>
			fn.specializations.includes(lockedProjection.region),
		);
		const owner = locked.runtime.functions[ownerIndex]!;
		const charCall = owner.instructions[charConsumer.callIp];
		if (charCall?.opcode !== "CALL") throw new Error("missing projected char call");
		const invalidZero: ProgramImage = {
			...locked,
			runtime: {
				...locked.runtime,
				functions: locked.runtime.functions.with(ownerIndex, {
					...owner,
					instructions: owner.instructions.with(charConsumer.callIp, {
						...charCall,
						arguments: [-4],
					}),
				}),
			},
		};
		expect(() => serializeCompilerArtifact(invalidZero)).toThrow(
			/invalid RegExp\.exec projection region/,
		);

		const asciiLoad = lockedProjection.region.loads.find(
			({ consumer }) => consumer?.kind === "asciiCaseLength",
		);
		if (asciiLoad?.consumer?.kind !== "asciiCaseLength") {
			throw new Error("missing projected ASCII case consumer");
		}
		const asciiConsumer = asciiLoad.consumer;
		const lowerProperty = owner.instructions[asciiConsumer.lowerPropertyIp];
		const upperProperty = owner.instructions[asciiConsumer.upperPropertyIp];
		if (
			lowerProperty?.opcode !== "LOAD_PROPERTY_STATIC" ||
			upperProperty?.opcode !== "LOAD_PROPERTY_STATIC"
		) {
			throw new Error("missing projected case properties");
		}
		const invalidCaseChain: ProgramImage = {
			...locked,
			runtime: {
				...locked.runtime,
				functions: locked.runtime.functions.with(ownerIndex, {
					...owner,
					instructions: owner.instructions.with(asciiConsumer.lowerPropertyIp, {
						...lowerProperty,
						stringIndex: upperProperty.stringIndex,
					}),
				}),
			},
		};
		expect(() => serializeCompilerArtifact(invalidCaseChain)).toThrow(
			/invalid RegExp\.exec projection region/,
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
		const mutable = compileSemanticProgramToProgramImage(semantic);
		expect(
			specializations(mutable).some((region) => region.kind === "string-slice-number"),
		).toBe(false);
		const lowered = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const regions = specializations(lowered).filter(
			(region) => region.kind === "string-slice-number",
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			kind: "string-slice-number",
			representation: "primitive-string-span-number",
			builtinIdentities: "authority-invariant",
			sliceStart: 1,
			license: {
				genericTwin: "retained",
				materialization: "none",
				guard: {
					dependencies: [{ kind: "world", fact: "primordials.locked" }],
					obligations: ["fallback"],
				},
			},
		});
		expect(regions[0]!.controlFlow.exceptionalHandlerIps).not.toHaveLength(0);
		const lockedDefinition = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const lockedRegions = specializations(lockedDefinition).filter(
			(region) => region.kind === "string-slice-number",
		);
		expect(lockedRegions).toHaveLength(1);
		expect(lockedRegions[0]).toMatchObject({
			builtinIdentities: "authority-invariant",
		});

		const cached = deserializeCompilerArtifact(
			serializeCompilerArtifact(lowered, { debugInfo: false }),
		);
		expect(
			specializations(cached).filter((region) => region.kind === "string-slice-number"),
		).toEqual(regions);
		expect(emitProgramImage(cached, { compiled: true })).toContain(
			"mal_builtin_string_slice_to_number_direct_locked(vm,",
		);

		const functionIndex = lowered.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "string-slice-number"),
		);
		const owner = lowered.native.functions[functionIndex]!;
		const regionIndex = owner.specializations.findIndex(
			(region) => region.kind === "string-slice-number",
		);
		const region = owner.specializations[regionIndex]!;
		if (region.kind !== "string-slice-number") {
			throw new Error("missing String.slice Number region");
		}
		const malformed = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, {
				...region,
				sliceStart: Number.POSITIVE_INFINITY,
			}),
		);
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid String\.slice Number region/,
		);
		const invalidIdentity = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, {
				...region,
				builtinIdentities: "runtime-guarded",
			}),
		);
		expect(() => serializeCompilerArtifact(invalidIdentity)).toThrow(
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
		const lowered = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const projections = specializations(lowered).filter(
			(region) => region.kind === "regexp-iterator-projection",
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
				admission: { mode: "stable" },
				guard: {
					dependencies: [{ kind: "world", fact: "primordials.locked" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		expect(projections[0]!.controlFlow.exceptionalHandlerIps).not.toHaveLength(0);

		const cached = deserializeCompilerArtifact(
			serializeCompilerArtifact(lowered, { debugInfo: false }),
		);
		expect(
			specializations(cached).filter(
				(region) => region.kind === "regexp-iterator-projection",
			),
		).toEqual(projections);
		expect(emitProgramImage(cached, { compiled: true })).toContain(
			"mal_regexp_try_exact_iterator_capture_projection(vm,",
		);

		const functionIndex = lowered.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "regexp-iterator-projection"),
		);
		const owner = lowered.native.functions[functionIndex]!;
		const regionIndex = owner.specializations.findIndex(
			(region) => region.kind === "regexp-iterator-projection",
		);
		const region = owner.specializations[regionIndex]!;
		if (region.kind !== "regexp-iterator-projection") {
			throw new Error("missing RegExp iterator projection region");
		}
		const malformed = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, {
				...region,
				runtimeGuard: "broken" as never,
			}),
		);
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid RegExp iterator projection region/,
		);
		const invalidForEmission = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(regionIndex, { ...region, loads: [] }),
		);
		expect(() => emitProgramImage(invalidForEmission, { compiled: true })).toThrow(
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
		const lowered = compileSemanticProgramToProgramImage(semantic);
		const cursors = specializations(lowered).filter(
			(region) => region.kind === "string-split-cursor",
		);
		expect(cursors).toHaveLength(1);
		expect(cursors[0]).toMatchObject({
			kind: "string-split-cursor",
			representation: "split-cursor-spans",
			splitIdentity: "runtime-guarded",
			trimIdentity: "runtime-guarded",
			license: {
				genericTwin: "retained",
				materialization: "on-demand",
				admission: { mode: "per-use" },
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		expect(cursors[0]?.primitiveStringLengthIps).toHaveLength(1);
		const lockedDefinition = compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		});
		const lockedCursors = specializations(lockedDefinition).filter(
			(region) => region.kind === "string-split-cursor",
		);
		expect(lockedCursors).toHaveLength(1);
		expect(lockedCursors[0]).toMatchObject({
			splitIdentity: "authority-invariant",
			trimIdentity: "authority-invariant",
			propertyPlacement: "call-fallback",
			license: { admission: { mode: "stable" } },
		});

		const cached = deserializeCompilerArtifact(
			serializeCompilerArtifact(lowered, { debugInfo: false }),
		);
		expect(
			specializations(cached).filter((region) => region.kind === "string-split-cursor"),
		).toEqual(cursors);
		const functionIndex = lowered.native.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "string-split-cursor"),
		);
		const owner = lowered.native.functions[functionIndex]!;
		const bytecode = lowered.runtime.functions[functionIndex]!;
		const cursor = owner.specializations.find(
			(region) => region.kind === "string-split-cursor",
		)!;
		const cursorIndex = owner.specializations.indexOf(cursor);
		const invalidIdentity = withSpecializations(
			lowered,
			functionIndex,
			owner.specializations.with(cursorIndex, {
				...cursor,
				trimIdentity: "authority-invariant",
			}),
		);
		expect(() => serializeCompilerArtifact(invalidIdentity)).toThrow(
			/invalid String\.split cursor region metadata/,
		);
		const element = bytecode.instructions[cursor.elementIp]!;
		expect(element.opcode).toBe("LOAD_PROPERTY");
		if (element.opcode !== "LOAD_PROPERTY")
			throw new Error("expected cursor element load");
		expect(owner.registerRepresentations[element.key]).toBe("number");
		const emitted = emitProgramImage(cached, { compiled: true });
		expect(emitted).toContain("mal_builtin_string_split_cursor_init(vm,");
		expect(emitted).toContain(
			`mal_vm_array_try_get_index(__property_receiver_${cursor.elementIp}, r${element.key}`,
		);
		const duplicate = withSpecializations(lowered, functionIndex, [
			...owner.specializations,
			cursor,
		]);
		expect(() => emitProgramImage(duplicate, { compiled: true })).toThrow(
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

	it("projects canonical String split calls with dynamic primitive contents", () => {
		const output = emitLocked(`
			function first(value) { return String(value).split(",")[0]; }
			globalThis.first = first;
		`);
		expect(output).toContain("mal_builtin_string_split_projection_locked(vm,");
		expect(output).toContain("mal_builtin_string_split_direct(vm,");
		expect(output).not.toContain("mal_vm_call_cached(vm,");
	});

	it("folds a constant String split projection without allocation or dispatch", () => {
		const code = `
			function first() {
				return "alpha,beta".split(",")[0];
			}
			globalThis.first = first;
		`;
		const output = inspectStaticValueFunction(code, "first");
		expect(output.structure.allocations).toBe(0);
		expect(output.structure.genericCalls).toBe(0);
		expect(output.structure.genericLookups).toBe(0);
		expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(false);
		const strings = output.fn.instructions.flatMap((instruction) =>
			instruction.opcode === "CREATE_STRING"
				? [
						String.fromCharCode(
							...output.image.runtime.stringConstants[instruction.stringIndex]!,
						),
					]
				: [],
		);
		expect(strings).toEqual(["alpha"]);
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

	it("erases locked projected charCodeAt identity checks", () => {
		const output = emitLocked(`
			function firstCodeUnit(value) {
				const match = /([a-z]+)/.exec(value);
				if (match === null) return -1;
				return match[1].charCodeAt(0);
			}
			globalThis.firstCodeUnit = firstCodeUnit;
		`);
		expect(output).toContain("mal_regexp_exec_capture_projection_locked(vm,");
		expect(output).not.toContain("mal_vm_local_watched_primitive_value_try_load_static");
		expect(output).not.toContain("u64 __watched_methods_epoch");
		expect(output).toContain("mal_builtin_string_char_code_at_direct(vm,");
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

	it("erases locked projected ASCII case method checks", () => {
		const output = emitLocked(`
			function normalizedLength(value) {
				const match = /([a-z]+)/.exec(value);
				if (match === null) return -1;
				return match[1].toUpperCase().toLowerCase().length;
			}
			globalThis.normalizedLength = normalizedLength;
		`);
		expect(output).toContain("mal_regexp_exec_capture_projection_locked(vm,");
		expect(output).toContain(
			"mal_builtin_string_ascii_case_chain_length_span_locked(vm,",
		);
		expect(output).not.toContain("mal_vm_local_watched_primitive_value_try_load_static");
		expect(output).not.toContain("u64 __watched_methods_epoch");
		expect(output).not.toContain("mal_builtin_string_ascii_case_chain_length_span(vm,");
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
		const output = emitLocked(`
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
		const output = emitLocked(`
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
		const source = `
			function update(map, set, key, value) {
				const previous = map.get(key);
				map.set(key, value);
				set.add(key);
				return previous;
			}
			globalThis.update = update;
		`;
		const definition = lower(source);
		const regions = specializations(definition).filter(
			(region) => region.kind === "builtin-collection-call-chain",
		);
		expect(regions).toHaveLength(3);
		expect(
			regions.map(
				(region) => region.kind === "builtin-collection-call-chain" && region.operation,
			),
		).toEqual(["Map.prototype.get", "Map.prototype.set", "Set.prototype.add"]);
		expect(regions[0]).toMatchObject({
			representation: "captured-collection-method",
			runtimeGuard: "exact-collection-method",
			evaluationOrder: "capture-property-before-arguments",
			license: { admission: { mode: "capture" }, materialization: "none" },
		});
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(definition))).toEqual(
			definition,
		);
		const output = emitProgramImage(definition, { compiled: true });
		expect(output).toContain("mal_vm_try_capture_collection_method(vm,");
		expect(output).toContain("mal_vm_op_load_property_ic_static_miss(vm,");
		expect(output).toContain("mal_builtin_collection_direct(vm, &__cc_");
		expect(output).toContain("MAL_GUARDED_BUILTIN_MAP_GET");
		expect(output).toContain("MAL_GUARDED_BUILTIN_MAP_SET");
		expect(output).toContain("MAL_GUARDED_BUILTIN_SET_ADD");
	});

	it("does not spend expansion slots on collection helper dispatch", () => {
		const definition = lower(`
			function update(key, value) {
				const map = new Map();
				const set = new Set();
				map.get(key);
				map.set(key, value);
				map.has(key);
				map.delete(key);
				set.add(key);
				set.has(key);
				set.delete(key);
			}
			globalThis.update = update;
		`);
		const operations = specializations(definition).flatMap((region) =>
			region.kind === "builtin-collection-call-chain" ? [region.operation] : [],
		);
		expect(operations).toEqual([
			"Map.prototype.get",
			"Map.prototype.set",
			"Map.prototype.has",
			"Map.prototype.delete",
			"Set.prototype.add",
			"Map.prototype.has",
			"Map.prototype.delete",
		]);
	});

	it("keeps proven own methods out of collection helper dispatch", () => {
		const definition = lower(`
			const plain = {
				get() {
					return 1;
				},
			};
			globalThis.value = plain.get();
		`);
		expect(
			specializations(definition).filter(
				(region) => region.kind === "builtin-collection-call-chain",
			),
		).toEqual([]);
	});

	it("polls only collection operations with exact-root safepoint metadata", () => {
		const output = emitLocked(`
			function read(key) {
				const map = new Map([[key, "value"]]);
				return map.get(key);
			}
			globalThis.read = read;
		`);
		const lines = output.split("\n");
		const poll = "if (mal_gc_poll) mal_gc_safepoint(vm);";
		const constructLine = lines.findIndex((line) =>
			line.includes("mal_vm_call_known_native"),
		);
		const getLine = lines.findIndex((line) => line.includes("mal_builtin_map_get_key"));

		expect(constructLine).toBeGreaterThanOrEqual(0);
		expect(
			lines.slice(constructLine + 1, constructLine + 5).map((line) => line.trim()),
		).toContain(poll);
		expect(getLine).toBeGreaterThanOrEqual(0);
		expect(
			lines.slice(getLine + 1, getLine + 4).map((line) => line.trim()),
		).not.toContain(poll);
	});
});

describe("native static typeof facts", () => {
	function emit(source: string): string {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"static-typeof-facts.js",
			parseScript(source, { strict: false }),
		);
		return emitProgramImage(compileSemanticProgramToProgramImage(semantic), {
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

		// Both operators have fixed primitive result kinds on normal completion; their
		// coercion and throwing effects remain in the preceding operations.
		expect(output).not.toContain("mal_vm_typeof_compare");
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
