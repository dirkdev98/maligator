import type { IncludedAsset } from "../../assets.ts";
import { knownOperationFlags } from "../shared/known-operations.ts";
import { knownOperationIndex } from "../shared/known-operations.ts";
import { staticDataQueryTag } from "../shared/static-data-query.ts";
import { finalizeCompilerRemarks } from "./profile-metadata.ts";
import type { ProgramImage } from "./program-image.ts";
import { directCompiledEntryKey, emitCompiledFunction } from "./render-native-c.ts";
import type { CompiledFunction } from "./render-native-c.ts";
import {
	compressPositions,
	computeArgumentRetentionLimit,
	countPropertyIcSites,
	validateRuntimeImageMetadata,
	vmGuardedCallSideTag,
	vmSafepointRootMapsAreTrusted,
	VM_MATH_BINARY_NUMBER_OPERATIONS,
	VM_MATH_UNARY_NUMBER_OPERATIONS,
} from "./runtime-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	RuntimeImage,
} from "./runtime-image.ts";

type VmBinaryOperator = Extract<BytecodeInstruction, { opcode: "BINARY" }>["operator"];

export interface EmitOptions {
	/** Host path normalization for compiled stack traces; virtual paths pass through by default. */
	sourcePath?: (file: string) => string;
	/**
	 * Suffix for all emitted symbols, so multiple program images can live in a
	 * single translation unit (used by the batched test262 runner).
	 */
	symbolSuffix?: string;
	includeHeader?: boolean;

	/**
	 * Emit debug-info tables (file names, source positions, per-function position
	 * tables) for stack traces. Defaults to true. Set false to strip debug info —
	 * traces then carry function names only, with no file/line/column. The batched
	 * test262 path strips it (test262 does not exercise Error.stack, and it keeps
	 * the code-size baseline stable).
	 */
	debugInfo?: boolean;

	/**
	 * Emit the native-C compiled function bodies and wire them
	 * into `MalFunction.compiled`. Defaults to true. Set false to force every
	 * function through the bytecode interpreter — used for profiling the pure
	 * interpreter path against the native overlay.
	 */
	compiled?: boolean;

	/** Assets captured by the resolved build config and baked into this executable. */
	assets?: Array<IncludedAsset>;

	/** Install the lowercase `mal` host surface. */
	maligatorSurface?: boolean;
}

/** Escape a string for a C string literal. */
export function cEscapeString(value: string): string {
	let out = "";
	const appendByte = (byte: number): void => {
		out += `\\${byte.toString(8).padStart(3, "0")}`;
	};
	for (const ch of value) {
		let code = ch.codePointAt(0)!;
		if (ch === "\\") {
			out += "\\\\";
		} else if (ch === '"') {
			out += '\\"';
		} else if (code >= 0x20 && code < 0x7f) {
			out += ch;
		} else if (ch === "\n") {
			out += "\\n";
		} else if (ch === "\t") {
			out += "\\t";
		} else {
			// Emit as UTF-8 octal escapes so the C literal is plain bytes.
			// Lone surrogates encode as U+FFFD, matching UTF-8 encoders including
			// Node's Buffer.from. Iteration has already combined valid pairs.
			if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
			if (code <= 0x7f) {
				appendByte(code);
			} else if (code <= 0x7ff) {
				appendByte(0xc0 | (code >> 6));
				appendByte(0x80 | (code & 0x3f));
			} else if (code <= 0xffff) {
				appendByte(0xe0 | (code >> 12));
				appendByte(0x80 | ((code >> 6) & 0x3f));
				appendByte(0x80 | (code & 0x3f));
			} else {
				appendByte(0xf0 | (code >> 18));
				appendByte(0x80 | ((code >> 12) & 0x3f));
				appendByte(0x80 | ((code >> 6) & 0x3f));
				appendByte(0x80 | (code & 0x3f));
			}
		}
	}
	return out;
}

const MAL_FUNCTION_ROW_MACRO = [
	"#define MAL_FUNCTION_ROW(argument_snapshot_plan_value, mapped_argument_slots_value, instructions_value, instruction_data_value, gc_safepoints_value, handlers_value, compiled_value, positions_value, profile_site_ids_value, name_string_index_value, kind_value, parameter_count_value, argument_snapshot_count_value, argument_snapshot_plan_count_value, mapped_argument_count_value, length_value, register_count_value, captured_count_value, argument_retention_limit_value, property_ic_count_value, literal_shape_count_value, instruction_count_value, instruction_data_count_value, gc_safepoint_count_value, handler_count_value, file_index_value, position_count_value, strict_value, needs_arguments_value, mapped_arguments_value, gc_safepoints_trusted_value, is_derived_constructor_value, is_class_constructor_value, constructor_slot_reserve_value, has_prototype_value) { ",
	".argument_snapshot_plan = argument_snapshot_plan_value, .mapped_argument_slots = mapped_argument_slots_value, .instructions = instructions_value, .instruction_data = instruction_data_value, .gc_safepoints = gc_safepoints_value, .handlers = handlers_value, .compiled = compiled_value, .positions = positions_value, MAL_FUNCTION_PROFILE_SITE(profile_site_ids_value) ",
	".name_string_index = name_string_index_value, .kind = kind_value, .parameter_count = parameter_count_value, .argument_snapshot_count = argument_snapshot_count_value, .argument_snapshot_plan_count = argument_snapshot_plan_count_value, .mapped_argument_count = mapped_argument_count_value, .length = length_value, .register_count = register_count_value, .captured_count = captured_count_value, .argument_retention_limit = argument_retention_limit_value, .property_ic_count = property_ic_count_value, .literal_shape_count = literal_shape_count_value, .instruction_count = instruction_count_value, .instruction_data_count = instruction_data_count_value, .gc_safepoint_count = gc_safepoint_count_value, .handler_count = handler_count_value, .file_index = file_index_value, .position_count = position_count_value, .strict = strict_value, .needs_arguments = needs_arguments_value, .mapped_arguments = mapped_arguments_value, .gc_safepoints_trusted = gc_safepoints_trusted_value, .is_derived_constructor = is_derived_constructor_value, .is_class_constructor = is_class_constructor_value, .constructor_slot_reserve = constructor_slot_reserve_value, .has_prototype = has_prototype_value }",
].join("");

export const NATIVE_C_HEADER_LINES = [
	"#include <string.h>",
	'#include "vm.h"',
	'#include "vm_ops.h"',
	'#include "value_ops.h"',
	'#include "perf_stats.h"',
	'#include "profile.h"',
	'#include "builtin_array.h"',
	'#include "builtin_boolean.h"',
	'#include "builtin_date.h"',
	'#include "builtin_object.h"',
	'#include "builtin_json.h"',
	'#include "builtin_map.h"',
	'#include "builtin_set.h"',
	'#include "builtin_number.h"',
	'#include "builtin_bigint.h"',
	'#include "builtin_string.h"',
	'#include "builtin_uri.h"',
	'#include "builtin_regexp.h"',
	'#include "builtin_math.h"',
	// Native-C for-of lowering uses the iterator-record helpers.
	'#include "builtin_iterator.h"',
	// for-await lowering uses mal_vm_get_async_iterator.
	'#include "builtin_async_iterator.h"',
	// Compiled coroutines cast their backend entry state to MalGeneratorObject.
	'#include "generator_object.h"',
	"#define MAL_ROOT_MASK(mask) (__gc_frame.inactive_slots = UINT64_C(mask))",
	"#define MAL_STRING_ROW(code_units_value, length_value) { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = length_value, .code_units = code_units_value }",
	"#define MAL_LINE_ENTRY(start_ip_value, pos_id_value) { .start_ip = start_ip_value, .pos_id = pos_id_value }",
	"#define MAL_SOURCE_POS(line_value, column_value, inlined_function_index_value, caller_pos_id_value) { .line = line_value, .column = column_value, .inlined_function_index = inlined_function_index_value, .caller_pos_id = caller_pos_id_value }",
	"#if MAL_PROFILE",
	"#define MAL_FUNCTION_PROFILE_SITE(value) .profile_site_ids = value,",
	"#else",
	"#define MAL_FUNCTION_PROFILE_SITE(value)",
	"#endif",
	MAL_FUNCTION_ROW_MACRO,
	"",
];

export const GENERATED_DATA_C_HEADER_LINES = [
	"#include <string.h>",
	'#include "vm.h"',
	"#define MAL_STRING_ROW(code_units_value, length_value) { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = length_value, .code_units = code_units_value }",
	"#define MAL_LINE_ENTRY(start_ip_value, pos_id_value) { .start_ip = start_ip_value, .pos_id = pos_id_value }",
	"#define MAL_SOURCE_POS(line_value, column_value, inlined_function_index_value, caller_pos_id_value) { .line = line_value, .column = column_value, .inlined_function_index = inlined_function_index_value, .caller_pos_id = caller_pos_id_value }",
	"#if MAL_PROFILE",
	"#define MAL_FUNCTION_PROFILE_SITE(value) .profile_site_ids = value,",
	"#else",
	"#define MAL_FUNCTION_PROFILE_SITE(value)",
	"#endif",
	MAL_FUNCTION_ROW_MACRO,
	"",
];

export type GeneratedTranslationUnitKind = "runtime-image" | "data" | "code";

export interface GeneratedTranslationUnitDefinition {
	readonly kind: "data array" | "compiled function";
	readonly symbol: string;
	readonly sourceCodeUnits: number;
}

export interface GeneratedTranslationUnit {
	readonly id: string;
	readonly kind: GeneratedTranslationUnitKind;
	readonly source: string;
	readonly headerFiles: ReadonlyArray<string>;
	readonly definitions: ReadonlyArray<GeneratedTranslationUnitDefinition>;
}

export interface TranslationUnitPolicy {
	readonly targetCodeUnits: number;
	readonly hardMaximumCodeUnits: number;
}

const COMPILED_FUNCTION_DECLARATION =
	"(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state)";

function directEntryDeclaration(
	entry: CompiledFunction["directEntries"][number],
): string {
	const cType = (
		representation: "boxed" | "int32" | "number" | "boolean" | "string",
	): string =>
		representation === "int32"
			? "i32"
			: representation === "number"
				? "double"
				: representation === "boolean"
					? "bool"
					: "MalValue";
	const parameters = entry.parameterRepresentations.map(
		(representation, index) => `${cType(representation)} p${index}`,
	);
	return `${cType(entry.resultRepresentation)} ${entry.symbol}(MalVm *vm, MalValue this_value${parameters.length === 0 ? "" : `, ${parameters.join(", ")}`}, MalEnv *env, MalValue callee)`;
}

export const DEFAULT_TRANSLATION_UNIT_TARGET_CODE_UNITS = 2 * 1024 * 1024;
/** Keep indivisible definitions below the self-host compiler's 16 MiB string limit. */
export const TRANSLATION_UNIT_HARD_MAXIMUM_CODE_UNITS = 8 * 1024 * 1024;
export const DEFAULT_TRANSLATION_UNIT_POLICY: TranslationUnitPolicy = {
	targetCodeUnits: DEFAULT_TRANSLATION_UNIT_TARGET_CODE_UNITS,
	hardMaximumCodeUnits: TRANSLATION_UNIT_HARD_MAXIMUM_CODE_UNITS,
};

function stringCodeUnitsBody(constant: Array<number>): string {
	return `{ ${constant.length > 0 ? constant.join(", ") : "0"} }`;
}

function malStringRow(symbol: string, length: number): string {
	// Immortal string constant. The row stays mutable because its hash is cached
	// lazily on first use (a static initializer cannot compute it).
	return `    MAL_STRING_ROW(${symbol}, ${length}),`;
}

function malFunctionKind(fn: RuntimeImage["functions"][number]): string {
	return fn.isAsync && fn.isGenerator
		? "MAL_FUNCTION_KIND_ASYNC_GENERATOR"
		: fn.isAsync
			? "MAL_FUNCTION_KIND_ASYNC"
			: fn.isGenerator
				? "MAL_FUNCTION_KIND_GENERATOR"
				: "MAL_FUNCTION_KIND_NORMAL";
}

/** One MalFunction table row, given the (possibly shared) symbols it points at. */
function malFunctionRow(
	fn: RuntimeImage["functions"][number],
	instructionsSymbol: string,
	instructionDataSymbol: string,
	instructionDataCount: number,
	gcSafepointsSymbol: string,
	gcSafepointCount: number,
	gcSafepointsTrusted: boolean,
	argumentSnapshotPlanSymbol: string,
	argumentSnapshotPlanCount: number,
	mappedArgumentSlotsSymbol: string,
	handlersSymbol: string,
	compiledSymbol: string,
	profileSiteIdsSymbol: string,
	debug: { positionsSymbol: string; positionCount: number; fileIndex: number },
	omitBytecode = false,
): Array<string> {
	const values = [
		argumentSnapshotPlanSymbol,
		mappedArgumentSlotsSymbol,
		omitBytecode ? "nullptr" : instructionsSymbol,
		instructionDataSymbol,
		gcSafepointsSymbol,
		omitBytecode ? "nullptr" : handlersSymbol,
		compiledSymbol,
		debug.positionsSymbol,
		fn.profileSiteIds === undefined ? "nullptr" : profileSiteIdsSymbol,
		fn.nameStringIndex,
		malFunctionKind(fn),
		fn.parameterCount,
		fn.argumentSnapshotCount,
		argumentSnapshotPlanCount,
		mappedArgumentSlotsSymbol === "nullptr" ? 0 : fn.mappedArgumentSlots.length,
		fn.length,
		fn.registerCount,
		fn.capturedCount,
		computeArgumentRetentionLimit(fn),
		countPropertyIcSites(fn.instructions),
		fn.literalShapeCount,
		omitBytecode ? 0 : fn.instructions.length,
		instructionDataCount,
		gcSafepointCount,
		omitBytecode ? 0 : fn.handlers.length,
		debug.fileIndex,
		debug.positionCount,
		fn.strict,
		fn.needsArguments,
		fn.mappedArguments,
		gcSafepointsTrusted,
		fn.isDerivedConstructor,
		fn.isClassConstructor,
		fn.constructorSlotReserve,
		fn.hasPrototype,
	];
	return [`    MAL_FUNCTION_ROW(${values.join(", ")}),`];
}

