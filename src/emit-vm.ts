import path from "node:path";
import type { IncludedAsset } from "./assets.ts";
import { emitCompiledFunction } from "./emit-c.ts";
import type { CompiledFunction } from "./emit-c.ts";
import {
	compressPositions,
	computeArgumentRetentionLimit,
	countLiteralShapeSites,
	countPropertyIcSites,
	decodeVmValueOperand,
	vmCallProvesBuiltin,
	vmRegionLicense,
	VM_MATH_BINARY_NUMBER_OPERATIONS,
	VM_MATH_UNARY_NUMBER_OPERATIONS,
} from "./lower-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "./lower-vm.ts";
import { finalizeCompilerRemarks } from "./profile-metadata.ts";

type VmBinaryOperator = Extract<VmInstruction, { opcode: "BINARY" }>["operator"];

export interface EmitOptions {
	/**
	 * Suffix for all emitted symbols, so multiple definitions can live in a
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
	 * Emit the native-backend (emit-c) compiled function bodies and wire them
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

/**
 * The stack-trace display path for a source file: relative to the compiler's
 * working directory, prefixed `compiled://`.
 */
function displayFilePath(filePath: string): string {
	const relative = path.isAbsolute(filePath)
		? path.relative(process.cwd(), filePath)
		: filePath;
	return `compiled://${relative}`;
}

const C_HEADER_LINES = [
	"#include <string.h>",
	'#include "vm.h"',
	'#include "vm_ops.h"',
	'#include "value_ops.h"',
	'#include "perf_stats.h"',
	'#include "profile.h"',
	'#include "builtin_array.h"',
	'#include "builtin_json.h"',
	'#include "builtin_map.h"',
	'#include "builtin_string.h"',
	'#include "builtin_regexp.h"',
	'#include "builtin_math.h"',
	// The compiled (emit-c) for-of lowering uses the iterator-record helpers.
	'#include "builtin_iterator.h"',
	// for-await lowering uses mal_vm_get_async_iterator.
	'#include "builtin_async_iterator.h"',
	// Compiled coroutines cast their backend entry state to MalGeneratorObject.
	'#include "generator_object.h"',
	"",
];

const COMPILED_FUNCTION_DECLARATION =
	"(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state)";

/** Keep native/self-hosted compiler strings comfortably below the 16 MiB engine limit. */
// Eight MiB accommodates large indivisible dependency functions while staying
// below the self-host compiler's 16 MiB string ceiling. Splittable functions and
// data continue to use separate bounded units for native compiler parallelism.
export const DEFAULT_TRANSLATION_UNIT_CODE_UNITS = 8 * 1024 * 1024;

function stringCodeUnitsBody(constant: Array<number>): string {
	return `{ ${constant.length > 0 ? constant.join(", ") : "0"} }`;
}

function malStringRow(symbol: string, length: number): string {
	// Immortal string constant. The row stays mutable because its hash is cached
	// lazily on first use (a static initializer cannot compute it).
	return `    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_STRING), .storage = MAL_STRING_STORAGE_EXTERNAL, .hash = 0, .length = ${length}, .code_units = ${symbol} },`;
}

function malFunctionKind(fn: VmDefinition["functions"][number]): string {
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
	fn: VmDefinition["functions"][number],
	instructionsSymbol: string,
	instructionDataSymbol: string,
	instructionDataCount: number,
	argumentSnapshotPlanSymbol: string,
	argumentSnapshotPlanCount: number,
	mappedArgumentSlotsSymbol: string,
	handlersSymbol: string,
	compiledSymbol: string,
	profileSiteIdsSymbol: string,
	debug: { positionsSymbol: string; positionCount: number; fileIndex: number },
	omitBytecode = false,
): Array<string> {
	const fields = [
		`.name_string_index = ${fn.nameStringIndex}`,
		`.kind = ${malFunctionKind(fn)}`,
		`.parameter_count = ${fn.parameterCount}`,
		`.length = ${fn.length}`,
		`.register_count = ${fn.registerCount}`,
		`.captured_count = ${fn.capturedCount}`,
		`.strict = ${fn.strict}`,
		`.needs_arguments = ${fn.needsArguments}`,
		`.argument_retention_limit = ${computeArgumentRetentionLimit(fn)}`,
		`.argument_snapshot_count = ${fn.argumentSnapshotCount}`,
		`.argument_snapshot_plan_count = ${argumentSnapshotPlanCount}`,
		`.argument_snapshot_plan = ${argumentSnapshotPlanSymbol}`,
		`.mapped_arguments = ${fn.mappedArguments}`,
		`.mapped_argument_count = ${mappedArgumentSlotsSymbol === "nullptr" ? 0 : fn.mappedArgumentSlots.length}`,
		`.mapped_argument_slots = ${mappedArgumentSlotsSymbol}`,
		`.is_derived_constructor = ${fn.isDerivedConstructor}`,
		`.is_class_constructor = ${fn.isClassConstructor}`,
		`.has_prototype = ${fn.hasPrototype}`,
		`.property_ic_count = ${countPropertyIcSites(fn.instructions)}`,
		`.literal_shape_count = ${countLiteralShapeSites(fn.instructions)}`,
		`.instruction_count = ${omitBytecode ? 0 : fn.instructions.length}`,
		`.instructions = ${omitBytecode ? "nullptr" : instructionsSymbol}`,
		`.instruction_data_count = ${omitBytecode ? 0 : instructionDataCount}`,
		`.instruction_data = ${omitBytecode ? "nullptr" : instructionDataSymbol}`,
		`.handler_count = ${omitBytecode ? 0 : fn.handlers.length}`,
		`.handlers = ${omitBytecode ? "nullptr" : handlersSymbol}`,
		`.compiled = ${compiledSymbol}`,
		`.file_index = ${debug.fileIndex}`,
		`.position_count = ${debug.positionCount}`,
		`.positions = ${debug.positionsSymbol}`,
	];
	if (fn.profileSiteIds !== undefined) {
		fields.push(`.profile_site_ids = ${profileSiteIdsSymbol}`);
	}
	return [`    { ${fields.join(", ")} },`];
}

function argumentSnapshotPlanBody(fn: VmFunction): string {
	return fn.argumentSnapshotPlan
		.map(
			(move) => `    { .destination = ${move.destination}, .source = ${move.source} },`,
		)
		.join("\n");
}

/** The body (rows, no braces) of a function's MalLineEntry position table. */
function positionArrayBody(fn: VmFunction): string {
	return compressPositions(fn.positions)
		.map((run) => `    { .start_ip = ${run.startIp}, .pos_id = ${run.posId} },`)
		.join("\n");
}

function instructionArrayBody(
	fn: VmDefinition["functions"][number],
	dataOffsets: Array<number | undefined>,
): string {
	return fn.instructions
		.map((instruction, i) => `    ${emitInstruction(instruction, dataOffsets[i])},`)
		.join("\n");
}

function instructionData(fn: VmDefinition["functions"][number]): {
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
			case "CREATE_OBJECT_SHAPED":
				if (instruction.count !== instruction.keyStringIndices.length) {
					throw new Error("instruction side-data count mismatch");
				}
				paired(index, instruction.keyStringIndices, instruction.valueRegisters);
				break;
			case "CREATE_MODULE_NAMESPACE":
				paired(index, instruction.nameIndices, instruction.slots);
				break;
			case "CREATE_TEMPLATE_OBJECT":
				paired(index, instruction.cookedIndices, instruction.rawIndices);
				break;
			case "CALL":
				single(index, instruction.arguments, instruction.argumentCount);
				break;
			case "CONSTRUCT":
				single(index, instruction.arguments, instruction.argumentCount);
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

function handlerArrayBody(fn: VmDefinition["functions"][number]): string {
	return fn.handlers
		.map(
			(handler) =>
				`    { .start_ip = ${handler.startIp}, .end_ip = ${handler.endIp}, .handler_ip = ${handler.handlerIp} },`,
		)
		.join("\n");
}

/**
 * Emit a C translation unit with the static MalVmDefinition data.
 */
export function emitVmDefinition(definition: VmDefinition, options: EmitOptions = {}) {
	return emitVmDefinitionSource(definition, options, false).source;
}

interface EmittedVmSource {
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
	source: string;
	declarations: Set<string>;
}

/**
 * Move generated arrays out of the definition translation unit.
 *
 * Aggregate tables can point at other generated symbols, so the definition unit
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
				throw new Error(`unterminated generated data definition '${symbol}'`);
			}
			definitionLines.push(lines[index]!);
		}
		definitionLines[0] = definitionLines[0]!.replace(/^static /, "");
		if (
			(symbol.startsWith("mal_functions") ||
				symbol.startsWith("mal_source_positions") ||
				symbol.startsWith("mal_strings") ||
				(symbol.startsWith("mal_function_") && symbol.includes("_instructions"))) &&
			definitionLines.join("\n").length > Math.floor(maxCodeUnits / 2)
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
		definitions.push({ symbol, source: definitionLines.join("\n") });
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

interface NativeStringScanTarget {
	functionIndex: number;
	arrayKeyStringIndex: number;
	matchKeyStringIndex: number;
	matchCodeUnit: number;
}

const VM_REGISTER_USE_FIELDS = [
	"src",
	"value",
	"cond",
	"callee",
	"thisValue",
	"object",
	"key",
	"left",
	"right",
	"receiver",
	"source",
	"target",
	"direct",
	"fallback",
	"iterator",
	"next",
	"accessor",
	"func",
	"parent",
	"newTarget",
	"found",
	"awaitedSrc",
	"yieldedSrc",
	"iterable",
	"argumentsArray",
] as const;

const VM_REGISTER_USE_ARRAY_FIELDS = [
	"arguments",
	"valueRegisters",
	"keyRegisters",
	"excluded",
] as const;

function vmInstructionUsesRegister(
	instruction: VmInstruction,
	register: number,
): boolean {
	const row = instruction as unknown as Record<string, unknown>;
	if (VM_REGISTER_USE_FIELDS.some((field) => row[field] === register)) return true;
	if (
		VM_REGISTER_USE_ARRAY_FIELDS.some(
			(field) => Array.isArray(row[field]) && row[field].includes(register),
		)
	) {
		return true;
	}
	switch (instruction.opcode) {
		case "RETURN":
		case "THROW":
		case "SET_THIS":
			return instruction.value === register;
		case "STORE_PROPERTY":
		case "STORE_PROPERTY_STATIC":
		case "STORE_SUPER_PROPERTY":
		case "DEFINE_PROPERTY":
		case "DEFINE_PRIVATE":
		case "STORE_PRIVATE":
			return instruction.value === register;
		default:
			return false;
	}
}

/** The generic scanner's `value` key is a register for stores/returns but a
 * literal payload for CREATE_NUMBER/F64/BOOLEAN. Semantic identity proofs must
 * not confuse equal literal bits with a physical-register use. */
function nativeInstructionUsesRegister(
	instruction: VmInstruction,
	register: number,
): boolean {
	if (
		instruction.opcode === "CREATE_NUMBER" ||
		instruction.opcode === "CREATE_F64" ||
		instruction.opcode === "CREATE_BOOLEAN"
	)
		return false;
	return vmInstructionUsesRegister(instruction, register);
}

function vmInstructionDefinesRegister(
	instruction: VmInstruction,
	register: number,
): boolean {
	const row = instruction as unknown as Record<string, unknown>;
	if (row.dst === register) return true;
	return ["iteratorDst", "nextDst", "resultDst", "valueDst", "doneDst", "modeDst"].some(
		(field) => row[field] === register,
	);
}

function staticStringEquals(
	definition: VmDefinition,
	index: number,
	value: string,
): boolean {
	const units = definition.stringConstants[index];
	return (
		units !== undefined &&
		units.length === value.length &&
		units.every((unit, position) => unit === value.charCodeAt(position))
	);
}

interface NativeProofCfg {
	successors: Array<ReadonlyArray<number>>;
	predecessors: Array<ReadonlyArray<number>>;
	dominators: Array<ReadonlySet<number>>;
	loops: Array<{ header: number; backedge: number; body: ReadonlySet<number> }>;
}

/** Build the exact ordinary-control CFG used by emitter-only proof annotations. */
function buildNativeProofCfg(fn: VmFunction): NativeProofCfg {
	const count = fn.instructions.length;
	const successors = fn.instructions.map((instruction, ip): Array<number> => {
		const handlerTargets = fn.handlers
			.filter((handler) => handler.startIp <= ip && ip < handler.endIp)
			.map((handler) => handler.handlerIp);
		if (instruction.opcode === "JUMP") return [instruction.targetIp];
		if (instruction.opcode === "JUMP_IF") {
			return ip + 1 < count ? [instruction.targetIp, ip + 1] : [instruction.targetIp];
		}
		if (instruction.opcode === "RETURN") return [];
		if (instruction.opcode === "THROW") return handlerTargets.slice(0, 1);
		return ip + 1 < count ? [ip + 1, ...handlerTargets] : handlerTargets;
	});
	const predecessors: Array<Array<number>> = Array.from({ length: count }, () => []);
	for (let ip = 0; ip < count; ip++) {
		for (const successor of successors[ip]!) {
			if (successor >= 0 && successor < count) predecessors[successor]!.push(ip);
		}
	}
	const all = new Set(Array.from({ length: count }, (_, ip) => ip));
	const dominators: Array<Set<number>> = Array.from({ length: count }, (_, ip) =>
		ip === 0 ? new Set([0]) : new Set(all),
	);
	let changed = true;
	while (changed) {
		changed = false;
		for (let ip = 1; ip < count; ip++) {
			const incoming = predecessors[ip]!;
			const next =
				incoming.length === 0
					? new Set<number>()
					: new Set(
							[...dominators[incoming[0]!]!].filter((candidate) =>
								incoming.every((predecessor) => dominators[predecessor]!.has(candidate)),
							),
						);
			next.add(ip);
			const current = dominators[ip]!;
			if (
				current.size !== next.size ||
				[...current].some((candidate) => !next.has(candidate))
			) {
				dominators[ip] = next;
				changed = true;
			}
		}
	}
	const loops: Array<{ header: number; backedge: number; body: ReadonlySet<number> }> =
		[];
	for (let from = 0; from < count; from++) {
		for (const to of successors[from]!) {
			if (to > from || !dominators[from]!.has(to)) continue;
			const body = new Set<number>([to, from]);
			const work = from === to ? [] : [from];
			while (work.length > 0) {
				const current = work.pop()!;
				for (const predecessor of predecessors[current]!) {
					if (body.has(predecessor)) continue;
					body.add(predecessor);
					if (predecessor !== to) work.push(predecessor);
				}
			}
			loops.push({ header: to, backedge: from, body });
		}
	}
	return { successors, predecessors, dominators, loops };
}

function privateAggregateDefinedRegisters(instruction: VmInstruction): Array<number> {
	switch (instruction.opcode) {
		case "GET_ITERATOR":
			return [instruction.iteratorDst, instruction.nextDst];
		case "ITERATOR_STEP":
			return [instruction.valueDst, instruction.doneDst];
		case "MOVE":
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
		case "CREATE_STRING":
		case "CREATE_UNDEFINED":
		case "CREATE_NULL":
		case "CREATE_ARRAY":
		case "CREATE_FUNCTION":
		case "LOAD_PROPERTY":
		case "LOAD_PROPERTY_STATIC":
		case "BINARY":
		case "UNARY":
		case "CALL":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER":
		case "CATCH":
			return [instruction.dst];
		default:
			return [];
	}
}

interface NativeIntegerRange {
	minimum: number;
	maximum: number;
}

/**
 * Virtualize the deliberately tiny identity-range shape used by the language
 * benchmark: a private fresh `[]`, filled exactly by `array[i] = i`, then read
 * only by bounded indexed loops. This emitter-only pass independently rebuilds
 * the producer/use/CFG/range proof after wire loading, so compile-only capacity
 * hints, bytecode, and interpreted semantics are never semantic authority.
 *
 * Native emission admits the virtual path only when there is no scheduler
 * preemption hook and the Array-elements protector is live. Therefore every
 * original poll stays in place, while fibers and poisoned prototypes execute
 * the complete allocation/store/load fallback from the first instruction.
 */
function annotateNativeAffineRangeVirtualizations(definition: VmDefinition): void {
	// With zero parameters/captures and no calls, globals, object/string producers,
	// handlers, or non-aggregate property operations, every remaining BINARY/UNARY
	// operand is a locally produced primitive. None can invoke user coercion or
	// invalidate Array prototype state between the admission guard and the loads.
	const safeOpcodes = new Set<VmInstruction["opcode"]>([
		"CREATE_NUMBER",
		"CREATE_F64",
		"CREATE_BOOLEAN",
		"CREATE_UNDEFINED",
		"CREATE_NULL",
		"CREATE_ARRAY",
		"MOVE",
		"BINARY",
		"UNARY",
		"JUMP",
		"JUMP_IF",
		"LOAD_PROPERTY",
		"STORE_PROPERTY",
		"RETURN",
	]);
	const usedRegisters = (instruction: VmInstruction): Array<number> => {
		switch (instruction.opcode) {
			case "MOVE":
				return [instruction.src];
			case "BINARY":
				return [instruction.left, instruction.right];
			case "UNARY":
				return [instruction.src];
			case "JUMP_IF":
				return [instruction.cond];
			case "LOAD_PROPERTY":
				return [instruction.object, instruction.key];
			case "STORE_PROPERTY":
				return [instruction.object, instruction.key, instruction.value];
			case "RETURN":
				return [instruction.value];
			default:
				return [];
		}
	};

	for (const fn of definition.functions) {
		for (const instruction of fn.instructions) {
			if (
				instruction.opcode === "CREATE_ARRAY" ||
				instruction.opcode === "LOAD_PROPERTY" ||
				instruction.opcode === "STORE_PROPERTY"
			) {
				delete instruction.nativeAffineRangeVirtualization;
			}
		}
		if (
			fn.isGenerator ||
			fn.isAsync ||
			fn.parameterCount !== 0 ||
			fn.needsArguments ||
			fn.mappedArguments ||
			fn.capturedCount !== 0 ||
			fn.handlers.length > 0 ||
			fn.instructions.some((instruction) => !safeOpcodes.has(instruction.opcode))
		) {
			continue;
		}
		const allocations = fn.instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "CREATE_ARRAY" }>;
					ip: number;
				} =>
					entry.instruction.opcode === "CREATE_ARRAY" && entry.instruction.length === 0,
			);
		// One site keeps the first structural checkpoint easy to audit and gives
		// each generated activation exactly one scalar virtual-state local.
		if (allocations.length !== 1) continue;
		const allocation = allocations[0]!;

		const cfg = buildNativeProofCfg(fn);
		const reaching = privateAggregateReachingDefinitions(fn, cfg);
		const aliasDefinitions = new Set<number>([allocation.ip]);
		let aliasesChanged = true;
		while (aliasesChanged) {
			aliasesChanged = false;
			for (let ip = 0; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (instruction.opcode !== "MOVE" || aliasDefinitions.has(ip)) continue;
				const definitions = reaching[instruction.src]?.[ip];
				if (
					definitions !== undefined &&
					definitions.size > 0 &&
					[...definitions].every((definitionIp) => aliasDefinitions.has(definitionIp))
				) {
					aliasDefinitions.add(ip);
					aliasesChanged = true;
				}
			}
		}
		const isAggregateUse = (register: number, ip: number): boolean => {
			const definitions = reaching[register]?.[ip];
			return (
				definitions !== undefined &&
				definitions.size > 0 &&
				[...definitions].every((definitionIp) => aliasDefinitions.has(definitionIp))
			);
		};

		const stores: Array<{
			instruction: Extract<VmInstruction, { opcode: "STORE_PROPERTY" }>;
			ip: number;
		}> = [];
		const loads: Array<{
			instruction: Extract<VmInstruction, { opcode: "LOAD_PROPERTY" }>;
			ip: number;
		}> = [];
		let closed = true;
		for (let ip = 0; ip < fn.instructions.length && closed; ip++) {
			const instruction = fn.instructions[ip]!;
			for (const register of new Set(usedRegisters(instruction))) {
				if (!isAggregateUse(register, ip)) continue;
				if (instruction.opcode === "MOVE" && instruction.src === register) continue;
				if (
					instruction.opcode === "STORE_PROPERTY" &&
					instruction.object === register &&
					instruction.key === instruction.value
				) {
					if (!stores.some((entry) => entry.ip === ip)) stores.push({ instruction, ip });
					continue;
				}
				if (instruction.opcode === "LOAD_PROPERTY" && instruction.object === register) {
					if (!loads.some((entry) => entry.ip === ip)) loads.push({ instruction, ip });
					continue;
				}
				closed = false;
				break;
			}
		}
		if (!closed || stores.length !== 1 || loads.length === 0 || loads.length > 8)
			continue;
		if (
			fn.instructions.some(
				(instruction, ip) =>
					(instruction.opcode === "LOAD_PROPERTY" ||
						instruction.opcode === "STORE_PROPERTY") &&
					!stores.some((entry) => entry.ip === ip) &&
					!loads.some((entry) => entry.ip === ip),
			)
		) {
			continue;
		}
		const store = stores[0]!;
		const producerLoop = cfg.loops
			.filter((loop) => loop.body.has(store.ip))
			.sort((left, right) => left.body.size - right.body.size)[0];
		if (producerLoop === undefined) continue;

