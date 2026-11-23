import type { IncludedAsset } from "../../assets.ts";
import type { PlatformData } from "../../platform/catalog.ts";
import {
	BUILTIN_MEMBER_GROUPS,
	NATIVE_BUILTIN_MEMBER_NAMES,
} from "../frontend/builtin-member-data.ts";
import {
	INTRINSIC_INSTALLERS,
	JSON_INSTALLER,
	MAP_INSTALLER,
	SET_INSTALLER,
} from "../frontend/engine-components.ts";
import {
	HTTP_WITHOUT_WEBSOCKET_INSTALLER,
	hostInstallerSymbol,
	BUFFER_INSTALLER_SYMBOL,
	NODE_CONSOLE_HOOKS_INSTALLER,
	NODE_BUILTIN_LOADER_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	NODE_FS_READ_STREAM_INSTALLER,
	PROCESS_ENV_INSTALLER,
	REGEXP_INSTALLER,
	UNICODE_NORMALIZATION_INSTALLER,
	WEB_FETCH_INSTALLER,
} from "../frontend/host-modules.ts";
import { bigintLimbs } from "../shared/bigint-digits.ts";
import { exactBuiltinCallDescriptor } from "../shared/builtin-registry.ts";
import {
	GUARDED_SEMANTIC_EPOCH_MASKS,
	PROBE_READ_KINDS,
	probeReadIsNamed,
} from "../shared/compiler-instruction.ts";
import { EMBED_INSTALLER, embeddedAsset } from "../shared/embedded-asset.ts";
import type { EmbeddedAsset } from "../shared/embedded-asset.ts";
import { knownOperationFlags } from "../shared/known-operations.ts";
import { knownOperationIndex } from "../shared/known-operations.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { staticDataQueryTag } from "../shared/static-data-query.ts";
import type { CoreTargetClassLayout } from "./core-target-ir.ts";
import {
	generatedDeclarationIndices,
	generatedDeclarationReferences,
} from "./generated-declaration-references.ts";
import { GENERATED_PRELUDE_END } from "./generated-prelude.ts";
import { validateNativeProgramStorage } from "./lower-native-storage.ts";
import { shiftNativeSourceRanges } from "./native-source-map.ts";
import type { NativeSourceRange } from "./native-source-map.ts";
import { finalizeCompilerRemarks } from "./profile-metadata.ts";
import type { ProgramImage } from "./program-image.ts";
import {
	validateNativeBodyAbis,
	validateNativeDirectEntry,
	validateNativeRecordCalls,
} from "./program-image.ts";
import {
	COMPILED_FUNCTION_DECLARATION,
	directCompiledEntryKey,
	createNativeFunctionRenderer,
	numericSortKernelDeclaration,
	numericReductionDeclaration,
	numericSortSite,
	nativeDirectClosureKey,
} from "./render-native-c.ts";
import type {
	CompiledFunction,
	NativeDirectClosureEnvironment,
} from "./render-native-c.ts";
import type { NativeFastTryAbi } from "./render-native-fast-entry.ts";
import {
	nativeFastTryAbiKey,
	nativeFastTryParameterList,
} from "./render-native-fast-entry.ts";
import {
	compressPositions,
	computeArgumentRetentionLimit,
	enginePolicyBits,
	positionTableEntries,
	restForwardFlags,
	validateRuntimeImageMetadata,
	vmGuardedCallSideTag,
	vmSafepointRootMapsAreTrusted,
	VM_MATH_BINARY_NUMBER_OPERATIONS,
	VM_MATH_UNARY_NUMBER_OPERATIONS,
} from "./runtime-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	ClosureCaptureValue,
	RuntimeImage,
} from "./runtime-image.ts";
import type { NativeSplitPolicy } from "./split-native-function.ts";
import { stablePartitionHash } from "./stable-partition-hash.ts";

type VmBinaryOperator = Extract<BytecodeInstruction, { opcode: "BINARY" }>["operator"];

export interface EmitOptions {
	/**
	 * Called once for each function the C renderer declines; that function then
	 * runs in the bytecode interpreter.
	 */
	onRendererBailout?: (bailout: { readonly file: string; readonly name: string }) => void;
	/** Host path normalization for compiled stack traces; virtual paths pass through by default. */
	sourcePath?: (file: string) => string;
	/**
	 * Project directory whose relative paths name source files in function partition
	 * keys, which name split units and symbols. Defaults to the entrypoint's directory;
	 * a worker image passes its owner program's, since its entry can be a toolchain file.
	 */
	partitionRoot?: string;
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

	/** The embedded copies of the `maligator:assets` declarations this executable reaches. */
	assets?: Array<IncludedAsset>;

	/** Install the internal `mal` global that toolchain programs reach their host through. */
	toolchainBridge?: boolean;

	/** Outlining thresholds for oversized native functions; tests force small parts. */
	nativeFunctionSplit?: NativeSplitPolicy;
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
	"#define MAL_FUNCTION_ROW(argument_snapshot_plan_value, mapped_argument_slots_value, closure_captures_value, closure_capture_owner_count_value, instructions_value, instruction_data_value, gc_safepoints_value, handlers_value, compiled_value, positions_value, profile_site_ids_value, name_string_index_value, kind_value, parameter_count_value, argument_snapshot_count_value, argument_snapshot_plan_count_value, mapped_argument_count_value, length_value, register_count_value, captured_count_value, argument_retention_limit_value, property_ic_count_value, literal_shape_count_value, instruction_count_value, instruction_data_count_value, gc_safepoint_count_value, handler_count_value, file_index_value, position_count_value, strict_value, needs_arguments_value, mapped_arguments_value, gc_safepoints_trusted_value, is_derived_constructor_value, is_class_constructor_value, constructor_slot_reserve_value, has_prototype_value) { ",
	".argument_snapshot_plan = argument_snapshot_plan_value, .mapped_argument_slots = mapped_argument_slots_value, .closure_captures = closure_captures_value, .closure_capture_owner_count = closure_capture_owner_count_value, .instructions = instructions_value, .instruction_data = instruction_data_value, .gc_safepoints = gc_safepoints_value, .handlers = handlers_value, .compiled = compiled_value, .positions = positions_value, MAL_FUNCTION_PROFILE_SITE(profile_site_ids_value) ",
	".name_string_index = name_string_index_value, .kind = kind_value, .parameter_count = parameter_count_value, .argument_snapshot_count = argument_snapshot_count_value, .argument_snapshot_plan_count = argument_snapshot_plan_count_value, .mapped_argument_count = mapped_argument_count_value, .length = length_value, .register_count = register_count_value, .captured_count = captured_count_value, .argument_retention_limit = argument_retention_limit_value, .property_ic_count = property_ic_count_value, .literal_shape_count = literal_shape_count_value, .instruction_count = instruction_count_value, .instruction_data_count = instruction_data_count_value, .gc_safepoint_count = gc_safepoint_count_value, .handler_count = handler_count_value, .file_index = file_index_value, .position_count = position_count_value, .strict = strict_value, .needs_arguments = needs_arguments_value, .mapped_arguments = mapped_arguments_value, .gc_safepoints_trusted = gc_safepoints_trusted_value, .is_derived_constructor = is_derived_constructor_value, .is_class_constructor = is_class_constructor_value, .constructor_slot_reserve = constructor_slot_reserve_value, .has_prototype = has_prototype_value }",
].join("");

export const NATIVE_C_HEADER_LINES = [
	"#include <stdatomic.h>",
	"#include <string.h>",
	'#include "vm.h"',
	'#include "vm_ops.h"',
	'#include "value_ops.h"',
	'#include "perf_stats.h"',
	'#include "profile.h"',
	'#include "builtin_array.h"',
	'#include "builtin_boolean.h"',
	'#include "builtin_data_view.h"',
	'#include "builtin_date.h"',
	'#include "builtin_object.h"',
	'#include "builtin_json.h"',
	'#include "builtin_members.h"',
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
	'#include "builtin_promise.h"',
	// Compiled coroutines cast their backend entry state to MalGeneratorObject.
	'#include "generator_object.h"',
	'#include "class_layout.h"',
	// Private roots live in C locals and reach the shadow frame only at collecting edges.
	"typedef MalValue MalPrivateRoot;",
	// A frame that ever needs a wide row publishes every mask as a row, so this word
	// is a narrow frame's whole inactive state and its tail stays null from entry.
	"#define MAL_ROOT_MASK(mask) (__gc_frame.inactive_slots = UINT64_C(mask))",
	"#define MAL_ROOT_MASK_ROW(row) mal_gc_root_frame_set_inactive(&__gc_frame, __gc_inactive_rows[row][0], &__gc_inactive_rows[row][1], countof(__gc_inactive_rows[0]) - 1)",
	"#define MAL_THREW() (vm->completion.kind == MAL_COMPLETION_THROW)",
	"#define MAL_FRAME_POS(row, entry) ((row)->position_entry = (entry))",
	"#define MAL_FUNCTION_INDEX_OF(value) (mal_value_is_function_object(value) ? mal_function_object_function_index(mal_value_to_function_object(value)) : -1)",
	"#if MAL_REALMS",
	"#define MAL_CALLEE_REALM_ENTER(callee) MalRealm *const __entry_realm = vm->current_realm; mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, (callee)))",
	"#define MAL_CALLEE_REALM_LEAVE() mal_vm_realm_switch_to(vm, __entry_realm)",
	"#else",
	"#define MAL_CALLEE_REALM_ENTER(callee) ((void) (callee))",
	"#define MAL_CALLEE_REALM_LEAVE() ((void) 0)",
	"#endif",
	"#if MAL_NATIVE_FRAME_WALK",
	"#if __has_attribute(disable_tail_calls)",
	"#define MAL_COMPILED_NO_TAIL_CALLS __attribute__((disable_tail_calls))",
	"#else",
	'#define MAL_COMPILED_NO_TAIL_CALLS __attribute__((optimize("no-optimize-sibling-calls")))',
	"#endif",
	// A walked frame keeps its own C frame and stays on the stack while its callees run.
	"#define MAL_COMPILED_FRAME __attribute__((section(MAL_COMPILED_TEXT_SECTION), noinline)) MAL_COMPILED_NO_TAIL_CALLS",
	"#define MAL_FRAME_DESC(name, owner) static MalCompiledFrameDesc name = { .code = (const void *) (owner) }",
	"#define MAL_FRAME_ENTER(record, desc, index) mal_vm_enter_compiled_frame(vm, (record), &(desc), (index), __builtin_frame_address(0))",
	"#define MAL_FRAME_SCOPE() ((void) 0)",
	"#define MAL_FRAME_ABSENT(record) ((record)->desc = nullptr)",
	"#else",
	"#define MAL_COMPILED_FRAME",
	"#define MAL_FRAME_DESC(name, owner) typedef int name",
	"#define MAL_FRAME_ENTER(record, desc, index) ((void) (record), mal_vm_enter_compiled_row(vm, (index)))",
	"#define MAL_FRAME_SCOPE() MalVm *const __entered __attribute__((cleanup(mal_vm_leave_compiled_scope))) = vm",
	"#define MAL_FRAME_ABSENT(record) ((void) (record))",
	"#endif",
	"#define MAL_STRING_ROW(code_units_value, length_value) { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = length_value, .code_units = code_units_value }",
	"#define MAL_LATIN1_STRING_ROW(units_value, length_value) { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .latin1 = 1, .hash = 0, .length = length_value, .latin1_units = units_value }",
	"#define MAL_LINE_ENTRY(start_ip_value, pos_id_value) { .start_ip = start_ip_value, .pos_id = pos_id_value }",
	"#define MAL_SOURCE_POS(line_value, column_value, inlined_function_index_value, caller_pos_id_value) { .line = line_value, .column = column_value, .inlined_function_index = inlined_function_index_value, .caller_pos_id = caller_pos_id_value }",
	"#if MAL_PROFILE",
	"#define MAL_FUNCTION_PROFILE_SITE(value) .profile_site_ids = value,",
	"#else",
	"#define MAL_FUNCTION_PROFILE_SITE(value)",
	"#endif",
	MAL_FUNCTION_ROW_MACRO,
	"",
	GENERATED_PRELUDE_END,
];

export const GENERATED_DATA_C_HEADER_LINES = [
	"#include <stdatomic.h>",
	"#include <string.h>",
	'#include "vm.h"',
	// Bytecode rows name Math operations by their runtime enum.
	'#include "builtin_math.h"',
	'#include "builtin_members.h"',
	"#define MAL_STRING_ROW(code_units_value, length_value) { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = length_value, .code_units = code_units_value }",
	"#define MAL_LATIN1_STRING_ROW(units_value, length_value) { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .latin1 = 1, .hash = 0, .length = length_value, .latin1_units = units_value }",
	"#define MAL_LINE_ENTRY(start_ip_value, pos_id_value) { .start_ip = start_ip_value, .pos_id = pos_id_value }",
	"#define MAL_SOURCE_POS(line_value, column_value, inlined_function_index_value, caller_pos_id_value) { .line = line_value, .column = column_value, .inlined_function_index = inlined_function_index_value, .caller_pos_id = caller_pos_id_value }",
	"#if MAL_PROFILE",
	"#define MAL_FUNCTION_PROFILE_SITE(value) .profile_site_ids = value,",
	"#else",
	"#define MAL_FUNCTION_PROFILE_SITE(value)",
	"#endif",
	MAL_FUNCTION_ROW_MACRO,
	"",
	GENERATED_PRELUDE_END,
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
	readonly sourceChunks: ReadonlyArray<string>;
	readonly sourceCodeUnits: number;
	readonly headerFiles: ReadonlyArray<string>;
	readonly definitions: ReadonlyArray<GeneratedTranslationUnitDefinition>;
	/**
	 * Content digests of the files this unit `#embed`s. A unit that lists them includes
	 * no header, so its object is keyed by its text and these digests: preprocessing
	 * would spell every embedded byte out as text.
	 */
	readonly embeddedFileDigests?: ReadonlyArray<string>;
}

function separatedSourceChunks(parts: ReadonlyArray<string>): Array<string> {
	const chunks: Array<string> = [];
	for (const part of parts) {
		if (chunks.length > 0) chunks.push("\n");
		chunks.push(part);
	}
	return chunks;
}

export interface TranslationUnitPolicy {
	readonly targetCodeUnits: number;
	/** Native compilation cost budget; larger functions keep their bytecode entry. */
	readonly maximumNativeFunctionCodeUnits: number;
}

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
	const parameters = [
		...entry.parameterRepresentations.map(
			(representation, index) => `${cType(representation)} p${index}`,
		),
		...(entry.resultFieldRepresentations ?? []).map(
			(rep, field) => `${cType(rep)} *rf${field}`,
		),
		...(entry.recordParameters ?? []).flatMap((parameter) =>
			parameter.representations.map(
				(rep, field) => `${cType(rep)} *rp${parameter.index}_${field}`,
			),
		),
	];
	return `${cType(entry.resultRepresentation)} ${entry.symbol}(MalVm *vm, MalValue this_value${parameters.length === 0 ? "" : `, ${parameters.join(", ")}`}, MalEnv *env, MalValue callee)`;
}

export const DEFAULT_TRANSLATION_UNIT_TARGET_CODE_UNITS = 2 * 1024 * 1024;
/** Bound native optimization cost without restricting valid program or data sizes. */
export const MAXIMUM_NATIVE_FUNCTION_CODE_UNITS = 8 * 1024 * 1024;
export const DEFAULT_TRANSLATION_UNIT_POLICY: TranslationUnitPolicy = {
	targetCodeUnits: DEFAULT_TRANSLATION_UNIT_TARGET_CODE_UNITS,
	maximumNativeFunctionCodeUnits: MAXIMUM_NATIVE_FUNCTION_CODE_UNITS,
};