function safepointRootData(fn: BytecodeFunction): Array<number> {
	return (fn.gcSafepoints ?? []).flatMap((safepoint) => [
		safepoint.instructionIp,
		safepoint.rootRegisters.length,
		...safepoint.rootRegisters,
		safepoint.clearRegisters?.length ?? 0,
		...(safepoint.clearRegisters ?? []),
	]);
}

function argumentSnapshotPlanBody(fn: BytecodeFunction): string {
	return fn.argumentSnapshotPlan
		.map(
			(move) => `    { .destination = ${move.destination}, .source = ${move.source} },`,
		)
		.join("\n");
}

/** The body (rows, no braces) of a function's MalLineEntry position table. */
function positionArrayBody(fn: BytecodeFunction): string {
	return compressPositions(fn.positions)
		.map((run) => `    MAL_LINE_ENTRY(${run.startIp}, ${run.posId}),`)
		.join("\n");
}

function instructionArrayBody(
	fn: RuntimeImage["functions"][number],
	dataOffsets: Array<number | undefined>,
): string {
	return fn.instructions
		.map((instruction, i) => `    ${emitInstruction(instruction, dataOffsets[i])},`)
		.join("\n");
}

function instructionData(fn: RuntimeImage["functions"][number]): {
	data: Array<number>;
	offsets: Array<number | undefined>;
} {
	const data: Array<number> = [];
	const offsets: Array<number | undefined> = [];
	const single = (index: number, values: Array<number>, count: number): void => {
		if (count !== values.length) throw new Error("instruction side-data count mismatch");
		offsets[index] = data.length;
		data.push(count, ...values);
	};
	const paired = (index: number, first: Array<number>, second: Array<number>): void => {
		if (first.length !== second.length)
			throw new Error("instruction side-data length mismatch");
		offsets[index] = data.length;
		data.push(first.length, ...first, ...second);
	};

	fn.instructions.forEach((instruction, index) => {
		switch (instruction.opcode) {
			case "QUERY_STATIC_DATA":
				offsets[index] = data.length;
				data.push(instruction.templateOffset, staticDataQueryTag(instruction.queryKind));
				break;
			case "CALL_REST_ARGUMENTS":
				offsets[index] = data.length;
				data.push(
					instruction.receiver,
					instruction.startIndex,
					instruction.apply ? 1 : 0,
				);
				break;
			case "SELECT_SHAPE_CASE":
				offsets[index] = data.length;
				for (const candidate of instruction.candidates) {
					data.push(candidate.shapeFunctionIndex, candidate.shapeCacheIndex);
				}
				break;
			case "LOAD_PROPERTY_STATIC_SHAPE_CASE":
				offsets[index] = data.length;
				data.push(
					instruction.stringIndex,
					instruction.icIndex,
					instruction.slots.length,
					...instruction.slots,
				);
				break;
			case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
				offsets[index] = data.length;
				data.push(instruction.stringIndex, instruction.candidates.length);
				for (const candidate of instruction.candidates) {
					data.push(
						candidate.shapeFunctionIndex,
						candidate.shapeCacheIndex,
						candidate.slot,
					);
				}
				break;
			case "CREATE_OBJECT_SHAPED":
				if (instruction.count !== instruction.keyStringIndices.length) {
					throw new Error("instruction side-data count mismatch");
				}
				paired(index, instruction.keyStringIndices, instruction.valueRegisters);
				break;
			case "GUARD_BASE_CONSTRUCTOR_LAYOUT":
				offsets[index] = data.length;
				data.push(
					instruction.keyStringIndices.length,
					instruction.icIndex,
					...instruction.keyStringIndices,
				);
				break;
			case "CREATE_MODULE_NAMESPACE":
				paired(index, instruction.nameIndices, instruction.slots);
				break;
			case "CREATE_TEMPLATE_OBJECT":
				paired(index, instruction.cookedIndices, instruction.rawIndices);
				break;
			case "CALL":
				if (instruction.argumentCount !== instruction.arguments.length) {
					throw new Error("instruction side-data count mismatch");
				}
				offsets[index] = data.length;
				data.push(
					instruction.argumentCount,
					instruction.exactFunctionIndex ?? -1,
					instruction.guardedFunctionIndices?.length ?? 0,
					...(instruction.guardedFunctionIndices ?? []),
					...instruction.arguments,
					vmGuardedCallSideTag(
						instruction.guardedMathCall,
						instruction.guardedBuiltinCall,
					),
				);
				break;
			case "CALL_KNOWN":
				single(index, instruction.arguments, instruction.argumentCount);
				break;
			case "PRECISE_NUMBER_SUM":
				single(index, instruction.arguments, instruction.arguments.length);
				break;
			case "CONSTRUCT":
				if (instruction.argumentCount !== instruction.arguments.length) {
					throw new Error("instruction side-data count mismatch");
				}
				offsets[index] = data.length;
				data.push(
					instruction.argumentCount,
					instruction.exactFunctionIndex ?? -1,
					0,
					...instruction.arguments,
				);
				break;
			case "COPY_DATA_PROPERTIES":
				single(index, instruction.excluded, instruction.excludedCount);
				break;
			case "INIT_GLOBAL_VARS":
				single(
					index,
					instruction.nameStringIndices,
					instruction.nameStringIndices.length,
				);
				break;
			case "CREATE_PRIVATE_NAMES":
				single(index, instruction.capturedIndices, instruction.capturedIndices.length);
				break;
			case "INIT_PRIVATE_FIELDS":
				single(index, instruction.keyRegisters, instruction.keyRegisters.length);
				break;
		}
	});

	return { data, offsets };
}

function compiledKnownOwnSlotSeedData(
	fn: RuntimeImage["functions"][number],
): Array<number> {
	const data: Array<number> = [0];
	for (const instruction of fn.instructions) {
		if (
			instruction.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
			instruction.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
		) {
			continue;
		}
		data[0] = data[0]! + 1;
		data.push(
			instruction.icIndex,
			instruction.stringIndex,
			instruction.candidates.length,
		);
		for (const candidate of instruction.candidates) {
			data.push(candidate.shapeFunctionIndex, candidate.shapeCacheIndex, candidate.slot);
		}
	}
	return data[0] === 0 ? [] : data;
}

function handlerArrayBody(fn: RuntimeImage["functions"][number]): string {
	return fn.handlers
		.map(
			(handler) =>
				`    { .start_ip = ${handler.startIp}, .end_ip = ${handler.endIp}, .handler_ip = ${handler.handlerIp} },`,
		)
		.join("\n");
}

/**
 * Emit a C translation unit with the static MalRuntimeImage data.
 */
export function emitProgramImage(image: ProgramImage, options: EmitOptions = {}) {
	return emitProgramImageSource(image, options, false).source;
}

interface EmittedProgramImageSource {
	source: string;
	compiled: Array<CompiledFunction | null>;
}

interface ExternalDataDefinition {
	symbol: string;
	source: string;
}

interface SplitDataSource {
	source: string;
	definitions: Array<ExternalDataDefinition>;
}

interface GeneratedDeclaration {
	symbol: string;
	source: string;
}

interface TranslationUnitPart {
	kind: "data array" | "compiled function";
	symbol: string;
	partitionKey: string;
	source: string;
	declarationIndices: Array<number>;
}

interface TranslationUnitPartition {
	parts: Array<TranslationUnitPart>;
	declarationIndices: Array<number>;
	declarationSourceCodeUnits: number;
	partSourceCodeUnits: number;
}

interface NativeCompilationAvailability {
	directCompiledTargets: Set<number>;
	directCompiledEntries: Map<
		string,
		ProgramImage["native"]["functions"][number]["directEntries"][number] & {
			readonly leaf?: true;
		}
	>;
}

function nativeCompilationAvailability(
	image: ProgramImage,
	compiled: ReadonlyArray<CompiledFunction | null>,
): NativeCompilationAvailability {
	const compiledTargets = new Set<number>();
	compiled.forEach((fn, index) => {
		if (fn !== null) compiledTargets.add(index);
	});
	const directCompiledTargets = new Set<number>();
	for (const [callerIndex, native] of image.native.functions.entries()) {
		if (!compiledTargets.has(callerIndex)) continue;
		for (const instruction of native.instructions) {
			if (instruction?.kind !== "call") continue;
			for (const target of [
				instruction.directFunctionIndex,
				instruction.directCallbackFunctionIndex,
				instruction.numericSortCallback?.functionIndex,
				instruction.directCallTargetFunctionIndex,
				...(instruction.guardedFunctionIndices ?? []),
			]) {
				if (
					target !== undefined &&
					compiledTargets.has(target) &&
					compiled[target]!.source.length > 0 &&
					!image.runtime.functions[target]!.isClassConstructor
				) {
					directCompiledTargets.add(target);
				}
			}
		}
	}
	const directCompiledEntries: NativeCompilationAvailability["directCompiledEntries"] =
		new Map();
	for (const [functionIndex, fn] of compiled.entries()) {
		if (fn === null) continue;
		for (const emittedEntry of fn.directEntries) {
			const entry = image.native.functions[functionIndex]!.directEntries[emittedEntry.id];
			if (entry !== undefined) {
				directCompiledEntries.set(
					directCompiledEntryKey(functionIndex, emittedEntry.id),
					{ ...entry, ...(emittedEntry.leaf ? { leaf: true as const } : {}) },
				);
			}
		}
	}
	return { directCompiledTargets, directCompiledEntries };
}

function omitUnreachableCanonicalBodies(
	image: ProgramImage,
	compiled: Array<CompiledFunction | null>,
): Array<CompiledFunction | null> {
	const removable = new Set(
		image.native.functions.flatMap((fn, index) =>
			fn.specializedOnly === true &&
			compiled[index] !== null &&
			compiled[index]!.directEntries.length > 0
				? [index]
				: [],
		),
	);
	if (removable.size === 0) return compiled;
	// Each emitted caller variant must select a typed entry for every private target.
	for (const [caller, native] of image.native.functions.entries()) {
		if (removable.size === 0) return compiled;
		const emitted = compiled[caller];
		const variants =
			emitted === null || emitted === undefined
				? []
				: [emitted, ...emitted.directEntries];
		for (const [ip, instruction] of native.instructions.entries()) {
			if (instruction?.kind !== "call") continue;
			for (const target of [
				instruction.directFunctionIndex,
				...(instruction.guardedFunctionIndices ?? []),
			]) {
				if (target === undefined || !removable.has(target)) continue;
				if (
					variants.length === 0 ||
					variants.some(
						(variant) =>
							variant.emittedInstructions.has(ip) &&
							!variant.directEntryCalls.get(ip)?.has(target),
					)
				)
					removable.delete(target);
			}
		}
	}
	return compiled.map((fn, index) =>
		fn !== null && removable.has(index) ? { ...fn, source: "" } : fn,
	);
}

function compiledAvailabilityKey(
	compiled: ReadonlyArray<CompiledFunction | null>,
): string {
	return compiled
		.map((fn) =>
			fn === null
				? "-"
				: `${fn.source.length > 0 ? "c" : "s"}:${fn.directEntries.map((entry) => entry.id).join(",")}`,
		)
		.join(";");
}

function emitNativeFunctions(
	image: ProgramImage,
	options: {
		useCompiled: boolean;
		suffix: string;
		debug: boolean;
		linkage: "static" | "external";
		maxCodeUnits?: number;
		relocatable?: boolean;
	},
): {
	compiled: Array<CompiledFunction | null>;
	availability: NativeCompilationAvailability;
} {
	const headerCodeUnits = NATIVE_C_HEADER_LINES.join("\n").length + 1;
	const fits = (source: string): boolean =>
		options.maxCodeUnits === undefined ||
		source.length + headerCodeUnits <= options.maxCodeUnits;
	const references = image.native.functions.map((native) => {
		const targets = new Set<number>();
		const entries = new Set<string>();
		for (const site of native.fieldCalls ?? [])
			for (const entry of site.entries) {
				targets.add(entry.functionIndex);
				entries.add(directCompiledEntryKey(entry.functionIndex, entry.entryId));
			}
		for (const instruction of native.instructions) {
			if (instruction?.kind !== "call") continue;
			for (const target of [
				instruction.directFunctionIndex,
				instruction.directCallbackFunctionIndex,
				instruction.numericSortCallback?.functionIndex,
				instruction.directCallTargetFunctionIndex,
				...(instruction.guardedFunctionIndices ?? []),
			]) {
				if (target !== undefined) targets.add(target);
			}
			if (instruction.numericSortCallback !== undefined) {
				entries.add(
					directCompiledEntryKey(
						instruction.numericSortCallback.functionIndex,
						instruction.numericSortCallback.entryId,
					),
				);
			}
			if (
				(instruction.directFunctionIndex !== undefined ||
					instruction.guardedFunctionIndices?.length === 1) &&
				instruction.directEntryId !== undefined
			) {
				entries.add(
					directCompiledEntryKey(
						instruction.directFunctionIndex ?? instruction.guardedFunctionIndices![0]!,
						instruction.directEntryId,
					),
				);
			}
		}
		return { targets: [...targets], entries: [...entries] };
	});
	const cached: Array<{ key: string; emitted: CompiledFunction | null } | undefined> = [];
	const strictCompiledTargets = new Set(
		image.runtime.functions.flatMap((fn, index) => (fn.strict ? [index] : [])),
	);
	const render = (
		functionIndex: number,
		availability: NativeCompilationAvailability,
	): CompiledFunction | null => {
		if (!options.useCompiled) return null;
		const emitted = emitCompiledFunction(
			image.runtime.functions[functionIndex]!,
			image.native.functions[functionIndex]!,
			functionIndex,
			options.suffix,
			options.debug,
			options.linkage,
			availability.directCompiledTargets,
			image.native.semanticProtectors,
			availability.directCompiledEntries,
			options.relocatable === true,
			strictCompiledTargets,
			image.runtime.stringConstants,
		);
		if (emitted === null || !fits(emitted.source)) return null;
		const entries = emitted.directEntries.filter((entry) => fits(entry.source));
		return {
			...emitted,
			// A typed entry is an optional native overlay. Keep it independently
			// bounded so duplicating a large body can never evict the canonical ABI.
			directEntries: entries,
		};
	};

	const emit = (
		functionIndex: number,
		availability: NativeCompilationAvailability,
	): CompiledFunction | null => {
		const referenced = references[functionIndex]!;
		const key =
			referenced.targets
				.map((target) => (availability.directCompiledTargets.has(target) ? "1" : "0"))
				.join("") +
			referenced.entries
				.map((entry) => (availability.directCompiledEntries.has(entry) ? "1" : "0"))
				.join("");
		const previous = cached[functionIndex];
		if (previous?.key === key) return previous.emitted;
		const emitted = render(functionIndex, availability);
		cached[functionIndex] = { key, emitted };
		return emitted;
	};

	const unavailable: NativeCompilationAvailability = {
		directCompiledTargets: new Set(),
		directCompiledEntries: new Map(),
	};
	let compiled = image.runtime.functions.map((_fn, index) => emit(index, unavailable));
	if (options.relocatable === true) {
		return { compiled, availability: unavailable };
	}
	for (let iteration = 0; iteration <= image.runtime.functions.length + 1; iteration++) {
		const availability = nativeCompilationAvailability(image, compiled);
		const next = image.runtime.functions.map((_fn, index) =>
			compiled[index] === null ? null : emit(index, availability),
		);
		if (compiledAvailabilityKey(next) === compiledAvailabilityKey(compiled)) {
			const stripped = omitUnreachableCanonicalBodies(image, next);
			return {
				compiled: stripped,
				availability: nativeCompilationAvailability(image, stripped),
			};
		}
		compiled = next;
	}
	throw new Error("native compiled-entry availability did not stabilize");
}