		const constantAt = (register: number, useIp: number): number | undefined => {
			const definitions = reaching[register]?.[useIp];
			if (definitions?.size !== 1) return undefined;
			const definitionIp = [...definitions][0]!;
			const instruction = fn.instructions[definitionIp];
			return instruction?.opcode === "CREATE_NUMBER" ||
				instruction?.opcode === "CREATE_F64"
				? instruction.value
				: undefined;
		};
		const canonicalCounter = (
			loop: NativeProofCfg["loops"][number],
			maximumBound: number,
		):
			| {
					register: number;
					bound: number;
					comparisonIp: number;
					boundDefinitionIp: number;
					initializerIp: number;
					incrementIp: number;
			  }
			| undefined => {
			for (const ip of loop.body) {
				const comparison = fn.instructions[ip];
				const branch = fn.instructions[ip + 1];
				if (
					comparison?.opcode !== "BINARY" ||
					comparison.operator !== "<" ||
					branch?.opcode !== "JUMP_IF" ||
					branch.cond !== comparison.dst ||
					!loop.body.has(branch.targetIp)
				) {
					continue;
				}
				const bound = constantAt(comparison.right, ip);
				if (!Number.isSafeInteger(bound) || bound! <= 0 || bound! > maximumBound)
					continue;
				const boundDefinitions = reaching[comparison.right]?.[ip];
				if (boundDefinitions?.size !== 1) continue;
				const boundDefinitionIp = [...boundDefinitions][0]!;
				const counter = comparison.left;
				const definitions = reaching[counter]?.[ip];
				if (definitions?.size !== 2) continue;
				let sawZero = false;
				let sawIncrement = false;
				let initializerIp = -1;
				let incrementIp = -1;
				for (const definitionIp of definitions) {
					const definition = fn.instructions[definitionIp];
					if (
						(definition?.opcode === "CREATE_NUMBER" ||
							definition?.opcode === "CREATE_F64") &&
						definition.value === 0 &&
						!loop.body.has(definitionIp)
					) {
						sawZero = true;
						initializerIp = definitionIp;
					} else if (
						definition?.opcode === "UNARY" &&
						definition.operator === "increment" &&
						definition.dst === counter &&
						definition.src === counter &&
						loop.body.has(definitionIp)
					) {
						sawIncrement = true;
						incrementIp = definitionIp;
					}
				}
				if (sawZero && sawIncrement) {
					return {
						register: counter,
						bound: bound!,
						comparisonIp: ip,
						boundDefinitionIp,
						initializerIp,
						incrementIp,
					};
				}
			}
			return undefined;
		};
		const producerCounter = canonicalCounter(producerLoop, 65_536);
		const producerBranch =
			producerCounter === undefined
				? undefined
				: fn.instructions[producerCounter.comparisonIp + 1];
		const producerBackedge = fn.instructions[producerLoop.backedge];
		const producerExit =
			producerCounter === undefined
				? undefined
				: fn.instructions[producerCounter.comparisonIp + 2];
		if (
			producerCounter === undefined ||
			store.instruction.key !== producerCounter.register ||
			store.instruction.value !== producerCounter.register ||
			producerCounter.initializerIp <= allocation.ip ||
			producerCounter.comparisonIp + 2 >= store.ip ||
			producerExit?.opcode !== "JUMP" ||
			producerLoop.body.has(producerExit.targetIp) ||
			producerBranch?.opcode !== "JUMP_IF" ||
			producerBranch.targetIp !== store.ip ||
			producerCounter.incrementIp !== store.ip + 1 ||
			producerLoop.backedge !== producerCounter.incrementIp + 1 ||
			producerBackedge?.opcode !== "JUMP" ||
			producerBackedge.targetIp !== producerLoop.header ||
			!cfg.dominators[producerLoop.header]!.has(allocation.ip) ||
			!cfg.dominators[producerLoop.header]!.has(producerCounter.initializerIp) ||
			!cfg.dominators[store.ip]!.has(allocation.ip) ||
			[...producerLoop.body].some((ip) =>
				cfg.predecessors[ip]!.some(
					(predecessor) =>
						!producerLoop.body.has(predecessor) && ip !== producerLoop.header,
				),
			)
		) {
			continue;
		}
		const producerInstructions = new Set([
			producerCounter.boundDefinitionIp,
			producerCounter.comparisonIp,
			producerCounter.comparisonIp + 1,
			producerCounter.comparisonIp + 2,
			store.ip,
			producerCounter.incrementIp,
			producerLoop.backedge,
		]);
		if ([...producerLoop.body].some((ip) => !producerInstructions.has(ip))) continue;
		for (let ip = allocation.ip + 1; ip < producerLoop.header; ip++) {
			const instruction = fn.instructions[ip]!;
			if (
				ip === producerCounter.initializerIp ||
				(instruction.opcode === "MOVE" && aliasDefinitions.has(ip)) ||
				(instruction.opcode === "JUMP" && instruction.targetIp === producerLoop.header)
			) {
				continue;
			}
			closed = false;
			break;
		}
		if (!closed) continue;
		const length = producerCounter.bound;

		let rangesProven = true;
		for (const load of loads) {
			const consumerLoop = cfg.loops
				.filter((loop) => loop.body.has(load.ip) && loop.backedge > producerLoop.backedge)
				.sort((left, right) => left.body.size - right.body.size)[0];
			const counter =
				consumerLoop === undefined ? undefined : canonicalCounter(consumerLoop, length);
			const consumerBackedge =
				consumerLoop === undefined ? undefined : fn.instructions[consumerLoop.backedge];
			const consumerBranch =
				counter === undefined ? undefined : fn.instructions[counter.comparisonIp + 1];
			const consumerExit =
				counter === undefined ? undefined : fn.instructions[counter.comparisonIp + 2];
			if (
				consumerLoop === undefined ||
				counter === undefined ||
				producerLoop.backedge >= consumerLoop.header ||
				!cfg.dominators[load.ip]!.has(allocation.ip) ||
				!cfg.dominators[load.ip]!.has(producerExit.targetIp) ||
				!cfg.dominators[load.ip]!.has(consumerLoop.header) ||
				!cfg.dominators[load.ip]!.has(counter.comparisonIp) ||
				!cfg.dominators[consumerLoop.header]!.has(counter.initializerIp) ||
				consumerBranch?.opcode !== "JUMP_IF" ||
				!cfg.dominators[load.ip]!.has(consumerBranch.targetIp) ||
				consumerExit?.opcode !== "JUMP" ||
				consumerLoop.body.has(consumerExit.targetIp) ||
				load.ip >= counter.incrementIp ||
				counter.incrementIp !== consumerLoop.backedge - 1 ||
				consumerBackedge?.opcode !== "JUMP" ||
				consumerBackedge.targetIp !== consumerLoop.header ||
				[...consumerLoop.body].some((ip) =>
					cfg.predecessors[ip]!.some(
						(predecessor) =>
							!consumerLoop.body.has(predecessor) && ip !== consumerLoop.header,
					),
				)
			) {
				rangesProven = false;
				break;
			}
			const counterDefinitions = reaching[counter.register]?.[load.ip];
			if (
				counterDefinitions?.size !== 2 ||
				!counterDefinitions.has(counter.initializerIp) ||
				!counterDefinitions.has(counter.incrementIp)
			) {
				rangesProven = false;
				break;
			}
			const inferRange = (
				register: number,
				useIp: number,
				seen = new Set<number>(),
			): NativeIntegerRange | undefined => {
				if (register === counter.register) {
					return { minimum: 0, maximum: counter.bound - 1 };
				}
				if (seen.has(register)) return undefined;
				seen.add(register);
				const definitions = reaching[register]?.[useIp];
				if (definitions?.size !== 1) return undefined;
				const definitionIp = [...definitions][0]!;
				const definition = fn.instructions[definitionIp];
				if (
					definition?.opcode === "CREATE_NUMBER" ||
					definition?.opcode === "CREATE_F64"
				) {
					return Number.isSafeInteger(definition.value)
						? { minimum: definition.value, maximum: definition.value }
						: undefined;
				}
				if (definition?.opcode === "MOVE") {
					return inferRange(definition.src, definitionIp, seen);
				}
				if (definition?.opcode !== "BINARY") return undefined;
				const left = inferRange(definition.left, definitionIp, new Set(seen));
				const right = inferRange(definition.right, definitionIp, new Set(seen));
				if (left === undefined || right === undefined) return undefined;
				let result: NativeIntegerRange | undefined;
				if (definition.operator === "+") {
					result = {
						minimum: left.minimum + right.minimum,
						maximum: left.maximum + right.maximum,
					};
				} else if (
					definition.operator === "*" &&
					left.minimum >= 0 &&
					right.minimum >= 0
				) {
					result = {
						minimum: left.minimum * right.minimum,
						maximum: left.maximum * right.maximum,
					};
				} else if (
					definition.operator === "%" &&
					left.minimum >= 0 &&
					right.minimum === right.maximum &&
					right.minimum > 0
				) {
					result = { minimum: 0, maximum: right.minimum - 1 };
				}
				return result !== undefined &&
					Number.isSafeInteger(result.minimum) &&
					Number.isSafeInteger(result.maximum)
					? result
					: undefined;
			};
			const range = inferRange(load.instruction.key, load.ip);
			if (range === undefined || range.minimum < 0 || range.maximum >= length) {
				rangesProven = false;
				break;
			}
		}
		if (!rangesProven) continue;

		allocation.instruction.nativeAffineRangeVirtualization = {
			allocationIp: allocation.ip,
			role: "allocation",
		};
		store.instruction.nativeAffineRangeVirtualization = {
			allocationIp: allocation.ip,
			role: "store",
		};
		for (const load of loads) {
			load.instruction.nativeAffineRangeVirtualization = {
				allocationIp: allocation.ip,
				role: "load",
			};
		}
	}
}

/** Register uses for the deliberately closed caller/target opcode vocabulary. */
function privateAggregateUsedRegisters(instruction: VmInstruction): Array<number> | null {
	const operand = (value: number): Array<number> =>
		decodeVmValueOperand(value).kind === "register" ? [value] : [];
	switch (instruction.opcode) {
		case "MOVE":
			return [instruction.src];
		case "RETURN":
		case "THROW":
			return [instruction.value];
		case "JUMP_IF":
			return [instruction.cond];
		case "JUMP":
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
		case "CREATE_STRING":
		case "CREATE_UNDEFINED":
		case "CREATE_NULL":
		case "CREATE_ARRAY":
		case "CREATE_FUNCTION":
		case "CATCH":
			return [];
		case "LOAD_PROPERTY_STATIC":
			return [instruction.object];
		case "BINARY":
			return [instruction.left, instruction.right];
		case "UNARY":
			return [instruction.src];
		case "MATH_UNARY_NUMBER":
			return [instruction.src];
		case "MATH_BINARY_NUMBER":
			return [instruction.left, instruction.right];
		case "CALL":
			return [
				...operand(instruction.callee),
				...operand(instruction.thisValue),
				...instruction.arguments.flatMap(operand),
			];
		case "GET_ITERATOR":
			return [instruction.source];
		case "ITERATOR_STEP":
			return [instruction.iterator, instruction.next];
		case "ITERATOR_CLOSE":
			return [instruction.iterator];
		default:
			return null;
	}
}

/** Classical forward reaching definitions, including synthetic parameter defs. */
function privateAggregateReachingDefinitions(
	fn: VmFunction,
	cfg: NativeProofCfg,
): Array<Array<ReadonlySet<number>>> {
	const result: Array<Array<ReadonlySet<number>>> = [];
	for (let register = 0; register < fn.registerCount; register++) {
		const incoming: Array<Set<number>> = Array.from(
			{ length: fn.instructions.length },
			() => new Set(),
		);
		if (register < fn.parameterCount && incoming.length > 0) {
			incoming[0]!.add(-register - 1);
		}
		const outgoing: Array<Set<number>> = Array.from(
			{ length: fn.instructions.length },
			() => new Set(),
		);
		let changed = true;
		while (changed) {
			changed = false;
			for (let ip = 0; ip < fn.instructions.length; ip++) {
				const nextIncoming = new Set<number>();
				if (ip === 0 && register < fn.parameterCount) nextIncoming.add(-register - 1);
				for (const predecessor of cfg.predecessors[ip]!) {
					for (const definition of outgoing[predecessor]!) {
						nextIncoming.add(definition);
					}
				}
				const defines = privateAggregateDefinedRegisters(fn.instructions[ip]!).includes(
					register,
				);
				const nextOutgoing = defines ? new Set([ip]) : new Set(nextIncoming);
				const same = (left: Set<number>, right: Set<number>) =>
					left.size === right.size && [...left].every((value) => right.has(value));
				if (!same(incoming[ip]!, nextIncoming)) {
					incoming[ip] = nextIncoming;
					changed = true;
				}
				if (!same(outgoing[ip]!, nextOutgoing)) {
					outgoing[ip] = nextOutgoing;
					changed = true;
				}
			}
		}
		result[register] = incoming;
	}
	return result;
}

const PRIVATE_AGGREGATE_NUMBER = 1 << 0;
const PRIVATE_AGGREGATE_BOOLEAN = 1 << 1;
const PRIVATE_AGGREGATE_STRING = 1 << 2;
const PRIVATE_AGGREGATE_ARRAY = 1 << 3;
const PRIVATE_AGGREGATE_ITERATOR = 1 << 4;
const PRIVATE_AGGREGATE_NEXT = 1 << 5;

/**
 * Prove the target is a closed Number reduction over one canonical Array iterator.
 * Exceptional edges are admitted only for explicit primitive throws caught by the
 * innermost local handler. Exact builtin iteration and Number operators cannot take
 * the generic exceptional edges that remain in the bytecode fallback CFG.
 */
function isPrivateDenseNumberReducer(fn: VmFunction): boolean {
	if (
		fn.parameterCount !== 1 ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.needsArguments ||
		fn.mappedArguments ||
		fn.capturedCount !== 0 ||
		fn.isClassConstructor ||
		fn.isDerivedConstructor ||
		fn.argumentSnapshotCount !== 0 ||
		fn.argumentSnapshotPlan.length !== 0
	) {
		return false;
	}
	const allowed = new Set<VmInstruction["opcode"]>([
		"MOVE",
		"RETURN",
		"JUMP_IF",
		"JUMP",
		"CREATE_NUMBER",
		"CREATE_F64",
		"CREATE_BOOLEAN",
		"CREATE_STRING",
		"CREATE_UNDEFINED",
		"CREATE_NULL",
		"THROW",
		"CATCH",
		"BINARY",
		"GET_ITERATOR",
		"ITERATOR_STEP",
		"ITERATOR_CLOSE",
	]);
	if (fn.instructions.some((instruction) => !allowed.has(instruction.opcode))) {
		return false;
	}
	if (
		fn.instructions.some((instruction) =>
			privateAggregateDefinedRegisters(instruction).includes(0),
		)
	) {
		return false;
	}
	const gets = fn.instructions.filter(
		(instruction): instruction is Extract<VmInstruction, { opcode: "GET_ITERATOR" }> =>
			instruction.opcode === "GET_ITERATOR",
	);
	const steps = fn.instructions.filter(
		(instruction): instruction is Extract<VmInstruction, { opcode: "ITERATOR_STEP" }> =>
			instruction.opcode === "ITERATOR_STEP",
	);
	if (
		gets.length !== 1 ||
		steps.length !== 1 ||
		gets[0]!.source !== 0 ||
		steps[0]!.iterator !== gets[0]!.iteratorDst ||
		steps[0]!.next !== gets[0]!.nextDst
	) {
		return false;
	}
	for (const instruction of fn.instructions) {
		const uses = privateAggregateUsedRegisters(instruction);
		if (uses === null) return false;
		if (
			uses.includes(0) &&
			!(instruction.opcode === "GET_ITERATOR" && instruction === gets[0])
		) {
			return false;
		}
	}
	const cfg = buildNativeProofCfg(fn);
	const stepIp = fn.instructions.indexOf(steps[0]!);
	const doneBranch = fn.instructions[stepIp + 1];
	const valueEntryIp = stepIp + 2;
	if (
		!cfg.loops.some((loop) => loop.body.has(stepIp)) ||
		doneBranch?.opcode !== "JUMP_IF" ||
		doneBranch.cond !== steps[0]!.doneDst ||
		doneBranch.targetIp === valueEntryIp ||
		!cfg.dominators[valueEntryIp]?.has(stepIp)
	) {
		return false;
	}
	const reaching = privateAggregateReachingDefinitions(fn, cfg);
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (
			!privateAggregateUsedRegisters(fn.instructions[ip]!)?.includes(steps[0]!.valueDst)
		) {
			continue;
		}
		const definitions = reaching[steps[0]!.valueDst]?.[ip];
		if (
			definitions?.has(stepIp) &&
			(!cfg.dominators[ip]!.has(valueEntryIp) || ip === doneBranch.targetIp)
		) {
			return false;
		}
	}

	type State = Uint8Array;
	const states: Array<State | undefined> = Array.from(
		{ length: fn.instructions.length },
		() => undefined,
	);
	const caught = new Uint8Array(fn.instructions.length);
	const entry = new Uint8Array(fn.registerCount);
	entry[0] = PRIVATE_AGGREGATE_ARRAY;
	states[0] = entry;
	const work = [0];
	let reachablePrimitiveThrows = 0;
	let sawNumberReturn = false;
	const merge = (ip: number, state: State): void => {
		const current = states[ip];
		if (current === undefined) {
			states[ip] = state.slice();
			work.push(ip);
			return;
		}
		let changed = false;
		for (let register = 0; register < state.length; register++) {
			const joined = current[register]! | state[register]!;
			if (joined !== current[register]) {
				current[register] = joined;
				changed = true;
			}
		}
		if (changed) work.push(ip);
	};
	const ordinarySuccessors = (ip: number): Array<number> => {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "JUMP") return [instruction.targetIp];
		if (instruction.opcode === "JUMP_IF") {
			return ip + 1 < fn.instructions.length
				? [instruction.targetIp, ip + 1]
				: [instruction.targetIp];
		}
		if (instruction.opcode === "RETURN" || instruction.opcode === "THROW") return [];
		return ip + 1 < fn.instructions.length ? [ip + 1] : [];
	};
	const handlerFor = (ip: number) =>
		fn.handlers
			.filter((handler) => handler.startIp <= ip && ip < handler.endIp)
			.sort(
				(left, right) => left.endIp - left.startIp - (right.endIp - right.startIp),
			)[0];
	while (work.length > 0) {
		const ip = work.pop()!;
		const before = states[ip];
		if (before === undefined) continue;
		const after = before.slice();
		const instruction = fn.instructions[ip]!;
		const exact = (register: number, type: number) => after[register] === type;
		let valid = true;
		switch (instruction.opcode) {
			case "CREATE_NUMBER":
			case "CREATE_F64":
				after[instruction.dst] = PRIVATE_AGGREGATE_NUMBER;
				break;
			case "CREATE_BOOLEAN":
				after[instruction.dst] = PRIVATE_AGGREGATE_BOOLEAN;
				break;
			case "CREATE_STRING":
				after[instruction.dst] = PRIVATE_AGGREGATE_STRING;
				break;
			case "CREATE_UNDEFINED":
			case "CREATE_NULL":
				after[instruction.dst] = PRIVATE_AGGREGATE_STRING;
				break;
			case "MOVE":
				if (after[instruction.src] === 0) valid = false;
				else after[instruction.dst] = after[instruction.src]!;
				break;
			case "GET_ITERATOR":
				if (!exact(instruction.source, PRIVATE_AGGREGATE_ARRAY)) valid = false;
				after[instruction.iteratorDst] = PRIVATE_AGGREGATE_ITERATOR;
				after[instruction.nextDst] = PRIVATE_AGGREGATE_NEXT;
				break;
			case "ITERATOR_STEP":
				if (
					!exact(instruction.iterator, PRIVATE_AGGREGATE_ITERATOR) ||
					!exact(instruction.next, PRIVATE_AGGREGATE_NEXT)
				) {
					valid = false;
				}
				after[instruction.valueDst] = PRIVATE_AGGREGATE_NUMBER;
				after[instruction.doneDst] = PRIVATE_AGGREGATE_BOOLEAN;
				break;
			case "BINARY": {
				const numeric = new Set(["+", "-", "*", "/", "%", "**"]);
				const comparison = new Set(["===", "!==", "<", "<=", ">", ">="]);
				if (numeric.has(instruction.operator)) {
					if (
						!exact(instruction.left, PRIVATE_AGGREGATE_NUMBER) ||
						!exact(instruction.right, PRIVATE_AGGREGATE_NUMBER)
					) {
						valid = false;
					}
					after[instruction.dst] = PRIVATE_AGGREGATE_NUMBER;
				} else if (comparison.has(instruction.operator)) {
					const left = after[instruction.left]!;
					const right = after[instruction.right]!;
					const scalar =
						PRIVATE_AGGREGATE_NUMBER |
						PRIVATE_AGGREGATE_BOOLEAN |
						PRIVATE_AGGREGATE_STRING;
					if (
						left === 0 ||
						right === 0 ||
						(left & ~scalar) !== 0 ||
						(right & ~scalar) !== 0
					) {
						valid = false;
					}
					after[instruction.dst] = PRIVATE_AGGREGATE_BOOLEAN;
				} else {
					valid = false;
				}
				break;
			}
			case "JUMP_IF":
				valid = exact(instruction.cond, PRIVATE_AGGREGATE_BOOLEAN);
				break;
			case "CATCH":
				if (caught[ip] === 0) valid = false;
				else after[instruction.dst] = caught[ip]!;
				break;
			case "THROW": {
				const thrown = after[instruction.value]!;
				const primitives =
					PRIVATE_AGGREGATE_NUMBER | PRIVATE_AGGREGATE_BOOLEAN | PRIVATE_AGGREGATE_STRING;
				const handler = handlerFor(ip);
				if (thrown === 0 || (thrown & ~primitives) !== 0 || handler === undefined) {
					valid = false;
					break;
				}
				reachablePrimitiveThrows++;
				const previousCaught = caught[handler.handlerIp]!;
				caught[handler.handlerIp] = previousCaught | thrown;
				merge(handler.handlerIp, after);
				if (caught[handler.handlerIp] !== previousCaught) work.push(handler.handlerIp);
				break;
			}
			case "ITERATOR_CLOSE":
				// Exact builtin dense iteration cannot reach abrupt-close machinery.
				valid = false;
				break;
			case "RETURN":
				valid = exact(instruction.value, PRIVATE_AGGREGATE_NUMBER);
				sawNumberReturn ||= valid;
				break;
			case "JUMP":
				break;
			default:
				valid = false;
		}
		if (!valid) return false;
		if (instruction.opcode === "THROW" || instruction.opcode === "RETURN") continue;
		for (const successor of ordinarySuccessors(ip)) merge(successor, after);
	}
	return sawNumberReturn && reachablePrimitiveThrows > 0;
}