function numericArrayRows(values: ReadonlyArray<number>): Array<string> {
	const rows: Array<string> = [];
	for (let start = 0; start < values.length; start += 1024)
		rows.push(`    ${values.slice(start, start + 1024).join(", ")},`);
	if (rows.length === 0) rows.push("    0,");
	return rows;
}

/** Constants whose units fit one byte use the runtime's compact Latin-1 storage. */
function stringConstantIsLatin1(constant: Array<number>): boolean {
	return constant.every((unit) => unit <= 0xff);
}

function stringUnitType(constant: Array<number>): string {
	return stringConstantIsLatin1(constant) ? "u8" : "c16";
}

function malStringRow(symbol: string, constant: Array<number>): string {
	// Immortal string constant. The row stays mutable because its hash is cached
	// lazily on first use (a static initializer cannot compute it).
	const row = stringConstantIsLatin1(constant)
		? "MAL_LATIN1_STRING_ROW"
		: "MAL_STRING_ROW";
	return `    ${row}(${symbol}, ${constant.length}),`;
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

function closureCaptureValueArrayBody(values: Array<ClosureCaptureValue>): string {
	return values
		.map(
			(value) =>
				`    { .owner_function_index = ${value.ownerFunctionIndex}, .captured_index = ${value.capturedIndex} },`,
		)
		.join("\n");
}

function closureCaptureLayoutBody(
	owners: string,
	values: string,
	valueCount: number,
): string {
	return `    { .owners = ${owners}, .values = ${values}, .value_count = ${valueCount} },`;
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
	closureCapturesSymbol: string,
	handlersSymbol: string,
	compiledSymbol: string,
	profileSiteIdsSymbol: string,
	debug: { positionsSymbol: string; positionCount: number; fileIndex: number },
	omitBytecode = false,
): Array<string> {
	const values = [
		argumentSnapshotPlanSymbol,
		mappedArgumentSlotsSymbol,
		closureCapturesSymbol,
		fn.closureCaptureOwners?.length ?? -1,
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
		fn.propertyIcCount,
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

// Trust in root maps never survives serialization, so a function that never runs
// claims none: a restored image must emit what the compiling process emitted.
function emissionUnreachable(image: ProgramImage, functionIndex: number): boolean {
	return image.native.functions[functionIndex]?.unreachable === true;
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

function argumentSnapshotPlanRows(fn: BytecodeFunction): Array<string> {
	return fn.argumentSnapshotPlan.map(
		(move) => `    { .destination = ${move.destination}, .source = ${move.source} },`,
	);
}

function positionArrayRows(runs: ReturnType<typeof compressPositions>): Array<string> {
	return runs.map((run) => `    MAL_LINE_ENTRY(${run.startIp}, ${run.posId}),`);
}

function instructionArrayRows(
	fn: RuntimeImage["functions"][number],
	dataOffsets: Array<number | undefined>,
): Array<string> {
	return fn.instructions.map(
		(instruction, i) => `    ${emitInstruction(instruction, dataOffsets[i])},`,
	);
}

function nativeNeedsMappedArgumentSlots(fn: RuntimeImage["functions"][number]): boolean {
	return (
		fn.mappedArgumentSlots.length > 0 &&
		fn.instructions.some(
			(instruction) =>
				(instruction.opcode === "CALL_REST_ARGUMENTS" ||
					instruction.opcode === "CONSTRUCT_REST_ARGUMENTS") &&
				instruction.mappedCallee !== undefined,
		)
	);
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
			case "CONSTRUCT_REST_ARGUMENTS":
				offsets[index] = data.length;
				data.push(
					instruction.receiver,
					instruction.startIndex,
					restForwardFlags(instruction),
					instruction.state,
					instruction.mappedCallee ?? -1,
					instruction.prefixArguments.length,
					...instruction.prefixArguments,
				);
				if (instruction.sourceArguments !== undefined)
					data.push(instruction.sourceArguments.length, ...instruction.sourceArguments);
				break;
			case "CALL_SPREAD_ITERABLE":
			case "CONSTRUCT_SPREAD_ITERABLE":
				offsets[index] = data.length;
				data.push(
					instruction.iterable,
					instruction.prefixArguments.length,
					...instruction.prefixArguments,
				);
				break;
			case "CONSTRUCT_SUPER_EXPLICIT":
				offsets[index] = data.length;
				data.push(instruction.newTarget, instruction.state, instruction.stateKey);
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
			case "PROBE_READ":
				offsets[index] = data.length;
				data.push(
					instruction.key,
					PROBE_READ_KINDS.indexOf(instruction.readKind),
					instruction.stringIndex ?? -1,
					probeReadIsNamed(instruction) ? instruction.icIndex : -1,
				);
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
					instruction.methodStringIndex,
					instruction.methodFunctionIndex,
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
			case "CONCAT_STRINGS":
			case "CONSTRUCT_SUPER":
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

function handlerArrayRows(fn: RuntimeImage["functions"][number]): Array<string> {
	return fn.handlers.map(
		(handler) =>
			`    { .start_ip = ${handler.startIp}, .end_ip = ${handler.endIp}, .handler_ip = ${handler.handlerIp} },`,
	);
}

/**
 * Emit a C translation unit with the static MalRuntimeImage data.
 */
export function emitProgramImage(image: ProgramImage, options: EmitOptions = {}) {
	return [
		...emitProgramImageParts(
			image,
			options,
			false,
			prepareProgramImageNativeEmission(image, options, false)(),
		).parts.map((part) => (typeof part === "string" ? part : part.join("\n"))),
		...inlineAssetData(options),
	].join("\n");
}

export interface EmittedCSourceMap {
	source: string;
	ranges: Array<NativeSourceRange & { functionIndex: number; symbol: string }>;
	functions: Array<{ functionIndex: number; symbol: string; start: number; end: number }>;
}

export function emitProgramImageWithSourceMap(
	image: ProgramImage,
	options: EmitOptions = {},
): EmittedCSourceMap {
	const emitted = emitProgramImageParts(
		image,
		options,
		false,
		prepareProgramImageNativeEmission(image, options, false, undefined, true)(),
		true,
	);
	const parts = [
		...emitted.parts.map((part) => (typeof part === "string" ? part : part.join("\n"))),
		...inlineAssetData(options),
	];
	const offsets = [0];
	for (const part of parts) offsets.push(offsets.at(-1)! + part.length + 1);
	return {
		source: parts.join("\n"),
		ranges: emitted.sourceMapParts.flatMap((part) =>
			shiftNativeSourceRanges(part.ranges, offsets[part.part]!).map((range) => ({
				...range,
				functionIndex: part.functionIndex,
				symbol: part.symbol,
			})),
		),
		functions: emitted.sourceMapParts.map((part) => ({
			functionIndex: part.functionIndex,
			symbol: part.symbol,
			start: offsets[part.part]!,
			end: offsets[part.part]! + parts[part.part]!.length,
		})),
	};
}

type ProgramSourcePart = string | ReadonlyArray<string>;

interface EmittedProgramImageParts {
	parts: ReadonlyArray<ProgramSourcePart>;
	compiled: Array<CompiledFunction | null>;
	sourceMapParts: Array<{
		part: number;
		functionIndex: number;
		symbol: string;
		ranges: ReadonlyArray<NativeSourceRange>;
	}>;
}

interface ExternalDataDefinition {
	symbol: string;
	source: string;
}

interface SplitDataSource {
	lines: ReadonlyArray<string>;
	definitions: Array<ExternalDataDefinition>;
	declarations: Array<GeneratedDeclaration>;
}

interface GeneratedDeclaration {
	symbol: string;
	source: string;
}

interface TranslationUnitPart {
	kind: "data array" | "compiled function";
	symbol: string;
	partitionKey: string;
	partitionHashes: Array<number | undefined>;
	source: string;
	declarationIndices: Array<number>;
	declarationSymbols: ReadonlySet<string> | undefined;
}

interface TranslationUnitDeclarations {
	readonly indices: ReadonlyArray<number>;
	readonly codeUnits: number;
}

interface NativeCompilationAvailability {
	directCompiledTargets: Set<number>;
	/** Functions whose canonical body exports a frameless fast path. */
	fastTryTargets: Map<number, NativeFastTryAbi>;
	/** Closures, by creator, whose creator and every caller run native code that enters them without an object. */
	directClosures: Map<string, NativeDirectClosureEnvironment>;
	directCompiledEntries: Map<
		string,
		ProgramImage["native"]["functions"][number]["directEntries"][number] & {
			readonly leaf?: true;
			readonly sortMayDecline?: true;
		}
	>;
}

interface NativeDirectClosureSite {
	readonly target: number;
	readonly environment: NativeDirectClosureEnvironment | undefined;
	/** The creating function and every function calling through the owner scope. */
	readonly functions: ReadonlyArray<number>;
	/** Some caller enters the target's compiled code directly. */
	readonly called: boolean;
}

function nativeDirectClosureSites(
	image: ProgramImage,
	uses: ReadonlyArray<NativeCallSite>,
): Map<string, NativeDirectClosureSite> {
	const creations = new Map<
		string,
		{ readonly target: number; readonly owner: number }
	>();
	const functions = new Map<string, Set<number>>();
	const called = new Set<string>();
	// A typed entry that guards the call identity would read the elided object.
	const guarded = new Set<string>();
	const participate = (key: string, functionIndex: number) => {
		const participants = functions.get(key) ?? new Set<number>();
		participants.add(functionIndex);
		functions.set(key, participants);
	};
	for (const { functionIndex, ip } of uses) {
		const native = image.native.functions[functionIndex]!;
		const plan = native.instructions[ip];
		const instruction = native.body.instructions[ip];
		if (plan?.kind === "direct-closure" && instruction?.opcode === "CREATE_FUNCTION") {
			const key = nativeDirectClosureKey(instruction.functionIndex, functionIndex);
			creations.set(key, { target: instruction.functionIndex, owner: functionIndex });
			participate(key, functionIndex);
		} else if (
			plan?.kind === "closure-materialization" &&
			instruction?.opcode === "LOAD_CAPTURED"
		) {
			participate(
				nativeDirectClosureKey(plan.functionIndex, instruction.ownerFunctionIndex),
				functionIndex,
			);
		} else if (
			plan?.kind === "call" &&
			plan.directClosureOwner !== undefined &&
			plan.directFunctionIndex !== undefined
		) {
			const key = nativeDirectClosureKey(
				plan.directFunctionIndex,
				plan.directClosureOwner,
			);
			participate(key, functionIndex);
			called.add(key);
			for (const entry of native.directEntries)
				for (const call of entry.callOverrides ?? [])
					if (
						call.instructionIp === ip &&
						(call.guarded === true || call.functionIndex !== plan.directFunctionIndex)
					)
						guarded.add(key);
		}
	}
	const sites = new Map<string, NativeDirectClosureSite>();
	for (const [key, { target, owner }] of creations) {
		const closure = image.runtime.functions[target]!;
		const layout = closure.closureCaptureOwners;
		const environment: NativeDirectClosureEnvironment | undefined =
			guarded.has(key) || (closure.closureCaptureValues?.length ?? 0) > 0
				? undefined
				: layout === undefined
					? { kind: "scope" }
					: layout.length === 0
						? { kind: "none" }
						: layout.length === 1
							? layout[0] === owner
								? { kind: "owner" }
								: { kind: "ancestor", owner: layout[0]! }
							: layout[layout.length - 1] === owner
								? { kind: "chain", layout: layout.join(",") }
								: {
										kind: "outer-chain",
										owner: layout[layout.length - 1]!,
										layout: layout.join(","),
									};
		sites.set(key, {
			target,
			environment,
			functions: [...functions.get(key)!],
			called: called.has(key),
		});
	}
	return sites;
}

function nativeCompilationAvailability(
	image: ProgramImage,
	compiled: ReadonlyArray<CompiledFunction | null>,
	plan: NativeEmissionReferences,
): NativeCompilationAvailability {
	const directCompiledTargets = new Set<number>();
	for (const [caller, fn] of compiled.entries()) {
		if (fn === null) continue;
		for (const target of plan.functions[caller]!.directTargets) {
			if (compiled[target] !== null && compiled[target]!.source.length > 0)
				directCompiledTargets.add(target);
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
					{
						...entry,
						...(emittedEntry.leaf ? { leaf: true as const } : {}),
						...(emittedEntry.sortMayDecline ? { sortMayDecline: true as const } : {}),
					},
				);
			}
		}
	}
	const fastTryTargets = new Map<number, NativeFastTryAbi>();
	for (const target of directCompiledTargets)
		if (compiled[target]?.trySymbol !== undefined)
			fastTryTargets.set(target, compiled[target].tryAbi!);
	const directClosures = new Map<string, NativeDirectClosureEnvironment>();
	for (const [key, site] of plan.closureSites)
		if (
			site.environment !== undefined &&
			(!site.called || directCompiledTargets.has(site.target)) &&
			site.functions.every((functionIndex) => compiled[functionIndex] !== null)
		)
			directClosures.set(key, site.environment);
	return { directCompiledTargets, fastTryTargets, directCompiledEntries, directClosures };
}

function omitUnreachableCanonicalBodies(
	compiled: Array<CompiledFunction | null>,
	references: NativeEmissionReferences,
): Array<CompiledFunction | null> {
	return compiled.map((fn, target) => {
		const sites = references.canonicalReferences[target];
		if (fn === null || fn.directEntries.length === 0 || sites === undefined) return fn;
		if (references.callbackCanonicalTargets.has(target)) return fn;
		for (const { functionIndex, ip } of sites) {
			const caller = compiled[functionIndex];
			if (
				caller === null ||
				caller === undefined ||
				[caller, ...caller.directEntries].some(
					(variant) =>
						variant.emittedInstructions.has(ip) &&
						!variant.directEntryCalls.get(ip)?.has(target),
				)
			)
				return fn;
		}
		return { ...fn, source: "" };
	});
}

function compiledAvailabilityMatches(
	left: ReadonlyArray<CompiledFunction | null>,
	right: ReadonlyArray<CompiledFunction | null>,
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const a = left[index]!;
		const b = right[index]!;
		if (a === b) continue;
		if (a === null || b === null) return false;
		if (
			(a.source.length === 0) !== (b.source.length === 0) ||
			(a.trySymbol === undefined) !== (b.trySymbol === undefined) ||
			nativeFastTryAbiKey(a.tryAbi) !== nativeFastTryAbiKey(b.tryAbi) ||
			a.directEntries.length !== b.directEntries.length
		)
			return false;
		for (let entry = 0; entry < a.directEntries.length; entry++)
			if (
				a.directEntries[entry]!.id !== b.directEntries[entry]!.id ||
				a.directEntries[entry]!.leaf !== b.directEntries[entry]!.leaf
			)
				return false;
	}
	return true;
}

interface NativeCallSite {
	readonly functionIndex: number;
	readonly ip: number;
}

interface NativeFunctionEmissionReferences {
	readonly targets: ReadonlyArray<number>;
	readonly entries: ReadonlyArray<string>;
	readonly directTargets: ReadonlyArray<number>;
	readonly sortEntries: ReadonlySet<string> | undefined;
}

interface NativeEmissionReferences {
	readonly functions: ReadonlyArray<NativeFunctionEmissionReferences>;
	readonly closureSites: ReadonlyMap<string, NativeDirectClosureSite>;
	readonly callbackEntries: ReadonlySet<string>;
	readonly reductionEntries: ReadonlySet<string>;
	readonly sortKernelEntries: ReadonlySet<string>;
	readonly canonicalReferences: ReadonlyArray<ReadonlyArray<NativeCallSite> | undefined>;
	readonly callbackCanonicalTargets: ReadonlySet<number>;
}

function prepareNativeEmissionReferences(image: ProgramImage): NativeEmissionReferences {
	const callbackEntries = new Set<string>();
	const reductionEntries = new Set<string>();
	const sortKernelEntries = new Set<string>();
	const callbackCanonicalTargets = new Set<number>();
	const canonicalReferences = image.native.functions.map((native) =>
		native.specializedOnly === true ? ([] as Array<NativeCallSite>) : undefined,
	);
	const closureUses: Array<NativeCallSite> = [];
	const functions = image.native.functions.map((native, functionIndex) => {
		const targets = new Set<number>();
		const directTargets = new Set<number>();
		const entries = new Set<string>();
		const entryTargets: Array<number> = [];
		let sortEntries: Set<string> | undefined;
		for (const entry of native.directEntries)
			if (entry.canonicalDispatch === true)
				entries.add(directCompiledEntryKey(functionIndex, entry.id));
		for (const storage of [
			native.storage,
			...native.directEntries.map((entry) => entry.storage),
		])
			for (const plan of storage?.callbackTransports ?? []) {
				const entry = directCompiledEntryKey(plan.functionIndex, plan.entryId);
				targets.add(plan.functionIndex);
				entries.add(entry);
				callbackEntries.add(entry);
				if (plan.numericReduction === true) reductionEntries.add(entry);
			}
		validateNativeRecordCalls(native.body, native, image.native.functions);
		for (const entry of native.directEntries) {
			validateNativeDirectEntry(native.body, entry, image.native.functions);
			for (const call of entry.callOverrides ?? []) {
				targets.add(call.functionIndex);
				entryTargets.push(call.functionIndex);
				entries.add(directCompiledEntryKey(call.functionIndex, call.entryId));
			}
		}
		for (const site of native.fieldCalls ?? [])
			for (const entry of site.entries) {
				targets.add(entry.functionIndex);
				entries.add(directCompiledEntryKey(entry.functionIndex, entry.entryId));
			}
		const demandTarget = (target: number | undefined) => {
			if (target === undefined) return;
			targets.add(target);
			if (!image.runtime.functions[target]!.isClassConstructor) directTargets.add(target);
		};
		for (let ip = 0; ip < native.instructions.length; ip++) {
			const instruction = native.instructions[ip];
			if (
				instruction?.kind === "direct-closure" ||
				instruction?.kind === "closure-materialization" ||
				(instruction?.kind === "call" && instruction.directClosureOwner !== undefined)
			)
				closureUses.push({ functionIndex, ip });
			if (instruction?.kind !== "call") continue;
			demandTarget(instruction.directFunctionIndex);
			const callback = instruction.directCallbackFunctionIndex;
			demandTarget(callback);
			if (callback !== undefined && canonicalReferences[callback] !== undefined)
				callbackCanonicalTargets.add(callback);
			for (const entry of instruction.numericSortCallback?.entries ?? []) {
				demandTarget(entry.functionIndex);
				entries.add(directCompiledEntryKey(entry.functionIndex, entry.entryId));
			}
			demandTarget(instruction.directCallTargetFunctionIndex);
			for (const target of instruction.guardedFunctionIndices ?? []) demandTarget(target);
			const exactTarget = instruction.directFunctionIndex;
			if (exactTarget !== undefined)
				canonicalReferences[exactTarget]?.push({ functionIndex, ip });
			for (const target of instruction.guardedFunctionIndices ?? [])
				canonicalReferences[target]?.push({ functionIndex, ip });
			if (
				(exactTarget !== undefined || instruction.guardedFunctionIndices?.length === 1) &&
				instruction.directEntryId !== undefined
			)
				entries.add(
					directCompiledEntryKey(
						exactTarget ?? instruction.guardedFunctionIndices![0]!,
						instruction.directEntryId,
					),
				);
			for (const entry of numericSortSite(native.body.instructions[ip], instruction)
				?.entries ?? []) {
				const key = directCompiledEntryKey(entry.functionIndex, entry.entryId);
				sortKernelEntries.add(key);
				(sortEntries ??= new Set()).add(key);
			}
		}
		for (const target of entryTargets) demandTarget(target);
		return {
			targets: [...targets],
			entries: [...entries],
			directTargets: [...directTargets],
			sortEntries,
		};
	});
	return {
		functions,
		callbackEntries,
		reductionEntries,
		sortKernelEntries,
		canonicalReferences,
		callbackCanonicalTargets,
		closureSites: nativeDirectClosureSites(image, closureUses),
	};
}

interface NativeFunctionEmission {
	readonly compiled: Array<CompiledFunction | null>;
	readonly availability: NativeCompilationAvailability;
}

function prepareNativeFunctionEmission(
	image: ProgramImage,
	options: {
		useCompiled: boolean;
		suffix: string;
		debug: boolean;
		captureSourceMap?: boolean;
		linkage: "static" | "external";
		maxCodeUnits?: number;
		/** Index-stable emission, naming each function by its stem. */
		symbolStems?: ReadonlyArray<string>;
		/** C expression for the relocation a spliced overlay's link slots are relative to. */
		relocation?: string;
		nativeFunctionSplit?: NativeSplitPolicy;
		onRendererBailout?: EmitOptions["onRendererBailout"];
	},
): (excludedSymbols?: ReadonlySet<string>) => NativeFunctionEmission {
	const headerCodeUnits = NATIVE_C_HEADER_LINES.join("\n").length + 1;
	const importedGlobals =
		options.relocation === undefined ? undefined : nativeImportedGlobals(image.runtime);
	const fits = (source: string): boolean =>
		options.maxCodeUnits === undefined ||
		source.length + headerCodeUnits <= options.maxCodeUnits;
	const plan = prepareNativeEmissionReferences(image);
	const {
		functions: references,
		closureSites,
		callbackEntries,
		reductionEntries,
		sortKernelEntries,
	} = plan;
	const closureParticipation: Array<Array<string>> = [];
	for (const [key, site] of closureSites)
		for (const functionIndex of site.functions)
			(closureParticipation[functionIndex] ??= []).push(key);
	const cached: Array<
		| {
				readonly key: string;
				readonly raw: CompiledFunction | null;
				excludedSymbols: ReadonlySet<string> | undefined;
				emitted: CompiledFunction | null;
		  }
		| undefined
	> = [];
	const fastTryLookups: Array<Map<number, "all" | "undefined"> | undefined> = [];
	const renderFunction = createNativeFunctionRenderer((caller, target, resultKind) => {
		const lookups = (fastTryLookups[caller] ??= new Map());
		if (resultKind === undefined || !lookups.has(target))
			lookups.set(target, resultKind ?? "all");
	}, new Set(image.runtime.cjsModuleFunctionIndices));
	const strictCompiledTargets = new Set(
		image.runtime.functions.flatMap((fn, index) => (fn.strict ? [index] : [])),
	);
	const framePositions = image.runtime.functions.map((fn) =>
		options.debug
			? Object.assign(
					positionTableEntries(fn),
					options.captureSourceMap ? { captureSourceMap: true } : {},
				)
			: false,
	);
	const render = (
		functionIndex: number,
		availability: NativeCompilationAvailability,
	): CompiledFunction | null => {
		fastTryLookups[functionIndex]?.clear();
		return renderFunction(
			image.native.functions[functionIndex]!,
			functionIndex,
			options.suffix,
			framePositions[functionIndex]!,
			options.linkage,
			availability.directCompiledTargets,
			image.native.semanticProtectors,
			availability.directCompiledEntries,
			options.symbolStems === undefined
				? false
				: {
						symbolStem: options.symbolStems[functionIndex]!,
						relocation: options.relocation,
						symbolStems: options.symbolStems,
						importedGlobals,
					},
			strictCompiledTargets,
			image.runtime.stringConstants,
			callbackEntries,
			options.maxCodeUnits === undefined
				? undefined
				: options.maxCodeUnits - headerCodeUnits,
			options.nativeFunctionSplit,
			sortKernelEntries,
			reductionEntries,
			availability.fastTryTargets,
			availability.directClosures,
		);
	};

	const fitVariants = (
		emitted: CompiledFunction | null,
		excludedSymbols: ReadonlySet<string> | undefined,
	): CompiledFunction | null => {
		if (
			emitted === null ||
			!fits(emitted.source) ||
			excludedSymbols?.has(emitted.symbol) === true
		)
			return null;
		// Typed siblings have independent budgets so they cannot evict the canonical ABI.
		const directEntries = emitted.directEntries.filter(
			(entry) => fits(entry.source) && excludedSymbols?.has(entry.symbol) !== true,
		);
		return directEntries.length === emitted.directEntries.length
			? emitted
			: { ...emitted, directEntries };
	};

	const availabilityKey = (
		functionIndex: number,
		availability: NativeCompilationAvailability,
	): string => {
		const referenced = references[functionIndex]!;
		let key = "";
		for (const target of referenced.targets)
			key += availability.directCompiledTargets.has(target) ? "1" : "0";
		for (const entry of referenced.entries) {
			const current = availability.directCompiledEntries.get(entry);
			if (current === undefined) key += "0";
			else if (referenced.sortEntries?.has(entry)) {
				key += current.sortMayDecline ? "3" : current.leaf ? "2" : "1";
			} else key += "1";
		}
		for (const closure of closureParticipation[functionIndex] ?? [])
			key += availability.directClosures.has(closure) ? "1" : "0";
		key += ":";
		for (const [target, requirement] of fastTryLookups[functionIndex] ?? []) {
			const abi = availability.fastTryTargets.get(target);
			key += nativeFastTryAbiKey(
				requirement === "all" || abi?.result.kind === requirement ? abi : undefined,
			);
		}
		return key;
	};
	const candidates: NativeCompilationAvailability = {
		directCompiledTargets: new Set(
			references.flatMap(({ targets }) =>
				targets.filter((target) => !image.runtime.functions[target]!.isClassConstructor),
			),
		),
		// Frameless entries need a base proof; recursive calls cannot certify one another.
		fastTryTargets: new Map(),
		directCompiledEntries: new Map(
			image.native.functions.flatMap((native, index) =>
				native.directEntries.map((entry) => [
					directCompiledEntryKey(index, entry.id),
					entry,
				]),
			),
		),
		directClosures: new Map(
			[...closureSites].flatMap(([key, site]) =>
				site.environment === undefined ? [] : [[key, site.environment]],
			),
		),
	};
	const shouldRender = image.native.functions.map(
		(fn, index) =>
			options.useCompiled &&
			fn.body.instructions[0]?.opcode !== "UNREACHABLE_METHOD" &&
			(fn.unreachable !== true || closureParticipation[index] !== undefined),
	);
	return (excludedSymbols) => {
		const onBailout = options.onRendererBailout;
		const bailouts = onBailout === undefined ? undefined : new Set<number>();
		const emit = (
			functionIndex: number,
			availability: NativeCompilationAvailability,
		): CompiledFunction | null => {
			if (!shouldRender[functionIndex]) return null;
			let record = cached[functionIndex];
			if (
				record === undefined ||
				record.key !== availabilityKey(functionIndex, availability)
			) {
				const raw = render(functionIndex, availability);
				// A newly admitted fast path can expose further dependencies.
				cached[functionIndex] = record = {
					key: availabilityKey(functionIndex, availability),
					raw,
					excludedSymbols,
					emitted: fitVariants(raw, excludedSymbols),
				};
			} else if (record.excludedSymbols !== excludedSymbols) {
				record.excludedSymbols = excludedSymbols;
				record.emitted = fitVariants(record.raw, excludedSymbols);
			}
			if (record.raw === null && bailouts?.has(functionIndex) === false) {
				bailouts.add(functionIndex);
				const fn = image.runtime.functions[functionIndex]!;
				onBailout?.({
					file: image.runtime.files[fn.fileIndex] ?? "<unknown>",
					name: String.fromCharCode(
						...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
					),
				});
			}
			return record.emitted;
		};
		let compiled = image.runtime.functions.map((_fn, index) => emit(index, candidates));
		for (
			let iteration = 0;
			iteration <= image.runtime.functions.length + 1;
			iteration++
		) {
			const availability = nativeCompilationAvailability(image, compiled, plan);
			const next = image.runtime.functions.map((_fn, index) =>
				compiled[index] === null ? null : emit(index, availability),
			);
			if (compiledAvailabilityMatches(next, compiled)) {
				const stripped = omitUnreachableCanonicalBodies(next, plan);
				return {
					compiled: stripped,
					availability: nativeCompilationAvailability(image, stripped, plan),
				};
			}
			compiled = next;
		}
		throw new Error("native compiled-entry availability did not stabilize");
	};
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
function externalizeDataArrays(
	parts: ReadonlyArray<ProgramSourcePart>,
	maxCodeUnits: number,
): SplitDataSource {
	const lines: Array<string> = [];
	for (const part of parts) {
		if (typeof part === "string") {
			if (part.includes("\n")) for (const line of part.split("\n")) lines.push(line);
			else lines.push(part);
		} else if (part.length === 0) lines.push("");
		else for (const line of part) lines.push(line);
	}
	const output: Array<string> = [];
	const definitions: Array<ExternalDataDefinition> = [];
	const declarations: Array<GeneratedDeclaration> = [];
	const declare = (symbol: string, source: string) => {
		output.push(source);
		declarations.push({ symbol, source });
	};
	const splitInitializers: Array<string> = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const match = /^(?:static )?(.+?) (mal_[A-Za-z0-9_]+)\[\] = (.*)$/.exec(line);
		if (match === null) {
			if (line.startsWith("extern ")) {
				const declaration = /\b(mal_[A-Za-z0-9_]+)(?=\[\]|\(|;)/.exec(line);
				if (declaration === null)
					throw new Error(`cannot identify generated declaration '${line}'`);
				declare(declaration[1]!, line);
			} else output.push(line);
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
		let definitionCodeUnits = definitionLines.length - 1;
		for (const row of definitionLines) definitionCodeUnits += row.length;
		const numeric = /^(?:const )?(?:u8|c16|i32|u32)$/.test(type);
		if (
			(symbol.startsWith("mal_functions") ||
				symbol.startsWith("mal_source_positions") ||
				symbol.startsWith("mal_strings") ||
				(symbol.startsWith("mal_function_") && symbol.includes("_instructions")) ||
				numeric) &&
			definitionLines.length > 2 &&
			definitionCodeUnits > Math.floor(maxCodeUnits / 2)
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

			declare(symbol, `extern ${mutableType} ${symbol}[];`);
			const rowElements = (row: string) => (numeric ? row.split(",").length - 1 : 1);
			const elementCount = rows.reduce((total, row) => total + rowElements(row), 0);
			output.push(`${mutableType} ${symbol}[${elementCount}];`);
			let rowOffset = 0;
			const initializer = `mal_initialize_${symbol}`;
			splitInitializers.push(initializer);
			for (const [chunkIndex, chunkRows] of chunks.entries()) {
				const chunkSymbol = `${initializer}_chunk_${chunkIndex}`;
				declare(chunkSymbol, `extern void ${chunkSymbol}(${mutableType} *target);`);
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
				rowOffset += chunkRows.reduce((total, row) => total + rowElements(row), 0);
			}
			output.push(`static void ${initializer}(void) {`);
			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				output.push(`    ${initializer}_chunk_${chunkIndex}(${symbol});`);
			}
			output.push("}");
			continue;
		}
		definitions.push({ symbol, source: definitionLines.join("\n") });
		declare(symbol, `extern ${type} ${symbol}[];`);
	}
	if (splitInitializers.length > 0) {
		output.unshift("static void mal_initialize_generated_data(void);");
		output.push("static void mal_initialize_generated_data(void) {");
		output.push(
			"    static _Atomic unsigned char state = 0;",
			"    unsigned char expected = 0;",
			"    if (!atomic_compare_exchange_strong_explicit(&state, &expected, 1, memory_order_acquire, memory_order_acquire)) {",
			"        while (atomic_load_explicit(&state, memory_order_acquire) != 2) {}",
			"        return;",
			"    }",
		);
		for (const initializer of splitInitializers) output.push(`    ${initializer}();`);
		output.push("    atomic_store_explicit(&state, 2, memory_order_release);");
		output.push("}");
	}
	if (splitInitializers.length > 0) {
		const placeholder = "    .initialize_generated_data = nullptr,";
		const index = output.findIndex((line) => line.includes(placeholder));
		if (index >= 0)
			output[index] = output[index]!.replace(
				placeholder,
				"    .initialize_generated_data = mal_initialize_generated_data,",
			);
	}
	return { lines: output, definitions, declarations };
}

function validateImageForEmission(image: ProgramImage): void {
	validateNativeBodyAbis(
		image.runtime.functions,
		image.native.functions.map((fn) => fn.body),
	);
	validateRuntimeImageMetadata(image.runtime);
	validateNativeProgramStorage(image.native, image.runtime.stringConstants);
	const layoutCount = image.native.classLayouts?.length ?? 0;
	for (const fn of image.native.functions) {
		const plans = fn.instructions;
		for (let ip = 0; ip < plans.length; ip++) {
			const plan = plans[ip];
			if (
				plan?.kind === "class-layout" &&
				plan.site.candidates.some(({ layout }) => layout >= layoutCount)
			)
				throw new RangeError("class layout site refers past the image's layout table");
		}
	}
}

function prepareProgramImageNativeEmission(
	image: ProgramImage,
	options: EmitOptions,
	splitCompiledFunctions: boolean,
	maxCodeUnits?: number,
	captureSourceMap = false,
) {
	validateImageForEmission(image);
	return prepareNativeFunctionEmission(image, {
		captureSourceMap,
		useCompiled: options.compiled !== false,
		suffix: options.symbolSuffix ?? "",
		debug: options.debugInfo !== false,
		linkage: splitCompiledFunctions ? "external" : "static",
		maxCodeUnits,
		nativeFunctionSplit: options.nativeFunctionSplit,
		onRendererBailout: options.onRendererBailout,
		// Split units can reuse the same object when a different image index names the body.
		...(splitCompiledFunctions
			? { symbolStems: splitEmissionSymbolStems(image, options.partitionRoot) }
			: {}),
	});
}

function emitProgramImageParts(
	image: ProgramImage,
	options: EmitOptions,
	splitCompiledFunctions: boolean,
	nativeEmission: NativeFunctionEmission,
	captureSourceMap = false,
): EmittedProgramImageParts {
	const sourceMapParts: EmittedProgramImageParts["sourceMapParts"] = [];
	const runtime = image.runtime;
	const suffix = options.symbolSuffix ?? "";
	const debug = options.debugInfo !== false;
	const useCompiled = options.compiled !== false;
	// Compiled functions call mal_vm_binary_op (vm_ops.h) and box unboxed doubles
	// via mal_ops_number_value (value_ops.h); include both alongside vm.h.
	const lines: Array<ProgramSourcePart> =
		options.includeHeader === false ? [] : [...NATIVE_C_HEADER_LINES];

	for (let i = 0; i < runtime.stringConstants.length; ++i) {
		const constant = runtime.stringConstants[i]!;
		lines.push(
			`static const ${stringUnitType(constant)} mal_string_${i}_code_units${suffix}[] = {`,
			numericArrayRows(constant),
			"};",
		);
	}

	if (runtime.stringConstants.length > 0) {
		lines.push(
			"",
			`${splitCompiledFunctions ? "" : "static "}MalString mal_strings${suffix}[] = {`,
		);
		for (let i = 0; i < runtime.stringConstants.length; ++i) {
			const constant = runtime.stringConstants[i]!;
			lines.push(malStringRow(`mal_string_${i}_code_units${suffix}`, constant));
		}
		lines.push("};", "");
	}

	lines.push(
		...emitBigintPool(
			runtime.bigintConstants,
			suffix,
			splitCompiledFunctions ? "" : "static ",
		),
	);

	const compiled = nativeEmission.compiled;
	{
		const { directCompiledTargets } = nativeEmission.availability;
		if (!splitCompiledFunctions && directCompiledTargets.size > 0) {
			for (let index = 0; index < compiled.length; index++) {
				const fn = compiled[index];
				if (fn !== undefined && fn !== null && directCompiledTargets.has(index)) {
					lines.push(`static MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`);
					if (fn.trySymbol !== undefined)
						lines.push(
							`static bool ${fn.trySymbol}(${nativeFastTryParameterList(fn.tryAbi!)});`,
						);
				}
			}
		}
		if (!splitCompiledFunctions) {
			for (const fn of compiled) {
				for (const entry of fn?.directEntries ?? []) {
					lines.push(`static ${directEntryDeclaration(entry)};`);
					if (entry.callbackSymbol !== undefined)
						lines.push(
							`static MalValue ${entry.callbackSymbol}${COMPILED_FUNCTION_DECLARATION};`,
						);
					if (entry.reductionSymbol !== undefined)
						lines.push(`static ${numericReductionDeclaration(entry.reductionSymbol)};`);
					if (entry.sortSymbol !== undefined)
						lines.push(
							`static ${numericSortKernelDeclaration(entry.sortSymbol, entry.sortMayDecline)};`,
						);
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
				if (fn.trySymbol !== undefined)
					lines.push(`bool ${fn.trySymbol}(${nativeFastTryParameterList(fn.tryAbi!)});`);
			}
		}
		for (const fn of compiled) {
			for (const entry of fn?.directEntries ?? []) {
				lines.push(`${directEntryDeclaration(entry)};`);
				if (entry.callbackSymbol !== undefined)
					lines.push(`MalValue ${entry.callbackSymbol}${COMPILED_FUNCTION_DECLARATION};`);
				if (entry.reductionSymbol !== undefined)
					lines.push(`${numericReductionDeclaration(entry.reductionSymbol)};`);
				if (entry.sortSymbol !== undefined)
					lines.push(
						`${numericSortKernelDeclaration(entry.sortSymbol, entry.sortMayDecline)};`,
					);
			}
		}
		if (compiled.some((fn) => fn !== null)) {
			lines.push("#undef MAL_DECLARE_COMPILED", "");
		}
	} else {
		for (const [functionIndex, fn] of compiled.entries()) {
			if (fn === null) continue;
			if (captureSourceMap && fn.source.length > 0)
				sourceMapParts.push({
					part: lines.length,
					functionIndex,
					symbol: fn.symbol,
					ranges: fn.sourceMap ?? [],
				});
			lines.push(fn.source);
			for (const entry of fn.directEntries) {
				lines.push("");
				if (captureSourceMap)
					sourceMapParts.push({
						part: lines.length,
						functionIndex,
						symbol: entry.symbol,
						ranges: entry.sourceMap ?? [],
					});
				lines.push(entry.source);
			}
			lines.push("");
		}
	}

	// A compiled function never re-enters the interpreter — a speculative param
	// guard falls back to a boxed compiled variant, not the bytecode — so its
	// bytecode and handler tables are dead weight. Only uncompiled functions
	// (generators/async) keep their overlay.
	const omitBytecode = compiled.map((c) => c !== null);
	const retainMappedSlots = runtime.functions.map(
		(fn, index) => !omitBytecode[index] || nativeNeedsMappedArgumentSlots(fn),
	);
	const trustedSafepoints = runtime.functions.map(
		(fn, index) =>
			!omitBytecode[index] &&
			!emissionUnreachable(image, index) &&
			vmSafepointRootMapsAreTrusted(fn),
	);
	const instructionDataByFunction = runtime.functions.map((fn, i) =>
		omitBytecode[i]
			? { data: compiledKnownOwnSlotSeedData(fn), offsets: [] }
			: instructionData(fn),
	);

	const positionInfo: Array<{ symbol: string; count: number }> = [];
	const profileSiteSymbols: Array<string> = [];
	const closureCaptureOwnerSymbols: Array<string> = [];
	const closureCaptureLayouts = new Map<string, string>();
	const closureCaptureValueSymbols: Array<string> = [];
	const closureCaptureValueLayouts = new Map<string, string>();
	const closureCaptureSymbols: Array<string> = [];
	const closureCaptureMetadata = new Map<string, string>();

	for (let i = 0; i < runtime.functions.length; ++i) {
		const fn = runtime.functions[i]!;
		if (fn.closureCaptureOwners === undefined) {
			closureCaptureOwnerSymbols.push("nullptr");
		} else {
			const layout = fn.closureCaptureOwners.join(", ");
			let symbol = closureCaptureLayouts.get(layout);
			if (symbol === undefined) {
				symbol = `mal_function_${i}_closure_capture_owners${suffix}`;
				closureCaptureLayouts.set(layout, symbol);
				// Non-null metadata distinguishes a known empty closure from a
				// manually initialized function that still needs its lexical chain.
				lines.push(`static const i32 ${symbol}[] = { ${layout || "0"} };`, "");
			}
			closureCaptureOwnerSymbols.push(symbol);
		}
		if (fn.closureCaptureValues === undefined) {
			closureCaptureValueSymbols.push("nullptr");
		} else {
			const layout = closureCaptureValueArrayBody(fn.closureCaptureValues);
			let symbol = closureCaptureValueLayouts.get(layout);
			if (symbol === undefined) {
				symbol = `mal_function_${i}_closure_capture_values${suffix}`;
				closureCaptureValueLayouts.set(layout, symbol);
				lines.push(
					`static const MalClosureCaptureValue ${symbol}[] = {`,
					layout,
					"};",
					"",
				);
			}
			closureCaptureValueSymbols.push(symbol);
		}
		if (fn.closureCaptureOwners === undefined) {
			closureCaptureSymbols.push("nullptr");
		} else {
			const body = closureCaptureLayoutBody(
				closureCaptureOwnerSymbols[i]!,
				closureCaptureValueSymbols[i]!,
				fn.closureCaptureValues?.length ?? 0,
			);
			let symbol = closureCaptureMetadata.get(body);
			if (symbol === undefined) {
				symbol = `mal_function_${i}_closure_captures${suffix}`;
				closureCaptureMetadata.set(body, symbol);
				lines.push(
					`static const MalClosureCaptureLayout ${symbol}[] = {`,
					body,
					"};",
					"",
				);
			}
			closureCaptureSymbols.push(symbol);
		}
		if (retainMappedSlots[i] && fn.mappedArgumentSlots.length > 0) {
			lines.push(
				`static const i32 mal_function_${i}_mapped_argument_slots${suffix}[] = { ${fn.mappedArgumentSlots.join(", ")} };`,
				"",
			);
		}
		if (!omitBytecode[i]) {
			if (fn.argumentSnapshotPlan.length > 0) {
				lines.push(
					`static const MalArgumentSnapshotMove mal_function_${i}_argument_snapshot_plan${suffix}[] = {`,
				);
				lines.push(argumentSnapshotPlanRows(fn));
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
			lines.push(instructionArrayRows(fn, sideData.offsets));
			lines.push("};", "");

			if (fn.handlers.length > 0) {
				lines.push(
					`static const MalExceptionHandler mal_function_${i}_handlers${suffix}[] = {`,
				);
				lines.push(handlerArrayRows(fn));
				lines.push("};", "");
			}
		}

		const runs = debug ? compressPositions(fn.positions) : [];
		if (runs.length > 0) {
			lines.push(`static const MalLineEntry mal_function_${i}_positions${suffix}[] = {`);
			lines.push(positionArrayRows(runs));
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
				retainMappedSlots[i] && fn.mappedArgumentSlots.length > 0
					? `mal_function_${i}_mapped_argument_slots${suffix}`
					: "nullptr",
				closureCaptureSymbols[i]!,
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
		nativeStackRootsAreConservative(image, useCompiled),
		undefined,
		options,
		image.profiling?.sites.length,
		useCompiled ? image.native.classLayouts : undefined,
		builtinNamesForNativeImage(image),
	)) {
		lines.push(line);
	}

	return { parts: lines, compiled, sourceMapParts };
}

function generatedHeaderFiles(lines: ReadonlyArray<string>): Array<string> {
	return lines.flatMap((line) => {
		const match = /^#include "([^"]+)"$/.exec(line);
		return match === null ? [] : [match[1]!];
	});
}

const MAX_STABLE_PARTITION_HASH_BITS = 64;

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

/**
 * Functions from source files under the partition root outside `node_modules`.
 * Internal modules, toolchain sources and packages change only with the toolchain or
 * a dependency update.
 */
function applicationFunctions(
	image: ProgramImage,
	root: string | undefined,
): Array<boolean> {
	const files = partitionFileNames(image, root);
	return image.runtime.functions.map((fn) => {
		const original = image.runtime.files[fn.fileIndex] ?? "";
		const file = files[fn.fileIndex] ?? "";
		return (
			ABSOLUTE_PATH.test(original) &&
			!ABSOLUTE_PATH.test(file) &&
			!/(?:^|[\\/])node_modules[\\/]/.test(file)
		);
	});
}

/** Prototypes for every compiled body and direct entry a unit may reference. */
function compiledFunctionDeclarations(
	compiled: ReadonlyArray<CompiledFunction | null>,
): Array<GeneratedDeclaration> {
	return [
		...compiled.flatMap((fn): Array<GeneratedDeclaration> =>
			fn === null || fn.source.length === 0
				? []
				: [
						{
							symbol: fn.symbol,
							source: `MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`,
						},
						...(fn.trySymbol === undefined
							? []
							: [
									{
										symbol: fn.trySymbol,
										source: `bool ${fn.trySymbol}(${nativeFastTryParameterList(fn.tryAbi!)});`,
									},
								]),
					],
		),
		...compiled.flatMap((fn) =>
			(fn?.directEntries ?? []).flatMap((entry) => [
				{ symbol: entry.symbol, source: `${directEntryDeclaration(entry)};` },
				...(entry.callbackSymbol === undefined
					? []
					: [
							{
								symbol: entry.callbackSymbol,
								source: `MalValue ${entry.callbackSymbol}${COMPILED_FUNCTION_DECLARATION};`,
							},
						]),
				...(entry.reductionSymbol === undefined
					? []
					: [
							{
								symbol: entry.reductionSymbol,
								source: `${numericReductionDeclaration(entry.reductionSymbol)};`,
							},
						]),
				...(entry.sortSymbol === undefined
					? []
					: [
							{
								symbol: entry.sortSymbol,
								source: `${numericSortKernelDeclaration(entry.sortSymbol, entry.sortMayDecline)};`,
							},
						]),
			]),
		),
	];
}

const pathSegments = (file: string) => file.split(/[\\/]/);

/**
 * Source paths under the partition root relative to it, so a program compiled from
 * another location (a temporary fixture, another checkout) keeps its partition keys.
 * Paths outside it, such as toolchain sources, stay absolute because they do not move
 * with the program. Without an absolute root, paths are relative to the deepest
 * directory holding them all.
 */
function partitionFileNames(
	image: ProgramImage,
	root: string | undefined,
): Array<string> {
	const { files, entrypointPath } = image.runtime;
	const base =
		root !== undefined
			? pathSegments(root).filter((segment, index) => index === 0 || segment !== "")
			: ABSOLUTE_PATH.test(entrypointPath)
				? pathSegments(entrypointPath).slice(0, -1)
				: undefined;
	if (base !== undefined)
		return files.map((file) => {
			if (!ABSOLUTE_PATH.test(file)) return file;
			const segments = pathSegments(file);
			return base.every((segment, index) => segments[index] === segment)
				? segments.slice(base.length).join("/")
				: file;
		});
	const directories = files
		.filter((file) => ABSOLUTE_PATH.test(file))
		.map((file) => pathSegments(file).slice(0, -1));
	if (directories.length === 0) return [...files];
	let depth = directories[0]!.length;
	for (const directory of directories)
		for (let index = 0; index < depth; index++)
			if (directory[index] !== directories[0]![index]) depth = index;
	return files.map((file) =>
		ABSOLUTE_PATH.test(file) ? pathSegments(file).slice(depth).join("/") : file,
	);
}

function compiledFunctionPartitionKeys(
	image: ProgramImage,
	root: string | undefined,
): Array<string> {
	const occurrences = new Map<string, number>();
	const files = partitionFileNames(image, root);
	return image.runtime.functions.map((fn) => {
		const name = image.runtime.stringConstants[fn.nameStringIndex] ?? [];
		const base = JSON.stringify({
			file: files[fn.fileIndex] ?? "<unknown>",
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
/** Code-unit symbols whose definition, header, and own declarations exceed one unit. */
function oversizedCodeDefinitions(
	inputs: {
		readonly compiled: ReadonlyArray<CompiledFunction | null>;
		readonly generatedDeclarations: ReadonlyArray<GeneratedDeclaration>;
		readonly declarationIndicesBySymbol: ReadonlyMap<string, ReadonlyArray<number>>;
	},
	maximumNativeFunctionCodeUnits: number,
): Array<string> {
	const { compiled, generatedDeclarations, declarationIndicesBySymbol } = inputs;
	let headerCodeUnits = NATIVE_C_HEADER_LINES.length;
	for (const line of NATIVE_C_HEADER_LINES) headerCodeUnits += line.length;
	let allDeclarationCodeUnits = generatedDeclarations.length;
	for (const declaration of generatedDeclarations)
		allDeclarationCodeUnits += declaration.source.length;
	const oversized: Array<string> = [];
	const check = (symbol: string, source: string, symbols: ReadonlySet<string>) => {
		if (
			source.length + headerCodeUnits + allDeclarationCodeUnits <
			maximumNativeFunctionCodeUnits
		)
			return;
		let unitCodeUnits = headerCodeUnits + source.length + 1;
		for (const index of generatedDeclarationIndices(symbols, declarationIndicesBySymbol))
			unitCodeUnits += generatedDeclarations[index]!.source.length + 1;
		if (unitCodeUnits > maximumNativeFunctionCodeUnits) oversized.push(symbol);
	};
	for (const fn of compiled) {
		if (fn === null) continue;
		if (fn.source.length > 0) check(fn.symbol, fn.source, fn.declarationSymbols);
		for (const entry of fn.directEntries)
			check(entry.symbol, entry.source, entry.declarationSymbols);
	}
	return oversized;
}

function prepareTranslationUnitInputs(
	image: ProgramImage,
	options: EmitOptions,
	maximumNativeFunctionCodeUnits: number,
) {
	const prepareNative = prepareProgramImageNativeEmission(
		image,
		options,
		true,
		maximumNativeFunctionCodeUnits,
	);
	const emitInputs = (excludedSymbols: ReadonlySet<string>) => {
		const emitted = emitProgramImageParts(
			image,
			{ ...options, includeHeader: false },
			true,
			prepareNative(excludedSymbols),
		);
		const splitData = externalizeDataArrays(
			emitted.parts,
			maximumNativeFunctionCodeUnits,
		);
		const runtimeChunks = separatedSourceChunks([
			...GENERATED_DATA_C_HEADER_LINES,
			...splitData.lines,
		]);

		const generatedDeclarations: Array<GeneratedDeclaration> =
			splitData.declarations.concat(compiledFunctionDeclarations(emitted.compiled));
		const declarationIndicesBySymbol = new Map<string, Array<number>>();
		for (const [index, declaration] of generatedDeclarations.entries()) {
			const indices = declarationIndicesBySymbol.get(declaration.symbol);
			if (indices === undefined)
				declarationIndicesBySymbol.set(declaration.symbol, [index]);
			else indices.push(index);
		}
		return {
			compiled: emitted.compiled,
			dataDefinitions: splitData.definitions,
			runtimeChunks,
			generatedDeclarations,
			declarationIndicesBySymbol,
		};
	};
	// Rendering bounds each definition before its declarations are known; a definition
	// that cannot share a unit with its own declarations stays with the interpreter.
	let excludedSymbols: ReadonlySet<string> = new Set();
	let inputs = emitInputs(excludedSymbols);
	for (
		let oversized = oversizedCodeDefinitions(inputs, maximumNativeFunctionCodeUnits);
		oversized.length > 0;
		oversized = oversizedCodeDefinitions(inputs, maximumNativeFunctionCodeUnits)
	) {
		excludedSymbols = new Set([...excludedSymbols, ...oversized]);
		inputs = emitInputs(excludedSymbols);
	}
	return inputs;
}

export function emitProgramTranslationUnits(
	image: ProgramImage,
	options: EmitOptions = {},
	policy: TranslationUnitPolicy = DEFAULT_TRANSLATION_UNIT_POLICY,
): Array<GeneratedTranslationUnit> {
	const { targetCodeUnits, maximumNativeFunctionCodeUnits } = policy;
	if (
		!Number.isSafeInteger(targetCodeUnits) ||
		targetCodeUnits <= 0 ||
		!Number.isSafeInteger(maximumNativeFunctionCodeUnits) ||
		maximumNativeFunctionCodeUnits <= 0
	) {
		throw new RangeError(
			"translation-unit target and native function budget must be positive integers",
		);
	}
	const inputs = prepareTranslationUnitInputs(
		image,
		options,
		maximumNativeFunctionCodeUnits,
	);
	const {
		compiled,
		dataDefinitions,
		runtimeChunks,
		generatedDeclarations,
		declarationIndicesBySymbol,
	} = inputs;
	const preparePart = (
		part: Omit<TranslationUnitPart, "declarationIndices" | "partitionHashes">,
	): TranslationUnitPart => {
		return {
			...part,
			partitionHashes: [],
			declarationIndices:
				part.declarationSymbols === undefined
					? generatedDeclarationReferences(part.source, declarationIndicesBySymbol)
					: generatedDeclarationIndices(
							part.declarationSymbols,
							declarationIndicesBySymbol,
						),
		};
	};
	const resolveDeclarations = (
		parts: ReadonlyArray<TranslationUnitPart>,
	): TranslationUnitDeclarations => {
		const referenced = new Set<number>();
		for (const part of parts)
			for (const index of part.declarationIndices) referenced.add(index);
		const indices = [...referenced].sort((left, right) => left - right);
		let codeUnits = 0;
		for (const index of indices)
			codeUnits += generatedDeclarations[index]!.source.length + 1;
		return { indices, codeUnits };
	};
	const partCodeUnits = (parts: ReadonlyArray<TranslationUnitPart>) =>
		parts.reduce((total, part) => total + part.source.length + 1, 0);
	const partition = (
		kind: "data" | "code",
		headerLines: ReadonlyArray<string>,
		inputs: Array<Omit<TranslationUnitPart, "declarationIndices" | "partitionHashes">>,
		group = "",
	): Array<GeneratedTranslationUnit> => {
		const units: Array<GeneratedTranslationUnit> = [];
		const headerCodeUnits = headerLines.reduce(
			(total, line) => total + line.length + 1,
			0,
		);
		const visit = (
			parts: ReadonlyArray<TranslationUnitPart>,
			bodyCodeUnits: number,
			prefix: string,
			depth: number,
			declarations?: TranslationUnitDeclarations,
		): void => {
			if (parts.length === 0) return;
			// A group already over budget without declarations needs to split.
			if (parts.length === 1 || headerCodeUnits + bodyCodeUnits <= targetCodeUnits) {
				declarations ??= resolveDeclarations(parts);
				const sourceCodeUnits = headerCodeUnits + bodyCodeUnits + declarations.codeUnits;
				if (sourceCodeUnits <= targetCodeUnits || parts.length === 1) {
					const sourceChunks = separatedSourceChunks([
						...headerLines,
						...declarations.indices.map((index) => generatedDeclarations[index]!.source),
						"",
						...parts.map((part) => part.source),
					]);
					units.push({
						id: `${kind}-${group}${prefix || "root"}`,
						kind,
						sourceChunks,
						sourceCodeUnits,
						headerFiles: generatedHeaderFiles(headerLines),
						definitions: parts.map((part) => ({
							kind: part.kind,
							symbol: part.symbol,
							sourceCodeUnits: part.source.length,
						})),
					});
					return;
				}
			}

			const left: Array<TranslationUnitPart> = [];
			const right: Array<TranslationUnitPart> = [];
			if (depth >= MAX_STABLE_PARTITION_HASH_BITS) {
				const ordered = [...parts].sort((a, b) =>
					a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0,
				);
				const middle = Math.floor(ordered.length / 2);
				const earlier = ordered.slice(0, middle);
				const later = ordered.slice(middle);
				visit(earlier, partCodeUnits(earlier), `${prefix}0`, depth + 1);
				visit(later, partCodeUnits(later), `${prefix}1`, depth + 1);
				return;
			}
			const round = Math.floor(depth / 32);
			const bit = depth % 32;
			let leftCodeUnits = 0;
			for (const part of parts) {
				const hash =
					part.partitionHashes[round] ??
					(part.partitionHashes[round] = stablePartitionHash(
						part.partitionKey,
						round,
						`${part.kind}:`,
						part.kind === "data array" ? part.symbol : undefined,
					));
				if (((hash >>> bit) & 1) === 0) {
					left.push(part);
					leftCodeUnits += part.source.length + 1;
				} else {
					right.push(part);
				}
			}
			if (left.length === 0 || right.length === 0) {
				visit(
					parts,
					bodyCodeUnits,
					`${prefix}${left.length === 0 ? "1" : "0"}`,
					depth + 1,
					declarations,
				);
				return;
			}
			visit(left, leftCodeUnits, `${prefix}0`, depth + 1);
			visit(right, bodyCodeUnits - leftCodeUnits, `${prefix}1`, depth + 1);
		};
		const parts = inputs.map(preparePart);
		visit(parts, partCodeUnits(parts), "", 0);
		return units;
	};
	const dataParts = dataDefinitions.map((data) => ({
		kind: "data array" as const,
		symbol: data.symbol,
		partitionKey: data.source,
		source: data.source,
		declarationSymbols: undefined,
	}));
	const dependencyCode: Array<
		Omit<TranslationUnitPart, "declarationIndices" | "partitionHashes">
	> = [];
	const applicationCode: typeof dependencyCode = [];
	const functionPartitionKeys = compiledFunctionPartitionKeys(
		image,
		options.partitionRoot,
	);
	const application = applicationFunctions(image, options.partitionRoot);
	for (const [functionIndex, fn] of compiled.entries()) {
		if (fn === null) continue;
		const codeParts = application[functionIndex] ? applicationCode : dependencyCode;
		if (fn.source.length > 0)
			codeParts.push({
				kind: "compiled function",
				symbol: fn.symbol,
				partitionKey: `${functionPartitionKeys[functionIndex]}\0canonical`,
				source: fn.source,
				declarationSymbols: fn.declarationSymbols,
			});
		for (const entry of fn.directEntries) {
			codeParts.push({
				kind: "compiled function",
				symbol: entry.symbol,
				partitionKey: `${functionPartitionKeys[functionIndex]}\0direct\0${String(entry.id)}`,
				source: entry.source,
				declarationSymbols: entry.declarationSymbols,
			});
		}
	}
	const linkParts = compiled.flatMap((fn, functionIndex) =>
		fn === null
			? []
			: [...(fn.source.length === 0 ? [] : [fn]), ...fn.directEntries].flatMap((part) =>
					part.link === undefined || part.link.length === 0
						? []
						: [
								{
									kind: "data array" as const,
									symbol: `${part.symbol}_link`,
									partitionKey: functionPartitionKeys[functionIndex]!,
									declarationSymbols: undefined,
									source: `const i32 ${part.symbol}_link[] = { ${part.link.map((slot) => slot.index).join(", ")} };`,
								},
							],
				),
	);
	return [
		{
			id: "runtime-image",
			kind: "runtime-image",
			sourceChunks: runtimeChunks,
			sourceCodeUnits: runtimeChunks.reduce((total, chunk) => total + chunk.length, 0),
			headerFiles: generatedHeaderFiles(GENERATED_DATA_C_HEADER_LINES),
			definitions: [],
		},
		...partition("data", GENERATED_DATA_C_HEADER_LINES, dataParts),
		...partition("data", ['#include "defaults.h"'], linkParts, "links-"),
		...partition("code", NATIVE_C_HEADER_LINES, dependencyCode),
		// Separate units keep an application edit from recompiling dependency code.
		...partition("code", NATIVE_C_HEADER_LINES, applicationCode, "app-"),
		...assetDataTranslationUnits(options.assets ?? [], options.symbolSuffix ?? ""),
	];
}

/** Each function's symbol stem in split emission: `mal_compiled_<stem>` names its body. */
export function splitEmissionSymbolStems(
	image: ProgramImage,
	partitionRoot?: string,
): Array<string> {
	return nativeOverlaySymbolStems(compiledFunctionPartitionKeys(image, partitionRoot));
}

/** Symbol stems that survive unrelated image edits; the partition key is the identity. */
function nativeOverlaySymbolStems(partitionKeys: ReadonlyArray<string>): Array<string> {
	const owners = new Map<string, string>();
	return partitionKeys.map((key) => {
		const stem = [0, 1]
			.map((round) =>
				stablePartitionHash(key, round, "symbol:").toString(16).padStart(8, "0"),
			)
			.join("");
		const owner = owners.get(stem);
		if (owner !== undefined)
			throw new Error(
				`native overlay symbol stem ${stem} is shared by ${JSON.stringify(owner)} and ${JSON.stringify(key)}`,
			);
		owners.set(stem, key);
		return stem;
	});
}

/**
 * Emit only relocation-aware native entries for a runtime image loaded from wire.
 *
 * A code unit's text depends only on its functions, so its object survives image
 * edits elsewhere. Every image index lives in link arrays in separate data units.
 */
/**
 * Where an overlay keeps the bases of the image it attaches to. The eval compiler
 * splices whenever a VM first evaluates code, so each VM holds its own; a program
 * fragment is spliced at startup in a fixed order, so one process-wide cell serves
 * every VM and later attaches verify it.
 */
export type NativeOverlayTarget =
	| { readonly kind: "eval-compiler" }
	| { readonly kind: "fragment"; readonly name: string };

const EVAL_COMPILER_OVERLAY: NativeOverlayTarget = { kind: "eval-compiler" };

/** Imported global slots in the order their overlay's attach resolves them. */
function nativeImportedGlobals(runtime: RuntimeImage): ReadonlyMap<number, number> {
	const imports = (runtime.moduleLinks?.imports ?? []).filter(
		(link) => link.kind !== "cjs",
	);
	return new Map(imports.map((link, ordinal) => [link.slot, ordinal]));
}

export function emitRelocatableNativeOverlayTranslationUnits(
	image: ProgramImage,
	wireDigest: string,
	maxCodeUnits = MAXIMUM_NATIVE_FUNCTION_CODE_UNITS,
	targetCodeUnits = maxCodeUnits,
	target: NativeOverlayTarget = EVAL_COMPILER_OVERLAY,
): Array<GeneratedTranslationUnit> {
	if (target.kind === "fragment" && !/^[a-z][a-z0-9_]*$/.test(target.name)) {
		throw new Error(
			`native overlay fragment name must be a C identifier: ${target.name}`,
		);
	}
	if (!/^[0-9a-f]{64}$/.test(wireDigest)) {
		throw new Error(
			`native overlay wire digest must be lowercase SHA-256: ${wireDigest}`,
		);
	}
	if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits <= 0) {
		throw new RangeError("translation-unit code-unit budget must be a positive integer");
	}
	if (!Number.isSafeInteger(targetCodeUnits) || targetCodeUnits <= 0) {
		throw new RangeError("translation-unit code-unit target must be a positive integer");
	}
	validateImageForEmission(image);
	if (
		image.native.functions.some(
			(fn) => (fn.storage?.captures.copiedClosureIps.length ?? 0) > 0,
		)
	)
		throw new Error("Native overlays require portable capture storage");
	const name = target.kind === "fragment" ? `fragment_${target.name}` : "eval_compiler";
	const suffix = `_${name}`;
	const unitPrefix = target.kind === "fragment" ? `${name}-` : "";
	const relocationCell = `mal_${name}_native_relocation`;
	// Every code unit reads the cell, so its declaration is part of each unit's header.
	const relocationDeclaration =
		target.kind === "fragment"
			? [`extern MalNativeProgramRelocation ${relocationCell};`]
			: [];
	const functionPartitionKeys = compiledFunctionPartitionKeys(image, undefined);
	const { compiled } = prepareNativeFunctionEmission(image, {
		useCompiled: true,
		suffix,
		debug: true,
		linkage: "external",
		maxCodeUnits,
		symbolStems: nativeOverlaySymbolStems(functionPartitionKeys),
		relocation:
			target.kind === "fragment"
				? `&${relocationCell}`
				: "&vm->compiler_native_relocation",
	})();
	const installed = compiled.map((fn) =>
		fn === null || fn.source.length === 0 ? undefined : fn.symbol,
	);
	const importCount = nativeImportedGlobals(image.runtime).size;
	if (importCount > 0 && target.kind !== "fragment")
		throw new Error("only a program fragment's overlay can import globals");
	const declarations = installed.flatMap((symbol) =>
		symbol === undefined ? [] : [`MAL_DECLARE_COMPILED(${symbol});`],
	);
	const tableChunks = separatedSourceChunks([
		...NATIVE_C_HEADER_LINES,
		'#include "compiler_native.h"',
		`#define MAL_DECLARE_COMPILED(name) MalValue name${COMPILED_FUNCTION_DECLARATION}`,
		...declarations,
		"",
		`static const MalCompiledFunction mal_${name}_native_entries[] = {`,
		...installed.map((symbol) => `    ${symbol ?? "nullptr"},`),
		"};",
		"",
		...(target.kind === "fragment"
			? [
					`MalNativeProgramRelocation ${relocationCell};`,
					`static bool ${relocationCell}_attached;`,
					...(importCount === 0
						? []
						: [`static i32 ${relocationCell}_global_imports[${importCount}];`]),
					"",
				]
			: []),
		`const MalNativeOverlay mal_${name}_native_overlay = {`,
		`    .wire_digest = "${wireDigest}",`,
		`    .function_count = ${compiled.length},`,
		`    .entries = mal_${name}_native_entries,`,
		`    .conservative_stack_roots = ${nativeStackRootsAreConservative(image, true)},`,
		...(target.kind === "fragment"
			? [
					`    .relocation = &${relocationCell},`,
					`    .relocation_attached = &${relocationCell}_attached,`,
					...(importCount === 0
						? []
						: [
								`    .global_imports = ${relocationCell}_global_imports,`,
								`    .global_import_count = ${importCount},`,
							]),
				]
			: []),
		"};",
	]);

	const header = [...NATIVE_C_HEADER_LINES, ...relocationDeclaration].join("\n");
	const headerFiles = generatedHeaderFiles([
		...NATIVE_C_HEADER_LINES,
		'#include "compiler_native.h"',
	]);
	const units: Array<GeneratedTranslationUnit> = [
		{
			id: `${unitPrefix}native-overlay-table`,
			kind: "code",
			sourceChunks: tableChunks,
			sourceCodeUnits: tableChunks.reduce((total, chunk) => total + chunk.length, 0),
			headerFiles,
			definitions: [],
		},
	];
	const linkHeaderLines = ['#include "defaults.h"'];
	const linkHeader = linkHeaderLines.join("\n");
	let links: Array<string> = [];
	let linkCodeUnits = linkHeader.length;
	const flushLinks = () => {
		if (links.length === 0) return;
		units.push({
			id: `${unitPrefix}native-overlay-links-${String(units.length)}`,
			kind: "data",
			sourceChunks: separatedSourceChunks([linkHeader, ...links]),
			sourceCodeUnits: linkCodeUnits,
			headerFiles: generatedHeaderFiles(linkHeaderLines),
			definitions: [],
		});
		links = [];
		linkCodeUnits = linkHeader.length;
	};
	const linked = compiled.flatMap((fn) =>
		fn === null ? [] : [...(fn.source.length === 0 ? [] : [fn]), ...fn.directEntries],
	);
	for (const fn of linked) {
		if (fn.link === undefined || fn.link.length === 0) continue;
		const definition = `const i32 ${fn.symbol}_link[] = { ${fn.link.map((slot) => slot.index).join(", ")} };`;
		if (linkCodeUnits + 1 + definition.length > targetCodeUnits) flushLinks();
		links.push(definition);
		linkCodeUnits += 1 + definition.length;
	}
	flushLinks();
	type NativeOverlayFunction = {
		fn: CompiledFunction;
		sourceChunks: ReadonlyArray<string>;
		sourceCodeUnits: number;
		partitionKey: string;
		partitionHashes: Array<number | undefined>;
	};
	// Direct calls cross units, so each unit declares the overlay symbols its bodies name.
	const overlayDeclarations = compiledFunctionDeclarations(compiled);
	const overlayDeclarationIndices = new Map<string, Array<number>>();
	for (const [index, declaration] of overlayDeclarations.entries())
		overlayDeclarationIndices.set(declaration.symbol, [
			...(overlayDeclarationIndices.get(declaration.symbol) ?? []),
			index,
		]);
	const bodies: Array<NativeOverlayFunction> = compiled.flatMap((fn, index) => {
		if (fn === null) return [];
		const parts = [fn.source, ...fn.directEntries.map((entry) => entry.source)].filter(
			(part) => part.length > 0,
		);
		return [
			{
				fn,
				sourceChunks: separatedSourceChunks(parts),
				sourceCodeUnits:
					parts.reduce((total, part) => total + part.length, 0) +
					Math.max(0, parts.length - 1),
				partitionKey: functionPartitionKeys[index]!,
				partitionHashes: [],
			},
		];
	});
	const visit = (
		functions: Array<NativeOverlayFunction>,
		prefix: string,
		depth: number,
	): void => {
		if (functions.length === 0) return;
		const sourceCodeUnits = functions.reduce(
			(total, fn) => total + 1 + fn.sourceCodeUnits,
			header.length,
		);
		if (sourceCodeUnits <= targetCodeUnits || functions.length === 1) {
			const referenced = generatedDeclarationIndices(
				functions.flatMap(({ fn }) => [
					...fn.declarationSymbols,
					...fn.directEntries.flatMap((entry) => [...entry.declarationSymbols]),
				]),
				overlayDeclarationIndices,
			).sort((left, right) => left - right);
			const sourceChunks = separatedSourceChunks([
				header,
				...referenced.map((index) => overlayDeclarations[index]!.source),
			]);
			for (const fn of functions) sourceChunks.push("\n", ...fn.sourceChunks);
			const completeCodeUnits = sourceChunks.reduce(
				(total, chunk) => total + chunk.length,
				0,
			);
			units.push({
				id: `${unitPrefix}native-overlay-code-${prefix || "root"}`,
				kind: "code",
				sourceChunks,
				sourceCodeUnits: completeCodeUnits,
				headerFiles,
				definitions: functions.flatMap(({ fn }) =>
					[...(fn.source.length === 0 ? [] : [fn]), ...fn.directEntries].map((part) => ({
						kind: "compiled function" as const,
						symbol: part.symbol,
						sourceCodeUnits: part.source.length,
					})),
				),
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
			const hash =
				fn.partitionHashes[round] ??
				(fn.partitionHashes[round] = stablePartitionHash(fn.partitionKey, round));
			(((hash >>> bit) & 1) === 0 ? left : right).push(fn);
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

type AssetEncoding = "data" | "brotli" | "gzip";

function assetFileSymbol(
	assetIndex: number,
	fileIndex: number,
	suffix: string,
	encoding: AssetEncoding = "data",
): string {
	return `mal_asset_${assetIndex}_file_${fileIndex}_${encoding}${suffix}`;
}

/** The bytes a file row embeds: its contents and any compressed copies. */
function assetFileBytes(
	file: IncludedAsset["files"][number],
): Array<{ encoding: AssetEncoding; sourcePath: string; size: number; digest: string }> {
	return [
		...(file.embeddedSymbol === undefined && file.size > 0
			? [{ encoding: "data" as const, ...file }]
			: []),
		...(file.brotli === undefined
			? []
			: [{ encoding: "brotli" as const, ...file.brotli }]),
		...(file.gzip === undefined ? [] : [{ encoding: "gzip" as const, ...file.gzip }]),
	];
}

/**
 * Defines `mal_assets<suffix>`, the table a runtime image's `assets` field points at.
 * It only declares the file bytes, which `assetDataTranslationUnits` defines.
 */
export function assetTableLines(
	assets: ReadonlyArray<IncludedAsset>,
	suffix: string,
): Array<string> {
	const lines: Array<string> = [];
	const declared = new Set<string>();
	for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
		const asset = assets[assetIndex]!;
		for (let fileIndex = 0; fileIndex < asset.files.length; fileIndex++) {
			const file = asset.files[fileIndex]!;
			const symbol =
				file.embeddedSymbol ?? assetFileSymbol(assetIndex, fileIndex, suffix);
			if (file.embeddedSymbol === undefined && file.size === 0)
				lines.push(`static const u8 ${symbol}[] = { 0 };`);
			else if (!declared.has(symbol)) {
				declared.add(symbol);
				lines.push(`extern const u8 ${symbol}[];`);
			}
			for (const encoding of ["brotli", "gzip"] as const)
				if (file[encoding] !== undefined)
					lines.push(
						`extern const u8 ${assetFileSymbol(assetIndex, fileIndex, suffix, encoding)}[];`,
					);
		}
	}
	if (lines.length > 0) lines.push("");

	for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
		const asset = assets[assetIndex]!;
		lines.push(`static const MalAssetFile mal_asset_${assetIndex}_files${suffix}[] = {`);
		for (let fileIndex = 0; fileIndex < asset.files.length; fileIndex++) {
			const file = asset.files[fileIndex]!;
			const symbol =
				file.embeddedSymbol ?? assetFileSymbol(assetIndex, fileIndex, suffix);
			const variant = (encoding: "brotli" | "gzip") =>
				file[encoding] === undefined
					? `.${encoding} = nullptr, .${encoding}_length = 0`
					: `.${encoding} = ${assetFileSymbol(assetIndex, fileIndex, suffix, encoding)}, .${encoding}_length = ${file[encoding].size}`;
			lines.push(
				`    { .path = "${cEscapeString(file.path)}", .data = ${symbol}, .length = ${file.size}, .digest = "${file.digest}", ${variant("brotli")}, ${variant("gzip")} },`,
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
	return lines;
}

/**
 * Units defining the asset bytes `assetTableLines` declares, one per asset. Each is
 * keyed by its text and its files' digests, so with the CLI's content-addressed
 * snapshots an asset's object is reused until its bytes change.
 */
export function assetDataTranslationUnits(
	assets: ReadonlyArray<IncludedAsset>,
	suffix: string,
): Array<GeneratedTranslationUnit> {
	return assets.flatMap((asset, assetIndex) => {
		const files = asset.files.flatMap((file, fileIndex) =>
			assetFileBytes(file).map((bytes) => ({
				...bytes,
				symbol: assetFileSymbol(assetIndex, fileIndex, suffix, bytes.encoding),
			})),
		);
		if (files.length === 0) return [];
		const source = files
			.flatMap(({ sourcePath, size, symbol }) => [
				`const unsigned char ${symbol}[] = {`,
				`#embed "${cEscapeString(sourcePath)}"`,
				"};",
				`static_assert(sizeof ${symbol} == ${size}, "asset file changed after it was recorded");`,
			])
			.join("\n");
		return [
			{
				id: `asset-${assetIndex}`,
				kind: "data" as const,
				sourceChunks: [source],
				sourceCodeUnits: source.length,
				headerFiles: [],
				definitions: [],
				embeddedFileDigests: files.map(({ digest }) => digest),
			},
		];
	});
}

function inlineAssetData(options: EmitOptions): Array<string> {
	return assetDataTranslationUnits(
		options.assets ?? [],
		options.symbolSuffix ?? "",
	).flatMap((unit) => unit.sourceChunks);
}

function nativeStackRootsAreConservative(
	image: ProgramImage,
	useCompiled: boolean,
): boolean {
	return (
		useCompiled &&
		image.native.functions.some((fn) => fn.storage?.stackRoots === "conservative")
	);
}

function malRuntimeImageStruct(
	runtime: RuntimeImage,
	suffix: string,
	debug: boolean,
	conservativeStackRoots: boolean,
	sharedLiteralTemplates?: string,
	options: Pick<EmitOptions, "assets" | "toolchainBridge" | "sourcePath"> = {},
	profileSiteCount?: number,
	classLayouts: ReadonlyArray<CoreTargetClassLayout> = [],
	builtinMemberNames?: ReadonlyArray<string>,
): Array<string> {
	const lines: Array<string> = [];
	const assets = options.assets ?? [];
	for (const [index, layout] of classLayouts.entries()) {
		lines.push(
			`static const i32 mal_class_layout_${index}_keys${suffix}[] = { ${layout.keys.length === 0 ? "0" : layout.keys.join(", ")} };`,
			`static const i32 mal_class_layout_${index}_methods${suffix}[] = { ${layout.methods.length === 0 ? "0" : layout.methods.join(", ")} };`,
		);
	}
	if (classLayouts.length > 0) {
		lines.push(`static const MalClassLayoutDesc mal_class_layouts${suffix}[] = {`);
		for (const [index, layout] of classLayouts.entries())
			lines.push(
				`    { .key_count = ${layout.keys.length}, .method_count = ${layout.methods.length / 2}, .keys = mal_class_layout_${index}_keys${suffix}, .methods = mal_class_layout_${index}_methods${suffix} },`,
			);
		lines.push("};", "");
	}
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

	const hasSourceProviders = runtime.sourceBuiltinProviders.length > 0;
	if (hasSourceProviders) {
		for (const [index, provider] of runtime.sourceBuiltinProviders.entries()) {
			if (provider.state.length > 0) {
				lines.push(
					`static const MalHostInstallSlot mal_source_builtin_state${suffix}_${index}[] = {`,
				);
				for (const entry of provider.state)
					lines.push(
						`    { .name = "${cEscapeString(entry.name)}", .slot = ${entry.slot} },`,
					);
				lines.push("};", "");
			}
			if (provider.imports.length === 0) continue;
			lines.push(
				`static const MalSourceBuiltinImport mal_source_builtin_imports${suffix}_${index}[] = {`,
			);
			for (const entry of provider.imports)
				lines.push(
					`    { .module_id = "${cEscapeString(entry.module)}", .name = "${cEscapeString(entry.name)}", .slot = ${entry.slot} },`,
				);
			lines.push("};", "");
		}
		lines.push(
			`static const MalSourceBuiltinProvider mal_source_builtin_providers${suffix}[] = {`,
		);
		for (const [index, provider] of runtime.sourceBuiltinProviders.entries())
			lines.push(
				`    { .id = "${cEscapeString(provider.id)}", .function_index = ${provider.functionIndex}, .state_count = ${provider.state.length}, .state = ${provider.state.length === 0 ? "nullptr" : `mal_source_builtin_state${suffix}_${index}`}, .import_count = ${provider.imports.length}, .imports = ${provider.imports.length === 0 ? "nullptr" : `mal_source_builtin_imports${suffix}_${index}`} },`,
			);
		lines.push("};", "");
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

	lines.push(...assetTableLines(assets, suffix));

	// Host-install manifest: direct references to the native installers of the
	// host built-ins (and `process`) the program actually reached. Only reachable
	// ones are emitted, so an ordinary program references no host symbol and the
	// extern decls / arrays below are absent — nothing to resolve at link.
	const hostInstalls = [...runtime.hostInstalls];
	if (
		options.toolchainBridge === true &&
		!hostInstalls.some((install) => install.installer === "mal_host_install_maligator")
	) {
		hostInstalls.push({ installer: "mal_host_install_maligator", exports: [] });
	}
	const hasHostInstalls = hostInstalls.length > 0;
	const members = builtinMemberLists(
		hostInstalls,
		runtime.enginePolicy,
		builtinMemberNames,
		suffix,
	);
	lines.push(...members);
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
			for (const { name, slot, constant, data } of install.exports) {
				// A built executable keeps where its assets came from, not the commands
				// that produced them.
				const payload =
					constant ??
					(install.installer === EMBED_INSTALLER && data !== undefined
						? (embeddedAsset(data as unknown as EmbeddedAsset) as unknown as PlatformData)
						: data);
				lines.push(
					`    { .name = "${cEscapeString(name)}", .slot = ${slot}, .data = ${payload === undefined ? "nullptr" : `"${cEscapeString(JSON.stringify(payload))}"`} },`,
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
		`    .engine_policy = ${enginePolicyBits(runtime)},`,
		`    .conservative_stack_roots = ${conservativeStackRoots},`,
		"    .initialize_generated_data = nullptr,",
		`    .string_constant_count = ${runtime.stringConstants.length},`,
		`    .string_constants = ${runtime.stringConstants.length > 0 ? `mal_strings${suffix}` : "nullptr"},`,
		`    .bigint_constant_count = ${runtime.bigintConstants.length},`,
		`    .bigint_constants = ${runtime.bigintConstants.length > 0 ? `mal_bigints${suffix}` : "nullptr"},`,
		`    .literal_template_data_count = ${runtime.literalTemplateData.length},`,
		`    .literal_template_data = ${literalTemplatesSymbol},`,
		`    .precompiled_literal_shape_count = ${precompiledShapeRows.length},`,
		`    .precompiled_literal_shapes = ${precompiledShapeRows.length > 0 ? `mal_precompiled_literal_shapes${suffix}` : "nullptr"},`,
		`    .class_layout_count = ${classLayouts.length},`,
		`    .class_layouts = ${classLayouts.length > 0 ? `mal_class_layouts${suffix}` : "nullptr"},`,
		`    .global_count = ${runtime.globalCount},`,
		`    .entry_path = "${cEscapeString(runtime.entrypointPath)}",`,
		`    .source_builtin_provider_count = ${runtime.sourceBuiltinProviders.length},`,
		`    .source_builtin_providers = ${hasSourceProviders ? `mal_source_builtin_providers${suffix}` : "nullptr"},`,
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
		`    .builtin_member_lists = mal_builtin_member_lists${suffix},`,
		"};",
	);

	return lines;
}

const MEMBER_SELECTION_HOSTS = new Set([
	...INTRINSIC_INSTALLERS,
	BUFFER_INSTALLER_SYMBOL,
	NODE_CONSOLE_HOOKS_INSTALLER,
	NODE_ERROR_HOOKS_INSTALLER,
	PROCESS_ENV_INSTALLER,
	REGEXP_INSTALLER,
	UNICODE_NORMALIZATION_INSTALLER,
	WEB_FETCH_INSTALLER,
	"mal_host_install_web_personality",
	"mal_host_install_web_basics",
	"mal_host_install_web_encoding",
	"mal_host_install_web_events",
	"mal_host_install_web_fetch_client",
	"mal_host_install_web_streams",
	"mal_host_install_web_url",
	"mal_host_install_maligator_assets",
	"mal_host_install_maligator_internal_fetch",
	"mal_host_install_maligator_internal_http",
]);
const FETCH_MEMBER_PROVIDERS = new Set([
	WEB_FETCH_INSTALLER,
	"mal_host_install_web_fetch_client",
	"mal_host_install_maligator_internal_fetch",
	"mal_host_install_maligator_internal_http",
	HTTP_WITHOUT_WEBSOCKET_INSTALLER,
	NODE_FS_READ_STREAM_INSTALLER,
	NODE_BUILTIN_LOADER_INSTALLER,
	...[
		"node:buffer",
		"node:child_process",
		"node:cluster",
		"node:crypto",
		"node:fs",
		"node:http",
		"node:https",
		"node:net",
		"node:stream",
		"node:stream/consumers",
		"node:stream/promises",
		"node:tls",
		"node:zlib",
	].map(hostInstallerSymbol),
]);
const NATIVE_BUILTIN_MEMBER_KEYS = [
	"add",
	"constructor",
	"entries",
	"exec",
	"has",
	"join",
	"keys",
	"next",
	"resolve",
	"return",
	"set",
	"then",
	"toJSON",
	"toString",
	"valueOf",
	"values",
];

function builtinNamesForNativeImage(image: ProgramImage): Array<string> | undefined {
	if (image.native.builtinMemberNames === undefined) return undefined;
	const names = new Set(image.native.builtinMemberNames);
	const retainPath = (path: string) => {
		for (const key of path.match(/[A-Za-z_$][A-Za-z_$0-9]*/g) ?? []) names.add(key);
	};
	for (const fn of [
		...image.runtime.functions,
		...image.native.functions.map(({ body }) => body),
	]) {
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "CALL_KNOWN") retainPath(instruction.operation);
			else if (instruction.opcode === "LOAD_PRIMORDIAL") {
				const node = getPrimordialCatalog().nodes[instruction.nodeIndex]!;
				retainPath(node[0]);
				for (const alias of node[5]) retainPath(alias);
			}
		}
	}
	return [...names];
}

function builtinMemberLists(
	hostInstalls: RuntimeImage["hostInstalls"],
	policy: RuntimeImage["enginePolicy"],
	names: ReadonlyArray<string> | undefined,
	suffix: string,
): Array<string> {
	const kept =
		names === undefined ||
		hostInstalls.some(({ installer }) => !MEMBER_SELECTION_HOSTS.has(installer))
			? undefined
			: new Set([
					...names,
					...NATIVE_BUILTIN_MEMBER_KEYS,
					...NATIVE_BUILTIN_MEMBER_NAMES,
				]);
	const installers = new Set(hostInstalls.map(({ installer }) => installer));
	const fetch = hostInstalls.some(({ installer }) =>
		FETCH_MEMBER_PROVIDERS.has(installer),
	);
	const families = new Set(["base"]);
	if (policy?.regexp !== false) families.add("regexp");
	if (installers.has(JSON_INSTALLER)) families.add("json");
	if (installers.has(MAP_INSTALLER)) families.add("map");
	if (installers.has(SET_INSTALLER)) families.add("set");
	if (installers.has("mal_host_install_intrinsic_math")) families.add("math");
	if (fetch) families.add("fetch");
	if (
		fetch ||
		installers.has("mal_host_install_web_streams") ||
		installers.has("mal_host_install_web_compression") ||
		installers.has("mal_host_install_maligator_internal_fs_stream")
	)
		families.add("streams");
	if (
		fetch ||
		installers.has("mal_host_install_web_url") ||
		installers.has(hostInstallerSymbol("node:url"))
	)
		families.add("url");
	const lists: Array<string> = [];
	const lines: Array<string> = [];
	for (const group of BUILTIN_MEMBER_GROUPS) {
		if (!families.has(group.family)) continue;
		const members =
			kept === undefined
				? group.members
				: group.members.filter(([, key, enumerable]) => enumerable || kept.has(key));
		if (members.length === 0) continue;
		if (members.length === group.members.length) {
			lists.push(
				`    [MAL_BUILTIN_MEMBER_${group.name}] = &mal_builtin_member_list_${group.name},`,
			);
			continue;
		}
		const groupSymbol = `mal_selected_members_${group.name}${suffix}`;
		for (const [symbol] of members)
			lines.push(`extern const MalBuiltinMember mal_builtin_member_${symbol};`);
		lines.push(
			`static const MalBuiltinMember *const ${groupSymbol}[] = {`,
			...members.map(([symbol]) => `    &mal_builtin_member_${symbol},`),
			"};",
		);
		lines.push(
			`static const MalBuiltinMemberList ${groupSymbol}_list = { ${groupSymbol}, ${members.length} };`,
		);
		lists.push(`    [MAL_BUILTIN_MEMBER_${group.name}] = &${groupSymbol}_list,`);
	}
	lines.push(
		`static const MalBuiltinMemberList *const mal_builtin_member_lists${suffix}[MAL_BUILTIN_MEMBER_GROUP_COUNT] = {`,
		...lists,
		"};",
		"",
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
	return emitBatchUnits(images, options, 0).body;
}

/**
 * Emit a batch whose first image starts with `sharedFunctionCount` functions that
 * every batch of a run carries identically. Their compiled bodies move to `shared`,
 * whose text depends only on those functions, so one object can serve every batch
 * that emits the same text. Both units use external linkage for compiled symbols.
 */
export function emitBatchWithSharedPrefix(
	images: Array<ProgramImage>,
	options: Pick<EmitOptions, "compiled">,
	sharedFunctionCount: number,
): { body: string; shared: string } {
	if (!Number.isSafeInteger(sharedFunctionCount) || sharedFunctionCount < 1)
		throw new RangeError("a shared batch prefix needs at least one function");
	return emitBatchUnits(images, options, sharedFunctionCount);
}

function emitBatchUnits(
	images: Array<ProgramImage>,
	options: Pick<EmitOptions, "compiled">,
	sharedFunctionCount: number,
): { body: string; shared: string } {
	const useCompiled = options.compiled !== false;
	const lines: Array<string> = [];
	const sharedLines: Array<string> = [];

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
		validateImageForEmission(image);
		const suffix = `_${d}`;
		const literalTemplatesSymbol =
			runtime.literalTemplateData.length > 0
				? intern("literals", "u32", `    ${runtime.literalTemplateData.join(", ")}`)
				: undefined;

		const stringSymbols = runtime.stringConstants.map((constant) =>
			intern(
				stringConstantIsLatin1(constant) ? "l1" : "cu",
				stringUnitType(constant),
				`    ${constant.length > 0 ? constant.join(", ") : "0"}`,
			),
		);
		if (stringSymbols.length > 0) {
			// MalString rows are mutable (hashes are cached lazily), so each runtime
			// keeps its own table; only the code-unit arrays are shared.
			lines.push(`static MalString mal_strings${suffix}[] = {`);
			for (let i = 0; i < stringSymbols.length; ++i) {
				lines.push(malStringRow(stringSymbols[i]!, runtime.stringConstants[i]!));
			}
			lines.push("};", "");
		}

		const sharedPrefix = d === 0 ? sharedFunctionCount : 0;
		const storage = sharedPrefix > 0 ? "" : "static ";
		lines.push(...emitBigintPool(runtime.bigintConstants, suffix, storage));

		// The batch path strips debug info, so compiled bodies emit no pos writes.
		// It uses the same fixed-point entry selection as product emit-C; otherwise
		// the test262 backend would carry typed bodies that no call could reach.
		const nativeEmission = prepareNativeFunctionEmission(image, {
			useCompiled,
			suffix,
			debug: false,
			linkage: sharedPrefix > 0 ? "external" : "static",
		})();
		const { compiled } = nativeEmission;
		const declarations = (fn: CompiledFunction, canonical: boolean): Array<string> => [
			...(canonical && fn.source.length > 0
				? [`${storage}MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`]
				: []),
			...(canonical && fn.trySymbol !== undefined
				? [`${storage}bool ${fn.trySymbol}(${nativeFastTryParameterList(fn.tryAbi!)});`]
				: []),
			...fn.directEntries.flatMap((entry) => [
				`${storage}${directEntryDeclaration(entry)};`,
				...(entry.callbackSymbol === undefined
					? []
					: [
							`${storage}MalValue ${entry.callbackSymbol}${COMPILED_FUNCTION_DECLARATION};`,
						]),
				...(entry.reductionSymbol === undefined
					? []
					: [`${storage}${numericReductionDeclaration(entry.reductionSymbol)};`]),
				...(entry.sortSymbol === undefined
					? []
					: [
							`${storage}${numericSortKernelDeclaration(entry.sortSymbol, entry.sortMayDecline)};`,
						]),
			]),
		];
		const directTargets = nativeEmission.availability.directCompiledTargets;
		const declared = compiled.flatMap((fn, index) =>
			fn === null
				? []
				: declarations(fn, directTargets.has(index) || index < sharedPrefix),
		);
		lines.push(...declared);
		if (declared.length > 0) lines.push("");
		if (sharedPrefix > 0) {
			const shared = compiled.slice(0, sharedPrefix);
			const sharedDeclarations = shared.flatMap((fn, index) =>
				fn === null ? [] : declarations(fn, directTargets.has(index)),
			);
			const sharedBodies = shared.flatMap((fn) =>
				fn === null
					? []
					: [fn.source, ...fn.directEntries.flatMap((entry) => ["", entry.source]), ""],
			);
			if (sharedBodies.some((source) => source.includes(`mal_bigints${suffix}[`)))
				sharedLines.push(`extern MalBigInt mal_bigints${suffix}[];`);
			sharedLines.push(...sharedDeclarations, "", ...sharedBodies);
		}
		for (const fn of compiled.slice(sharedPrefix)) {
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
			(fn, index) =>
				!omitBytecode[index] &&
				!emissionUnreachable(image, index) &&
				vmSafepointRootMapsAreTrusted(fn),
		);

		const instructionSymbols: Array<string> = [];
		const instructionDataSymbols: Array<string> = [];
		const instructionDataCounts: Array<number> = [];
		const gcSafepointSymbols: Array<string> = [];
		const gcSafepointCounts: Array<number> = [];
		const argumentSnapshotPlanSymbols: Array<string> = [];
		const argumentSnapshotPlanCounts: Array<number> = [];
		const mappedArgumentSlotsSymbols: Array<string> = [];
		const closureCaptureOwnersSymbols: Array<string> = [];
		const closureCaptureValuesSymbols: Array<string> = [];
		const closureCaptureSymbols: Array<string> = [];
		const handlerSymbols: Array<string> = [];
		for (let i = 0; i < runtime.functions.length; ++i) {
			const fn = runtime.functions[i]!;
			closureCaptureOwnersSymbols.push(
				fn.closureCaptureOwners !== undefined
					? intern(
							"closure_capture_owners",
							"i32",
							`    ${fn.closureCaptureOwners.join(", ") || "0"}`,
						)
					: "nullptr",
			);
			closureCaptureValuesSymbols.push(
				fn.closureCaptureValues !== undefined
					? intern(
							"closure_capture_values",
							"MalClosureCaptureValue",
							closureCaptureValueArrayBody(fn.closureCaptureValues),
						)
					: "nullptr",
			);
			closureCaptureSymbols.push(
				fn.closureCaptureOwners !== undefined
					? intern(
							"closure_captures",
							"MalClosureCaptureLayout",
							closureCaptureLayoutBody(
								closureCaptureOwnersSymbols[i]!,
								closureCaptureValuesSymbols[i]!,
								fn.closureCaptureValues?.length ?? 0,
							),
						)
					: "nullptr",
			);
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
				mappedArgumentSlotsSymbols.push(
					nativeNeedsMappedArgumentSlots(fn)
						? intern(
								"mapped_argument_slots",
								"i32",
								`    ${fn.mappedArgumentSlots.join(", ")}`,
							)
						: "nullptr",
				);
				handlerSymbols.push("nullptr");
				continue;
			}
			const sideData = instructionData(fn);
			instructionSymbols.push(
				intern(
					"insns",
					"MalInstruction",
					instructionArrayRows(fn, sideData.offsets).join("\n"),
				),
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
							argumentSnapshotPlanRows(fn).join("\n"),
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
					? intern("handlers", "MalExceptionHandler", handlerArrayRows(fn).join("\n"))
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
					closureCaptureSymbols[i]!,
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

		lines.push(
			...malRuntimeImageStruct(
				runtime,
				suffix,
				false,
				nativeStackRootsAreConservative(image, useCompiled),
				literalTemplatesSymbol,
				{},
				undefined,
				useCompiled ? image.native.classLayouts : undefined,
			),
		);
		lines.push("");
	}

	return { body: lines.join("\n"), shared: sharedLines.join("\n") };
}

function emitInstruction(instruction: BytecodeInstruction, dataOffset?: number) {
	const sideDataOffset = (): number => {
		if (dataOffset === undefined) throw new Error("missing instruction side-data offset");
		return dataOffset;
	};
	switch (instruction.opcode) {
		case "UNREACHABLE_METHOD":
			return "{ .opcode = MAL_OP_UNREACHABLE_METHOD }";
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
			return `{ .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = ${instruction.dst}, .reserve_source = ${instruction.reserveSource}, .slot_reserve = ${instruction.slotReserve} } }`;
		case "CREATE_BASE_CONSTRUCT_RECEIVER":
			return `{ .opcode = MAL_OP_CREATE_BASE_CONSTRUCT_RECEIVER, .as.create_base_construct_receiver = { .dst = ${instruction.dst}, .new_target = ${instruction.newTarget}, .constructor_slot_reserve = ${instruction.constructorSlotReserve} } }`;
		case "CREATE_OBJECT_SHAPED":
			return `{ .opcode = MAL_OP_CREATE_OBJECT_SHAPED, .as.create_object_shaped = { .dst = ${instruction.dst}, .data_offset = ${sideDataOffset()}, .shape_cache_index = ${instruction.shapeCacheIndex} } }`;
		case "CREATE_ARRAY":
			return `{ .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = ${instruction.dst}, .length = ${instruction.length} } }`;
		case "CREATE_ARRAY_FROM_ITERABLE":
			return `{ .opcode = MAL_OP_CREATE_ARRAY_FROM_ITERABLE, .as.create_array_from_iterable = { .dst = ${instruction.dst}, .src = ${instruction.src} } }`;
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
		case "LOAD_DYNAMIC_ARGUMENT":
			return `{ .opcode = MAL_OP_LOAD_DYNAMIC_ARGUMENT, .as.load_dynamic_argument = { .dst = ${instruction.dst}, .key = ${instruction.key} } }`;
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
		case "STRING_CONCAT_LENGTH":
			return `{ .opcode = MAL_OP_STRING_CONCAT_LENGTH, .as.string_concat_length = { .dst = ${instruction.dst}, .prefix_length = ${instruction.prefixLength}, .part = ${instruction.part}, .following_quasi_length = ${instruction.followingQuasiLength}u } }`;
		case "CONCAT_STRINGS":
			return `{ .opcode = MAL_OP_CONCAT_STRINGS, .as.concat_strings = { .dst = ${instruction.dst}, .data_offset = ${sideDataOffset()} } }`;
		case "PREPARED_STRING_COMPARE":
			return `{ .opcode = MAL_OP_PREPARED_STRING_COMPARE, .as.prepared_string_compare = { .dst = ${instruction.dst}, .left = ${instruction.left}, .right = ${instruction.right}, .locale_options = ${instruction.stringIndex}u * 64u + ${instruction.options}u } }`;
		case "CALL_KNOWN": {
			const specialization =
				instruction.specialized === undefined
					? "0"
					: `${exactBuiltinCallDescriptor(instruction.specialized)!.cOperation} + 1`;
			return `{ .opcode = MAL_OP_CALL_KNOWN, .as.call_known = { .dst = ${instruction.dst}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()}, .operation = ${(knownOperationIndex(instruction.operation)! << 4) | knownOperationFlags(instruction)}u | ((u32) (${specialization}) << 24) } }`;
		}
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
			return `{ .opcode = MAL_OP_YIELD, .as.yield = { .yielded_src = ${instruction.yieldedSrc}, .value_dst = ${instruction.valueDst}, .mode_dst = ${instruction.modeDst}, .delegated_result = ${instruction.delegatedResult} } }`;
		case "TERMINAL_YIELD":
			return `{ .opcode = MAL_OP_TERMINAL_YIELD, .as.terminal_yield = { .yielded_src = ${instruction.yieldedSrc} } }`;
		case "AWAIT":
			return `{ .opcode = MAL_OP_AWAIT, .as.await = { .awaited_src = ${instruction.awaitedSrc}, .value_dst = ${instruction.valueDst}, .mode_dst = ${instruction.modeDst} } }`;
		case "LOAD_CAPTURED":
			return `{ .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = ${instruction.dst}, .owner_function_index = ${instruction.ownerFunctionIndex}, .index = ${instruction.index} } }`;
		case "GUARD_FUNCTION_INDEX":
			return `{ .opcode = MAL_OP_GUARD_FUNCTION_INDEX, .as.guard_function_index = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .function_index = ${instruction.functionIndex} } }`;
		case "GUARD_BOUND_FUNCTION":
			return `{ .opcode = MAL_OP_GUARD_BOUND_FUNCTION, .as.guard_bound_function = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .bound_argument_count = ${instruction.boundArgumentCount} } }`;
		case "LOAD_BOUND_FUNCTION_SLOT":
			return `{ .opcode = MAL_OP_LOAD_BOUND_FUNCTION_SLOT, .as.load_bound_function_slot = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .slot = ${instruction.slot} } }`;
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
		case "FOR_IN_HAS":
			return `{ .opcode = MAL_OP_FOR_IN_HAS, .as.for_in_has = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key}, .keys = ${instruction.keys} } }`;
		case "CALL_SPREAD":
			return `{ .opcode = MAL_OP_CALL_SPREAD, .as.call_spread = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .arguments_array = ${instruction.argumentsArray} } }`;
		case "CALL_REST_ARGUMENTS":
			return `{ .opcode = MAL_OP_CALL_REST_ARGUMENTS, .as.call_rest_arguments = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()} } }`;
		case "CONSTRUCT_REST_ARGUMENTS":
			return `{ .opcode = MAL_OP_CONSTRUCT_REST_ARGUMENTS, .as.call_rest_arguments = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()} } }`;
		case "CALL_SPREAD_ITERABLE":
			return `{ .opcode = MAL_OP_CALL_SPREAD_ITERABLE, .as.call_spread_iterable = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()} } }`;
		case "CONSTRUCT_SPREAD":
			return `{ .opcode = MAL_OP_CONSTRUCT_SPREAD, .as.construct_spread = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .arguments_array = ${instruction.argumentsArray} } }`;
		case "CONSTRUCT_SPREAD_ITERABLE":
			return `{ .opcode = MAL_OP_CONSTRUCT_SPREAD_ITERABLE, .as.construct_spread_iterable = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .data_offset = ${sideDataOffset()} } }`;
		case "CONSTRUCT_SUPER":
			return `{ .opcode = MAL_OP_CONSTRUCT_SUPER, .as.construct_super = { .dst = ${instruction.dst}, .parent = ${instruction.parent}, .data_offset = ${sideDataOffset()} } }`;
		case "CONSTRUCT_SUPER_FORWARD":
			return `{ .opcode = MAL_OP_CONSTRUCT_SUPER_FORWARD, .as.construct_super_forward = { .dst = ${instruction.dst}, .parent = ${instruction.parent} } }`;
		case "CONSTRUCT_SUPER_SPREAD":
			return `{ .opcode = MAL_OP_CONSTRUCT_SUPER_SPREAD, .as.construct_super_spread = { .dst = ${instruction.dst}, .parent = ${instruction.parent}, .arguments_array = ${instruction.argumentsArray} } }`;
		case "CONSTRUCT_SUPER_EXPLICIT":
			return `{ .opcode = MAL_OP_CONSTRUCT_SUPER_EXPLICIT, .as.construct_super_explicit = { .dst = ${instruction.dst}, .parent = ${instruction.parent}, .arguments_array = ${instruction.argumentsArray}, .data_offset = ${sideDataOffset()} } }`;
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
		case "GUARD_SERVICE_EPOCH":
			return `{ .opcode = MAL_OP_GUARD_SERVICE_EPOCH, .as.guard_service_epoch = { .dst = ${instruction.dst}, .epoch = ${instruction.epoch} } }`;
		case "READ_SERVICE_EPOCH":
			return `{ .opcode = MAL_OP_READ_SERVICE_EPOCH, .as.read_service_epoch = { .dst = ${instruction.dst} } }`;
		case "GUARD_SEMANTIC_EPOCH":
			return `{ .opcode = MAL_OP_GUARD_SEMANTIC_EPOCH, .as.guard_semantic_epoch = { .dst = ${instruction.dst}, .dependencies = ${GUARDED_SEMANTIC_EPOCH_MASKS[instruction.family]} } }`;
		case "PROBE_READ":
			return `{ .opcode = MAL_OP_PROBE_READ, .as.probe_read = { .dst = ${instruction.dst}, .success = ${instruction.success}, .object = ${instruction.object}, .data_offset = ${sideDataOffset()} } }`;
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
			return `{ .opcode = MAL_OP_WITH_ENTER, .as.with_enter = { .object = ${instruction.object}, .function_index = ${instruction.functionIndex}, .scope_index = ${instruction.scopeIndex}, .record_kind = ${instruction.recordKind} } }`;
		case "WITH_CAPTURE_OBJECT":
			return `{ .opcode = MAL_OP_WITH_CAPTURE_OBJECT, .as.with_capture_object = { .dst = ${instruction.dst}, .function_index = ${instruction.functionIndex}, .scope_index = ${instruction.scopeIndex}, .record_kind = ${instruction.recordKind} } }`;
		case "WITH_EXIT":
			return `{ .opcode = MAL_OP_WITH_EXIT, .as.with_exit = {} }`;
		case "WITH_GET":
			return `{ .opcode = MAL_OP_WITH_GET, .as.with_get = { .dst = ${instruction.dst}, .name_string_index = ${instruction.nameStringIndex}, .strict = ${instruction.strict ? "true" : "false"} } }`;
		case "WITH_RESOLVE_BASE":
			return `{ .opcode = MAL_OP_WITH_RESOLVE_BASE, .as.with_resolve_base = { .dst = ${instruction.dst}, .kind_dst = ${instruction.kindDst}, .name_string_index = ${instruction.nameStringIndex} } }`;
		case "WITH_SET":
			return `{ .opcode = MAL_OP_WITH_SET, .as.with_set = { .found = ${instruction.found}, .value = ${instruction.value}, .name_string_index = ${instruction.nameStringIndex}, .strict = ${instruction.strict ? "true" : "false"} } }`;
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
			return `{ .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = ${instruction.dst}, .src = ${instruction.src}, .copy_mode = ${instruction.copyMode}, .slot_reserve = ${instruction.slotReserve}, .data_offset = ${sideDataOffset()} } }`;
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
		case "__attachRequireTable":
			return "MAL_INTRINSIC_ATTACH_REQUIRE_TABLE";
		case "__createImportMetaResolve":
			return "MAL_INTRINSIC_CREATE_IMPORT_META_RESOLVE";
		case "__functionPrototypeCall":
			return "MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL";
		case "__functionPrototypeApply":
			return "MAL_INTRINSIC_FUNCTION_PROTOTYPE_APPLY";
		case "__functionPrototypeBind":
			return "MAL_INTRINSIC_FUNCTION_PROTOTYPE_BIND";
		case "__generatorPrototypeNext":
			return "MAL_INTRINSIC_GENERATOR_PROTOTYPE_NEXT";
		case "__arrayPrototypeValues":
			return "MAL_INTRINSIC_ARRAY_PROTOTYPE_VALUES";
		case "__arrayIteratorPrototypeNext":
			return "MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE_NEXT";
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

function emitBigintPool(
	values: ReadonlyArray<bigint>,
	suffix: string,
	storage: string,
): Array<string> {
	if (values.length === 0) return [];
	const rows: Array<string> = [],
		lines: Array<string> = [];
	for (let index = 0; index < values.length; index++) {
		const value = values[index]!,
			limbs = bigintLimbs(value).map((limb) => `UINT64_C(0x${limb.toString(16)})`);
		const symbol = `mal_bigint_${index}_digits${suffix}`;
		if (limbs.length > 2)
			lines.push(`static const u64 ${symbol}[] = { ${limbs.join(", ")} };`);
		const payload =
			limbs.length > 2
				? `.digits = ${symbol}`
				: `.inline_digits = { ${limbs.length === 0 ? "0" : limbs.join(", ")} }`;
		rows.push(
			`    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_BIGINT), .sign = ${value === 0n ? 0 : value < 0n ? -1 : 1}, .digit_count = ${limbs.length}, .data = { ${payload} } },`,
		);
	}
	return [...lines, `${storage}MalBigInt mal_bigints${suffix}[] = {`, ...rows, "};", ""];
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