/**
 * Move generated arrays out of the runtime-image translation unit.
 *
 * Aggregate tables can point at other generated symbols, so the runtime-image unit
 * retains declarations for every externalized array. The translation-unit packer
 * selects the dependency-minimal subset for each secondary unit. Keeping every
 * array external lets large contiguous metadata tables retain their runtime ABI
 * without charging unrelated declarations to every compiler input.
 */
function externalizeDataArrays(source: string, maxCodeUnits: number): SplitDataSource {
	const lines = source.split("\n");
	const output: Array<string> = [];
	const definitions: Array<ExternalDataDefinition> = [];
	const splitInitializers: Array<string> = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const match = /^(?:static )?(.+?) (mal_[A-Za-z0-9_]+)\[\] = (.*)$/.exec(line);
		if (match === null) {
			output.push(line);
			continue;
		}
		const type = match[1]!;
		const symbol = match[2]!;

		const definitionLines = [line];
		while (!definitionLines.at(-1)!.trimEnd().endsWith(";")) {
			index++;
			if (index >= lines.length) {
				throw new Error(`unterminated generated data runtime '${symbol}'`);
			}
			definitionLines.push(lines[index]!);
		}
		definitionLines[0] = definitionLines[0]!.replace(/^static /, "");
		const definitionSource = definitionLines.join("\n");
		if (
			(symbol.startsWith("mal_functions") ||
				symbol.startsWith("mal_source_positions") ||
				symbol.startsWith("mal_strings") ||
				(symbol.startsWith("mal_function_") && symbol.includes("_instructions"))) &&
			definitionSource.length > Math.floor(maxCodeUnits / 2)
		) {
			const rows = definitionLines.slice(1, -1);
			const mutableType = type.replace(/^const /, "");
			const chunkBudget = Math.max(1, Math.floor(maxCodeUnits / 4));
			const chunks: Array<Array<string>> = [];
			let chunk: Array<string> = [];
			let chunkCodeUnits = 0;
			for (const row of rows) {
				if (chunk.length > 0 && chunkCodeUnits + row.length + 1 > chunkBudget) {
					chunks.push(chunk);
					chunk = [];
					chunkCodeUnits = 0;
				}
				chunk.push(row);
				chunkCodeUnits += row.length + 1;
			}
			if (chunk.length > 0) chunks.push(chunk);

			output.push(
				`extern ${mutableType} ${symbol}[];`,
				`${mutableType} ${symbol}[${rows.length}];`,
			);
			let rowOffset = 0;
			const initializer = `mal_initialize_${symbol}`;
			splitInitializers.push(initializer);
			for (const [chunkIndex, chunkRows] of chunks.entries()) {
				const chunkSymbol = `${initializer}_chunk_${chunkIndex}`;
				output.push(`extern void ${chunkSymbol}(${mutableType} *target);`);
				definitions.push({
					symbol: chunkSymbol,
					source: [
						`void ${chunkSymbol}(${mutableType} *target) {`,
						`    static ${type} rows[] = {`,
						...chunkRows,
						"    };",
						`    memcpy(target + ${rowOffset}, rows, sizeof(rows));`,
						"}",
					].join("\n"),
				});
				rowOffset += chunkRows.length;
			}
			output.push(`static void ${initializer}(void) {`);
			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				output.push(`    ${initializer}_chunk_${chunkIndex}(${symbol});`);
			}
			output.push("}");
			continue;
		}
		definitions.push({ symbol, source: definitionSource });
		output.push(`extern ${type} ${symbol}[];`);
	}
	if (splitInitializers.length > 0) {
		output.unshift("static void mal_initialize_generated_data(void);");
		output.push("static void mal_initialize_generated_data(void) {");
		for (const initializer of splitInitializers) output.push(`    ${initializer}();`);
		output.push("}");
	}
	let splitSource = output.join("\n");
	if (splitInitializers.length > 0) {
		splitSource = splitSource.replace(
			"    .initialize_generated_data = nullptr,",
			"    .initialize_generated_data = mal_initialize_generated_data,",
		);
	}
	return { source: splitSource, definitions };
}

function emitProgramImageSource(
	image: ProgramImage,
	options: EmitOptions,
	splitCompiledFunctions: boolean,
	maxCompiledFunctionCodeUnits?: number,
): EmittedProgramImageSource {
	const runtime = image.runtime;
	validateRuntimeImageMetadata(runtime);
	const suffix = options.symbolSuffix ?? "";
	const debug = options.debugInfo !== false;
	const useCompiled = options.compiled !== false;
	// Compiled functions call mal_vm_binary_op (vm_ops.h) and box unboxed doubles
	// via mal_ops_number_value (value_ops.h); include both alongside vm.h.
	const lines = options.includeHeader === false ? [] : [...NATIVE_C_HEADER_LINES];

	for (let i = 0; i < runtime.stringConstants.length; ++i) {
		const constant = runtime.stringConstants[i]!;
		lines.push(
			`static const c16 mal_string_${i}_code_units${suffix}[] = ${stringCodeUnitsBody(constant)};`,
		);
	}

	if (runtime.stringConstants.length > 0) {
		lines.push(
			"",
			`${splitCompiledFunctions ? "" : "static "}MalString mal_strings${suffix}[] = {`,
		);
		for (let i = 0; i < runtime.stringConstants.length; ++i) {
			const constant = runtime.stringConstants[i]!;
			lines.push(malStringRow(`mal_string_${i}_code_units${suffix}`, constant.length));
		}
		lines.push("};", "");
	}

	if (runtime.bigintConstants.length > 0) {
		// Immortal bigint constants with their 128-bit value baked at compile time.
		lines.push(
			`${splitCompiledFunctions ? "" : "static "}MalBigInt mal_bigints${suffix}[] = {`,
		);
		for (const value of runtime.bigintConstants) {
			lines.push(
				`    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_BIGINT), .value = ${emitBigintValue(value)} },`,
			);
		}
		lines.push("};", "");
	}

	// Native-backend functions. Emitted before the MalFunction table (which
	// references their symbols) and after the constant pools (which they may
	// reference). The bytecode is still emitted below as a fallback / for `new`.
	// Exact script calls may target either the canonical compiled ABI or one of the
	// explicit typed siblings. Iterate to a fixed point because a size-bounded
	// split build can independently reject a canonical body or typed sibling, and
	// no remaining caller may retain a reference to a body that was not emitted.
	const nativeEmission = emitNativeFunctions(image, {
		useCompiled,
		suffix,
		debug,
		linkage: splitCompiledFunctions ? "external" : "static",
		maxCodeUnits: maxCompiledFunctionCodeUnits,
	});
	const compiled = nativeEmission.compiled;
	{
		const { directCompiledTargets } = nativeEmission.availability;
		if (!splitCompiledFunctions && directCompiledTargets.size > 0) {
			for (let index = 0; index < compiled.length; index++) {
				const fn = compiled[index];
				if (fn !== undefined && fn !== null && directCompiledTargets.has(index)) {
					lines.push(`static MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`);
				}
			}
		}
		if (!splitCompiledFunctions) {
			for (const fn of compiled) {
				for (const entry of fn?.directEntries ?? []) {
					lines.push(`static ${directEntryDeclaration(entry)};`);
				}
			}
		}
		if (
			!splitCompiledFunctions &&
			(directCompiledTargets.size > 0 ||
				compiled.some((fn) => (fn?.directEntries.length ?? 0) > 0))
		) {
			lines.push("");
		}
	}
	finalizeCompilerRemarks(image, compiled);
	if (splitCompiledFunctions) {
		if (compiled.some((fn) => fn !== null)) {
			lines.push(
				`#define MAL_DECLARE_COMPILED(name) MalValue name${COMPILED_FUNCTION_DECLARATION}`,
			);
		}
		for (const fn of compiled) {
			if (fn !== null) {
				if (fn.source.length > 0) lines.push(`MAL_DECLARE_COMPILED(${fn.symbol});`);
			}
		}
		for (const fn of compiled) {
			for (const entry of fn?.directEntries ?? []) {
				lines.push(`${directEntryDeclaration(entry)};`);
			}
		}
		if (compiled.some((fn) => fn !== null)) {
			lines.push("#undef MAL_DECLARE_COMPILED", "");
		}
	} else {
		for (const fn of compiled) {
			if (fn !== null) {
				lines.push(
					fn.source,
					...fn.directEntries.flatMap((entry) => ["", entry.source]),
					"",
				);
			}
		}
	}

	// A compiled function never re-enters the interpreter — a speculative param
	// guard falls back to a boxed compiled variant, not the bytecode — so its
	// bytecode and handler tables are dead weight. Only uncompiled functions
	// (generators/async) keep their overlay.
	const omitBytecode = compiled.map((c) => c !== null);
	const trustedSafepoints = runtime.functions.map(
		(fn, index) => !omitBytecode[index] && vmSafepointRootMapsAreTrusted(fn),
	);
	const instructionDataByFunction = runtime.functions.map((fn, i) =>
		omitBytecode[i]
			? { data: compiledKnownOwnSlotSeedData(fn), offsets: [] }
			: instructionData(fn),
	);

	const positionInfo: Array<{ symbol: string; count: number }> = [];
	const profileSiteSymbols: Array<string> = [];

	for (let i = 0; i < runtime.functions.length; ++i) {
		const fn = runtime.functions[i]!;
		if (!omitBytecode[i]) {
			if (fn.mappedArgumentSlots.length > 0) {
				lines.push(
					`static const i32 mal_function_${i}_mapped_argument_slots${suffix}[] = { ${fn.mappedArgumentSlots.join(", ")} };`,
					"",
				);
			}
			if (fn.argumentSnapshotPlan.length > 0) {
				lines.push(
					`static const MalArgumentSnapshotMove mal_function_${i}_argument_snapshot_plan${suffix}[] = {`,
				);
				lines.push(argumentSnapshotPlanBody(fn));
				lines.push("};", "");
			}
		}
		const sideData = instructionDataByFunction[i]!;
		if (sideData.data.length > 0) {
			lines.push(
				`static const i32 mal_function_${i}_instruction_data${suffix}[] = { ${sideData.data.join(", ")} };`,
				"",
			);
		}
		const rootData = trustedSafepoints[i] ? safepointRootData(fn) : [];
		if (rootData.length > 0) {
			lines.push(
				`static const i32 mal_function_${i}_gc_safepoints${suffix}[] = { ${rootData.join(", ")} };`,
				"",
			);
		}
		if (!omitBytecode[i]) {
			lines.push(
				`static const MalInstruction mal_function_${i}_instructions${suffix}[] = {`,
			);
			lines.push(instructionArrayBody(fn, sideData.offsets));
			lines.push("};", "");

			if (fn.handlers.length > 0) {
				lines.push(
					`static const MalExceptionHandler mal_function_${i}_handlers${suffix}[] = {`,
				);
				lines.push(handlerArrayBody(fn));
				lines.push("};", "");
			}
		}

		const runs = debug ? compressPositions(fn.positions) : [];
		if (runs.length > 0) {
			lines.push(`static const MalLineEntry mal_function_${i}_positions${suffix}[] = {`);
			lines.push(positionArrayBody(fn));
			lines.push("};", "");
			positionInfo.push({
				symbol: `mal_function_${i}_positions${suffix}`,
				count: runs.length,
			});
		} else {
			positionInfo.push({ symbol: "nullptr", count: 0 });
		}
		if (fn.profileSiteIds !== undefined) {
			const symbol = `mal_function_${i}_profile_site_ids${suffix}`;
			lines.push(
				`static const i32 ${symbol}[] = { ${fn.profileSiteIds.join(", ")} };`,
				"",
			);
			profileSiteSymbols.push(symbol);
		} else {
			profileSiteSymbols.push("nullptr");
		}
	}

	lines.push(`static const MalFunction mal_functions${suffix}[] = {`);
	for (let i = 0; i < runtime.functions.length; ++i) {
		const fn = runtime.functions[i]!;
		lines.push(
			...malFunctionRow(
				fn,
				`mal_function_${i}_instructions${suffix}`,
				instructionDataByFunction[i]!.data.length > 0
					? `mal_function_${i}_instruction_data${suffix}`
					: "nullptr",
				instructionDataByFunction[i]!.data.length,
				trustedSafepoints[i] && (fn.gcSafepoints?.length ?? 0) > 0
					? `mal_function_${i}_gc_safepoints${suffix}`
					: "nullptr",
				trustedSafepoints[i] ? (fn.gcSafepoints?.length ?? 0) : 0,
				trustedSafepoints[i]!,
				!omitBytecode[i] && fn.argumentSnapshotPlan.length > 0
					? `mal_function_${i}_argument_snapshot_plan${suffix}`
					: "nullptr",
				omitBytecode[i] ? 0 : fn.argumentSnapshotPlan.length,
				!omitBytecode[i] && fn.mappedArgumentSlots.length > 0
					? `mal_function_${i}_mapped_argument_slots${suffix}`
					: "nullptr",
				fn.handlers.length > 0 ? `mal_function_${i}_handlers${suffix}` : "nullptr",
				compiled[i] !== null && compiled[i]!.source.length > 0
					? compiled[i]!.symbol
					: "nullptr",
				profileSiteSymbols[i]!,
				{
					positionsSymbol: positionInfo[i]!.symbol,
					positionCount: positionInfo[i]!.count,
					fileIndex: debug ? fn.fileIndex : 0,
				},
				omitBytecode[i],
			),
		);
	}
	lines.push("};", "");

	for (const line of malRuntimeImageStruct(
		runtime,
		suffix,
		debug,
		undefined,
		options,
		image.diagnostics.profileSites?.length,
	)) {
		lines.push(line);
	}

	return { source: lines.join("\n"), compiled };
}