/**
 * Find one deliberately narrow caller: one fresh Array, exact push-only private
 * construction, then one exact reducer call in a side-effect-free natural loop.
 */
function annotateNativePrivateAggregateMemos(definition: VmDefinition): void {
	const reducerTargets = new Set<number>();
	for (let index = 0; index < definition.functions.length; index++) {
		if (isPrivateDenseNumberReducer(definition.functions[index]!))
			reducerTargets.add(index);
	}
	for (const fn of definition.functions) {
		delete fn.nativePrivateAggregateMemos;
		if (
			fn.isGenerator ||
			fn.isAsync ||
			fn.needsArguments ||
			fn.mappedArguments ||
			fn.capturedCount !== 0 ||
			fn.isClassConstructor ||
			fn.isDerivedConstructor ||
			fn.argumentSnapshotCount !== 0 ||
			fn.argumentSnapshotPlan.length !== 0 ||
			fn.handlers.length > 0 ||
			fn.instructions.some(
				(instruction) => privateAggregateUsedRegisters(instruction) === null,
			)
		) {
			continue;
		}
		const allocations = fn.instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "CREATE_ARRAY" }>;
					ip: number;
				} =>
					entry.instruction.opcode === "CREATE_ARRAY" && entry.instruction.length === 0,
			);
		if (allocations.length !== 1) continue;
		const cfg = buildNativeProofCfg(fn);
		const allocation = allocations[0]!;
		if (cfg.loops.some((loop) => loop.body.has(allocation.ip))) continue;
		const reaching = privateAggregateReachingDefinitions(fn, cfg);
		const aliasDefinitions = new Set<number>([allocation.ip]);
		let aliasChanged = true;
		while (aliasChanged) {
			aliasChanged = false;
			for (let ip = 0; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (instruction.opcode !== "MOVE" || aliasDefinitions.has(ip)) continue;
				const definitions = reaching[instruction.src]?.[ip];
				if (
					definitions !== undefined &&
					definitions.size > 0 &&
					[...definitions].every((definitionIp) => aliasDefinitions.has(definitionIp))
				) {
					aliasDefinitions.add(ip);
					aliasChanged = true;
				}
			}
		}
		const isAggregateUse = (register: number, ip: number): boolean => {
			const definitions = reaching[register]?.[ip];
			return (
				definitions !== undefined &&
				definitions.size > 0 &&
				[...definitions].every((definitionIp) => aliasDefinitions.has(definitionIp))
			);
		};
		const candidates = fn.instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "CALL" }>;
					ip: number;
				} => {
					if (
						entry.instruction.opcode !== "CALL" ||
						entry.instruction.arguments.length !== 1 ||
						entry.instruction.directFunctionIndex === undefined ||
						!reducerTargets.has(entry.instruction.directFunctionIndex) ||
						decodeVmValueOperand(entry.instruction.thisValue).kind !== "undefined"
					) {
						return false;
					}
					const argument = decodeVmValueOperand(entry.instruction.arguments[0]!);
					return (
						argument.kind === "register" && isAggregateUse(argument.register, entry.ip)
					);
				},
			);
		if (candidates.length !== 1) continue;
		const candidate = candidates[0]!;
		const callLoop = cfg.loops.find((loop) => loop.body.has(candidate.ip));
		if (callLoop === undefined || !cfg.dominators[candidate.ip]!.has(allocation.ip)) {
			continue;
		}
		const callee = decodeVmValueOperand(candidate.instruction.callee);
		const input = decodeVmValueOperand(candidate.instruction.arguments[0]!);
		if (callee.kind !== "register" || input.kind !== "register") continue;
		const reachesAny = (start: number, targets: ReadonlySet<number>): boolean => {
			const seen = new Set<number>();
			const work = [...cfg.successors[start]!];
			while (work.length > 0) {
				const ip = work.pop()!;
				if (targets.has(ip)) return true;
				if (seen.has(ip)) continue;
				seen.add(ip);
				work.push(...cfg.successors[ip]!);
			}
			return false;
		};
		const calleeDefinitions = reaching[callee.register]?.[candidate.ip];
		if (calleeDefinitions?.size !== 1) continue;
		let calleeDefinitionIp = [...calleeDefinitions][0]!;
		const seenCalleeDefinitions = new Set<number>();
		let provedCallee = false;
		while (!seenCalleeDefinitions.has(calleeDefinitionIp)) {
			seenCalleeDefinitions.add(calleeDefinitionIp);
			const definition = fn.instructions[calleeDefinitionIp];
			if (
				definition?.opcode === "CREATE_FUNCTION" &&
				definition.functionIndex === candidate.instruction.directFunctionIndex
			) {
				provedCallee = true;
				break;
			}
			if (definition?.opcode !== "MOVE") {
				calleeDefinitionIp = -1;
				break;
			}
			const previous = reaching[definition.src]?.[calleeDefinitionIp];
			if (previous?.size !== 1) {
				calleeDefinitionIp = -1;
				break;
			}
			calleeDefinitionIp = [...previous][0]!;
		}
		if (!provedCallee) continue;

		const pushes: Array<number> = [];
		let valid = true;
		for (let ip = 0; ip < fn.instructions.length && valid; ip++) {
			const instruction = fn.instructions[ip]!;
			const uses = privateAggregateUsedRegisters(instruction)!;
			for (const register of uses) {
				if (!isAggregateUse(register, ip)) continue;
				if (instruction.opcode === "MOVE" && instruction.src === register) continue;
				if (
					instruction.opcode === "LOAD_PROPERTY_STATIC" &&
					instruction.object === register &&
					staticStringEquals(definition, instruction.stringIndex, "push")
				) {
					continue;
				}
				if (instruction.opcode === "CALL") {
					const thisValue = decodeVmValueOperand(instruction.thisValue);
					const aggregateArguments = instruction.arguments.filter((argument) => {
						const decoded = decodeVmValueOperand(argument);
						return decoded.kind === "register" && isAggregateUse(decoded.register, ip);
					});
					if (instruction === candidate.instruction && aggregateArguments.length === 1) {
						continue;
					}
					if (
						vmCallProvesBuiltin(instruction, "Array.prototype.push") &&
						thisValue.kind === "register" &&
						isAggregateUse(thisValue.register, ip) &&
						aggregateArguments.length === 0 &&
						instruction.arguments.length === 1
					) {
						if (!pushes.includes(ip)) pushes.push(ip);
						continue;
					}
				}
				valid = false;
				break;
			}
		}
		if (!valid || pushes.length === 0) continue;
		const constructionTargets = new Set([allocation.ip, ...pushes]);
		if (
			pushes.some(
				(ip) =>
					ip >= candidate.ip ||
					callLoop.body.has(ip) ||
					!cfg.dominators[ip]!.has(allocation.ip),
			) ||
			reachesAny(candidate.ip, constructionTargets) ||
			pushes.some((pushIp) => reachesAny(pushIp, new Set([allocation.ip])))
		) {
			continue;
		}
		// The whole caller is closed: no other call or aggregate-observing operation
		// can re-enter JavaScript between construction and memo hits.
		if (
			fn.instructions.some(
				(instruction, ip) =>
					instruction.opcode === "CALL" && ip !== candidate.ip && !pushes.includes(ip),
			)
		) {
			continue;
		}
		fn.nativePrivateAggregateMemos = [
			{
				allocationIp: allocation.ip,
				constructionPushIps: pushes,
				callIp: candidate.ip,
				targetFunctionIndex: candidate.instruction.directFunctionIndex!,
				callee: callee.register,
				input: input.register,
				result: candidate.instruction.dst,
			},
		];
	}
}

/**
 * Recognize a deliberately narrow aggregate producer: scan one String by code
 * unit, append exactly one shaped record per unit to a fresh Array, count one
 * code unit value, and return `{array, count}`. Then recognize an exact caller
 * that observes only `array.length` and `count`.
 *
 * This runs after wire loading and annotates only native emission. The original
 * call and property instructions remain complete fallbacks, so no wire/runtime
 * semantics depend on the summary.
 */
function annotateNativeStringScanSummaries(definition: VmDefinition): void {
	const targets = new Map<number, NativeStringScanTarget>();
	for (
		let functionIndex = 0;
		functionIndex < definition.functions.length;
		functionIndex++
	) {
		const fn = definition.functions[functionIndex]!;
		if (
			fn.parameterCount !== 1 ||
			fn.isGenerator ||
			fn.isAsync ||
			fn.handlers.length > 0
		) {
			continue;
		}
		const instructions = fn.instructions;
		const arrays = instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "CREATE_ARRAY" }>;
					ip: number;
				} =>
					entry.instruction.opcode === "CREATE_ARRAY" && entry.instruction.length === 0,
			);
		const boundedCalls = instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "CALL" }>;
					ip: number;
				} =>
					entry.instruction.opcode === "CALL" &&
					entry.instruction.directStringCharCodeAtPosition === "inBounds",
			);
		const pushes = instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "CALL" }>;
					ip: number;
				} =>
					entry.instruction.opcode === "CALL" &&
					vmCallProvesBuiltin(entry.instruction, "Array.prototype.push"),
			);
		const returns = instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "RETURN" }>;
					ip: number;
				} => entry.instruction.opcode === "RETURN",
			);
		if (
			arrays.length !== 1 ||
			boundedCalls.length !== 1 ||
			pushes.length !== 2 ||
			returns.length !== 1
		) {
			continue;
		}
		const arrayAllocation = arrays[0]!;
		const arrayAliases = new Set<number>([arrayAllocation.instruction.dst]);
		for (const instruction of instructions) {
			if (instruction.opcode === "MOVE" && arrayAliases.has(instruction.src)) {
				arrayAliases.add(instruction.dst);
			}
		}
		if (
			pushes.some(
				(push) =>
					!arrayAliases.has(push.instruction.thisValue) ||
					push.instruction.arguments.length !== 1,
			)
		) {
			continue;
		}
		const bounded = boundedCalls[0]!.instruction;
		const parameterAliases = new Set<number>([0]);
		for (const instruction of instructions) {
			if (instruction.opcode === "MOVE" && parameterAliases.has(instruction.src)) {
				parameterAliases.add(instruction.dst);
			}
		}
		if (!parameterAliases.has(bounded.thisValue) || bounded.arguments.length !== 1)
			continue;
		const propertyLoads = instructions
			.map((instruction, ip) => ({ instruction, ip }))
			.filter(
				(
					entry,
				): entry is {
					instruction: Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
					ip: number;
				} => entry.instruction.opcode === "LOAD_PROPERTY_STATIC",
			);
		if (
			propertyLoads.length !== 4 ||
			propertyLoads.filter(
				(load) =>
					parameterAliases.has(load.instruction.object) &&
					staticStringEquals(definition, load.instruction.stringIndex, "length"),
			).length !== 1 ||
			propertyLoads.filter(
				(load) =>
					load.ip + 1 === boundedCalls[0]!.ip &&
					load.instruction.dst === bounded.callee &&
					parameterAliases.has(load.instruction.object) &&
					staticStringEquals(definition, load.instruction.stringIndex, "charCodeAt"),
			).length !== 1 ||
			pushes.some((push) => {
				let load: VmInstruction | undefined;
				for (let ip = push.ip - 1; ip >= 0; ip--) {
					if (vmInstructionDefinesRegister(instructions[ip]!, push.instruction.callee)) {
						load = instructions[ip];
						break;
					}
				}
				return (
					load?.opcode !== "LOAD_PROPERTY_STATIC" ||
					load.dst !== push.instruction.callee ||
					!arrayAliases.has(load.object) ||
					!staticStringEquals(definition, load.stringIndex, "push")
				);
			})
		) {
			continue;
		}
		const position = decodeVmValueOperand(bounded.arguments[0]!);
		if (position.kind !== "register") continue;

		const charAliases = new Set<number>([bounded.dst]);
		for (const instruction of instructions) {
			if (instruction.opcode === "MOVE" && charAliases.has(instruction.src)) {
				charAliases.add(instruction.dst);
			}
		}
		const comparisons = instructions.filter(
			(instruction): instruction is Extract<VmInstruction, { opcode: "BINARY" }> =>
				instruction.opcode === "BINARY" &&
				instruction.operator === "===" &&
				(charAliases.has(instruction.left) || charAliases.has(instruction.right)),
		);
		if (comparisons.length !== 1) continue;
		const comparison = comparisons[0]!;
		const needleRegister = charAliases.has(comparison.left)
			? comparison.right
			: comparison.left;
		const needleDefinitions = instructions.filter(
			(instruction): instruction is Extract<VmInstruction, { opcode: "CREATE_NUMBER" }> =>
				instruction.opcode === "CREATE_NUMBER" && instruction.dst === needleRegister,
		);
		if (
			needleDefinitions.length !== 1 ||
			!Number.isInteger(needleDefinitions[0]!.value) ||
			needleDefinitions[0]!.value < 0 ||
			needleDefinitions[0]!.value > 0xffff
		) {
			continue;
		}
		const comparisonIp = instructions.indexOf(comparison);
		const branch = instructions[comparisonIp + 1];
		const alternate = instructions[comparisonIp + 2];
		if (
			branch?.opcode !== "JUMP_IF" ||
			branch.cond !== comparison.dst ||
			alternate?.opcode !== "JUMP" ||
			branch.targetIp <= comparisonIp + 2 ||
			alternate.targetIp <= branch.targetIp
		) {
			continue;
		}
		const firstEnd = alternate.targetIp - 1;
		const secondEnd =
			instructions[firstEnd]?.opcode === "JUMP"
				? instructions[firstEnd].targetIp - 1
				: -1;
		if (
			firstEnd < branch.targetIp ||
			secondEnd < alternate.targetIp ||
			instructions[firstEnd]?.opcode !== "JUMP" ||
			instructions[secondEnd]?.opcode !== "JUMP" ||
			instructions[firstEnd].targetIp !== instructions[secondEnd].targetIp
		) {
			continue;
		}
		const firstPushCount = pushes.filter(
			(push) => push.ip >= branch.targetIp && push.ip <= firstEnd,
		).length;
		const secondPushCount = pushes.filter(
			(push) => push.ip >= alternate.targetIp && push.ip <= secondEnd,
		).length;
		if (firstPushCount !== 1 || secondPushCount !== 1) continue;

		const countUpdates = instructions.filter(
			(instruction): instruction is Extract<VmInstruction, { opcode: "UNARY" }> =>
				instruction.opcode === "UNARY" && instruction.operator === "increment",
		);
		if (countUpdates.length !== 2) continue;
		const induction = position.register;
		const matchUpdate = countUpdates.find(
			(instruction) => instruction.dst !== induction || instruction.src !== induction,
		);
		if (
			matchUpdate === undefined ||
			matchUpdate.dst !== matchUpdate.src ||
			!countUpdates.some(
				(instruction) => instruction.dst === induction && instruction.src === induction,
			)
		) {
			continue;
		}
		const matchUpdateIp = instructions.indexOf(matchUpdate);
		let matchInitial: VmInstruction | undefined;
		for (let ip = matchUpdateIp - 1; ip >= 0; ip--) {
			if (vmInstructionDefinesRegister(instructions[ip]!, matchUpdate.dst)) {
				matchInitial = instructions[ip];
				break;
			}
		}
		if (matchInitial?.opcode !== "CREATE_NUMBER" || matchInitial.value !== 0) continue;
		const matchOnFirst = matchUpdateIp >= branch.targetIp && matchUpdateIp <= firstEnd;
		const matchOnSecond =
			matchUpdateIp >= alternate.targetIp && matchUpdateIp <= secondEnd;
		if (matchOnFirst === matchOnSecond) continue;

		const returned = instructions[returns[0]!.ip - 1];
		if (
			returned?.opcode !== "CREATE_OBJECT_SHAPED" ||
			returns[0]!.instruction.value !== returned.dst ||
			returned.count !== 2
		) {
			continue;
		}
		const arrayField = returned.valueRegisters.findIndex((register) =>
			arrayAliases.has(register),
		);
		const matchField = returned.valueRegisters.indexOf(matchUpdate.dst);
		if (arrayField < 0 || matchField < 0 || arrayField === matchField) continue;

		// The accepted body is intentionally closed: besides charCodeAt and the two
		// pushes, no call may run user code, and every pushed value is a shaped literal.
		if (
			instructions.some(
				(instruction) =>
					instruction.opcode === "CALL" &&
					instruction !== bounded &&
					!pushes.some((push) => push.instruction === instruction),
			) ||
			pushes.some((push) => {
				const argument = decodeVmValueOperand(push.instruction.arguments[0]!);
				if (argument.kind !== "register") return true;
				return !instructions.some(
					(instruction) =>
						instruction.opcode === "CREATE_OBJECT_SHAPED" &&
						instruction.dst === argument.register,
				);
			})
		) {
			continue;
		}
		targets.set(functionIndex, {
			functionIndex,
			arrayKeyStringIndex: returned.keyStringIndices[arrayField]!,
			matchKeyStringIndex: returned.keyStringIndices[matchField]!,
			matchCodeUnit: needleDefinitions[0]!.value,
		});
	}

	if (targets.size === 0) return;
	for (const fn of definition.functions) {
		const regions: Array<NonNullable<VmFunction["nativeStringScanRegions"]>[number]> = [];
		for (let entryIp = 0; entryIp < fn.instructions.length; entryIp++) {
			const entry = fn.instructions[entryIp]!;
			if (entry.opcode !== "CREATE_ARRAY" || entry.length !== 0) continue;
			const position = definition.sourcePositions[fn.positions[entryIp] ?? -1];
			const inlinedFunctionIndex = position?.inlinedFunctionIndex;
			const callerPosId = position?.callerPosId;
			const target =
				inlinedFunctionIndex === undefined
					? undefined
					: targets.get(inlinedFunctionIndex);
			if (target === undefined || callerPosId === undefined) continue;

			let inlineEnd = entryIp;
			while (inlineEnd + 1 < fn.instructions.length) {
				const nextPosition =
					definition.sourcePositions[fn.positions[inlineEnd + 1] ?? -1];
				if (
					nextPosition?.inlinedFunctionIndex !== target.functionIndex ||
					nextPosition.callerPosId !== callerPosId
				) {
					break;
				}
				inlineEnd++;
			}
			const span = fn.instructions.slice(entryIp, inlineEnd + 1);
			const allowedRegionOpcodes = new Set<VmInstruction["opcode"]>([
				"CREATE_ARRAY",
				"MOVE",
				"CREATE_NUMBER",
				"JUMP",
				"LOAD_PROPERTY_STATIC",
				"BINARY",
				"JUMP_IF",
				"CALL",
				"CREATE_STRING",
				"CREATE_OBJECT_SHAPED",
				"UNARY",
			]);
			if (span.some((instruction) => !allowedRegionOpcodes.has(instruction.opcode))) {
				continue;
			}
			const boundedCalls = span
				.map((instruction, offset) => ({ instruction, ip: entryIp + offset }))
				.filter(
					(
						entry,
					): entry is {
						instruction: Extract<VmInstruction, { opcode: "CALL" }>;
						ip: number;
					} =>
						entry.instruction.opcode === "CALL" &&
						entry.instruction.directStringCharCodeAtPosition === "inBounds",
				);
			const pushes = span
				.map((instruction, offset) => ({ instruction, ip: entryIp + offset }))
				.filter(
					(
						entry,
					): entry is {
						instruction: Extract<VmInstruction, { opcode: "CALL" }>;
						ip: number;
					} =>
						entry.instruction.opcode === "CALL" &&
						vmCallProvesBuiltin(entry.instruction, "Array.prototype.push"),
				);
			if (boundedCalls.length !== 1 || pushes.length !== 2) continue;

			const arrayAliases = new Set<number>([entry.dst]);
			for (const instruction of span) {
				if (instruction.opcode === "MOVE" && arrayAliases.has(instruction.src)) {
					arrayAliases.add(instruction.dst);
				}
			}
			if (
				pushes.some(
					(push) =>
						!arrayAliases.has(push.instruction.thisValue) ||
						push.instruction.arguments.length !== 1,
				)
			) {
				continue;
			}
			const bounded = boundedCalls[0]!.instruction;
			const boundedIp = boundedCalls[0]!.ip;
			const indexOperand = decodeVmValueOperand(bounded.arguments[0]!);
			if (indexOperand.kind !== "register") continue;
			const comparisons = span.filter(
				(instruction): instruction is Extract<VmInstruction, { opcode: "BINARY" }> =>
					instruction.opcode === "BINARY" &&
					instruction.operator === "===" &&
					(instruction.left === bounded.dst || instruction.right === bounded.dst),
			);
			if (comparisons.length !== 1) continue;
			const comparison = comparisons[0]!;
			const needleRegister =
				comparison.left === bounded.dst ? comparison.right : comparison.left;
			const needleDefinitions = span.filter(
				(
					instruction,
				): instruction is Extract<VmInstruction, { opcode: "CREATE_NUMBER" }> =>
					instruction.opcode === "CREATE_NUMBER" && instruction.dst === needleRegister,
			);
			if (
				needleDefinitions.length !== 1 ||
				needleDefinitions[0]!.value !== target.matchCodeUnit
			) {
				continue;
			}

			const increments = span
				.map((instruction, offset) => ({ instruction, ip: entryIp + offset }))
				.filter(
					(
						entry,
					): entry is {
						instruction: Extract<VmInstruction, { opcode: "UNARY" }>;
						ip: number;
					} =>
						entry.instruction.opcode === "UNARY" &&
						entry.instruction.operator === "increment",
				);
			if (increments.length !== 2) continue;
			const indexIncrement = increments.find(
				(entry) =>
					entry.instruction.dst === indexOperand.register &&
					entry.instruction.src === indexOperand.register,
			);
			const matchIncrement = increments.find((entry) => entry !== indexIncrement);
			if (
				indexIncrement === undefined ||
				matchIncrement === undefined ||
				matchIncrement.instruction.dst !== matchIncrement.instruction.src
			) {
				continue;
			}
			const latestDefinitionBefore = (register: number, beforeIp: number) => {
				for (let ip = beforeIp - 1; ip >= entryIp; ip--) {
					if (vmInstructionDefinesRegister(fn.instructions[ip]!, register))
						return fn.instructions[ip];
				}
				return undefined;
			};
			const matchInitial = latestDefinitionBefore(
				matchIncrement.instruction.dst,
				matchIncrement.ip,
			);
			const indexInitial = latestDefinitionBefore(indexOperand.register, boundedIp);
			if (
				matchInitial?.opcode !== "CREATE_NUMBER" ||
				matchInitial.value !== 0 ||
				indexInitial?.opcode !== "CREATE_NUMBER" ||
				indexInitial.value !== 0
			) {
				continue;
			}

			const exitJump = span.find(
				(instruction): instruction is Extract<VmInstruction, { opcode: "JUMP" }> =>
					instruction.opcode === "JUMP" && instruction.targetIp === inlineEnd + 1,
			);
			if (exitJump === undefined) continue;
			let lengthLoadIp = -1;
			for (
				let ip = inlineEnd + 1;
				ip <= Math.min(inlineEnd + 8, fn.instructions.length - 1);
				ip++
			) {
				const instruction = fn.instructions[ip]!;
				if (
					instruction.opcode === "LOAD_PROPERTY_STATIC" &&
					arrayAliases.has(instruction.object) &&
					staticStringEquals(definition, instruction.stringIndex, "length")
				) {
					lengthLoadIp = ip;
					break;
				}
			}
			if (lengthLoadIp < 0) continue;
			const lengthLoad = fn.instructions[lengthLoadIp]!;
			if (lengthLoad.opcode !== "LOAD_PROPERTY_STATIC") continue;

			const definedInRegion = new Set<number>();
			for (const instruction of span) {
				const dst = (instruction as { dst?: number }).dst;
				if (dst !== undefined) definedInRegion.add(dst);
			}
			definedInRegion.delete(bounded.thisValue);
			let liveOutIsClosed = true;
			for (const register of definedInRegion) {
				if (register === matchIncrement.instruction.dst) continue;
				for (let ip = inlineEnd + 1; ip < fn.instructions.length; ip++) {
					const instruction = fn.instructions[ip]!;
					if (vmInstructionUsesRegister(instruction, register)) {
						if (ip === lengthLoadIp && arrayAliases.has(register)) break;
						liveOutIsClosed = false;
						break;
					}
					if (vmInstructionDefinesRegister(instruction, register)) break;
				}
				if (!liveOutIsClosed) break;
			}
			if (!liveOutIsClosed) continue;

			regions.push({
				entryIp,
				exitIp: inlineEnd + 1,
				input: bounded.thisValue,
				lengthLoadIp,
				lengthResult: lengthLoad.dst,
				matchResult: matchIncrement.instruction.dst,
				matchCodeUnit: target.matchCodeUnit,
			});
			entryIp = inlineEnd;
		}
		if (regions.length > 0) fn.nativeStringScanRegions = regions;
		else delete fn.nativeStringScanRegions;
	}
}