function generatedHeaderFiles(lines: ReadonlyArray<string>): Array<string> {
	return lines.flatMap((line) => {
		const match = /^#include "([^"]+)"$/.exec(line);
		return match === null ? [] : [match[1]!];
	});
}

function stablePartitionHash(value: string, round: number): number {
	let hash = (0x811c9dc5 ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

const MAX_STABLE_PARTITION_HASH_BITS = 64;

function compiledFunctionPartitionKeys(image: ProgramImage): Array<string> {
	const occurrences = new Map<string, number>();
	return image.runtime.functions.map((fn) => {
		const name = image.runtime.stringConstants[fn.nameStringIndex] ?? [];
		const base = JSON.stringify({
			file: image.runtime.files[fn.fileIndex] ?? "<unknown>",
			name,
			async: fn.isAsync,
			generator: fn.isGenerator,
			parameters: fn.parameterCount,
		});
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return `${base}\0${String(occurrence)}`;
	});
}

/** Emit one runtime-image unit plus edit-local data and compiled-function units. */
export function emitProgramTranslationUnits(
	image: ProgramImage,
	options: EmitOptions = {},
	policy: TranslationUnitPolicy = DEFAULT_TRANSLATION_UNIT_POLICY,
): Array<GeneratedTranslationUnit> {
	const { targetCodeUnits, hardMaximumCodeUnits } = policy;
	if (
		!Number.isSafeInteger(targetCodeUnits) ||
		targetCodeUnits <= 0 ||
		!Number.isSafeInteger(hardMaximumCodeUnits) ||
		hardMaximumCodeUnits <= 0 ||
		targetCodeUnits > hardMaximumCodeUnits
	) {
		throw new RangeError(
			"translation-unit target and hard maximum must be positive integers with target <= maximum",
		);
	}
	const emitted = emitProgramImageSource(
		image,
		{ ...options, includeHeader: false },
		true,
		hardMaximumCodeUnits,
	);
	const splitData = externalizeDataArrays(emitted.source, hardMaximumCodeUnits);
	const runtimeSource = [...GENERATED_DATA_C_HEADER_LINES, splitData.source].join("\n");
	if (runtimeSource.length > hardMaximumCodeUnits) {
		throw new RangeError(
			`generated runtime-image translation unit has ${runtimeSource.length} code units; ` +
				`maximum is ${hardMaximumCodeUnits}`,
		);
	}

	const generatedDeclarations: Array<GeneratedDeclaration> = splitData.source
		.split("\n")
		.filter((line) => line.startsWith("extern "))
		.map((source) => {
			const match = /\b(mal_[A-Za-z0-9_]+)(?=\[\]|\()/.exec(source);
			if (match === null) {
				throw new Error(`cannot identify generated declaration '${source}'`);
			}
			return { symbol: match[1]!, source };
		})
		.concat(
			emitted.compiled.flatMap(
				(fn): Array<GeneratedDeclaration> =>
					fn === null || fn.source.length === 0
						? []
						: [
								{
									symbol: fn.symbol,
									source: `MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`,
								},
							],
			),
		)
		.concat(
			emitted.compiled.flatMap((fn) =>
				(fn?.directEntries ?? []).map((entry) => ({
					symbol: entry.symbol,
					source: `${directEntryDeclaration(entry)};`,
				})),
			),
		);
	const declarationIndicesBySymbol = new Map<string, Array<number>>();
	for (const [index, declaration] of generatedDeclarations.entries()) {
		const indices = declarationIndicesBySymbol.get(declaration.symbol);
		if (indices === undefined)
			declarationIndicesBySymbol.set(declaration.symbol, [index]);
		else indices.push(index);
	}
	const preparePart = (
		part: Omit<TranslationUnitPart, "declarationIndices">,
	): TranslationUnitPart => {
		const declarationIndices = new Set<number>();
		for (const match of part.source.matchAll(/\bmal_[A-Za-z0-9_]+\b/g)) {
			const indices = declarationIndicesBySymbol.get(match[0]);
			if (indices === undefined) continue;
			for (const index of indices) declarationIndices.add(index);
		}
		return { ...part, declarationIndices: [...declarationIndices] };
	};
	const preparePartition = (
		parts: Array<TranslationUnitPart>,
	): TranslationUnitPartition => {
		const referenced = new Set<number>();
		let partSourceCodeUnits = 0;
		for (const part of parts) {
			partSourceCodeUnits += part.source.length;
			for (const index of part.declarationIndices) referenced.add(index);
		}
		const declarationIndices = [...referenced].sort((a, b) => a - b);
		return {
			parts,
			declarationIndices,
			declarationSourceCodeUnits: declarationIndices.reduce(
				(total, index) => total + generatedDeclarations[index]!.source.length,
				0,
			),
			partSourceCodeUnits,
		};
	};
	const unitSourceCodeUnits = (
		headerSourceCodeUnits: number,
		headerLineCount: number,
		partition: TranslationUnitPartition,
	): number => {
		const lineCount =
			headerLineCount + partition.declarationIndices.length + 1 + partition.parts.length;
		return (
			headerSourceCodeUnits +
			partition.declarationSourceCodeUnits +
			partition.partSourceCodeUnits +
			lineCount -
			1
		);
	};
	const unitSource = (
		headerLines: ReadonlyArray<string>,
		partition: TranslationUnitPartition,
	): string => {
		return [
			...headerLines,
			...partition.declarationIndices.map(
				(index) => generatedDeclarations[index]!.source,
			),
			"",
			...partition.parts.map((part) => part.source),
		].join("\n");
	};
	const partition = (
		kind: "data" | "code",
		headerLines: ReadonlyArray<string>,
		inputs: Array<Omit<TranslationUnitPart, "declarationIndices">>,
	): Array<GeneratedTranslationUnit> => {
		const units: Array<GeneratedTranslationUnit> = [];
		const headerSourceCodeUnits = headerLines.reduce(
			(total, line) => total + line.length,
			0,
		);
		const visit = (
			current: TranslationUnitPartition,
			prefix: string,
			depth: number,
		): void => {
			const { parts } = current;
			if (parts.length === 0) return;
			const sourceCodeUnits = unitSourceCodeUnits(
				headerSourceCodeUnits,
				headerLines.length,
				current,
			);
			if (sourceCodeUnits <= targetCodeUnits || parts.length === 1) {
				const source = unitSource(headerLines, current);
				if (source.length > hardMaximumCodeUnits) {
					const part = parts[0]!;
					throw new RangeError(
						`generated ${part.kind} '${part.symbol}' has ${part.source.length} code units ` +
							`and requires ${source.length} including its declarations; ` +
							`translation-unit maximum is ${hardMaximumCodeUnits}`,
					);
				}
				units.push({
					id: `${kind}-${prefix || "root"}`,
					kind,
					source,
					headerFiles: generatedHeaderFiles(headerLines),
					definitions: parts.map((part) => ({
						kind: part.kind,
						symbol: part.symbol,
						sourceCodeUnits: part.source.length,
					})),
				});
				return;
			}

			const left: Array<TranslationUnitPart> = [];
			const right: Array<TranslationUnitPart> = [];
			if (depth >= MAX_STABLE_PARTITION_HASH_BITS) {
				const ordered = [...parts].sort((a, b) =>
					a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0,
				);
				const middle = Math.floor(ordered.length / 2);
				visit(preparePartition(ordered.slice(0, middle)), `${prefix}0`, depth + 1);
				visit(preparePartition(ordered.slice(middle)), `${prefix}1`, depth + 1);
				return;
			}
			const round = Math.floor(depth / 32);
			const bit = depth % 32;
			for (const part of parts) {
				const target =
					((stablePartitionHash(`${part.kind}:${part.partitionKey}`, round) >>> bit) &
						1) ===
					0
						? left
						: right;
				target.push(part);
			}
			if (left.length === 0 || right.length === 0) {
				visit(current, `${prefix}${left.length === 0 ? "1" : "0"}`, depth + 1);
				return;
			}
			visit(preparePartition(left), `${prefix}0`, depth + 1);
			visit(preparePartition(right), `${prefix}1`, depth + 1);
		};
		visit(preparePartition(inputs.map(preparePart)), "", 0);
		return units;
	};
	const dataParts = splitData.definitions.map((data) => ({
		kind: "data array" as const,
		symbol: data.symbol,
		partitionKey: data.source.replaceAll(data.symbol, "<self>"),
		source: data.source,
	}));
	const codeParts: Array<Omit<TranslationUnitPart, "declarationIndices">> = [];
	const functionPartitionKeys = compiledFunctionPartitionKeys(image);
	for (const [functionIndex, fn] of emitted.compiled.entries()) {
		if (fn === null) continue;
		if (fn.source.length > 0)
			codeParts.push({
				kind: "compiled function",
				symbol: fn.symbol,
				partitionKey: `${functionPartitionKeys[functionIndex]}\0canonical`,
				source: fn.source,
			});
		for (const entry of fn.directEntries) {
			codeParts.push({
				kind: "compiled function",
				symbol: entry.symbol,
				partitionKey: `${functionPartitionKeys[functionIndex]}\0direct\0${String(entry.id)}`,
				source: entry.source,
			});
		}
	}
	return [
		{
			id: "runtime-image",
			kind: "runtime-image",
			source: runtimeSource,
			headerFiles: generatedHeaderFiles(GENERATED_DATA_C_HEADER_LINES),
			definitions: [],
		},
		...partition("data", GENERATED_DATA_C_HEADER_LINES, dataParts),
		...partition("code", NATIVE_C_HEADER_LINES, codeParts),
	];
}

/** Emit only relocation-aware native entries for a runtime image loaded from wire. */
export function emitRelocatableNativeOverlayTranslationUnits(
	image: ProgramImage,
	wireDigest: string,
	maxCodeUnits = TRANSLATION_UNIT_HARD_MAXIMUM_CODE_UNITS,
): Array<GeneratedTranslationUnit> {
	if (!/^[0-9a-f]{64}$/.test(wireDigest)) {
		throw new Error(
			`native overlay wire digest must be lowercase SHA-256: ${wireDigest}`,
		);
	}
	if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits <= 0) {
		throw new RangeError("translation-unit code-unit budget must be a positive integer");
	}
	const suffix = "_eval_compiler";
	const { compiled } = emitNativeFunctions(image, {
		useCompiled: true,
		suffix,
		debug: true,
		linkage: "external",
		maxCodeUnits,
		relocatable: true,
	});
	const declarations = compiled.flatMap((fn) =>
		fn === null ? [] : [`MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`],
	);
	const table = [
		...NATIVE_C_HEADER_LINES,
		'#include "compiler_native.h"',
		...declarations,
		"",
		"static const MalCompiledFunction mal_eval_compiler_native_entries[] = {",
		...compiled.map((fn) => `    ${fn?.symbol ?? "nullptr"},`),
		"};",
		"",
		"const MalCompilerNativeOverlay mal_eval_compiler_native_overlay = {",
		`    .wire_digest = "${wireDigest}",`,
		`    .function_count = ${compiled.length},`,
		"    .entries = mal_eval_compiler_native_entries,",
		"};",
	].join("\n");
	if (table.length > maxCodeUnits) {
		throw new RangeError(
			`native overlay table has ${table.length} code units; maximum is ${maxCodeUnits}`,
		);
	}

	const header = NATIVE_C_HEADER_LINES.join("\n");
	const headerFiles = generatedHeaderFiles([
		...NATIVE_C_HEADER_LINES,
		'#include "compiler_native.h"',
	]);
	const units: Array<GeneratedTranslationUnit> = [
		{
			id: "native-overlay-table",
			kind: "code",
			source: table,
			headerFiles,
			definitions: [],
		},
	];
	type NativeOverlayFunction = { fn: CompiledFunction; partitionKey: string };
	const functionPartitionKeys = compiledFunctionPartitionKeys(image);
	const bodies: Array<NativeOverlayFunction> = compiled.flatMap((fn, index) =>
		fn === null ? [] : [{ fn, partitionKey: functionPartitionKeys[index]! }],
	);
	const visit = (
		functions: Array<NativeOverlayFunction>,
		prefix: string,
		depth: number,
	): void => {
		if (functions.length === 0) return;
		const sourceCodeUnits = functions.reduce(
			(total, { fn }) => total + 1 + fn.source.length,
			header.length,
		);
		if (sourceCodeUnits <= maxCodeUnits || functions.length === 1) {
			const source = [header, ...functions.map(({ fn }) => fn.source)].join("\n");
			if (source.length > maxCodeUnits) {
				throw new RangeError(
					`generated compiled function '${functions[0]!.fn.symbol}' requires ${source.length} code units; translation-unit maximum is ${maxCodeUnits}`,
				);
			}
			units.push({
				id: `native-overlay-code-${prefix || "root"}`,
				kind: "code",
				source,
				headerFiles,
				definitions: functions.map(({ fn }) => ({
					kind: "compiled function",
					symbol: fn.symbol,
					sourceCodeUnits: fn.source.length,
				})),
			});
			return;
		}
		const bit = depth % 32;
		const round = Math.floor(depth / 32);
		const left: Array<NativeOverlayFunction> = [];
		const right: Array<NativeOverlayFunction> = [];
		if (depth >= MAX_STABLE_PARTITION_HASH_BITS) {
			const ordered = [...functions].sort((a, b) =>
				a.partitionKey < b.partitionKey
					? -1
					: a.partitionKey > b.partitionKey
						? 1
						: a.fn.symbol < b.fn.symbol
							? -1
							: a.fn.symbol > b.fn.symbol
								? 1
								: 0,
			);
			const middle = Math.floor(ordered.length / 2);
			visit(ordered.slice(0, middle), `${prefix}0`, depth + 1);
			visit(ordered.slice(middle), `${prefix}1`, depth + 1);
			return;
		}
		for (const fn of functions) {
			(((stablePartitionHash(fn.partitionKey, round) >>> bit) & 1) === 0
				? left
				: right
			).push(fn);
		}
		if (left.length === 0 || right.length === 0) {
			visit(functions, `${prefix}${left.length === 0 ? "1" : "0"}`, depth + 1);
			return;
		}
		visit(left, `${prefix}0`, depth + 1);
		visit(right, `${prefix}1`, depth + 1);
	};
	visit(bodies, "", 0);
	return units;
}

function malRuntimeImageStruct(
	runtime: RuntimeImage,
	suffix: string,
	debug: boolean,
	sharedLiteralTemplates?: string,
	options: Pick<EmitOptions, "assets" | "maligatorSurface" | "sourcePath"> = {},
	profileSiteCount?: number,
): Array<string> {
	const lines: Array<string> = [];
	const assets = options.assets ?? [];
	const precompiledShapeRows = runtime.precompiledLiteralShapes;
	for (let index = 0; index < precompiledShapeRows.length; index++) {
		const shape = precompiledShapeRows[index]!;
		lines.push(
			`static const i32 mal_precompiled_literal_shape_${index}_keys${suffix}[] = { ${shape.keyStringIndices.join(", ")} };`,
		);
	}
	if (precompiledShapeRows.length > 0) {
		lines.push(
			`static const MalPrecompiledLiteralShape mal_precompiled_literal_shapes${suffix}[] = {`,
		);
		for (let index = 0; index < precompiledShapeRows.length; index++) {
			const shape = precompiledShapeRows[index]!;
			lines.push(
				`    { .function_index = ${shape.functionIndex}, .shape_cache_index = ${shape.shapeCacheIndex}, .key_count = ${shape.keyStringIndices.length}, .key_string_indices = mal_precompiled_literal_shape_${index}_keys${suffix} },`,
			);
		}
		lines.push("};", "");
	}
	const hasLiteralTemplates = runtime.literalTemplateData.length > 0;
	const literalTemplatesSymbol = hasLiteralTemplates
		? (sharedLiteralTemplates ?? `mal_literal_templates${suffix}`)
		: "nullptr";
	if (hasLiteralTemplates && sharedLiteralTemplates === undefined) {
		lines.push(
			`static const u32 ${literalTemplatesSymbol}[] = { ${runtime.literalTemplateData.join(", ")} };`,
			"",
		);
	}

	const hasCjs = runtime.cjsModuleFunctionIndices.length > 0;
	if (hasCjs) {
		lines.push(
			`static const i32 mal_cjs_modules${suffix}[] = { ${runtime.cjsModuleFunctionIndices.join(", ")} };`,
			"",
		);
	}

	const hasFiles = debug && runtime.files.length > 0;
	if (hasFiles) {
		lines.push(`static const char *const mal_files${suffix}[] = {`);
		for (const file of runtime.files) {
			lines.push(
				`    "${cEscapeString(`compiled://${options.sourcePath?.(file) ?? file}`)}",`,
			);
		}
		lines.push("};", "");
	}

	const hasPositions = debug && runtime.sourcePositions.length > 0;
	if (hasPositions) {
		lines.push(`static const MalSourcePos mal_source_positions${suffix}[] = {`);
		for (const pos of runtime.sourcePositions) {
			lines.push(
				`    MAL_SOURCE_POS(${pos.line}, ${pos.column}, ${pos.inlinedFunctionIndex ?? -1}, ${pos.callerPosId ?? -1}),`,
			);
		}
		lines.push("};", "");
	}

	const embeddedAssetSymbols = new Set(
		assets.flatMap((asset) =>
			asset.files.flatMap((file) =>
				file.embeddedSymbol === undefined ? [] : [file.embeddedSymbol],
			),
		),
	);
	for (const symbol of embeddedAssetSymbols) {
		lines.push(`extern const u8 ${symbol}[];`);
	}
	if (embeddedAssetSymbols.size > 0) lines.push("");

	for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
		const asset = assets[assetIndex]!;
		for (let fileIndex = 0; fileIndex < asset.files.length; fileIndex++) {
			const file = asset.files[fileIndex]!;
			if (file.embeddedSymbol !== undefined) continue;
			const symbol = `mal_asset_${assetIndex}_file_${fileIndex}_data${suffix}`;
			if (file.size === 0) {
				lines.push(`static const u8 ${symbol}[] = { 0 };`);
			} else {
				lines.push(
					`static const u8 ${symbol}[] = {`,
					`#embed "${cEscapeString(file.sourcePath)}"`,
					"};",
				);
			}
		}
		lines.push(`static const MalAssetFile mal_asset_${assetIndex}_files${suffix}[] = {`);
		for (let fileIndex = 0; fileIndex < asset.files.length; fileIndex++) {
			const file = asset.files[fileIndex]!;
			const symbol =
				file.embeddedSymbol ?? `mal_asset_${assetIndex}_file_${fileIndex}_data${suffix}`;
			lines.push(
				`    { .path = "${cEscapeString(file.path)}", .data = ${symbol}, .source_path = nullptr, .length = ${file.size} },`,
			);
		}
		lines.push("};", "");
	}
	if (assets.length > 0) {
		lines.push(`static const MalAsset mal_assets${suffix}[] = {`);
		for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
			const asset = assets[assetIndex]!;
			lines.push(
				`    { .name = "${cEscapeString(asset.name)}", .hash = "${asset.hash}", .version = "${asset.version}", .directory = ${asset.type === "directory"}, .file_count = ${asset.files.length}, .files = mal_asset_${assetIndex}_files${suffix} },`,
			);
		}
		lines.push("};", "");
	}

	// Host-install manifest: direct references to the native installers of the
	// host built-ins (and `process`) the program actually reached. Only reachable
	// ones are emitted, so an ordinary program references no host symbol and the
	// extern decls / arrays below are absent — nothing to resolve at link.
	const hostInstalls = [...runtime.hostInstalls];
	if (
		options.maligatorSurface === true &&
		!hostInstalls.some((install) => install.installer === "mal_host_install_maligator")
	) {
		hostInstalls.push({ installer: "mal_host_install_maligator", exports: [] });
	}
	const hasHostInstalls = hostInstalls.length > 0;
	if (hasHostInstalls) {
		const declared = new Set<string>();
		for (const install of hostInstalls) {
			if (!declared.has(install.installer)) {
				declared.add(install.installer);
				lines.push(
					`extern void ${install.installer}(MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);`,
				);
			}
		}
		lines.push("");
		hostInstalls.forEach((install, i) => {
			lines.push(
				`static const MalHostInstallSlot mal_host_install_${i}_slots${suffix}[] = {`,
			);
			for (const { name, slot, constant } of install.exports) {
				lines.push(
					`    { .name = "${cEscapeString(name)}", .slot = ${slot}, .data = ${constant === undefined ? "nullptr" : `"${cEscapeString(JSON.stringify(constant))}"`} },`,
				);
			}
			lines.push("};", "");
		});
		lines.push(`static const MalHostInstall mal_host_installs${suffix}[] = {`);
		hostInstalls.forEach((install, i) => {
			lines.push(
				`    { .installer = ${install.installer}, .slots = mal_host_install_${i}_slots${suffix}, .slot_count = ${install.exports.length} },`,
			);
		});
		lines.push("};", "");
	}

	lines.push(
		`const MalRuntimeImage mal_runtime_image${suffix} = {`,
		`    .function_count = ${runtime.functionCount},`,
		`    .functions = mal_functions${suffix},`,
		"    .initialize_generated_data = nullptr,",
		`    .string_constant_count = ${runtime.stringConstants.length},`,
		`    .string_constants = ${runtime.stringConstants.length > 0 ? `mal_strings${suffix}` : "nullptr"},`,
		`    .bigint_constant_count = ${runtime.bigintConstants.length},`,
		`    .bigint_constants = ${runtime.bigintConstants.length > 0 ? `mal_bigints${suffix}` : "nullptr"},`,
		`    .literal_template_data_count = ${runtime.literalTemplateData.length},`,
		`    .literal_template_data = ${literalTemplatesSymbol},`,
		`    .precompiled_literal_shape_count = ${precompiledShapeRows.length},`,
		`    .precompiled_literal_shapes = ${precompiledShapeRows.length > 0 ? `mal_precompiled_literal_shapes${suffix}` : "nullptr"},`,
		`    .global_count = ${runtime.globalCount},`,
		`    .entry_path = "${cEscapeString(runtime.entrypointPath)}",`,
		`    .cjs_module_count = ${runtime.cjsModuleFunctionIndices.length},`,
		`    .cjs_module_function_indices = ${hasCjs ? `mal_cjs_modules${suffix}` : "nullptr"},`,
		`    .file_count = ${hasFiles ? runtime.files.length : 0},`,
		`    .files = ${hasFiles ? `mal_files${suffix}` : "nullptr"},`,
		`    .source_position_count = ${hasPositions ? runtime.sourcePositions.length : 0},`,
		`    .source_positions = ${hasPositions ? `mal_source_positions${suffix}` : "nullptr"},`,
		...(profileSiteCount === undefined
			? []
			: [`    .profile_site_count = ${profileSiteCount},`]),
		`    .asset_count = ${assets.length},`,
		`    .assets = ${assets.length > 0 ? `mal_assets${suffix}` : "nullptr"},`,
		`    .host_install_count = ${hostInstalls.length},`,
		`    .host_installs = ${hasHostInstalls ? `mal_host_installs${suffix}` : "nullptr"},`,
		"};",
	);

	return lines;
}

/**
 * Emit several program images into one translation unit, sharing byte-identical
 * static arrays across them. The test262 harness compiles to the same ~730
 * instructions and ~60 string constants in every test, so emitting each unique
 * array once (and pointing every runtime image's small MalFunction/MalString table
 * at the shared symbol) collapses the dominant ~60% of the generated C.
 *
 * Sharing is purely content-addressed - only arrays whose emitted bytes are
 * identical merge - so it cannot change behaviour: two images share an
 * instruction array iff they would have emitted the same one anyway. The
 * images are named `mal_runtime_image_<index>` to match the batch footer.
 * The caller prepends the shared `#include` header (as for the per-test path).
 */
export function emitBatch(
	images: Array<ProgramImage>,
	options: Pick<EmitOptions, "compiled"> = {},
): string {
	const useCompiled = options.compiled !== false;
	const lines: Array<string> = [];

	// content -> shared symbol, for each kind of array. `body` is the element
	// list (no surrounding braces); intern wraps it in the array initializer.
	const shared = new Map<string, string>();
	let sharedCounter = 0;
	const intern = (kind: string, type: string, body: string): string => {
		const key = `${kind}\0${body}`;
		const existing = shared.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const symbol = `mal_shared_${kind}_${sharedCounter++}`;
		lines.push(`static const ${type} ${symbol}[] = {`, body, "};", "");
		shared.set(key, symbol);
		return symbol;
	};

	for (let d = 0; d < images.length; ++d) {
		const image = images[d]!;
		const runtime = image.runtime;
		validateRuntimeImageMetadata(runtime);
		const suffix = `_${d}`;
		const literalTemplatesSymbol =
			runtime.literalTemplateData.length > 0
				? intern("literals", "u32", `    ${runtime.literalTemplateData.join(", ")}`)
				: undefined;

		const stringSymbols = runtime.stringConstants.map((constant) =>
			intern("cu", "c16", `    ${constant.length > 0 ? constant.join(", ") : "0"}`),
		);
		if (stringSymbols.length > 0) {
			// MalString rows are mutable (hashes are cached lazily), so each runtime
			// keeps its own table; only the code-unit arrays are shared.
			lines.push(`static MalString mal_strings${suffix}[] = {`);
			for (let i = 0; i < stringSymbols.length; ++i) {
				lines.push(malStringRow(stringSymbols[i]!, runtime.stringConstants[i]!.length));
			}
			lines.push("};", "");
		}

		if (runtime.bigintConstants.length > 0) {
			lines.push(`static MalBigInt mal_bigints${suffix}[] = {`);
			for (const value of runtime.bigintConstants) {
				lines.push(
					`    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_BIGINT), .value = ${emitBigintValue(value)} },`,
				);
			}
			lines.push("};", "");
		}

		// The batch path strips debug info, so compiled bodies emit no pos writes.
		// It uses the same fixed-point entry selection as product emit-C; otherwise
		// the test262 backend would carry typed bodies that no call could reach.
		const nativeEmission = emitNativeFunctions(image, {
			useCompiled,
			suffix,
			debug: false,
			linkage: "static",
		});
		const { compiled } = nativeEmission;
		for (const functionIndex of nativeEmission.availability.directCompiledTargets) {
			const fn = compiled[functionIndex];
			if (fn !== undefined && fn !== null && fn.source.length > 0) {
				lines.push(`static MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`);
			}
		}
		for (const fn of compiled) {
			for (const entry of fn?.directEntries ?? []) {
				lines.push(`static ${directEntryDeclaration(entry)};`);
			}
		}
		if (
			nativeEmission.availability.directCompiledTargets.size > 0 ||
			compiled.some((fn) => (fn?.directEntries.length ?? 0) > 0)
		) {
			lines.push("");
		}
		for (const fn of compiled) {
			if (fn !== null) {
				lines.push(
					fn.source,
					...fn.directEntries.flatMap((entry) => ["", entry.source]),
					"",
				);
			}
		}

		// Successfully compiled functions never re-enter the interpreter, so they
		// need no bytecode tables.
		const omitBytecode = compiled.map((c) => c !== null);
		const trustedSafepoints = runtime.functions.map(
			(fn, index) => !omitBytecode[index] && vmSafepointRootMapsAreTrusted(fn),
		);

		const instructionSymbols: Array<string> = [];
		const instructionDataSymbols: Array<string> = [];
		const instructionDataCounts: Array<number> = [];
		const gcSafepointSymbols: Array<string> = [];
		const gcSafepointCounts: Array<number> = [];
		const argumentSnapshotPlanSymbols: Array<string> = [];
		const argumentSnapshotPlanCounts: Array<number> = [];
		const mappedArgumentSlotsSymbols: Array<string> = [];
		const handlerSymbols: Array<string> = [];
		for (let i = 0; i < runtime.functions.length; ++i) {
			const fn = runtime.functions[i]!;
			if (omitBytecode[i]) {
				const seedData = compiledKnownOwnSlotSeedData(fn);
				instructionSymbols.push("nullptr");
				instructionDataSymbols.push(
					seedData.length > 0
						? intern("insn_data", "i32", `    ${seedData.join(", ")}`)
						: "nullptr",
				);
				instructionDataCounts.push(seedData.length);
				gcSafepointSymbols.push("nullptr");
				gcSafepointCounts.push(0);
				argumentSnapshotPlanSymbols.push("nullptr");
				argumentSnapshotPlanCounts.push(0);
				mappedArgumentSlotsSymbols.push("nullptr");
				handlerSymbols.push("nullptr");
				continue;
			}
			const sideData = instructionData(fn);
			instructionSymbols.push(
				intern("insns", "MalInstruction", instructionArrayBody(fn, sideData.offsets)),
			);
			instructionDataSymbols.push(
				sideData.data.length > 0
					? intern("insn_data", "i32", `    ${sideData.data.join(", ")}`)
					: "nullptr",
			);
			instructionDataCounts.push(sideData.data.length);
			const rootData = trustedSafepoints[i] ? safepointRootData(fn) : [];
			gcSafepointSymbols.push(
				rootData.length > 0
					? intern("gc_safepoints", "i32", `    ${rootData.join(", ")}`)
					: "nullptr",
			);
			gcSafepointCounts.push(trustedSafepoints[i] ? (fn.gcSafepoints?.length ?? 0) : 0);
			argumentSnapshotPlanSymbols.push(
				fn.argumentSnapshotPlan.length > 0
					? intern(
							"argument_snapshot_plan",
							"MalArgumentSnapshotMove",
							argumentSnapshotPlanBody(fn),
						)
					: "nullptr",
			);
			argumentSnapshotPlanCounts.push(fn.argumentSnapshotPlan.length);
			mappedArgumentSlotsSymbols.push(
				fn.mappedArgumentSlots.length > 0
					? intern(
							"mapped_argument_slots",
							"i32",
							`    ${fn.mappedArgumentSlots.join(", ")}`,
						)
					: "nullptr",
			);
			handlerSymbols.push(
				fn.handlers.length > 0
					? intern("handlers", "MalExceptionHandler", handlerArrayBody(fn))
					: "nullptr",
			);
		}

		lines.push(`static const MalFunction mal_functions${suffix}[] = {`);
		for (let i = 0; i < runtime.functions.length; ++i) {
			lines.push(
				...malFunctionRow(
					runtime.functions[i]!,
					instructionSymbols[i]!,
					instructionDataSymbols[i]!,
					instructionDataCounts[i]!,
					gcSafepointSymbols[i]!,
					gcSafepointCounts[i]!,
					trustedSafepoints[i]!,
					argumentSnapshotPlanSymbols[i]!,
					argumentSnapshotPlanCounts[i]!,
					mappedArgumentSlotsSymbols[i]!,
					handlerSymbols[i]!,
					compiled[i] !== null && compiled[i]!.source.length > 0
						? compiled[i]!.symbol
						: "nullptr",
					"nullptr",
					// The batch path strips debug info (test262 does not use it).
					{ positionsSymbol: "nullptr", positionCount: 0, fileIndex: 0 },
					omitBytecode[i],
				),
			);
		}
		lines.push("};", "");

		lines.push(...malRuntimeImageStruct(runtime, suffix, false, literalTemplatesSymbol));
		lines.push("");
	}

	return lines.join("\n");
}