/**
 * Replace an exact builtin String split Array with a rooted projection when all
 * uses are constant element reads and/or `length`. The complete call and loads
 * remain as the guard-miss path.
 */
function annotateNativeStringSplitProjections(definition: VmDefinition): void {
	const splitEffects = [
		"coerce",
		"property-access",
		"call-user-code",
		"allocate",
		"throw",
		"safepoint",
	] as const;
	for (const fn of definition.functions) {
		const projections: Array<
			NonNullable<VmFunction["nativeStringSplitProjections"]>[number]
		> = [];
		const jumpTargets = new Set<number>();
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
				jumpTargets.add(instruction.targetIp);
			}
		}
		const latestDefinition = (register: number, beforeIp: number) => {
			for (let ip = beforeIp - 1; ip >= 0; ip--) {
				if (vmInstructionDefinesRegister(fn.instructions[ip]!, register)) {
					return { instruction: fn.instructions[ip]!, ip };
				}
			}
			return undefined;
		};
		for (let callIp = 1; callIp < fn.instructions.length; callIp++) {
			const call = fn.instructions[callIp]!;
			const load = fn.instructions[callIp - 1]!;
			if (
				call.opcode !== "CALL" ||
				!vmCallProvesBuiltin(call, "String.prototype.split", {
					lowering: "projected-string-split",
					result: "array-of-strings",
					effects: splitEffects,
				}) ||
				call.arguments.length !== 1 ||
				load.opcode !== "LOAD_PROPERTY_STATIC" ||
				load.dst !== call.callee ||
				load.object !== call.thisValue ||
				!staticStringEquals(definition, load.stringIndex, "split") ||
				jumpTargets.has(callIp)
			) {
				continue;
			}
			const separator = decodeVmValueOperand(call.arguments[0]!);
			if (
				separator.kind !== "string" ||
				(definition.stringConstants[separator.index]?.length ?? 0) === 0
			) {
				continue;
			}

			const aliases = new Set<number>([call.dst]);
			const loads: Array<
				NonNullable<VmFunction["nativeStringSplitProjections"]>[number]["loads"][number]
			> = [];
			const indices = new Set<number>();
			let lengthSeen = false;
			let safe = true;
			for (let ip = callIp + 1; ip < fn.instructions.length && aliases.size > 0; ip++) {
				const instruction = fn.instructions[ip]!;
				const usedAliases = [...aliases].filter((alias) =>
					vmInstructionUsesRegister(instruction, alias),
				);
				let accepted = usedAliases.length === 0;
				if (
					instruction.opcode === "MOVE" &&
					usedAliases.length === 1 &&
					usedAliases[0] === instruction.src
				) {
					accepted = true;
				} else if (
					instruction.opcode === "LOAD_PROPERTY_STATIC" &&
					aliases.has(instruction.object) &&
					staticStringEquals(definition, instruction.stringIndex, "length") &&
					!lengthSeen
				) {
					loads.push({ ip, kind: "length", dst: instruction.dst });
					lengthSeen = true;
					accepted = true;
				} else if (
					instruction.opcode === "LOAD_PROPERTY" &&
					aliases.has(instruction.object)
				) {
					const key = latestDefinition(instruction.key, ip);
					if (
						key?.instruction.opcode === "CREATE_NUMBER" &&
						Number.isInteger(key.instruction.value) &&
						key.instruction.value >= 0 &&
						key.instruction.value <= 0xffff &&
						![...jumpTargets, ...fn.handlers.map((handler) => handler.handlerIp)].some(
							(targetIp) => targetIp > key.ip && targetIp <= ip,
						) &&
						!indices.has(key.instruction.value)
					) {
						loads.push({
							ip,
							kind: "element",
							index: key.instruction.value,
							dst: instruction.dst,
						});
						indices.add(key.instruction.value);
						accepted = true;
					}
				}
				if (!accepted) {
					safe = false;
					break;
				}

				for (const alias of [...aliases]) {
					if (vmInstructionDefinesRegister(instruction, alias)) aliases.delete(alias);
				}
				if (instruction.opcode === "MOVE" && usedAliases.includes(instruction.src)) {
					aliases.add(instruction.dst);
				}
			}
			const elementLoads = loads.filter((entry) => entry.kind === "element");
			if (!safe || elementLoads.length === 0 || elementLoads.length > 8) {
				continue;
			}
			const license = vmRegionLicense([call.guardedBuiltinCall?.guard], "whole-region");
			if (license === undefined) continue;
			projections.push({
				license,
				resultRepresentation: "projected-elements",
				propertyIp: callIp - 1,
				callIp,
				callee: call.callee,
				receiver: call.thisValue,
				separatorStringIndex: separator.index,
				result: call.dst,
				loads,
			});
		}
		if (projections.length > 0) fn.nativeStringSplitProjections = projections;
		else delete fn.nativeStringSplitProjections;
	}
}

/** Stream one closed indexed String#split loop and materialize only trimmed elements. */
function annotateNativeStringSplitCursors(definition: VmDefinition): void {
	const splitEffects = [
		"coerce",
		"property-access",
		"call-user-code",
		"allocate",
		"throw",
		"safepoint",
	] as const;
	const trimEffects = ["coerce", "allocate", "throw", "safepoint"] as const;
	for (const fn of definition.functions) {
		const cursors: Array<NonNullable<VmFunction["nativeStringSplitCursors"]>[number]> =
			[];
		const latestDefinition = (register: number, beforeIp: number) => {
			for (let ip = beforeIp - 1; ip >= 0; ip--) {
				if (vmInstructionDefinesRegister(fn.instructions[ip]!, register)) {
					return { instruction: fn.instructions[ip]!, ip };
				}
			}
			return undefined;
		};
		const usesRegister = (instruction: VmInstruction, register: number): boolean => {
			if (
				instruction.opcode === "CREATE_NUMBER" ||
				instruction.opcode === "CREATE_F64" ||
				instruction.opcode === "CREATE_BOOLEAN"
			) {
				return false;
			}
			return vmInstructionUsesRegister(instruction, register);
		};
		const instructionDominates = (dominatorIp: number, targetIp: number): boolean => {
			const pending = [0];
			const visited = new Set<number>();
			while (pending.length > 0) {
				const ip = pending.pop()!;
				if (ip < 0 || ip >= fn.instructions.length || visited.has(ip)) continue;
				visited.add(ip);
				if (ip === dominatorIp) continue;
				if (ip === targetIp) return false;
				const instruction = fn.instructions[ip]!;
				if (instruction.opcode === "JUMP") {
					pending.push(instruction.targetIp);
				} else if (instruction.opcode === "JUMP_IF") {
					pending.push(instruction.targetIp, ip + 1);
				} else if (instruction.opcode !== "RETURN" && instruction.opcode !== "THROW") {
					pending.push(ip + 1);
				}
				for (const handler of fn.handlers) {
					if (ip >= handler.startIp && ip < handler.endIp)
						pending.push(handler.handlerIp);
				}
			}
			return true;
		};
		const isReachableAvoiding = (
			startIp: number,
			targetIp: number,
			blockedIp: number,
		): boolean => {
			const pending = [startIp];
			const visited = new Set<number>();
			while (pending.length > 0) {
				const ip = pending.pop()!;
				if (
					ip < 0 ||
					ip >= fn.instructions.length ||
					ip === blockedIp ||
					visited.has(ip)
				) {
					continue;
				}
				if (ip === targetIp) return true;
				visited.add(ip);
				const instruction = fn.instructions[ip]!;
				if (instruction.opcode === "JUMP") {
					pending.push(instruction.targetIp);
				} else if (instruction.opcode === "JUMP_IF") {
					pending.push(instruction.targetIp, ip + 1);
				} else if (instruction.opcode !== "RETURN" && instruction.opcode !== "THROW") {
					pending.push(ip + 1);
				}
				for (const handler of fn.handlers) {
					if (ip >= handler.startIp && ip < handler.endIp)
						pending.push(handler.handlerIp);
				}
			}
			return false;
		};
		const jumpEdges = fn.instructions.flatMap((instruction, sourceIp) =>
			instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF"
				? [{ sourceIp, targetIp: instruction.targetIp }]
				: [],
		);
		for (let callIp = 0; callIp < fn.instructions.length; callIp++) {
			const call = fn.instructions[callIp]!;
			if (
				call.opcode !== "CALL" ||
				!vmCallProvesBuiltin(call, "String.prototype.split", {
					lowering: "closed-string-split",
					result: "array-of-strings",
					effects: splitEffects,
				}) ||
				call.arguments.length !== 1
			)
				continue;
			const callee = decodeVmValueOperand(call.callee);
			const receiver = decodeVmValueOperand(call.thisValue);
			const separator = decodeVmValueOperand(call.arguments[0]!);
			if (
				callee.kind !== "register" ||
				receiver.kind !== "register" ||
				separator.kind !== "register"
			) {
				continue;
			}
			const calleeDefinition = latestDefinition(callee.register, callIp);
			if (
				calleeDefinition?.instruction.opcode !== "LOAD_PROPERTY_STATIC" ||
				calleeDefinition.instruction.object !== receiver.register ||
				!staticStringEquals(definition, calleeDefinition.instruction.stringIndex, "split")
			) {
				continue;
			}
			if (
				fn.instructions
					.slice(calleeDefinition.ip + 1, callIp)
					.some((instruction) =>
						vmInstructionDefinesRegister(instruction, receiver.register),
					)
			) {
				continue;
			}
			const alias = fn.instructions[callIp + 1];
			if (alias?.opcode !== "MOVE" || alias.src !== call.dst) continue;
			let lengthIp = -1;
			for (let ip = callIp + 2; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (usesRegister(instruction, alias.dst)) {
					if (
						instruction.opcode === "LOAD_PROPERTY_STATIC" &&
						instruction.object === alias.dst &&
						staticStringEquals(definition, instruction.stringIndex, "length")
					) {
						lengthIp = ip;
					}
					break;
				}
				if (vmInstructionDefinesRegister(instruction, alias.dst)) break;
			}
			if (lengthIp < 1) continue;
			const length = fn.instructions[lengthIp]!;
			const compare = fn.instructions[lengthIp + 1];
			const bodyBranch = fn.instructions[lengthIp + 2];
			const exitJump = fn.instructions[lengthIp + 3];
			const elementIp = lengthIp + 4;
			const element = fn.instructions[elementIp];
			const trimProperty = fn.instructions[elementIp + 1];
			const trimCall = fn.instructions[elementIp + 2];
			if (
				length.opcode !== "LOAD_PROPERTY_STATIC" ||
				compare?.opcode !== "BINARY" ||
				compare.operator !== "<" ||
				compare.right !== length.dst ||
				bodyBranch?.opcode !== "JUMP_IF" ||
				bodyBranch.cond !== compare.dst ||
				bodyBranch.targetIp !== elementIp ||
				exitJump?.opcode !== "JUMP" ||
				element?.opcode !== "LOAD_PROPERTY" ||
				element.object !== alias.dst ||
				element.key !== compare.left ||
				trimProperty?.opcode !== "LOAD_PROPERTY_STATIC" ||
				trimProperty.object !== element.dst ||
				!staticStringEquals(definition, trimProperty.stringIndex, "trim") ||
				trimCall?.opcode !== "CALL" ||
				!vmCallProvesBuiltin(trimCall, "String.prototype.trim", {
					lowering: "split-cursor-span",
					result: "string",
					effects: trimEffects,
				}) ||
				trimCall.callee !== trimProperty.dst ||
				trimCall.thisValue !== element.dst ||
				trimCall.arguments.length !== 0
			) {
				continue;
			}
			const index = compare.left;
			const backedges = jumpEdges.filter((edge) => edge.targetIp === lengthIp);
			if (backedges.length !== 2) continue;
			const preheader = backedges.find((edge) => edge.sourceIp === lengthIp - 1);
			const backedge = backedges.find((edge) => edge.sourceIp > elementIp + 2);
			if (preheader === undefined || backedge === undefined) continue;
			const increment = fn.instructions[backedge.sourceIp - 1];
			const indexDefinition = latestDefinition(index, lengthIp);
			if (
				increment?.opcode !== "UNARY" ||
				increment.operator !== "increment" ||
				increment.src !== index ||
				increment.dst !== index ||
				exitJump.targetIp !== backedge.sourceIp + 1 ||
				indexDefinition?.instruction.opcode !== "CREATE_NUMBER" ||
				!Object.is(indexDefinition.instruction.value, 0) ||
				!instructionDominates(indexDefinition.ip, lengthIp) ||
				!instructionDominates(callIp, lengthIp) ||
				isReachableAvoiding(exitJump.targetIp, lengthIp, callIp) ||
				fn.handlers.some(
					(handler) =>
						handler.handlerIp >= lengthIp && handler.handlerIp <= elementIp + 2,
				)
			) {
				continue;
			}
			const unexpectedEntry = jumpEdges.some((edge) => {
				if (edge.targetIp < lengthIp || edge.targetIp > backedge.sourceIp) return false;
				if (edge.targetIp === lengthIp) {
					return edge.sourceIp !== lengthIp - 1 && edge.sourceIp !== backedge.sourceIp;
				}
				if (edge.targetIp >= elementIp && edge.targetIp <= elementIp + 2) {
					return edge.sourceIp !== lengthIp + 2 || edge.targetIp !== elementIp;
				}
				return edge.sourceIp <= callIp || edge.sourceIp > backedge.sourceIp;
			});
			if (
				unexpectedEntry ||
				fn.instructions.some((instruction, sourceIp) => {
					if (sourceIp < elementIp || sourceIp > backedge.sourceIp) return false;
					const successors =
						instruction.opcode === "JUMP"
							? [instruction.targetIp]
							: instruction.opcode === "JUMP_IF"
								? [instruction.targetIp, sourceIp + 1]
								: instruction.opcode === "RETURN" || instruction.opcode === "THROW"
									? []
									: [sourceIp + 1];
					return successors.some(
						(targetIp) =>
							!(sourceIp === backedge.sourceIp && targetIp === lengthIp) &&
							(targetIp < elementIp || targetIp > backedge.sourceIp) &&
							isReachableAvoiding(targetIp, lengthIp, callIp),
					);
				}) ||
				fn.handlers.some(
					(handler) =>
						(handler.handlerIp >= lengthIp && handler.handlerIp <= backedge.sourceIp) ||
						(handler.startIp <= backedge.sourceIp && handler.endIp > elementIp),
				)
			) {
				continue;
			}

			let closed = true;
			let callResultLive = true;
			let aliasLive = true;
			for (let ip = callIp + 1; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (
					callResultLive &&
					usesRegister(instruction, call.dst) &&
					!(ip === callIp + 1 && instruction === alias)
				) {
					closed = false;
					break;
				}
				if (
					aliasLive &&
					usesRegister(instruction, alias.dst) &&
					ip !== lengthIp &&
					ip !== elementIp
				) {
					closed = false;
					break;
				}
				if (ip > callIp + 1 && vmInstructionDefinesRegister(instruction, call.dst)) {
					callResultLive = false;
				}
				if (ip > callIp + 1 && vmInstructionDefinesRegister(instruction, alias.dst)) {
					aliasLive = false;
				}
				if (!callResultLive && !aliasLive) break;
			}
			for (let ip = lengthIp; closed && ip <= backedge.sourceIp; ip++) {
				const instruction = fn.instructions[ip]!;
				if (
					usesRegister(instruction, index) &&
					ip !== lengthIp + 1 &&
					ip !== elementIp &&
					ip !== backedge.sourceIp - 1
				) {
					closed = false;
				}
			}
			let elementLive = true;
			for (
				let ip = elementIp + 1;
				closed && elementLive && ip < fn.instructions.length;
				ip++
			) {
				const instruction = fn.instructions[ip]!;
				if (
					usesRegister(instruction, element.dst) &&
					ip !== elementIp + 1 &&
					ip !== elementIp + 2
				) {
					closed = false;
					break;
				}
				if (vmInstructionDefinesRegister(instruction, element.dst)) elementLive = false;
			}
			if (!closed) continue;
			const license = vmRegionLicense(
				[call.guardedBuiltinCall?.guard, trimCall.guardedBuiltinCall?.guard],
				"on-demand",
			);
			if (license === undefined) continue;
			const primitiveStringLengthIps: Array<number> = [];
			const trimResultAliases = new Set([trimCall.dst]);
			for (let ip = elementIp + 3; ip <= backedge.sourceIp; ip++) {
				const instruction = fn.instructions[ip]!;
				if (
					instruction.opcode === "LOAD_PROPERTY_STATIC" &&
					trimResultAliases.has(instruction.object) &&
					staticStringEquals(definition, instruction.stringIndex, "length")
				) {
					primitiveStringLengthIps.push(ip);
				}
				const moveAlias =
					instruction.opcode === "MOVE" && trimResultAliases.has(instruction.src);
				for (const alias of [...trimResultAliases]) {
					if (vmInstructionDefinesRegister(instruction, alias)) {
						trimResultAliases.delete(alias);
					}
				}
				if (moveAlias) trimResultAliases.add(instruction.dst);
			}
			cursors.push({
				license,
				resultRepresentation: "split-cursor-spans",
				propertyIp: calleeDefinition.ip,
				callIp,
				callee: call.callee,
				receiver: call.thisValue,
				separator: call.arguments[0]!,
				result: call.dst,
				index,
				lengthIp,
				elementIp,
				trimPropertyIp: elementIp + 1,
				trimIcIndex: trimProperty.icIndex,
				trimCallIp: elementIp + 2,
				primitiveStringLengthIps,
				backedgeIp: backedge.sourceIp,
				exitIp: exitJump.targetIp,
			});
		}
		if (cursors.length > 0) fn.nativeStringSplitCursors = cursors;
		else delete fn.nativeStringSplitCursors;
	}
}