function emitInstruction(instruction: BytecodeInstruction, dataOffset?: number) {
	const sideDataOffset = (): number => {
		if (dataOffset === undefined) throw new Error("missing instruction side-data offset");
		return dataOffset;
	};
	switch (instruction.opcode) {
		case "MOVE":
			return `{ .opcode = MAL_OP_MOVE, .as.move = { .dst = ${instruction.dst}, .src = ${instruction.src} } }`;
		case "BASE_CONSTRUCT_RESULT":
			return `{ .opcode = MAL_OP_BASE_CONSTRUCT_RESULT, .as.base_construct_result = { .dst = ${instruction.dst}, .receiver = ${instruction.receiver}, .value = ${instruction.value} } }`;
		case "RETURN":
			return `{ .opcode = MAL_OP_RETURN, .as.ret = { .value = ${instruction.value} } }`;
		case "JUMP_IF":
			return `{ .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = ${instruction.cond}, .target_ip = ${instruction.targetIp} } }`;
		case "JUMP":
			return `{ .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = ${instruction.targetIp} } }`;
		case "CREATE_NUMBER":
			return `{ .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = ${instruction.dst}, .value = ${instruction.value} } }`;
		case "CREATE_F64":
			return emitCreateF64(instruction.dst, instruction.value);
		case "CREATE_BOOLEAN":
			return `{ .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = ${instruction.dst}, .value = ${instruction.value ? 1 : 0} } }`;
		case "CREATE_STRING":
			return `{ .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = ${instruction.dst}, .string_index = ${instruction.stringIndex} } }`;
		case "CREATE_BIGINT":
			return `{ .opcode = MAL_OP_CREATE_BIGINT, .as.create_bigint = { .dst = ${instruction.dst}, .bigint_index = ${instruction.bigintIndex} } }`;
		case "CREATE_OBJECT":
			return `{ .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = ${instruction.dst} } }`;
		case "CREATE_BASE_CONSTRUCT_RECEIVER":
			return `{ .opcode = MAL_OP_CREATE_BASE_CONSTRUCT_RECEIVER, .as.create_base_construct_receiver = { .dst = ${instruction.dst}, .new_target = ${instruction.newTarget}, .constructor_slot_reserve = ${instruction.constructorSlotReserve} } }`;
		case "CREATE_OBJECT_SHAPED":
			return `{ .opcode = MAL_OP_CREATE_OBJECT_SHAPED, .as.create_object_shaped = { .dst = ${instruction.dst}, .data_offset = ${sideDataOffset()}, .shape_cache_index = ${instruction.shapeCacheIndex} } }`;
		case "CREATE_ARRAY":
			return `{ .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = ${instruction.dst}, .length = ${instruction.length} } }`;
		case "INSTANTIATE_LITERAL_TEMPLATE":
			return `{ .opcode = MAL_OP_INSTANTIATE_LITERAL_TEMPLATE, .as.instantiate_literal_template = { .dst = ${instruction.dst}, .template_offset = ${instruction.templateOffset}, .cache_slot = ${instruction.cacheSlot ?? -1} } }`;
		case "QUERY_STATIC_DATA":
			return `{ .opcode = MAL_OP_QUERY_STATIC_DATA, .as.query_static_data = { .dst = ${instruction.dst}, .needle = ${instruction.needle}, .from_index = ${instruction.fromIndex}, .data_offset = ${sideDataOffset()} } }`;
		case "CREATE_MODULE_NAMESPACE":
			return `{ .opcode = MAL_OP_CREATE_MODULE_NAMESPACE, .as.create_module_namespace = { .dst = ${instruction.dst}, .cache_slot = ${instruction.cacheSlot}, .data_offset = ${sideDataOffset()} } }`;
		case "CREATE_TEMPLATE_OBJECT":
			return `{ .opcode = MAL_OP_CREATE_TEMPLATE_OBJECT, .as.create_template_object = { .dst = ${instruction.dst}, .cache_slot = ${instruction.cacheSlot}, .data_offset = ${sideDataOffset()} } }`;
		case "CREATE_UNDEFINED":
			return `{ .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = ${instruction.dst} } }`;
		case "CREATE_EMPTY":
			return `{ .opcode = MAL_OP_CREATE_EMPTY, .as.create_empty = { .dst = ${instruction.dst} } }`;
		case "CREATE_NULL":
			return `{ .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = ${instruction.dst} } }`;
		case "CREATE_FUNCTION":
			return `{ .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = ${instruction.dst}, .function_index = ${instruction.functionIndex} } }`;
		case "CREATE_ARGUMENTS_OBJECT":
			return `{ .opcode = MAL_OP_CREATE_ARGUMENTS_OBJECT, .as.create_arguments_object = { .dst = ${instruction.dst} } }`;
		case "LOAD_ARGUMENT_COUNT":
			return `{ .opcode = MAL_OP_LOAD_ARGUMENT_COUNT, .as.load_argument_count = { .dst = ${instruction.dst} } }`;
		case "LOAD_ARGUMENT":
			return `{ .opcode = MAL_OP_LOAD_ARGUMENT, .as.load_argument = { .dst = ${instruction.dst}, .index = ${instruction.index} } }`;
		case "LOAD_STATIC_ARGUMENT":
			return `{ .opcode = MAL_OP_LOAD_STATIC_ARGUMENT, .as.load_static_argument = { .dst = ${instruction.dst}, .direct = ${instruction.direct}, .fallback = ${instruction.fallback}, .index = ${instruction.index} } }`;
		case "LOAD_THIS":
			return `{ .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = ${instruction.dst} } }`;
		case "LOAD_NEW_TARGET":
			return `{ .opcode = MAL_OP_LOAD_NEW_TARGET, .as.load_new_target = { .dst = ${instruction.dst} } }`;
		case "LOAD_CALLEE":
			return `{ .opcode = MAL_OP_LOAD_CALLEE, .as.load_callee = { .dst = ${instruction.dst} } }`;
		case "CALL":
			return `{ .opcode = MAL_OP_CALL, .as.call = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()} } }`;
		case "BUILTIN_ERROR":
			return `{ .opcode = MAL_OP_BUILTIN_ERROR, .as.builtin_error = { .dst = ${instruction.dst}, .error = MAL_BUILTIN_ERROR_${instruction.error} } }`;
		case "PRECISE_NUMBER_SUM":
			return `{ .opcode = MAL_OP_PRECISE_NUMBER_SUM, .as.precise_number_sum = { .dst = ${instruction.dst}, .data_offset = ${sideDataOffset()} } }`;
		case "PREPARED_STRING_COMPARE":
			return `{ .opcode = MAL_OP_PREPARED_STRING_COMPARE, .as.prepared_string_compare = { .dst = ${instruction.dst}, .left = ${instruction.left}, .right = ${instruction.right}, .locale_options = ${instruction.stringIndex}u * 64u + ${instruction.options}u } }`;
		case "CALL_KNOWN":
			return `{ .opcode = MAL_OP_CALL_KNOWN, .as.call_known = { .dst = ${instruction.dst}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()}, .operation = ${(knownOperationIndex(instruction.operation)! << 4) | knownOperationFlags(instruction)} } }`;
		case "MATH_UNARY_NUMBER": {
			if (
				!(VM_MATH_UNARY_NUMBER_OPERATIONS as ReadonlyArray<string>).includes(
					instruction.operation,
				)
			) {
				throw new Error(`Unknown unary numeric Math operation ${instruction.operation}`);
			}
			const operation = instruction.operation.slice("Math.".length).toUpperCase();
			return `{ .opcode = MAL_OP_MATH_UNARY_NUMBER, .as.math_unary_number = { .dst = ${instruction.dst}, .src = ${instruction.src}, .operation = MAL_MATH_UNARY_${operation} } }`;
		}
		case "MATH_BINARY_NUMBER": {
			if (
				!(VM_MATH_BINARY_NUMBER_OPERATIONS as ReadonlyArray<string>).includes(
					instruction.operation,
				)
			) {
				throw new Error(`Unknown binary numeric Math operation ${instruction.operation}`);
			}
			const operation = instruction.operation.slice("Math.".length).toUpperCase();
			return `{ .opcode = MAL_OP_MATH_BINARY_NUMBER, .as.math_binary_number = { .dst = ${instruction.dst}, .left = ${instruction.left}, .right = ${instruction.right}, .operation = MAL_MATH_BINARY_${operation} } }`;
		}
		case "CONSTRUCT":
			return `{ .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .data_offset = ${sideDataOffset()} } }`;
		case "THROW":
			return `{ .opcode = MAL_OP_THROW, .as.thrown = { .value = ${instruction.value} } }`;
		case "CATCH":
			return `{ .opcode = MAL_OP_CATCH, .as.caught = { .dst = ${instruction.dst} } }`;
		case "TRY_BEGIN":
			// The protected ranges live in the handler table; the markers only
			// keep the instruction pointers stable.
			return `{ .opcode = MAL_OP_TRY_BEGIN }`;
		case "TRY_END":
			return `{ .opcode = MAL_OP_TRY_END }`;
		case "GENERATOR_START":
			return `{ .opcode = MAL_OP_GENERATOR_START }`;
		case "ASYNC_START":
			return `{ .opcode = MAL_OP_ASYNC_START }`;
		case "YIELD":
			return `{ .opcode = MAL_OP_YIELD, .as.yield = { .yielded_src = ${instruction.yieldedSrc}, .value_dst = ${instruction.valueDst}, .mode_dst = ${instruction.modeDst} } }`;
		case "TERMINAL_YIELD":
			return `{ .opcode = MAL_OP_TERMINAL_YIELD, .as.terminal_yield = { .yielded_src = ${instruction.yieldedSrc} } }`;
		case "AWAIT":
			return `{ .opcode = MAL_OP_AWAIT, .as.await = { .awaited_src = ${instruction.awaitedSrc}, .value_dst = ${instruction.valueDst}, .mode_dst = ${instruction.modeDst} } }`;
		case "LOAD_CAPTURED":
			return `{ .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = ${instruction.dst}, .owner_function_index = ${instruction.ownerFunctionIndex}, .index = ${instruction.index} } }`;
		case "GUARD_FUNCTION_INDEX":
			return `{ .opcode = MAL_OP_GUARD_FUNCTION_INDEX, .as.guard_function_index = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .function_index = ${instruction.functionIndex} } }`;
		case "GUARD_BASE_CONSTRUCTOR_LAYOUT":
			return `{ .opcode = MAL_OP_GUARD_BASE_CONSTRUCTOR_LAYOUT, .as.guard_base_constructor_layout = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .function_index = ${instruction.functionIndex}, .data_offset = ${sideDataOffset()} } }`;
		case "SELECT_SHAPE_CASE":
			return `{ .opcode = MAL_OP_SELECT_SHAPE_CASE, .as.select_shape_case = { .dst = ${instruction.dst}, .object = ${instruction.object}, .data_offset = ${sideDataOffset()}, .candidate_count = ${instruction.candidates.length} } }`;
		case "LOAD_GLOBAL_INDEX":
			return `{ .opcode = MAL_OP_LOAD_GLOBAL_INDEX, .as.load_global_index = { .dst = ${instruction.dst}, .index = ${instruction.index} } }`;
		case "LOAD_GLOBAL":
			return `{ .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = ${instruction.dst}, .index = ${instruction.index} } }`;
		case "LOAD_PRIMORDIAL":
			return `{ .opcode = MAL_OP_LOAD_PRIMORDIAL, .as.load_intrinsic = { .dst = ${instruction.dst}, .intrinsic = ${instruction.nodeIndex} } }`;
		case "LOAD_INTRINSIC":
			return `{ .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = ${instruction.dst}, .intrinsic = ${emitIntrinsic(instruction.intrinsic)} } }`;
		case "STORE_CAPTURED":
			return `{ .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = ${instruction.src}, .owner_function_index = ${instruction.ownerFunctionIndex}, .index = ${instruction.index} } }`;
		case "ENV_PUSH":
			return `{ .opcode = MAL_OP_ENV_PUSH, .as.env_scope = { .scope_id = ${instruction.scopeId}, .slot_count = ${instruction.slotCount} } }`;
		case "ENV_COPY":
			return `{ .opcode = MAL_OP_ENV_COPY, .as.env_scope = { .scope_id = ${instruction.scopeId}, .slot_count = ${instruction.slotCount} } }`;
		case "ENV_POP":
			return `{ .opcode = MAL_OP_ENV_POP }`;
		case "STORE_GLOBAL":
			return `{ .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = ${instruction.src}, .index = ${instruction.index} } }`;
		case "LOAD_PROPERTY":
			return `{ .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key}, .ic_index = ${instruction.icIndex} } }`;
		case "LOAD_PROPERTY_STATIC":
			return `{ .opcode = MAL_OP_LOAD_PROPERTY_STATIC, .as.load_property_static = { .dst = ${instruction.dst}, .object = ${instruction.object}, .string_index = ${instruction.stringIndex}, .ic_index = ${instruction.icIndex} } }`;
		case "LOAD_PROPERTY_STATIC_ARRAY_LENGTH":
			return `{ .opcode = MAL_OP_LOAD_PROPERTY_STATIC_ARRAY_LENGTH, .as.load_property_static = { .dst = ${instruction.dst}, .object = ${instruction.object}, .string_index = ${instruction.stringIndex}, .ic_index = ${instruction.icIndex} } }`;
		case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			return `{ .opcode = MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT, .as.load_property_static_known_own_slot = { .dst = ${instruction.dst}, .object = ${instruction.object}, .data_offset = ${sideDataOffset()}, .ic_index = ${instruction.icIndex} } }`;
		case "LOAD_PROPERTY_STATIC_SHAPE_CASE":
			return `{ .opcode = MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE, .as.load_property_static_shape_case = { .dst = ${instruction.dst}, .object = ${instruction.object}, .shape_case = ${instruction.shapeCase}, .data_offset = ${sideDataOffset()} } }`;
		case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			return `{ .opcode = MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT, .as.store_property_static_known_own_slot = { .object = ${instruction.object}, .value = ${instruction.value}, .data_offset = ${sideDataOffset()}, .ic_index = ${instruction.icIndex} } }`;
		case "STORE_PROPERTY":
			return `{ .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = ${instruction.object}, .key = ${instruction.key}, .value = ${instruction.value}, .ic_index = ${instruction.icIndex} } }`;
		case "STORE_PROPERTY_STATIC":
			return `{ .opcode = MAL_OP_STORE_PROPERTY_STATIC, .as.store_property_static = { .object = ${instruction.object}, .value = ${instruction.value}, .string_index = ${instruction.stringIndex}, .ic_index = ${instruction.icIndex} } }`;
		case "TO_PROPERTY_KEY":
			return `{ .opcode = MAL_OP_TO_PROPERTY_KEY, .as.to_property_key = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key} } }`;
		case "STORE_SUPER_PROPERTY":
			return `{ .opcode = MAL_OP_STORE_SUPER_PROPERTY, .as.store_super_property = { .object = ${instruction.object}, .key = ${instruction.key}, .value = ${instruction.value}, .receiver = ${instruction.receiver} } }`;
		case "LOAD_SUPER_PROPERTY":
			return `{ .opcode = MAL_OP_LOAD_SUPER_PROPERTY, .as.load_super_property = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key}, .receiver = ${instruction.receiver} } }`;
		case "LOAD_PROTOTYPE":
			return `{ .opcode = MAL_OP_LOAD_PROTOTYPE, .as.load_prototype = { .dst = ${instruction.dst}, .object = ${instruction.object} } }`;
		case "GET_ITERATOR":
			return `{ .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = ${instruction.iteratorDst}, .next_dst = ${instruction.nextDst}, .source = ${instruction.source} } }`;
		case "GET_ASYNC_ITERATOR":
			return `{ .opcode = MAL_OP_GET_ASYNC_ITERATOR, .as.get_async_iterator = { .iterator_dst = ${instruction.iteratorDst}, .next_dst = ${instruction.nextDst}, .source = ${instruction.source} } }`;
		case "ITERATOR_NEXT":
			return `{ .opcode = MAL_OP_ITERATOR_NEXT, .as.iterator_next = { .result_dst = ${instruction.resultDst}, .iterator = ${instruction.iterator}, .next = ${instruction.next} } }`;
		case "ITERATOR_STEP":
			return `{ .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = ${instruction.valueDst}, .done_dst = ${instruction.doneDst}, .iterator = ${instruction.iterator}, .next = ${instruction.next} } }`;
		case "ITERATOR_CLOSE":
			return `{ .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = ${instruction.iterator}, .normal = ${instruction.normal} } }`;
		case "FOR_IN_KEYS":
			return `{ .opcode = MAL_OP_FOR_IN_KEYS, .as.for_in_keys = { .dst = ${instruction.dst}, .source = ${instruction.source} } }`;
		case "CALL_SPREAD":
			return `{ .opcode = MAL_OP_CALL_SPREAD, .as.call_spread = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .arguments_array = ${instruction.argumentsArray} } }`;
		case "CALL_REST_ARGUMENTS":
			return `{ .opcode = MAL_OP_CALL_REST_ARGUMENTS, .as.call_rest_arguments = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()} } }`;
		case "CALL_SPREAD_ITERABLE":
			return `{ .opcode = MAL_OP_CALL_SPREAD_ITERABLE, .as.call_spread_iterable = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .iterable = ${instruction.iterable} } }`;
		case "CONSTRUCT_SPREAD":
			return `{ .opcode = MAL_OP_CONSTRUCT_SPREAD, .as.construct_spread = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .arguments_array = ${instruction.argumentsArray} } }`;
		case "CONSTRUCT_SUPER":
			return `{ .opcode = MAL_OP_CONSTRUCT_SUPER, .as.construct_super = { .dst = ${instruction.dst}, .parent = ${instruction.parent}, .arguments_array = ${instruction.argumentsArray} } }`;
		case "CONSTRUCT_SUPER_EXPLICIT":
			return `{ .opcode = MAL_OP_CONSTRUCT_SUPER_EXPLICIT, .as.construct_super_explicit = { .dst = ${instruction.dst}, .parent = ${instruction.parent}, .arguments_array = ${instruction.argumentsArray}, .new_target = ${instruction.newTarget} } }`;
		case "SET_THIS":
			return `{ .opcode = MAL_OP_SET_THIS, .as.set_this = { .value = ${instruction.value} } }`;
		case "MERGE_DATA_PROPERTIES":
			return `{ .opcode = MAL_OP_MERGE_DATA_PROPERTIES, .as.merge_data_properties = { .target = ${instruction.target}, .src = ${instruction.src} } }`;
		case "DELETE_PROPERTY":
			return `{ .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key} } }`;
		case "DEFINE_ACCESSOR":
			return `{ .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = ${instruction.object}, .key = ${instruction.key}, .accessor = ${instruction.accessor}, .is_setter = ${instruction.isSetter}, .enumerable = ${instruction.enumerable} } }`;
		case "DEFINE_PROPERTY":
			return `{ .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = ${instruction.object}, .key = ${instruction.key}, .value = ${instruction.value}, .enumerable = ${instruction.enumerable}, .writable = ${instruction.writable}, .configurable = ${instruction.configurable} } }`;
		case "SET_FUNCTION_NAME":
			return `{ .opcode = MAL_OP_SET_FUNCTION_NAME, .as.set_function_name = { .func = ${instruction.func}, .key = ${instruction.key}, .prefix = ${instruction.prefix} } }`;
		case "CREATE_PRIVATE_NAME":
			return `{ .opcode = MAL_OP_CREATE_PRIVATE_NAME, .as.create_private_name = { .dst = ${instruction.dst} } }`;
		case "CREATE_PRIVATE_NAMES":
			return `{ .opcode = MAL_OP_CREATE_PRIVATE_NAMES, .as.create_private_names = { .owner_function_index = ${instruction.ownerFunctionIndex}, .data_offset = ${sideDataOffset()} } }`;
		case "DEFINE_PRIVATE":
			return `{ .opcode = MAL_OP_DEFINE_PRIVATE, .as.define_private = { .object = ${instruction.object}, .key = ${instruction.key}, .value = ${instruction.value} } }`;
		case "INIT_PRIVATE_FIELDS":
			return `{ .opcode = MAL_OP_INIT_PRIVATE_FIELDS, .as.init_private_fields = { .object = ${instruction.object}, .data_offset = ${sideDataOffset()} } }`;
		case "LOAD_PRIVATE":
			return `{ .opcode = MAL_OP_LOAD_PRIVATE, .as.load_private = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key} } }`;
		case "STORE_PRIVATE":
			return `{ .opcode = MAL_OP_STORE_PRIVATE, .as.store_private = { .object = ${instruction.object}, .key = ${instruction.key}, .value = ${instruction.value} } }`;
		case "HAS_PRIVATE":
			return `{ .opcode = MAL_OP_HAS_PRIVATE, .as.has_private = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key} } }`;
		case "SET_PROTOTYPE":
			return `{ .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = ${instruction.object}, .prototype = ${instruction.prototype}, .literal = ${instruction.literal} } }`;
		case "LOAD_UNDECLARED":
			return `{ .opcode = MAL_OP_LOAD_UNDECLARED, .as.load_undeclared = { .dst = ${instruction.dst}, .name_string_index = ${instruction.nameStringIndex} } }`;
		case "LOAD_GLOBAL_PROPERTY":
			return `{ .opcode = MAL_OP_LOAD_GLOBAL_PROPERTY, .as.load_global_property = { .dst = ${instruction.dst}, .name_string_index = ${instruction.nameStringIndex} } }`;
		case "STORE_GLOBAL_PROPERTY":
			return `{ .opcode = MAL_OP_STORE_GLOBAL_PROPERTY, .as.store_global_property = { .src = ${instruction.src}, .name_string_index = ${instruction.nameStringIndex}, .declaration = ${instruction.declaration}, .declaration_configurable = ${instruction.declarationConfigurable} } }`;
		case "DECLARE_GLOBAL_LEXICAL":
			return `{ .opcode = MAL_OP_DECLARE_GLOBAL_LEXICAL, .as.declare_global_lexical = { .name_string_index = ${instruction.nameStringIndex}, .index = ${instruction.index}, .immutable = ${instruction.immutable}, .check_only = ${instruction.checkOnly} } }`;
		case "GLOBAL_BINDING_QUERY":
			return `{ .opcode = MAL_OP_GLOBAL_BINDING_QUERY, .as.global_binding_query = { .dst = ${instruction.dst}, .name_string_index = ${instruction.nameStringIndex}, .query = ${["typeof", "has", "delete"].indexOf(instruction.query)} } }`;
		case "INIT_GLOBAL_VARS":
			return `{ .opcode = MAL_OP_INIT_GLOBAL_VARS, .as.init_global_vars = { .data_offset = ${sideDataOffset()}, .declaration_configurable = ${instruction.declarationConfigurable} } }`;
		case "THROW_IF_TDZ":
			return `{ .opcode = MAL_OP_THROW_IF_TDZ, .as.throw_if_tdz = { .src = ${instruction.src}, .name_string_index = ${instruction.nameStringIndex} } }`;
		case "WITH_ENTER":
			return `{ .opcode = MAL_OP_WITH_ENTER, .as.with_enter = { .object = ${instruction.object} } }`;
		case "WITH_EXIT":
			return `{ .opcode = MAL_OP_WITH_EXIT, .as.with_exit = {} }`;
		case "WITH_GET":
			return `{ .opcode = MAL_OP_WITH_GET, .as.with_get = { .dst = ${instruction.dst}, .name_string_index = ${instruction.nameStringIndex} } }`;
		case "WITH_RESOLVE_BASE":
			return `{ .opcode = MAL_OP_WITH_RESOLVE_BASE, .as.with_resolve_base = { .dst = ${instruction.dst}, .name_string_index = ${instruction.nameStringIndex} } }`;
		case "WITH_SET":
			return `{ .opcode = MAL_OP_WITH_SET, .as.with_set = { .found = ${instruction.found}, .value = ${instruction.value}, .name_string_index = ${instruction.nameStringIndex} } }`;
		case "IS_EMPTY":
			return `{ .opcode = MAL_OP_IS_EMPTY, .as.is_empty = { .dst = ${instruction.dst}, .src = ${instruction.src} } }`;
		case "REQUIRE_COERCIBLE":
			return `{ .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = ${instruction.src} } }`;
		case "CHECK_SUPER_CLASS":
			return `{ .opcode = MAL_OP_CHECK_SUPER_CLASS, .as.check_super_class = { .parent = ${instruction.parent} } }`;
		case "CREATE_REST_ARGUMENTS":
			return `{ .opcode = MAL_OP_CREATE_REST_ARGUMENTS, .as.create_rest_arguments = { .dst = ${instruction.dst}, .start_index = ${instruction.startIndex} } }`;
		case "ARRAY_REST":
			return `{ .opcode = MAL_OP_ARRAY_REST, .as.array_rest = { .dst = ${instruction.dst}, .src = ${instruction.src}, .start_index = ${instruction.startIndex} } }`;
		case "COPY_DATA_PROPERTIES":
			return `{ .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = ${instruction.dst}, .src = ${instruction.src}, .data_offset = ${sideDataOffset()} } }`;
		case "BINARY":
			return `{ .opcode = MAL_OP_BINARY, .as.binary = { .dst = ${instruction.dst}, .left = ${instruction.left}, .right = ${instruction.right}, .op = ${emitBinaryOperator(instruction.operator)} } }`;
		case "UNARY":
			return `{ .opcode = MAL_OP_UNARY, .as.unary = { .dst = ${instruction.dst}, .src = ${instruction.src}, .op = ${emitUnaryOperator(instruction.operator)} } }`;
		case "TYPEOF_COMPARE":
			return `{ .opcode = MAL_OP_TYPEOF_COMPARE, .as.typeof_compare = { .dst = ${instruction.dst}, .src = ${instruction.src}, .expected = ${emitTypeofResult(instruction.expected)}, .negated = ${instruction.negated} } }`;
	}

	throw new Error(`Unknown vm instruction ${(instruction as { opcode: string }).opcode}`);
}

export function emitIntrinsic(
	intrinsic: Extract<BytecodeInstruction, { opcode: "LOAD_INTRINSIC" }>["intrinsic"],
) {
	switch (intrinsic) {
		case "Object":
			return "MAL_INTRINSIC_OBJECT_CONSTRUCTOR";
		case "Array":
			return "MAL_INTRINSIC_ARRAY_CONSTRUCTOR";
		case "Function":
			return "MAL_INTRINSIC_FUNCTION_CONSTRUCTOR";
		case "Error":
			return "MAL_INTRINSIC_ERROR_CONSTRUCTOR";
		case "TypeError":
			return "MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR";
		case "RangeError":
			return "MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR";
		case "ReferenceError":
			return "MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR";
		case "SyntaxError":
			return "MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR";
		case "URIError":
			return "MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR";
		case "EvalError":
			return "MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR";
		case "AggregateError":
			return "MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR";
		case "String":
			return "MAL_INTRINSIC_STRING_CONSTRUCTOR";
		case "Number":
			return "MAL_INTRINSIC_NUMBER_CONSTRUCTOR";
		case "Boolean":
			return "MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR";
		case "Symbol":
			return "MAL_INTRINSIC_SYMBOL_CONSTRUCTOR";
		case "BigInt":
			return "MAL_INTRINSIC_BIGINT_CONSTRUCTOR";
		case "ArrayBuffer":
			return "MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR";
		case "SharedArrayBuffer":
			return "MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR";
		case "Int8Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_INT8_CONSTRUCTOR";
		case "Uint8Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR";
		case "Uint8ClampedArray":
			return "MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_CONSTRUCTOR";
		case "Int16Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_INT16_CONSTRUCTOR";
		case "Uint16Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_UINT16_CONSTRUCTOR";
		case "Int32Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_INT32_CONSTRUCTOR";
		case "Uint32Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_UINT32_CONSTRUCTOR";
		case "Float32Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_CONSTRUCTOR";
		case "Float64Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_CONSTRUCTOR";
		case "BigInt64Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_CONSTRUCTOR";
		case "BigUint64Array":
			return "MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_CONSTRUCTOR";
		case "DataView":
			return "MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR";
		case "Map":
			return "MAL_INTRINSIC_MAP_CONSTRUCTOR";
		case "Set":
			return "MAL_INTRINSIC_SET_CONSTRUCTOR";
		case "WeakMap":
			return "MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR";
		case "WeakSet":
			return "MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR";
		case "WeakRef":
			return "MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR";
		case "FinalizationRegistry":
			return "MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR";
		case "DisposableStack":
			return "MAL_INTRINSIC_DISPOSABLE_STACK_CONSTRUCTOR";
		case "AsyncDisposableStack":
			return "MAL_INTRINSIC_ASYNC_DISPOSABLE_STACK_CONSTRUCTOR";
		case "SuppressedError":
			return "MAL_INTRINSIC_SUPPRESSED_ERROR_CONSTRUCTOR";
		case "Promise":
			return "MAL_INTRINSIC_PROMISE_CONSTRUCTOR";
		case "Date":
			return "MAL_INTRINSIC_DATE_CONSTRUCTOR";
		case "RegExp":
			return "MAL_INTRINSIC_REGEXP_CONSTRUCTOR";
		case "Intl":
			return "MAL_INTRINSIC_INTL";
		case "Iterator":
			return "MAL_INTRINSIC_ITERATOR_CONSTRUCTOR";
		case "AsyncIterator":
			return "MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR";
		case "parseInt":
			return "MAL_INTRINSIC_PARSE_INT";
		case "parseFloat":
			return "MAL_INTRINSIC_PARSE_FLOAT";
		case "isNaN":
			return "MAL_INTRINSIC_IS_NAN";
		case "isFinite":
			return "MAL_INTRINSIC_IS_FINITE";
		case "decodeURI":
			return "MAL_INTRINSIC_DECODE_URI";
		case "decodeURIComponent":
			return "MAL_INTRINSIC_DECODE_URI_COMPONENT";
		case "encodeURI":
			return "MAL_INTRINSIC_ENCODE_URI";
		case "encodeURIComponent":
			return "MAL_INTRINSIC_ENCODE_URI_COMPONENT";
		case "Math":
			return "MAL_INTRINSIC_MATH";
		case "JSON":
			return "MAL_INTRINSIC_JSON";
		case "Atomics":
			return "MAL_INTRINSIC_ATOMICS";
		case "Reflect":
			return "MAL_INTRINSIC_REFLECT";
		case "Proxy":
			return "MAL_INTRINSIC_PROXY_CONSTRUCTOR";
		case "console":
			return "MAL_INTRINSIC_CONSOLE";
		case "globalThis":
			return "MAL_INTRINSIC_GLOBAL_THIS";
		case "eval":
			return "MAL_INTRINSIC_EVAL";
		case "__directEval":
			return "MAL_INTRINSIC_DIRECT_EVAL";
		case "__dynamicImport":
			return "MAL_INTRINSIC_DYNAMIC_IMPORT";
		case "__configureDeferredNamespace":
			return "MAL_INTRINSIC_CONFIGURE_DEFERRED_NAMESPACE";
		case "__evaluateModuleSync":
			return "MAL_INTRINSIC_EVALUATE_MODULE_SYNC";
		case "__newDisposeCapability":
			return "MAL_INTRINSIC_NEW_DISPOSE_CAPABILITY";
		case "__addDisposableResource":
			return "MAL_INTRINSIC_ADD_DISPOSABLE_RESOURCE";
		case "__disposeResources":
			return "MAL_INTRINSIC_DISPOSE_RESOURCES";
		case "NaN":
			return "MAL_INTRINSIC_NAN_VALUE";
		case "Infinity":
			return "MAL_INTRINSIC_INFINITY_VALUE";
		case "__cjs_require":
			return "MAL_INTRINSIC_CJS_REQUIRE";
		case "__arrayIterationEligible":
			return "MAL_INTRINSIC_ARRAY_ITERATION_ELIGIBLE";
		case "__arrayFlatMapAppend":
			return "MAL_INTRINSIC_ARRAY_FLAT_MAP_APPEND";
	}
}