/**
 * Replace a closed exact RegExp.prototype.exec result with selected capture
 * values. The ordinary result Array remains the complete guard-miss path; a
 * guarded hit exposes only a null/non-null marker plus constant capture loads.
 */
function annotateNativeRegExpExecProjections(definition: VmDefinition): void {
	const execEffects = [
		"coerce",
		"property-access",
		"allocate",
		"throw",
		"safepoint",
	] as const;
	for (const fn of definition.functions) {
		const projections: Array<
			NonNullable<VmFunction["nativeRegExpExecProjections"]>[number]
		> = [];
		const entryTargets = new Set<number>(fn.handlers.map((handler) => handler.handlerIp));
		const jumpEdges: Array<{ sourceIp: number; targetIp: number }> = [];
		for (const [sourceIp, instruction] of fn.instructions.entries()) {
			if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
				entryTargets.add(instruction.targetIp);
				jumpEdges.push({ sourceIp, targetIp: instruction.targetIp });
			}
		}
		const latestDefinition = (register: number, beforeIp: number) => {
			for (let ip = beforeIp - 1; ip >= 0; ip--) {
				if (vmInstructionDefinesRegister(fn.instructions[ip]!, register)) {
					return { instruction: fn.instructions[ip]!, ip };
				}
			}
			return undefined;
		};
		const hasOnlyUsesUntilRedefinition = (
			register: number,
			startIp: number,
			allowedUses: ReadonlySet<number>,
		): boolean => {
			for (let ip = startIp; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (vmInstructionUsesRegister(instruction, register) && !allowedUses.has(ip)) {
					return false;
				}
				if (vmInstructionDefinesRegister(instruction, register)) return true;
			}
			return true;
		};
		const instructionDominates = (dominatorIp: number, targetIp: number): boolean => {
			const pending = [0];
			const visited = new Set<number>();
			while (pending.length > 0) {
				const ip = pending.pop()!;
				if (ip < 0 || ip >= fn.instructions.length || visited.has(ip)) continue;
				visited.add(ip);
				if (ip === dominatorIp) continue;
				if (ip === targetIp) return false;
				const instruction = fn.instructions[ip]!;
				if (instruction.opcode === "JUMP") {
					pending.push(instruction.targetIp);
				} else if (instruction.opcode === "JUMP_IF") {
					pending.push(instruction.targetIp, ip + 1);
				} else if (instruction.opcode !== "RETURN" && instruction.opcode !== "THROW") {
					pending.push(ip + 1);
				}
				for (const handler of fn.handlers) {
					if (ip >= handler.startIp && ip < handler.endIp)
						pending.push(handler.handlerIp);
				}
			}
			return true;
		};

		for (let callIp = 1; callIp < fn.instructions.length; callIp++) {
			const call = fn.instructions[callIp]!;
			const load = fn.instructions[callIp - 1]!;
			if (
				call.opcode !== "CALL" ||
				!vmCallProvesBuiltin(call, "RegExp.prototype.exec", {
					lowering: "capture-projection",
					result: "regexp-match-or-null",
					effects: execEffects,
				}) ||
				call.arguments.length !== 1 ||
				load.opcode !== "LOAD_PROPERTY_STATIC" ||
				load.dst !== call.callee ||
				load.object !== call.thisValue ||
				!staticStringEquals(definition, load.stringIndex, "exec") ||
				entryTargets.has(callIp)
			) {
				continue;
			}

			const immediateAlias = fn.instructions[callIp + 1];
			if (
				immediateAlias?.opcode !== "MOVE" ||
				immediateAlias.src !== call.dst ||
				entryTargets.has(callIp + 1)
			) {
				continue;
			}
			const stableAlias = immediateAlias.dst;
			const aliases = new Set<number>([call.dst, stableAlias]);
			const loads: Array<
				NonNullable<VmFunction["nativeRegExpExecProjections"]>[number]["loads"][number]
			> = [];
			const captureIndices = new Set<number>();
			let safe = true;
			for (let ip = callIp + 2; ip < fn.instructions.length && aliases.size > 0; ip++) {
				const instruction = fn.instructions[ip]!;
				const usedAliases = [...aliases].filter(
					(alias) =>
						instruction.opcode !== "CREATE_NUMBER" &&
						instruction.opcode !== "CREATE_F64" &&
						vmInstructionUsesRegister(instruction, alias),
				);
				let accepted = usedAliases.length === 0;
				if (
					instruction.opcode === "BINARY" &&
					(instruction.operator === "===" || instruction.operator === "!==") &&
					usedAliases.length === 1
				) {
					const other = aliases.has(instruction.left)
						? instruction.right
						: instruction.left;
					const definition = latestDefinition(other, ip);
					accepted =
						definition?.instruction.opcode === "CREATE_NULL" &&
						![...entryTargets].some(
							(targetIp) => targetIp > definition.ip && targetIp <= ip,
						);
				} else if (
					instruction.opcode === "LOAD_PROPERTY" &&
					instruction.object === stableAlias &&
					usedAliases.length === 1
				) {
					const key = latestDefinition(instruction.key, ip);
					if (
						key?.instruction.opcode === "CREATE_NUMBER" &&
						Number.isInteger(key.instruction.value) &&
						key.instruction.value > 0 &&
						key.instruction.value <= 0xffff &&
						![...entryTargets].some((targetIp) => targetIp > key.ip && targetIp <= ip) &&
						!captureIndices.has(key.instruction.value)
					) {
						loads.push({
							ip,
							captureIndex: key.instruction.value,
							dst: instruction.dst,
						});
						captureIndices.add(key.instruction.value);
						accepted = true;
					}
				}
				if (!accepted) {
					safe = false;
					break;
				}

				for (const alias of [...aliases]) {
					if (vmInstructionDefinesRegister(instruction, alias)) aliases.delete(alias);
				}
			}
			for (const captureLoad of loads) {
				const property = fn.instructions[captureLoad.ip + 1];
				const upperProperty = property;
				const upperCall = fn.instructions[captureLoad.ip + 2];
				const lowerProperty = fn.instructions[captureLoad.ip + 3];
				const lowerCall = fn.instructions[captureLoad.ip + 4];
				const possibleCaseMove = fn.instructions[captureLoad.ip + 5];
				const caseMove =
					possibleCaseMove?.opcode === "MOVE" &&
					lowerCall?.opcode === "CALL" &&
					possibleCaseMove.src === lowerCall.dst
						? possibleCaseMove
						: undefined;
				const caseResult =
					caseMove?.dst ?? (lowerCall?.opcode === "CALL" ? lowerCall.dst : -1);
				const caseSearchStart = captureLoad.ip + (caseMove === undefined ? 5 : 6);
				let caseLengthIp = -1;
				for (let ip = caseSearchStart; ip < fn.instructions.length; ip++) {
					const instruction = fn.instructions[ip]!;
					if (vmInstructionUsesRegister(instruction, caseResult)) {
						if (
							instruction.opcode === "LOAD_PROPERTY_STATIC" &&
							instruction.object === caseResult &&
							staticStringEquals(definition, instruction.stringIndex, "length")
						) {
							caseLengthIp = ip;
						}
						break;
					}
					if (vmInstructionDefinesRegister(instruction, caseResult)) break;
				}
				const caseLength = fn.instructions[caseLengthIp];
				if (
					upperProperty?.opcode === "LOAD_PROPERTY_STATIC" &&
					upperProperty.object === captureLoad.dst &&
					staticStringEquals(definition, upperProperty.stringIndex, "toUpperCase") &&
					upperCall?.opcode === "CALL" &&
					upperCall.callee === upperProperty.dst &&
					upperCall.thisValue === captureLoad.dst &&
					upperCall.arguments.length === 0 &&
					lowerProperty?.opcode === "LOAD_PROPERTY_STATIC" &&
					lowerProperty.object === upperCall.dst &&
					staticStringEquals(definition, lowerProperty.stringIndex, "toLowerCase") &&
					lowerCall?.opcode === "CALL" &&
					lowerCall.callee === lowerProperty.dst &&
					lowerCall.thisValue === upperCall.dst &&
					lowerCall.arguments.length === 0 &&
					caseLength?.opcode === "LOAD_PROPERTY_STATIC" &&
					caseLength.object === caseResult &&
					staticStringEquals(definition, caseLength.stringIndex, "length") &&
					![
						captureLoad.ip + 1,
						captureLoad.ip + 2,
						captureLoad.ip + 3,
						captureLoad.ip + 4,
						...(caseMove === undefined ? [] : [captureLoad.ip + 5]),
					].some((ip) => entryTargets.has(ip)) &&
					hasOnlyUsesUntilRedefinition(
						captureLoad.dst,
						captureLoad.ip + 1,
						new Set([captureLoad.ip + 1, captureLoad.ip + 2]),
					) &&
					hasOnlyUsesUntilRedefinition(
						upperProperty.dst,
						captureLoad.ip + 2,
						new Set([captureLoad.ip + 2]),
					) &&
					hasOnlyUsesUntilRedefinition(
						upperCall.dst,
						captureLoad.ip + 3,
						new Set([captureLoad.ip + 3, captureLoad.ip + 4]),
					) &&
					hasOnlyUsesUntilRedefinition(
						lowerProperty.dst,
						captureLoad.ip + 4,
						new Set([captureLoad.ip + 4]),
					) &&
					hasOnlyUsesUntilRedefinition(
						lowerCall.dst,
						captureLoad.ip + 5,
						new Set(caseMove === undefined ? [caseLengthIp] : [captureLoad.ip + 5]),
					) &&
					(caseMove === undefined ||
						hasOnlyUsesUntilRedefinition(
							caseMove.dst,
							captureLoad.ip + 6,
							new Set([caseLengthIp]),
						)) &&
					caseLengthIp >= caseSearchStart
				) {
					captureLoad.consumer = {
						kind: "asciiCaseLength",
						upperPropertyIp: captureLoad.ip + 1,
						upperCallIp: captureLoad.ip + 2,
						lowerPropertyIp: captureLoad.ip + 3,
						lowerIcIndex: lowerProperty.icIndex,
						lowerCallIp: captureLoad.ip + 4,
						lengthPropertyIp: caseLengthIp,
					};
					continue;
				}
				if (
					property?.opcode === "LOAD_PROPERTY_STATIC" &&
					property.object === captureLoad.dst &&
					staticStringEquals(definition, property.stringIndex, "length") &&
					hasOnlyUsesUntilRedefinition(
						captureLoad.dst,
						captureLoad.ip + 1,
						new Set([captureLoad.ip + 1]),
					)
				) {
					captureLoad.consumer = { kind: "length", propertyIp: captureLoad.ip + 1 };
					continue;
				}

				const charProperty = property;
				const afterProperty = fn.instructions[captureLoad.ip + 2];
				const zero =
					afterProperty?.opcode === "CREATE_NUMBER" ? afterProperty : undefined;
				const charCallIp = captureLoad.ip + (zero === undefined ? 2 : 3);
				const charCall = fn.instructions[charCallIp];
				const charArgument =
					charCall?.opcode === "CALL" && charCall.arguments[0] !== undefined
						? decodeVmValueOperand(charCall.arguments[0])
						: undefined;
				if (
					charProperty?.opcode === "LOAD_PROPERTY_STATIC" &&
					charProperty.object === captureLoad.dst &&
					staticStringEquals(definition, charProperty.stringIndex, "charCodeAt") &&
					charCall?.opcode === "CALL" &&
					charCall.callee === charProperty.dst &&
					charCall.thisValue === captureLoad.dst &&
					charCall.arguments.length === 1 &&
					((zero !== undefined &&
						Object.is(zero.value, 0) &&
						charArgument?.kind === "register" &&
						charArgument.register === zero.dst) ||
						(charArgument?.kind === "number" && Object.is(charArgument.value, 0))) &&
					hasOnlyUsesUntilRedefinition(
						captureLoad.dst,
						captureLoad.ip + 1,
						new Set([captureLoad.ip + 1, charCallIp]),
					) &&
					hasOnlyUsesUntilRedefinition(
						charProperty.dst,
						captureLoad.ip + 2,
						new Set([charCallIp]),
					)
				) {
					captureLoad.consumer = {
						kind: "charCodeAtZero",
						propertyIp: captureLoad.ip + 1,
						callIp: charCallIp,
					};
					continue;
				}

				const numberCall = fn.instructions[captureLoad.ip + 1];
				const numberArgument =
					numberCall?.opcode === "CALL" && numberCall.arguments[0] !== undefined
						? decodeVmValueOperand(numberCall.arguments[0])
						: undefined;
				const numberDefinition =
					numberCall?.opcode === "CALL"
						? latestDefinition(numberCall.callee, captureLoad.ip)
						: undefined;
				if (
					numberCall?.opcode === "CALL" &&
					numberCall.arguments.length === 1 &&
					numberArgument?.kind === "register" &&
					numberArgument.register === captureLoad.dst &&
					numberDefinition?.instruction.opcode === "LOAD_INTRINSIC" &&
					numberDefinition.instruction.intrinsic === "Number" &&
					![...entryTargets].some(
						(targetIp) =>
							targetIp > numberDefinition.ip && targetIp <= captureLoad.ip + 1,
					) &&
					hasOnlyUsesUntilRedefinition(
						captureLoad.dst,
						captureLoad.ip + 1,
						new Set([captureLoad.ip + 1]),
					)
				) {
					captureLoad.consumer = { kind: "number", callIp: captureLoad.ip + 1 };
				}
			}
			const lastLoadIp = loads.at(-1)?.ip ?? -1;
			const lastRegionIp = Math.max(
				lastLoadIp,
				...loads.map((entry) =>
					entry.consumer?.kind === "charCodeAtZero" || entry.consumer?.kind === "number"
						? entry.consumer.callIp
						: entry.consumer?.kind === "asciiCaseLength"
							? entry.consumer.lengthPropertyIp
							: (entry.consumer?.propertyIp ?? entry.ip),
				),
			);
			const hasInteriorEntry =
				fn.handlers.some(
					(handler) => handler.handlerIp > callIp && handler.handlerIp <= lastRegionIp,
				) ||
				jumpEdges.some(
					({ sourceIp, targetIp }) =>
						targetIp > callIp &&
						targetIp <= lastRegionIp &&
						// Only a strictly forward edge from inside the region is safe.
						// This permits the canonical null-check branch while rejecting
						// alternate entries and backedges that could skip this CALL.
						(sourceIp <= callIp || sourceIp >= targetIp),
				);
			const stableAliasRedefined = fn.instructions.some(
				(instruction, ip) =>
					ip > callIp + 1 &&
					ip <= lastLoadIp &&
					vmInstructionDefinesRegister(instruction, stableAlias),
			);
			const caseProducerBypassed = loads.some((load) => {
				const consumer = load.consumer;
				return (
					consumer?.kind === "asciiCaseLength" &&
					!instructionDominates(consumer.upperPropertyIp, consumer.lengthPropertyIp)
				);
			});
			if (
				!safe ||
				loads.length === 0 ||
				loads.length > 8 ||
				hasInteriorEntry ||
				caseProducerBypassed ||
				stableAliasRedefined
			) {
				continue;
			}
			const license = vmRegionLicense([call.guardedBuiltinCall?.guard], "whole-region");
			if (license === undefined) continue;
			let lockedFreshLiteral = false;
			const receiverDefinition = latestDefinition(call.thisValue, callIp - 1);
			if (receiverDefinition?.instruction.opcode === "CONSTRUCT") {
				const receiverConstruct = receiverDefinition.instruction;
				const constructorDefinition = latestDefinition(
					receiverConstruct.callee,
					receiverDefinition.ip,
				);
				const constructorIntrinsic = constructorDefinition?.instruction;
				const argument = decodeVmValueOperand(call.arguments[0]!);
				lockedFreshLiteral =
					license.guard.dependencies.every((dependency) => dependency.kind === "world") &&
					receiverConstruct.dst === call.thisValue &&
					receiverConstruct.arguments.length === 2 &&
					constructorDefinition !== undefined &&
					constructorIntrinsic?.opcode === "LOAD_INTRINSIC" &&
					constructorIntrinsic.intrinsic === "RegExp" &&
					constructorIntrinsic.dst === receiverConstruct.callee &&
					instructionDominates(constructorDefinition.ip, receiverDefinition.ip) &&
					instructionDominates(receiverDefinition.ip, callIp) &&
					(argument.kind !== "register" || argument.register !== call.thisValue) &&
					hasOnlyUsesUntilRedefinition(
						call.thisValue,
						receiverDefinition.ip + 1,
						new Set([callIp - 1, callIp]),
					);
			}
			projections.push({
				license,
				resultRepresentation: "regexp-capture-projection",
				propertyIp: callIp - 1,
				callIp,
				lockedFreshLiteral,
				callee: call.callee,
				receiver: call.thisValue,
				input: call.arguments[0]!,
				result: call.dst,
				loads,
			});
		}
		if (projections.length > 0) fn.nativeRegExpExecProjections = projections;
		else delete fn.nativeRegExpExecProjections;
	}
}

/**
 * Keep the match value of an exact RegExp String Iterator virtual when a loop
 * consumes it only through constant captures passed directly to Number. The
 * iterator/next pair and the complete close CFG stay untouched.
 */
function annotateNativeRegExpIteratorProjections(definition: VmDefinition): void {
	for (const fn of definition.functions) {
		const projections: Array<
			NonNullable<VmFunction["nativeRegExpIteratorProjections"]>[number]
		> = [];
		const handlerTargets = new Set(fn.handlers.map((handler) => handler.handlerIp));
		const jumpEdges: Array<{ sourceIp: number; targetIp: number }> = [];
		for (const [sourceIp, instruction] of fn.instructions.entries()) {
			if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
				jumpEdges.push({ sourceIp, targetIp: instruction.targetIp });
			}
		}
		const latestDefinition = (register: number, beforeIp: number) => {
			for (let ip = beforeIp - 1; ip >= 0; ip--) {
				if (vmInstructionDefinesRegister(fn.instructions[ip]!, register)) {
					return { instruction: fn.instructions[ip]!, ip };
				}
			}
			return undefined;
		};
		const hasOnlyUsesUntilRedefinition = (
			register: number,
			startIp: number,
			allowedUses: ReadonlySet<number>,
		): boolean => {
			for (let ip = startIp; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (vmInstructionUsesRegister(instruction, register) && !allowedUses.has(ip)) {
					return false;
				}
				if (vmInstructionDefinesRegister(instruction, register)) return true;
			}
			return true;
		};

		for (const [stepIp, step] of fn.instructions.entries()) {
			const doneBranch = fn.instructions[stepIp + 1];
			if (
				step.opcode !== "ITERATOR_STEP" ||
				doneBranch?.opcode !== "JUMP_IF" ||
				doneBranch.cond !== step.doneDst ||
				doneBranch.targetIp <= stepIp + 1 ||
				handlerTargets.has(stepIp)
			) {
				continue;
			}

			const aliases = new Set([step.valueDst]);
			const loads: Array<
				NonNullable<
					VmFunction["nativeRegExpIteratorProjections"]
				>[number]["loads"][number]
			> = [];
			const indices = new Set<number>();
			let safe = true;
			for (let ip = stepIp + 2; ip < fn.instructions.length && aliases.size > 0; ip++) {
				const instruction = fn.instructions[ip]!;
				const usedAliases = [...aliases].filter((alias) =>
					vmInstructionUsesRegister(instruction, alias),
				);
				let accepted = usedAliases.length === 0;
				if (
					instruction.opcode === "MOVE" &&
					usedAliases.length === 1 &&
					aliases.has(instruction.src)
				) {
					accepted = true;
				} else if (
					instruction.opcode === "LOAD_PROPERTY" &&
					aliases.has(instruction.object) &&
					usedAliases.length === 1
				) {
					const key = latestDefinition(instruction.key, ip);
					const numberCall = fn.instructions[ip + 1];
					const argument =
						numberCall?.opcode === "CALL" && numberCall.arguments[0] !== undefined
							? decodeVmValueOperand(numberCall.arguments[0])
							: undefined;
					const numberDefinition =
						numberCall?.opcode === "CALL"
							? latestDefinition(numberCall.callee, ip + 1)
							: undefined;
					if (
						key?.instruction.opcode === "CREATE_NUMBER" &&
						key.ip > stepIp &&
						Number.isInteger(key.instruction.value) &&
						key.instruction.value > 0 &&
						key.instruction.value <= 0xffff &&
						!indices.has(key.instruction.value) &&
						numberCall?.opcode === "CALL" &&
						numberCall.arguments.length === 1 &&
						argument?.kind === "register" &&
						argument.register === instruction.dst &&
						numberDefinition?.instruction.opcode === "LOAD_INTRINSIC" &&
						numberDefinition.ip > stepIp &&
						numberDefinition.instruction.intrinsic === "Number" &&
						hasOnlyUsesUntilRedefinition(instruction.dst, ip + 1, new Set([ip + 1]))
					) {
						loads.push({
							ip,
							captureIndex: key.instruction.value,
							dst: instruction.dst,
							numberCallIp: ip + 1,
						});
						indices.add(key.instruction.value);
						accepted = true;
					}
				}
				if (!accepted) {
					safe = false;
					break;
				}
				for (const alias of [...aliases]) {
					if (vmInstructionDefinesRegister(instruction, alias)) aliases.delete(alias);
				}
				if (instruction.opcode === "MOVE" && usedAliases.includes(instruction.src)) {
					aliases.add(instruction.dst);
				}
			}

			const regionEnd = Math.max(stepIp, ...loads.map((load) => load.numberCallIp));
			const hasInteriorEntry =
				fn.handlers.some(
					(handler) => handler.handlerIp > stepIp && handler.handlerIp <= regionEnd,
				) || jumpEdges.some(({ targetIp }) => targetIp > stepIp && targetIp <= regionEnd);
			if (
				!safe ||
				loads.length === 0 ||
				loads.length > 8 ||
				doneBranch.targetIp <= regionEnd ||
				hasInteriorEntry
			) {
				continue;
			}

			projections.push({
				stepIp,
				iterator: step.iterator,
				next: step.next,
				value: step.valueDst,
				done: step.doneDst,
				loads,
			});
		}
		if (projections.length > 0) fn.nativeRegExpIteratorProjections = projections;
		else delete fn.nativeRegExpIteratorProjections;
	}
}

/**
 * Fuse an exact builtin `string.slice(constant)` whose only produced value is
 * immediately consumed by the exact Number intrinsic. Both calls remain as the
 * guard-miss path.
 */
function annotateNativeStringSliceNumberFusions(definition: VmDefinition): void {
	for (const fn of definition.functions) {
		const fusions: Array<
			NonNullable<VmFunction["nativeStringSliceNumberFusions"]>[number]
		> = [];
		const jumpTargets = new Set<number>();
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
				jumpTargets.add(instruction.targetIp);
			}
		}
		const latestDefinition = (register: number, beforeIp: number) => {
			for (let ip = beforeIp - 1; ip >= 0; ip--) {
				if (vmInstructionDefinesRegister(fn.instructions[ip]!, register)) {
					return { instruction: fn.instructions[ip]!, ip };
				}
			}
			return undefined;
		};
		for (let sliceCallIp = 1; sliceCallIp + 1 < fn.instructions.length; sliceCallIp++) {
			const sliceCall = fn.instructions[sliceCallIp]!;
			const load = fn.instructions[sliceCallIp - 1]!;
			const numberCall = fn.instructions[sliceCallIp + 1]!;
			const numberArgument =
				numberCall.opcode === "CALL"
					? decodeVmValueOperand(numberCall.arguments[0] ?? -1)
					: undefined;
			if (
				sliceCall.opcode !== "CALL" ||
				!vmCallProvesBuiltin(sliceCall, "String.prototype.slice") ||
				sliceCall.arguments.length !== 1 ||
				load.opcode !== "LOAD_PROPERTY_STATIC" ||
				load.dst !== sliceCall.callee ||
				load.object !== sliceCall.thisValue ||
				!staticStringEquals(definition, load.stringIndex, "slice") ||
				numberCall.opcode !== "CALL" ||
				numberCall.arguments.length !== 1 ||
				numberArgument?.kind !== "register" ||
				numberArgument.register !== sliceCall.dst ||
				jumpTargets.has(sliceCallIp + 1)
			) {
				continue;
			}
			const start = decodeVmValueOperand(sliceCall.arguments[0]!);
			const numberCallee = latestDefinition(numberCall.callee, sliceCallIp + 1);
			if (
				start.kind !== "number" ||
				!Number.isFinite(start.value) ||
				numberCallee?.instruction.opcode !== "LOAD_INTRINSIC" ||
				numberCallee.instruction.intrinsic !== "Number" ||
				![...jumpTargets, ...fn.handlers.map((handler) => handler.handlerIp)].every(
					(targetIp) => targetIp <= numberCallee.ip || targetIp > sliceCallIp,
				)
			) {
				continue;
			}
			let resultEscapes = false;
			for (let ip = sliceCallIp + 2; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (vmInstructionUsesRegister(instruction, sliceCall.dst)) {
					resultEscapes = true;
					break;
				}
				if (vmInstructionDefinesRegister(instruction, sliceCall.dst)) break;
			}
			if (resultEscapes) continue;
			fusions.push({
				propertyIp: sliceCallIp - 1,
				sliceCallIp,
				numberCallIp: sliceCallIp + 1,
				numberCallee: numberCall.callee,
				receiver: sliceCall.thisValue,
				sliceStart: start.value,
				result: numberCall.dst,
			});
			sliceCallIp++;
		}
		if (fusions.length > 0) fn.nativeStringSliceNumberFusions = fusions;
		else delete fn.nativeStringSliceNumberFusions;
	}
}

/** Mark the exact lowered shape of `primitiveString.search(/literal/flags)`. */
function annotateNativeStringSearchRegExpCalls(definition: VmDefinition): void {
	for (const fn of definition.functions) {
		const entryTargets = new Set<number>(fn.handlers.map((handler) => handler.handlerIp));
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
				entryTargets.add(instruction.targetIp);
			}
		}
		for (let callIp = 3; callIp < fn.instructions.length; callIp++) {
			const call = fn.instructions[callIp]!;
			const construct = fn.instructions[callIp - 1]!;
			const intrinsic = fn.instructions[callIp - 2]!;
			const load = fn.instructions[callIp - 3]!;
			if (
				call.opcode !== "CALL" ||
				call.arguments.length !== 1 ||
				construct.opcode !== "CONSTRUCT" ||
				construct.arguments.length !== 2 ||
				intrinsic.opcode !== "LOAD_INTRINSIC" ||
				intrinsic.intrinsic !== "RegExp" ||
				construct.callee !== intrinsic.dst ||
				load.opcode !== "LOAD_PROPERTY_STATIC" ||
				load.dst !== call.callee ||
				load.object !== call.thisValue ||
				!staticStringEquals(definition, load.stringIndex, "search") ||
				[callIp - 2, callIp - 1, callIp].some((ip) => entryTargets.has(ip))
			) {
				continue;
			}
			const regexp = decodeVmValueOperand(call.arguments[0]!);
			const pattern = decodeVmValueOperand(construct.arguments[0]!);
			const flags = decodeVmValueOperand(construct.arguments[1]!);
			if (
				regexp.kind !== "register" ||
				regexp.register !== construct.dst ||
				pattern.kind !== "string" ||
				flags.kind !== "string" ||
				(definition.stringConstants[flags.index] ?? []).some(
					(unit) => unit === "g".charCodeAt(0) || unit === "y".charCodeAt(0),
				)
			) {
				continue;
			}
			const patternUnits = definition.stringConstants[pattern.index] ?? [];
			const flagsUnits = definition.stringConstants[flags.index] ?? [];
			const fixedLiteral =
				patternUnits.length > 0 &&
				flagsUnits.length === 0 &&
				patternUnits.every(
					(unit) =>
						unit <= 0x7f && !"\\\\^$.*+?{}[]()|".includes(String.fromCharCode(unit)),
				);
			let literalHasOtherUse = false;
			if (fixedLiteral) {
				const callee = decodeVmValueOperand(call.callee);
				const receiver = decodeVmValueOperand(call.thisValue);
				literalHasOtherUse =
					(callee.kind === "register" && callee.register === construct.dst) ||
					(receiver.kind === "register" && receiver.register === construct.dst);
				for (let ip = callIp; ip < fn.instructions.length; ip++) {
					const instruction = fn.instructions[ip]!;
					if (vmInstructionUsesRegister(instruction, construct.dst) && ip !== callIp) {
						literalHasOtherUse = true;
						break;
					}
					if (vmInstructionDefinesRegister(instruction, construct.dst)) break;
				}
			}
			if (fixedLiteral && !literalHasOtherUse) {
				construct.directStringSearchLiteral = {
					callIp,
					searchCallee: call.callee,
					receiver: call.thisValue,
					patternStringIndex: pattern.index,
				};
				call.directStringSearchLiteralConstructIp = callIp - 1;
			}
			call.directStringSearchRegExp = true;
		}
	}
}

/**
 * Mark an exact no-reviver JSON.parse inside a natural loop. Native emission
 * keeps a private parsed template per activation and returns a fresh structural
 * clone on hits; the template never becomes observable JavaScript state.
 */
function annotateNativeInvariantJsonParseCaches(definition: VmDefinition): void {
	for (const fn of definition.functions) {
		const caches: Array<
			NonNullable<VmFunction["nativeInvariantJsonParseCaches"]>[number]
		> = [];
		const entryTargets = new Set<number>(fn.handlers.map((handler) => handler.handlerIp));
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
				entryTargets.add(instruction.targetIp);
			}
		}
		const latestDefinition = (register: number, beforeIp: number) => {
			for (let ip = beforeIp - 1; ip >= 0; ip--) {
				if (vmInstructionDefinesRegister(fn.instructions[ip]!, register)) {
					return { instruction: fn.instructions[ip]!, ip };
				}
			}
			return undefined;
		};
		for (let callIp = 0; callIp < fn.instructions.length; callIp++) {
			const parseCall = fn.instructions[callIp]!;
			if (parseCall.opcode !== "CALL" || parseCall.arguments.length !== 1) continue;
			const parseLoadDef = latestDefinition(parseCall.callee, callIp);
			const jsonLoadDef = latestDefinition(parseCall.thisValue, callIp);
			const parseLoad = parseLoadDef?.instruction;
			const jsonLoad = jsonLoadDef?.instruction;
			const parsePropertyIsExact =
				parseLoad?.opcode === "LOAD_PROPERTY_STATIC"
					? staticStringEquals(definition, parseLoad.stringIndex, "parse")
					: parseLoad?.opcode === "LOAD_PROPERTY"
						? (() => {
								const key = latestDefinition(parseLoad.key, parseLoadDef?.ip ?? 0);
								return (
									key?.instruction.opcode === "CREATE_STRING" &&
									staticStringEquals(definition, key.instruction.stringIndex, "parse") &&
									![...entryTargets].some(
										(target) => target > key.ip && target <= (parseLoadDef?.ip ?? 0),
									)
								);
							})()
						: false;
			if (
				jsonLoad?.opcode !== "LOAD_INTRINSIC" ||
				jsonLoad.intrinsic !== "JSON" ||
				(parseLoad?.opcode !== "LOAD_PROPERTY_STATIC" &&
					parseLoad?.opcode !== "LOAD_PROPERTY") ||
				parseLoad.object !== jsonLoad.dst ||
				!parsePropertyIsExact ||
				parseCall.callee !== parseLoad.dst ||
				parseCall.thisValue !== jsonLoad.dst ||
				parseLoadDef === undefined ||
				jsonLoadDef === undefined ||
				[parseLoadDef.ip, callIp].some((ip) => entryTargets.has(ip)) ||
				[...entryTargets].some((target) => target > jsonLoadDef.ip && target <= callIp)
			) {
				continue;
			}
			const text = decodeVmValueOperand(parseCall.arguments[0]!);
			if (text.kind !== "register") continue;
			const backedge = fn.instructions.findIndex(
				(instruction, ip) =>
					ip > callIp &&
					(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
					instruction.targetIp <= jsonLoadDef.ip,
			);
			if (backedge < 0) continue;
			caches.push({
				callIp,
				jsonObject: jsonLoad.dst,
				parseCallee: parseLoad.dst,
				text: text.register,
				result: parseCall.dst,
			});
		}
		if (caches.length > 0) fn.nativeInvariantJsonParseCaches = caches;
		else delete fn.nativeInvariantJsonParseCaches;
	}
}

/** Generic post-wire reaching definitions for emitter-only semantic proofs. */
function nativeReachingDefinitions(
	fn: VmFunction,
	cfg: NativeProofCfg,
): Array<Array<ReadonlySet<number>>> {
	const result: Array<Array<ReadonlySet<number>>> = [];
	for (let register = 0; register < fn.registerCount; register++) {
		const incoming = Array.from(
			{ length: fn.instructions.length },
			() => new Set<number>(),
		);
		const outgoing = Array.from(
			{ length: fn.instructions.length },
			() => new Set<number>(),
		);
		let changed = true;
		while (changed) {
			changed = false;
			for (let ip = 0; ip < fn.instructions.length; ip++) {
				const nextIncoming = new Set<number>();
				if (ip === 0 && register < fn.parameterCount) nextIncoming.add(-register - 1);
				for (const predecessor of cfg.predecessors[ip]!) {
					for (const definition of outgoing[predecessor]!) nextIncoming.add(definition);
				}
				const nextOutgoing = vmInstructionDefinesRegister(fn.instructions[ip]!, register)
					? new Set([ip])
					: new Set(nextIncoming);
				const same = (left: Set<number>, right: Set<number>) =>
					left.size === right.size && [...left].every((value) => right.has(value));
				if (!same(incoming[ip]!, nextIncoming)) {
					incoming[ip] = nextIncoming;
					changed = true;
				}
				if (!same(outgoing[ip]!, nextOutgoing)) {
					outgoing[ip] = nextOutgoing;
					changed = true;
				}
			}
		}
		result[register] = incoming;
	}
	return result;
}

function nativeResolveMoves(
	fn: VmFunction,
	reaching: Array<Array<ReadonlySet<number>>>,
	register: number,
	ip: number,
): { instruction?: VmInstruction; ip: number } | undefined {
	const seen = new Set<string>();
	let currentRegister = register;
	let currentIp = ip;
	while (true) {
		const key = `${currentRegister}:${currentIp}`;
		if (seen.has(key)) return undefined;
		seen.add(key);
		const definitions = reaching[currentRegister]?.[currentIp];
		if (definitions?.size !== 1) return undefined;
		const definitionIp = [...definitions][0]!;
		const instruction = definitionIp >= 0 ? fn.instructions[definitionIp] : undefined;
		if (instruction?.opcode !== "MOVE") return { instruction, ip: definitionIp };
		currentRegister = instruction.src;
		currentIp = definitionIp;
	}
}

/**
 * Prove the tiny closure factory used by the first linked projection. Runtime
 * callback identity remains the authority; this proof only selects a target.
 */
function nativeProjectionFactoryTarget(
	definition: VmDefinition,
	functionIndex: number,
): number | undefined {
	const fn = definition.functions[functionIndex];
	if (
		fn === undefined ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.needsArguments ||
		fn.mappedArguments ||
		fn.handlers.length > 0 ||
		fn.argumentSnapshotCount !== 0
	)
		return undefined;
	const allowed = new Set<VmInstruction["opcode"]>([
		"MOVE",
		"RETURN",
		"JUMP",
		"JUMP_IF",
		"CREATE_NUMBER",
		"CREATE_F64",
		"CREATE_BOOLEAN",
		"CREATE_STRING",
		"CREATE_UNDEFINED",
		"CREATE_EMPTY",
		"CREATE_NULL",
		"CREATE_FUNCTION",
		"STORE_CAPTURED",
		"ENV_PUSH",
		"ENV_COPY",
		"ENV_POP",
		"BINARY",
	]);
	if (fn.instructions.some((instruction) => !allowed.has(instruction.opcode)))
		return undefined;
	const creates = fn.instructions
		.map((instruction, ip) => ({ instruction, ip }))
		.filter(
			(
				entry,
			): entry is {
				instruction: Extract<VmInstruction, { opcode: "CREATE_FUNCTION" }>;
				ip: number;
			} => entry.instruction.opcode === "CREATE_FUNCTION",
		);
	const returns = fn.instructions
		.map((instruction, ip) => ({ instruction, ip }))
		.filter(
			(
				entry,
			): entry is {
				instruction: Extract<VmInstruction, { opcode: "RETURN" }>;
				ip: number;
			} => entry.instruction.opcode === "RETURN",
		);
	if (creates.length !== 1 || returns.length !== 1) return undefined;
	const cfg = buildNativeProofCfg(fn);
	const reaching = nativeReachingDefinitions(fn, cfg);
	if (
		nativeResolveMoves(fn, reaching, returns[0]!.instruction.value, returns[0]!.ip)
			?.ip !== creates[0]!.ip
	) {
		return undefined;
	}
	const target = creates[0]!.instruction.functionIndex;
	const targetFn = definition.functions[target];
	if (targetFn === undefined) return undefined;
	for (const load of targetFn.instructions) {
		if (load.opcode !== "LOAD_CAPTURED") continue;
		const stores: Array<{ owner: number; ip: number }> = [];
		for (let owner = 0; owner < definition.functions.length; owner++) {
			for (let ip = 0; ip < definition.functions[owner]!.instructions.length; ip++) {
				const instruction = definition.functions[owner]!.instructions[ip]!;
				if (
					instruction.opcode === "STORE_CAPTURED" &&
					instruction.ownerFunctionIndex === load.ownerFunctionIndex &&
					instruction.index === load.index
				)
					stores.push({ owner, ip });
			}
		}
		if (
			load.ownerFunctionIndex !== functionIndex ||
			stores.length === 0 ||
			stores.some(
				(store) =>
					store.owner !== functionIndex ||
					store.ip >= creates[0]!.ip ||
					!cfg.dominators[creates[0]!.ip]!.has(store.ip),
			)
		)
			return undefined;
	}
	return target;
}