export function emitUnaryOperator(
	operator: Extract<BytecodeInstruction, { opcode: "UNARY" }>["operator"],
) {
	switch (operator) {
		case "!":
			return "MAL_UNARY_NOT";
		case "-":
			return "MAL_UNARY_NEGATE";
		case "+":
			return "MAL_UNARY_PLUS";
		case "~":
			return "MAL_UNARY_BIT_NOT";
		case "typeof":
			return "MAL_UNARY_TYPEOF";
		case "tonumeric":
			return "MAL_UNARY_TO_NUMERIC";
		case "tostring":
			return "MAL_UNARY_TO_STRING";
		case "increment":
			return "MAL_UNARY_INCREMENT";
		case "decrement":
			return "MAL_UNARY_DECREMENT";
	}

	throw new Error("Unknown unary operator");
}

export function emitTypeofResult(
	result: Extract<BytecodeInstruction, { opcode: "TYPEOF_COMPARE" }>["expected"],
) {
	switch (result) {
		case "undefined":
			return "MAL_TYPEOF_UNDEFINED";
		case "object":
			return "MAL_TYPEOF_OBJECT";
		case "boolean":
			return "MAL_TYPEOF_BOOLEAN";
		case "number":
			return "MAL_TYPEOF_NUMBER";
		case "string":
			return "MAL_TYPEOF_STRING";
		case "symbol":
			return "MAL_TYPEOF_SYMBOL";
		case "bigint":
			return "MAL_TYPEOF_BIGINT";
		case "function":
			return "MAL_TYPEOF_FUNCTION";
	}
}

/**
 * Emit a non-negative bigint literal value as a C i128 initializer. The value is
 * built in `unsigned __int128` (well-defined wrapping) then cast to i128, which
 * preserves the two's-complement bit pattern and matches the runtime parser's
 * wrap-at-128-bits behavior. BigInt literals are always non-negative (unary `-`
 * is a separate operation).
 */
function emitBigintValue(value: bigint): string {
	const mask = (1n << 64n) - 1n;
	const lo = value & mask;
	const hi = (value >> 64n) & mask;

	if (hi === 0n) {
		return `(i128) ${lo}ULL`;
	}

	return `(i128) (((unsigned __int128) ${hi}ULL << 64) | (unsigned __int128) ${lo}ULL)`;
}

function emitCreateF64(dst: number, value: number): string {
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	view.setFloat64(0, value, true);
	const low = view.getUint32(0, true).toString(16).padStart(8, "0");
	const high = view.getUint32(4, true).toString(16).padStart(8, "0");
	return `{ .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = ${dst}, .bits_low = 0x${low}u, .bits_high = 0x${high}u } }`;
}

export function emitBinaryOperator(operator: VmBinaryOperator) {
	switch (operator) {
		case "+":
			return "MAL_BIN_ADD";
		case "-":
			return "MAL_BIN_SUB";
		case "*":
			return "MAL_BIN_MUL";
		case "/":
			return "MAL_BIN_DIV";
		case "%":
			return "MAL_BIN_REM";
		case "**":
			return "MAL_BIN_POW";
		case "&":
			return "MAL_BIN_BIT_AND";
		case "|":
			return "MAL_BIN_BIT_OR";
		case "^":
			return "MAL_BIN_BIT_XOR";
		case "<<":
			return "MAL_BIN_SHL";
		case ">>":
			return "MAL_BIN_SHR";
		case ">>>":
			return "MAL_BIN_USHR";
		case "<":
			return "MAL_BIN_LT";
		case "<=":
			return "MAL_BIN_LTE";
		case ">":
			return "MAL_BIN_GT";
		case ">=":
			return "MAL_BIN_GTE";
		case "==":
			return "MAL_BIN_EQ";
		case "!=":
			return "MAL_BIN_NEQ";
		case "===":
			return "MAL_BIN_STRICT_EQ";
		case "!==":
			return "MAL_BIN_STRICT_NEQ";
		case "in":
			return "MAL_BIN_IN";
		case "instanceof":
			return "MAL_BIN_INSTANCEOF";
	}

	throw new Error("Unknown binary operator");
}