interface NativePrimitiveProjectionProof {
	captures: Array<{ ownerFunctionIndex: number; index: number }>;
	rowPropertyLoads: number;
	primitiveRowStringIndices: Array<number>;
	nestedBaseStringIndex: number;
	nestedValueStringIndex: number;
	excludedStringIndices: Array<number>;
}

/**
 * Deliberately narrow pure projection: JSON row reads, one nested optional read,
 * object rest into one fresh result, primitive arithmetic, and exact Math.round.
 */
function proveNativePrimitiveProjection(
	definition: VmDefinition,
	functionIndex: number,
): NativePrimitiveProjectionProof | undefined {
	const fn = definition.functions[functionIndex];
	if (
		fn === undefined ||
		fn.parameterCount !== 1 ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.needsArguments ||
		fn.mappedArguments ||
		fn.handlers.length > 0 ||
		fn.argumentSnapshotCount !== 0 ||
		fn.argumentSnapshotPlan.length !== 0
	)
		return undefined;
	const allowed = new Set<VmInstruction["opcode"]>([
		"MOVE",
		"RETURN",
		"JUMP",
		"JUMP_IF",
		"CREATE_NUMBER",
		"CREATE_F64",
		"CREATE_BOOLEAN",
		"CREATE_STRING",
		"CREATE_UNDEFINED",
		"CREATE_NULL",
		"LOAD_CALLEE",
		"LOAD_INTRINSIC",
		"LOAD_CAPTURED",
		"LOAD_PROPERTY_STATIC",
		"REQUIRE_COERCIBLE",
		"COPY_DATA_PROPERTIES",
		"DEFINE_PROPERTY",
		"BINARY",
		"CALL",
	]);
	if (fn.instructions.some((instruction) => !allowed.has(instruction.opcode)))
		return undefined;
	const cfg = buildNativeProofCfg(fn);
	const reaching = nativeReachingDefinitions(fn, cfg);
	const resolvesParameter = (register: number, ip: number) =>
		nativeResolveMoves(fn, reaching, register, ip)?.ip === -1;
	const stringAt = (register: number, ip: number): number | undefined => {
		const resolved = nativeResolveMoves(fn, reaching, register, ip)?.instruction;
		return resolved?.opcode === "CREATE_STRING" ? resolved.stringIndex : undefined;
	};
	const captures = new Map<string, { ownerFunctionIndex: number; index: number }>();
	let copyIp = -1;
	let rowLoads = 0;
	let nestedLoads = 0;
	let nestedBaseStringIndex = -1;
	let nestedValueStringIndex = -1;
	let nestedBaseLoadIp = -1;
	let roundLoadIp = -1;
	let roundCalls = 0;
	let returnCount = 0;
	let excludedStringIndices: Array<number> = [];
	const rowLoadStringIndices: Array<number> = [];
	const reachable = new Set<number>();
	const work = fn.instructions.length > 0 ? [0] : [];
	while (work.length > 0) {
		const ip = work.pop()!;
		if (reachable.has(ip)) continue;
		reachable.add(ip);
		for (const successor of cfg.successors[ip]!) work.push(successor);
	}
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (!reachable.has(ip)) return undefined;
		const instruction = fn.instructions[ip]!;
		switch (instruction.opcode) {
			case "LOAD_CAPTURED":
				captures.set(`${instruction.ownerFunctionIndex}:${instruction.index}`, {
					ownerFunctionIndex: instruction.ownerFunctionIndex,
					index: instruction.index,
				});
				break;
			case "LOAD_INTRINSIC":
				if (instruction.intrinsic !== "Math") return undefined;
				break;
			case "REQUIRE_COERCIBLE":
				if (!resolvesParameter(instruction.src, ip)) return undefined;
				break;
			case "LOAD_PROPERTY_STATIC": {
				if (resolvesParameter(instruction.object, ip)) {
					rowLoads++;
					rowLoadStringIndices.push(instruction.stringIndex);
					break;
				}
				const base = nativeResolveMoves(fn, reaching, instruction.object, ip);
				if (
					base?.instruction?.opcode === "LOAD_PROPERTY_STATIC" &&
					resolvesParameter(base.instruction.object, base.ip)
				) {
					nestedLoads++;
					nestedBaseStringIndex = base.instruction.stringIndex;
					nestedValueStringIndex = instruction.stringIndex;
					nestedBaseLoadIp = base.ip;
					break;
				}
				const namespace = base;
				if (
					namespace?.instruction?.opcode === "LOAD_INTRINSIC" &&
					namespace.instruction.intrinsic === "Math" &&
					staticStringEquals(definition, instruction.stringIndex, "round")
				) {
					roundLoadIp = ip;
					break;
				}
				return undefined;
			}
			case "COPY_DATA_PROPERTIES": {
				if (!resolvesParameter(instruction.src, ip) || copyIp !== -1) return undefined;
				const keys = instruction.excluded.map((register) => stringAt(register, ip));
				if (keys.some((key) => key === undefined)) return undefined;
				excludedStringIndices = keys as Array<number>;
				copyIp = ip;
				break;
			}
			case "DEFINE_PROPERTY":
				if (
					nativeResolveMoves(fn, reaching, instruction.object, ip)?.ip !== copyIp ||
					stringAt(instruction.key, ip) === undefined ||
					!instruction.enumerable ||
					!instruction.writable ||
					!instruction.configurable
				)
					return undefined;
				break;
			case "CALL": {
				const callee = nativeResolveMoves(fn, reaching, instruction.callee, ip);
				const receiver = nativeResolveMoves(fn, reaching, instruction.thisValue, ip);
				if (
					callee?.ip !== roundLoadIp ||
					receiver?.instruction?.opcode !== "LOAD_INTRINSIC" ||
					receiver.instruction.intrinsic !== "Math" ||
					instruction.arguments.length !== 1
				) {
					return undefined;
				}
				roundCalls++;
				break;
			}
			case "BINARY":
				if (
					!["+", "-", "*", "/", "%", "**", "===", "!==", "==", "!="].includes(
						instruction.operator,
					)
				)
					return undefined;
				break;
			case "RETURN":
				returnCount++;
				break;
		}
	}
	if (
		captures.size === 0 ||
		rowLoads !== 6 ||
		nestedLoads !== 1 ||
		nestedBaseStringIndex < 0 ||
		nestedValueStringIndex < 0 ||
		roundCalls !== 1 ||
		returnCount !== 1 ||
		excludedStringIndices.length !== 6
	)
		return undefined;

	/*
	 * Typed provenance closes the effect lattice. JSON row leaves and captured
	 * Numbers are primitives; the one nested base is deliberately not. Therefore
	 * arithmetic cannot invoke valueOf/toString and property definitions cannot
	 * publish an object capture. Merges are accepted only when every reaching
	 * definition proves the same primitive domain.
	 */
	const primitiveMemo = new Map<string, boolean>();
	const primitiveVisiting = new Set<string>();
	const isNullishAt = (register: number, ip: number): boolean => {
		const definitions = reaching[register]?.[ip];
		if (definitions === undefined || definitions.size === 0) return false;
		return [...definitions].every((definitionIp) => {
			if (definitionIp < 0) return false;
			const instruction = fn.instructions[definitionIp]!;
			return (
				instruction.opcode === "CREATE_NULL" ||
				instruction.opcode === "CREATE_UNDEFINED" ||
				(instruction.opcode === "MOVE" && isNullishAt(instruction.src, definitionIp))
			);
		});
	};
	const isPrimitiveAt = (register: number, ip: number): boolean => {
		const key = `${register}:${ip}`;
		const known = primitiveMemo.get(key);
		if (known !== undefined) return known;
		if (primitiveVisiting.has(key)) return false;
		primitiveVisiting.add(key);
		const definitions = reaching[register]?.[ip];
		const result =
			definitions !== undefined &&
			definitions.size > 0 &&
			[...definitions].every((definitionIp) => {
				if (definitionIp < 0) return false;
				const instruction = fn.instructions[definitionIp]!;
				switch (instruction.opcode) {
					case "CREATE_NUMBER":
					case "CREATE_F64":
					case "CREATE_BOOLEAN":
					case "CREATE_STRING":
					case "CREATE_UNDEFINED":
					case "CREATE_NULL":
						return true;
					case "MOVE":
						return isPrimitiveAt(instruction.src, definitionIp);
					case "LOAD_CAPTURED":
						return true; // exact Number value is snapshotted/rechecked at runtime
					case "LOAD_PROPERTY_STATIC": {
						if (resolvesParameter(instruction.object, definitionIp)) {
							return definitionIp !== nestedBaseLoadIp;
						}
						const base = nativeResolveMoves(
							fn,
							reaching,
							instruction.object,
							definitionIp,
						);
						return base?.ip === nestedBaseLoadIp;
					}
					case "BINARY": {
						if (["===", "!=="].includes(instruction.operator)) return true;
						if (["==", "!="].includes(instruction.operator)) {
							return (
								isNullishAt(instruction.left, definitionIp) ||
								isNullishAt(instruction.right, definitionIp)
							);
						}
						return (
							isPrimitiveAt(instruction.left, definitionIp) &&
							isPrimitiveAt(instruction.right, definitionIp)
						);
					}
					case "CALL":
						if (
							nativeResolveMoves(fn, reaching, instruction.callee, definitionIp)?.ip !==
								roundLoadIp ||
							instruction.arguments.length !== 1
						)
							return false;
						{
							const argument = decodeVmValueOperand(instruction.arguments[0]!);
							return (
								argument.kind === "register" &&
								isPrimitiveAt(argument.register, definitionIp)
							);
						}
					default:
						return false;
				}
			});
		primitiveVisiting.delete(key);
		primitiveMemo.set(key, result);
		return result;
	};
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode === "BINARY" &&
			!["===", "!==", "==", "!="].includes(instruction.operator) &&
			(!isPrimitiveAt(instruction.left, ip) || !isPrimitiveAt(instruction.right, ip))
		)
			return undefined;
		if (instruction.opcode === "CALL") {
			const argument = decodeVmValueOperand(instruction.arguments[0]!);
			if (argument.kind !== "register" || !isPrimitiveAt(argument.register, ip))
				return undefined;
		}
		if (instruction.opcode === "DEFINE_PROPERTY" && !isPrimitiveAt(instruction.value, ip))
			return undefined;
	}

	/* Every reachable completion returns the sole fresh rest object. Its aliases
	 * may only feed definitions on that object or the final return. */
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		for (let register = 0; register < fn.registerCount; register++) {
			if (
				nativeResolveMoves(fn, reaching, register, ip)?.ip !== copyIp ||
				!nativeInstructionUsesRegister(fn.instructions[ip]!, register)
			)
				continue;
			const instruction = fn.instructions[ip]!;
			if (instruction.opcode === "DEFINE_PROPERTY" && instruction.object === register)
				continue;
			if (instruction.opcode === "RETURN" && instruction.value === register) continue;
			return undefined;
		}
	}
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode === "RETURN" &&
			nativeResolveMoves(fn, reaching, instruction.value, ip)?.ip !== copyIp
		)
			return undefined;
		if (cfg.successors[ip]!.length === 0 && instruction.opcode !== "RETURN")
			return undefined;
	}

	/* LOAD_CALLEE is emitted by ordinary closures but must remain dead: observing
	 * it in a computation would escape the typed primitive domain. */
	for (let loadIp = 0; loadIp < fn.instructions.length; loadIp++) {
		const load = fn.instructions[loadIp]!;
		if (load.opcode !== "LOAD_CALLEE") continue;
		for (let ip = loadIp + 1; ip < fn.instructions.length; ip++) {
			if (
				nativeInstructionUsesRegister(fn.instructions[ip]!, load.dst) &&
				nativeResolveMoves(fn, reaching, load.dst, ip)?.ip === loadIp
			)
				return undefined;
		}
	}
	const primitiveRowStringIndices = rowLoadStringIndices.filter(
		(index) => index !== nestedBaseStringIndex,
	);
	return {
		captures: [...captures.values()],
		rowPropertyLoads: rowLoads + 1,
		primitiveRowStringIndices,
		nestedBaseStringIndex,
		nestedValueStringIndex,
		excludedStringIndices,
	};
}

/** Link one exact adjacent parse/map chain to a private final-row template. */
function annotateNativeInvariantJsonMapTemplates(definition: VmDefinition): void {
	const projections = new Map<number, NativePrimitiveProjectionProof>();
	for (let index = 0; index < definition.functions.length; index++) {
		const proof = proveNativePrimitiveProjection(definition, index);
		if (proof !== undefined) projections.set(index, proof);
	}
	const uniquelyFactoryCreatedProjectionTargets = new Set<number>();
	for (let index = 0; index < definition.functions.length; index++) {
		const target = nativeProjectionFactoryTarget(definition, index);
		if (target !== undefined && projections.has(target)) {
			uniquelyFactoryCreatedProjectionTargets.add(target);
		}
	}
	for (const fn of definition.functions) {
		delete fn.nativeInvariantJsonMapTemplates;
		if (fn.isGenerator || fn.isAsync) continue;
		const cfg = buildNativeProofCfg(fn);
		const reaching = nativeReachingDefinitions(fn, cfg);
		const templates: Array<
			NonNullable<VmFunction["nativeInvariantJsonMapTemplates"]>[number]
		> = [];
		for (let p = 0; p + 3 < fn.instructions.length; p++) {
			const parse = fn.instructions[p]!;
			const mapLoad = fn.instructions[p + 1]!;
			const mapCall = fn.instructions[p + 2]!;
			const handlerOverlap = fn.handlers.some(
				(handler) =>
					(handler.startIp < p + 4 && handler.endIp > p) ||
					(handler.handlerIp >= p && handler.handlerIp < p + 4),
			);
			if (
				parse.opcode !== "CALL" ||
				parse.arguments.length !== 1 ||
				handlerOverlap ||
				mapLoad.opcode !== "LOAD_PROPERTY_STATIC" ||
				mapLoad.object !== parse.dst ||
				mapLoad.dst === parse.dst ||
				!staticStringEquals(definition, mapLoad.stringIndex, "map") ||
				mapCall.opcode !== "CALL" ||
				mapCall.callee !== mapLoad.dst ||
				mapCall.thisValue !== parse.dst ||
				mapCall.dst === parse.dst ||
				mapCall.arguments.length !== 1 ||
				cfg.predecessors[p + 1]!.length !== 1 ||
				cfg.predecessors[p + 1]![0] !== p ||
				cfg.predecessors[p + 2]!.length !== 1 ||
				cfg.predecessors[p + 2]![0] !== p + 1 ||
				cfg.predecessors[p + 3]!.length !== 1 ||
				cfg.predecessors[p + 3]![0] !== p + 2 ||
				!cfg.loops.some((loop) => loop.body.has(p))
			)
				continue;
			const json = nativeResolveMoves(fn, reaching, parse.thisValue, p);
			const parseLoad = nativeResolveMoves(fn, reaching, parse.callee, p);
			if (
				json?.instruction?.opcode !== "LOAD_INTRINSIC" ||
				json.instruction.intrinsic !== "JSON" ||
				parseLoad?.instruction?.opcode !== "LOAD_PROPERTY_STATIC" ||
				parseLoad.instruction.object !== json.instruction.dst ||
				!staticStringEquals(definition, parseLoad.instruction.stringIndex, "parse")
			)
				continue;
			const text = decodeVmValueOperand(parse.arguments[0]!);
			const callback = decodeVmValueOperand(mapCall.arguments[0]!);
			if (text.kind !== "register" || callback.kind !== "register") continue;
			const callbackDefinition = nativeResolveMoves(
				fn,
				reaching,
				callback.register,
				p + 2,
			);
			let target: number | undefined;
			if (callbackDefinition?.instruction?.opcode === "CREATE_FUNCTION") {
				target = callbackDefinition.instruction.functionIndex;
			} else if (callbackDefinition?.instruction?.opcode === "CALL") {
				if (callbackDefinition.instruction.directFunctionIndex !== undefined) {
					target = nativeProjectionFactoryTarget(
						definition,
						callbackDefinition.instruction.directFunctionIndex,
					);
				} else if (uniquelyFactoryCreatedProjectionTargets.size === 1) {
					/* The ordinary callback-producing call is not statically trusted. A
					 * unique lexical factory target only selects metadata; runtime exact
					 * function-index, identity, realm, and captured-value guards remain
					 * semantic authority before every hit. */
					target = [...uniquelyFactoryCreatedProjectionTargets][0]!;
				}
			}
			if (target === undefined) continue;
			const projection = projections.get(target);
			if (projection === undefined) continue;
			let privateParseResult = true;
			for (let ip = p + 1; ip < fn.instructions.length && privateParseResult; ip++) {
				const instruction = fn.instructions[ip]!;
				for (let register = 0; register < fn.registerCount; register++) {
					if (
						nativeResolveMoves(fn, reaching, register, ip)?.ip !== p ||
						!nativeInstructionUsesRegister(instruction, register)
					)
						continue;
					if (
						ip === p + 1 &&
						instruction.opcode === "LOAD_PROPERTY_STATIC" &&
						instruction.object === register
					)
						continue;
					if (
						ip === p + 2 &&
						instruction.opcode === "CALL" &&
						instruction.thisValue === register
					)
						continue;
					privateParseResult = false;
					break;
				}
			}
			if (!privateParseResult) continue;
			templates.push({
				parseCallIp: p,
				mapLoadIp: p + 1,
				mapCallIp: p + 2,
				jsonObject: parse.thisValue,
				parseCallee: parse.callee,
				text: text.register,
				parseResult: parse.dst,
				mapCallee: mapLoad.dst,
				callback: callback.register,
				mapResult: mapCall.dst,
				targetFunctionIndex: target,
				...projection,
			});
		}
		if (templates.length > 0) fn.nativeInvariantJsonMapTemplates = templates;
	}
}

function emitVmDefinitionSource(
	definition: VmDefinition,
	options: EmitOptions,
	splitCompiledFunctions: boolean,
	maxCompiledFunctionCodeUnits?: number,
): EmittedVmSource {
	const suffix = options.symbolSuffix ?? "";
	const debug = options.debugInfo !== false;
	const useCompiled = options.compiled !== false;
	if (useCompiled) {
		annotateNativeStringScanSummaries(definition);
		annotateNativeStringSplitProjections(definition);
		annotateNativeStringSplitCursors(definition);
		annotateNativeRegExpExecProjections(definition);
		annotateNativeRegExpIteratorProjections(definition);
		annotateNativeStringSliceNumberFusions(definition);
		annotateNativeStringSearchRegExpCalls(definition);
		annotateNativePrivateAggregateMemos(definition);
		annotateNativeAffineRangeVirtualizations(definition);
		annotateNativeInvariantJsonMapTemplates(definition);
		annotateNativeInvariantJsonParseCaches(definition);
	}
	// Compiled functions call mal_vm_binary_op (vm_ops.h) and box unboxed doubles
	// via mal_ops_number_value (value_ops.h); include both alongside vm.h.
	const lines = options.includeHeader === false ? [] : [...C_HEADER_LINES];

	for (let i = 0; i < definition.stringConstants.length; ++i) {
		const constant = definition.stringConstants[i]!;
		lines.push(
			`static const c16 mal_string_${i}_code_units${suffix}[] = ${stringCodeUnitsBody(constant)};`,
		);
	}

	if (definition.stringConstants.length > 0) {
		lines.push(
			"",
			`${splitCompiledFunctions ? "" : "static "}MalString mal_strings${suffix}[] = {`,
		);
		for (let i = 0; i < definition.stringConstants.length; ++i) {
			const constant = definition.stringConstants[i]!;
			lines.push(malStringRow(`mal_string_${i}_code_units${suffix}`, constant.length));
		}
		lines.push("};", "");
	}

	if (definition.bigintConstants.length > 0) {
		// Immortal bigint constants with their 128-bit value baked at compile time.
		lines.push(
			`${splitCompiledFunctions ? "" : "static "}MalBigInt mal_bigints${suffix}[] = {`,
		);
		for (const value of definition.bigintConstants) {
			lines.push(
				`    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_BIGINT), .value = ${emitBigintValue(value)} },`,
			);
		}
		lines.push("};", "");
	}

	// Native-backend functions. Emitted before the MalFunction table (which
	// references their symbols) and after the constant pools (which they may
	// reference). The bytecode is still emitted below as a fallback / for `new`.
	let compiled: Array<CompiledFunction | null> = definition.functions.map((fn, i) => {
		if (!useCompiled) return null;
		const emitted = emitCompiledFunction(
			fn,
			i,
			suffix,
			debug,
			undefined,
			splitCompiledFunctions ? "external" : "static",
		);
		if (emitted === null) return null;
		if (
			maxCompiledFunctionCodeUnits !== undefined &&
			emitted.source.length + C_HEADER_LINES.join("\n").length + 1 >
				maxCompiledFunctionCodeUnits
		) {
			return null;
		}
		return emitted;
	});
	// A single translation unit can make an exact script call a real direct C
	// call. First determine which functions lower successfully, then re-emit with
	// that closed target set; split units retain the external runtime call seam so
	// they need no cross-unit availability/linkage protocol.
	if (!splitCompiledFunctions && maxCompiledFunctionCodeUnits === undefined) {
		const compiledTargets = new Set<number>();
		compiled.forEach((fn, index) => {
			if (fn !== null) compiledTargets.add(index);
		});
		const directCompiledTargets = new Map<number, number>();
		for (const fn of definition.functions) {
			for (const instruction of fn.instructions) {
				if (
					instruction.opcode === "CALL" &&
					instruction.directFunctionIndex !== undefined &&
					compiledTargets.has(instruction.directFunctionIndex)
				) {
					const target = compiled[instruction.directFunctionIndex];
					if (target !== undefined && target !== null) {
						directCompiledTargets.set(
							instruction.directFunctionIndex,
							target.nativeNumberArgumentCount,
						);
					}
				}
			}
		}
		compiled = definition.functions.map((fn, i) => {
			if (!compiledTargets.has(i)) return null;
			return emitCompiledFunction(
				fn,
				i,
				suffix,
				debug,
				undefined,
				"static",
				directCompiledTargets,
			);
		});
		const usedNativeNumberTargets = new Set<number>();
		for (const fn of compiled) {
			if (fn === null) continue;
			for (const target of fn.nativeNumberCallTargets) {
				usedNativeNumberTargets.add(target);
			}
		}
		let refinedNativeTargets = false;
		for (const [target, count] of directCompiledTargets) {
			if (count > 0 && !usedNativeNumberTargets.has(target)) {
				directCompiledTargets.set(target, 0);
				refinedNativeTargets = true;
			}
		}
		if (refinedNativeTargets) {
			compiled = definition.functions.map((fn, i) => {
				if (!compiledTargets.has(i)) return null;
				return emitCompiledFunction(
					fn,
					i,
					suffix,
					debug,
					undefined,
					"static",
					directCompiledTargets,
				);
			});
		}
		if (directCompiledTargets.size > 0) {
			for (let index = 0; index < compiled.length; index++) {
				const fn = compiled[index];
				if (fn !== undefined && fn !== null && directCompiledTargets.has(index)) {
					lines.push(`static MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`);
					if ((directCompiledTargets.get(index) ?? 0) > 0) {
						lines.push(
							`static MalValue ${fn.symbol}_native_numbers(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state, f64 native_arg0, f64 native_arg1, f64 native_arg2, f64 native_arg3);`,
						);
					}
				}
			}
			lines.push("");
		}
	}
	finalizeCompilerRemarks(definition, compiled);
	if (splitCompiledFunctions) {
		if (compiled.some((fn) => fn !== null)) {
			lines.push(
				`#define MAL_DECLARE_COMPILED(name) MalValue name${COMPILED_FUNCTION_DECLARATION}`,
			);
		}
		for (const fn of compiled) {
			if (fn !== null) {
				lines.push(`MAL_DECLARE_COMPILED(${fn.symbol});`);
			}
		}
		if (compiled.some((fn) => fn !== null)) {
			lines.push("#undef MAL_DECLARE_COMPILED", "");
		}
	} else {
		for (const fn of compiled) {
			if (fn !== null) {
				lines.push(fn.source, "");
			}
		}
	}

	// A compiled function never re-enters the interpreter — a speculative param
	// guard falls back to a boxed compiled variant, not the bytecode — so its
	// bytecode and handler tables are dead weight. Only uncompiled functions
	// (generators/async) keep their overlay.
	const omitBytecode = compiled.map((c) => c !== null);
	const instructionDataByFunction = definition.functions.map((fn, i) =>
		omitBytecode[i] ? { data: [], offsets: [] } : instructionData(fn),
	);

	const positionInfo: Array<{ symbol: string; count: number }> = [];
	const profileSiteSymbols: Array<string> = [];

	for (let i = 0; i < definition.functions.length; ++i) {
		const fn = definition.functions[i]!;
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
			const sideData = instructionDataByFunction[i]!;
			if (sideData.data.length > 0) {
				lines.push(
					`static const i32 mal_function_${i}_instruction_data${suffix}[] = { ${sideData.data.join(", ")} };`,
					"",
				);
			}
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
	for (let i = 0; i < definition.functions.length; ++i) {
		const fn = definition.functions[i]!;
		lines.push(
			...malFunctionRow(
				fn,
				`mal_function_${i}_instructions${suffix}`,
				instructionDataByFunction[i]!.data.length > 0
					? `mal_function_${i}_instruction_data${suffix}`
					: "nullptr",
				instructionDataByFunction[i]!.data.length,
				!omitBytecode[i] && fn.argumentSnapshotPlan.length > 0
					? `mal_function_${i}_argument_snapshot_plan${suffix}`
					: "nullptr",
				omitBytecode[i] ? 0 : fn.argumentSnapshotPlan.length,
				!omitBytecode[i] && fn.mappedArgumentSlots.length > 0
					? `mal_function_${i}_mapped_argument_slots${suffix}`
					: "nullptr",
				fn.handlers.length > 0 ? `mal_function_${i}_handlers${suffix}` : "nullptr",
				compiled[i] !== null ? compiled[i]!.symbol : "nullptr",
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

	for (const line of malVmDefinitionStruct(
		definition,
		suffix,
		debug,
		undefined,
		options,
	)) {
		lines.push(line);
	}

	return { source: lines.join("\n"), compiled };
}

/**
 * Emit one definition/table translation unit plus bounded data and
 * compiled-function units.
 *
 * The native product compiler cannot materialize strings above 16 MiB. Keeping
 * compiled functions and leaf data arrays out of the definition unit avoids that
 * ceiling and lets the C driver compile large programs as independent translation
 * units. A single generated function or array is indivisible; reject one that
 * exceeds the configured budget with a bounded diagnostic.
 */
export function emitVmTranslationUnits(
	definition: VmDefinition,
	options: EmitOptions = {},
	maxCodeUnits = DEFAULT_TRANSLATION_UNIT_CODE_UNITS,
): Array<string> {
	if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits <= 0) {
		throw new RangeError("translation-unit code-unit budget must be a positive integer");
	}
	const emitted = emitVmDefinitionSource(definition, options, true, maxCodeUnits);
	const splitData = externalizeDataArrays(emitted.source, maxCodeUnits);
	if (splitData.source.length > maxCodeUnits) {
		throw new RangeError(
			`generated definition translation unit has ${splitData.source.length} code units; ` +
				`maximum is ${maxCodeUnits}`,
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
					fn === null
						? []
						: [
								{
									symbol: fn.symbol,
									source: `MalValue ${fn.symbol}${COMPILED_FUNCTION_DECLARATION};`,
								},
							],
			),
		);
	const declarationsBySymbol = new Map(
		generatedDeclarations.map((declaration) => [declaration.symbol, declaration]),
	);
	const preparePart = (
		part: Omit<TranslationUnitPart, "declarations">,
	): TranslationUnitPart => {
		const declarations = new Set<string>();
		for (const match of part.source.matchAll(/\bmal_[A-Za-z0-9_]+\b/g)) {
			if (declarationsBySymbol.has(match[0])) declarations.add(match[0]);
		}
		return { ...part, declarations };
	};
	const unitSource = (
		parts: Array<TranslationUnitPart>,
		referenced: Set<string>,
	): string => {
		const declarations = generatedDeclarations
			.filter((declaration) => referenced.has(declaration.symbol))
			.map((declaration) => declaration.source);
		return [
			...C_HEADER_LINES,
			...declarations,
			"",
			...parts.map((part) => part.source),
		].join("\n");
	};
	const units = [splitData.source];
	let parts: Array<TranslationUnitPart> = [];
	let referenced = new Set<string>();
	let declarationCodeUnits = 0;
	let bodyCodeUnits = 0;
	const baseHeaderCodeUnits = C_HEADER_LINES.reduce(
		(total, line) => total + line.length + 1,
		0,
	);
	const flush = (): void => {
		if (parts.length === 0) return;
		units.push(unitSource(parts, referenced));
		parts = [];
		referenced = new Set();
		declarationCodeUnits = 0;
		bodyCodeUnits = 0;
	};
	const additionalDeclarationCodeUnits = (part: TranslationUnitPart): number => {
		let codeUnits = 0;
		for (const symbol of part.declarations) {
			if (!referenced.has(symbol)) {
				codeUnits += declarationsBySymbol.get(symbol)!.source.length + 1;
			}
		}
		return codeUnits;
	};
	const append = (input: Omit<TranslationUnitPart, "declarations">): void => {
		const part = preparePart(input);
		let addedDeclarations = additionalDeclarationCodeUnits(part);
		let candidateCodeUnits =
			baseHeaderCodeUnits +
			declarationCodeUnits +
			addedDeclarations +
			bodyCodeUnits +
			part.source.length +
			1;
		if (candidateCodeUnits > maxCodeUnits) {
			flush();
			addedDeclarations = additionalDeclarationCodeUnits(part);
			candidateCodeUnits =
				baseHeaderCodeUnits + addedDeclarations + part.source.length + 1;
		}
		if (candidateCodeUnits > maxCodeUnits) {
			throw new RangeError(
				`generated ${part.kind} '${part.symbol}' has ${part.source.length} code units ` +
					`and requires ${candidateCodeUnits} including its declarations; ` +
					`translation-unit maximum is ${maxCodeUnits}`,
			);
		}
		for (const symbol of part.declarations) referenced.add(symbol);
		declarationCodeUnits += addedDeclarations;
		bodyCodeUnits += part.source.length + 1;
		parts.push(part);
	};
	for (const data of splitData.definitions) {
		append({ kind: "data array", symbol: data.symbol, source: data.source });
	}
	for (const fn of emitted.compiled) {
		if (fn === null) continue;
		append({ kind: "compiled function", symbol: fn.symbol, source: fn.source });
	}
	flush();
	return units;
}

function malVmDefinitionStruct(
	definition: VmDefinition,
	suffix: string,
	debug: boolean,
	sharedLiteralTemplates?: string,
	options: Pick<EmitOptions, "assets" | "maligatorSurface"> = {},
): Array<string> {
	const lines: Array<string> = [];
	const assets = options.assets ?? [];
	const hasLiteralTemplates = definition.literalTemplateData.length > 0;
	const literalTemplatesSymbol = hasLiteralTemplates
		? (sharedLiteralTemplates ?? `mal_literal_templates${suffix}`)
		: "nullptr";
	if (hasLiteralTemplates && sharedLiteralTemplates === undefined) {
		lines.push(
			`static const u32 ${literalTemplatesSymbol}[] = { ${definition.literalTemplateData.join(", ")} };`,
			"",
		);
	}

	const hasCjs = definition.cjsModuleFunctionIndices.length > 0;
	if (hasCjs) {
		lines.push(
			`static const i32 mal_cjs_modules${suffix}[] = { ${definition.cjsModuleFunctionIndices.join(", ")} };`,
			"",
		);
	}

	const hasFiles = debug && definition.files.length > 0;
	if (hasFiles) {
		lines.push(`static const char *const mal_files${suffix}[] = {`);
		for (const file of definition.files) {
			lines.push(`    "${cEscapeString(displayFilePath(file))}",`);
		}
		lines.push("};", "");
	}

	const hasPositions = debug && definition.sourcePositions.length > 0;
	if (hasPositions) {
		lines.push(`static const MalSourcePos mal_source_positions${suffix}[] = {`);
		for (const pos of definition.sourcePositions) {
			lines.push(
				`    { .line = ${pos.line}, .column = ${pos.column}, .inlined_function_index = ${pos.inlinedFunctionIndex ?? -1}, .caller_pos_id = ${pos.callerPosId ?? -1} },`,
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
	const hostInstalls = [...definition.hostInstalls];
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
			for (const { name, slot } of install.exports) {
				lines.push(`    { .name = "${cEscapeString(name)}", .slot = ${slot} },`);
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
		`const MalVmDefinition mal_vm_definition${suffix} = {`,
		`    .function_count = ${definition.functionCount},`,
		`    .functions = mal_functions${suffix},`,
		"    .initialize_generated_data = nullptr,",
		`    .string_constant_count = ${definition.stringConstants.length},`,
		`    .string_constants = ${definition.stringConstants.length > 0 ? `mal_strings${suffix}` : "nullptr"},`,
		`    .bigint_constant_count = ${definition.bigintConstants.length},`,
		`    .bigint_constants = ${definition.bigintConstants.length > 0 ? `mal_bigints${suffix}` : "nullptr"},`,
		`    .literal_template_data_count = ${definition.literalTemplateData.length},`,
		`    .literal_template_data = ${literalTemplatesSymbol},`,
		`    .global_count = ${definition.globalCount},`,
		`    .entry_path = "${cEscapeString(definition.entrypointPath)}",`,
		`    .cjs_module_count = ${definition.cjsModuleFunctionIndices.length},`,
		`    .cjs_module_function_indices = ${hasCjs ? `mal_cjs_modules${suffix}` : "nullptr"},`,
		`    .file_count = ${hasFiles ? definition.files.length : 0},`,
		`    .files = ${hasFiles ? `mal_files${suffix}` : "nullptr"},`,
		`    .source_position_count = ${hasPositions ? definition.sourcePositions.length : 0},`,
		`    .source_positions = ${hasPositions ? `mal_source_positions${suffix}` : "nullptr"},`,
		...(definition.profileSites === undefined
			? []
			: [`    .profile_site_count = ${definition.profileSites.length},`]),
		`    .asset_count = ${assets.length},`,
		`    .assets = ${assets.length > 0 ? `mal_assets${suffix}` : "nullptr"},`,
		`    .host_install_count = ${hostInstalls.length},`,
		`    .host_installs = ${hasHostInstalls ? `mal_host_installs${suffix}` : "nullptr"},`,
		"};",
	);

	return lines;
}

/**
 * Emit several definitions into one translation unit, sharing byte-identical
 * static arrays across them. The test262 harness compiles to the same ~730
 * instructions and ~60 string constants in every test, so emitting each unique
 * array once (and pointing every definition's small MalFunction/MalString table
 * at the shared symbol) collapses the dominant ~60% of the generated C.
 *
 * Sharing is purely content-addressed - only arrays whose emitted bytes are
 * identical merge - so it cannot change behaviour: two definitions share an
 * instruction array iff they would have emitted the same one anyway. The
 * definitions are named `mal_vm_definition_<index>` to match the batch footer.
 * The caller prepends the shared `#include` header (as for the per-test path).
 */
export function emitBatch(
	definitions: Array<VmDefinition>,
	options: Pick<EmitOptions, "compiled"> = {},
): string {
	const useCompiled = options.compiled !== false;
	const lines: Array<string> = [];

	// content -> shared symbol, for each kind of array. `body` is the element
	// list (no surrounding braces); intern wraps it in the array initializer.
	const shared = new Map<string, string>();
	let sharedCounter = 0;
	const intern = (kind: string, type: string, body: string): string => {
		const key = `${kind} ${body}`;
		const existing = shared.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const symbol = `mal_shared_${kind}_${sharedCounter++}`;
		lines.push(`static const ${type} ${symbol}[] = {`, body, "};", "");
		shared.set(key, symbol);
		return symbol;
	};

	for (let d = 0; d < definitions.length; ++d) {
		const definition = definitions[d]!;
		const suffix = `_${d}`;
		const literalTemplatesSymbol =
			definition.literalTemplateData.length > 0
				? intern("literals", "u32", `    ${definition.literalTemplateData.join(", ")}`)
				: undefined;

		const stringSymbols = definition.stringConstants.map((constant) =>
			intern("cu", "c16", `    ${constant.length > 0 ? constant.join(", ") : "0"}`),
		);
		if (stringSymbols.length > 0) {
			// MalString rows are mutable (hashes are cached lazily), so each definition
			// keeps its own table; only the code-unit arrays are shared.
			lines.push(`static MalString mal_strings${suffix}[] = {`);
			for (let i = 0; i < stringSymbols.length; ++i) {
				lines.push(
					malStringRow(stringSymbols[i]!, definition.stringConstants[i]!.length),
				);
			}
			lines.push("};", "");
		}

		if (definition.bigintConstants.length > 0) {
			lines.push(`static MalBigInt mal_bigints${suffix}[] = {`);
			for (const value of definition.bigintConstants) {
				lines.push(
					`    { .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_BIGINT), .value = ${emitBigintValue(value)} },`,
				);
			}
			lines.push("};", "");
		}

		const compiled = definition.functions.map((fn, i) =>
			// The batch path strips debug info, so compiled bodies emit no pos writes.
			useCompiled ? emitCompiledFunction(fn, i, suffix, false) : null,
		);
		for (const fn of compiled) {
			if (fn !== null) {
				lines.push(fn.source, "");
			}
		}

		// Compiled functions never re-enter the interpreter (a param guard falls
		// back to a boxed compiled variant), so they need no bytecode tables.
		const omitBytecode = compiled.map((c) => c !== null);

		const instructionSymbols: Array<string> = [];
		const instructionDataSymbols: Array<string> = [];
		const instructionDataCounts: Array<number> = [];
		const argumentSnapshotPlanSymbols: Array<string> = [];
		const argumentSnapshotPlanCounts: Array<number> = [];
		const mappedArgumentSlotsSymbols: Array<string> = [];
		const handlerSymbols: Array<string> = [];
		for (let i = 0; i < definition.functions.length; ++i) {
			const fn = definition.functions[i]!;
			if (omitBytecode[i]) {
				instructionSymbols.push("nullptr");
				instructionDataSymbols.push("nullptr");
				instructionDataCounts.push(0);
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
		for (let i = 0; i < definition.functions.length; ++i) {
			lines.push(
				...malFunctionRow(
					definition.functions[i]!,
					instructionSymbols[i]!,
					instructionDataSymbols[i]!,
					instructionDataCounts[i]!,
					argumentSnapshotPlanSymbols[i]!,
					argumentSnapshotPlanCounts[i]!,
					mappedArgumentSlotsSymbols[i]!,
					handlerSymbols[i]!,
					compiled[i] !== null ? compiled[i]!.symbol : "nullptr",
					"nullptr",
					// The batch path strips debug info (test262 does not use it).
					{ positionsSymbol: "nullptr", positionCount: 0, fileIndex: 0 },
					omitBytecode[i],
				),
			);
		}
		lines.push("};", "");

		lines.push(
			...malVmDefinitionStruct(definition, suffix, false, literalTemplatesSymbol),
		);
		lines.push("");
	}

	return lines.join("\n");
}

function emitInstruction(instruction: VmInstruction, dataOffset?: number) {
	const sideDataOffset = (): number => {
		if (dataOffset === undefined) throw new Error("missing instruction side-data offset");
		return dataOffset;
	};
	switch (instruction.opcode) {
		case "MOVE":
			return `{ .opcode = MAL_OP_MOVE, .as.move = { .dst = ${instruction.dst}, .src = ${instruction.src} } }`;
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
		case "CREATE_OBJECT_SHAPED":
			return `{ .opcode = MAL_OP_CREATE_OBJECT_SHAPED, .as.create_object_shaped = { .dst = ${instruction.dst}, .data_offset = ${sideDataOffset()}, .shape_cache_index = ${instruction.shapeCacheIndex} } }`;
		case "CREATE_ARRAY":
			return `{ .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = ${instruction.dst}, .length = ${instruction.length} } }`;
		case "INSTANTIATE_LITERAL_TEMPLATE":
			return `{ .opcode = MAL_OP_INSTANTIATE_LITERAL_TEMPLATE, .as.instantiate_literal_template = { .dst = ${instruction.dst}, .template_offset = ${instruction.templateOffset} } }`;
		case "CREATE_MODULE_NAMESPACE":
			return `{ .opcode = MAL_OP_CREATE_MODULE_NAMESPACE, .as.create_module_namespace = { .dst = ${instruction.dst}, .data_offset = ${sideDataOffset()} } }`;
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
		case "LOAD_GLOBAL":
			return `{ .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = ${instruction.dst}, .index = ${instruction.index} } }`;
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
	intrinsic: Extract<VmInstruction, { opcode: "LOAD_INTRINSIC" }>["intrinsic"],
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
	operator: Extract<VmInstruction, { opcode: "UNARY" }>["operator"],
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
		case "increment":
			return "MAL_UNARY_INCREMENT";
		case "decrement":
			return "MAL_UNARY_DECREMENT";
	}

	throw new Error("Unknown unary operator");
}

export function emitTypeofResult(
	result: Extract<VmInstruction, { opcode: "TYPEOF_COMPARE" }>["expected"],
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
