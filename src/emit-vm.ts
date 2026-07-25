import path from "node:path";
import type { IncludedAsset } from "./assets.ts";
import { emitCompiledFunction } from "./emit-c.ts";
import type { CompiledFunction } from "./emit-c.ts";
import { compressPositions } from "./lower-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "./lower-vm.ts";

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
	'#include "vm.h"',
	'#include "vm_ops.h"',
	'#include "value_ops.h"',
	'#include "perf_stats.h"',
	'#include "builtin_math.h"',
	// The compiled (emit-c) for-of lowering uses the iterator-record helpers.
	'#include "builtin_iterator.h"',
	// for-await lowering uses mal_vm_get_async_iterator.
	'#include "builtin_async_iterator.h"',
	// Compiled coroutines dereference MalGeneratorObject (resume_state->frame).
	'#include "generator_object.h"',
	"",
];

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
	debug: { positionsSymbol: string; positionCount: number; fileIndex: number },
	omitBytecode = false,
): Array<string> {
	return [
		"    {",
		`        .name_string_index = ${fn.nameStringIndex},`,
		`        .kind = ${malFunctionKind(fn)},`,
		`        .parameter_count = ${fn.parameterCount},`,
		`        .length = ${fn.length},`,
		`        .register_count = ${fn.registerCount},`,
		`        .captured_count = ${fn.capturedCount},`,
		`        .strict = ${fn.strict},`,
		`        .needs_arguments = ${fn.needsArguments},`,
		`        .argument_snapshot_count = ${fn.argumentSnapshotCount},`,
		`        .argument_snapshot_plan_count = ${argumentSnapshotPlanCount},`,
		`        .argument_snapshot_plan = ${argumentSnapshotPlanSymbol},`,
		`        .mapped_arguments = ${fn.mappedArguments},`,
		`        .mapped_argument_count = ${mappedArgumentSlotsSymbol === "nullptr" ? 0 : fn.mappedArgumentSlots.length},`,
		`        .mapped_argument_slots = ${mappedArgumentSlotsSymbol},`,
		`        .is_derived_constructor = ${fn.isDerivedConstructor},`,
		`        .is_class_constructor = ${fn.isClassConstructor},`,
		`        .has_prototype = ${fn.hasPrototype},`,
		`        .instruction_count = ${omitBytecode ? 0 : fn.instructions.length},`,
		`        .instructions = ${omitBytecode ? "nullptr" : instructionsSymbol},`,
		`        .instruction_data_count = ${omitBytecode ? 0 : instructionDataCount},`,
		`        .instruction_data = ${omitBytecode ? "nullptr" : instructionDataSymbol},`,
		`        .handler_count = ${omitBytecode ? 0 : fn.handlers.length},`,
		`        .handlers = ${omitBytecode ? "nullptr" : handlersSymbol},`,
		`        .compiled = ${compiledSymbol},`,
		`        .file_index = ${debug.fileIndex},`,
		`        .position_count = ${debug.positionCount},`,
		`        .positions = ${debug.positionsSymbol},`,
		"    },",
	];
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
	const suffix = options.symbolSuffix ?? "";
	const debug = options.debugInfo !== false;
	const useCompiled = options.compiled !== false;
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
		lines.push("", `static MalString mal_strings${suffix}[] = {`);
		for (let i = 0; i < definition.stringConstants.length; ++i) {
			const constant = definition.stringConstants[i]!;
			lines.push(malStringRow(`mal_string_${i}_code_units${suffix}`, constant.length));
		}
		lines.push("};", "");
	}

	if (definition.bigintConstants.length > 0) {
		// Immortal bigint constants with their 128-bit value baked at compile time.
		lines.push(`static MalBigInt mal_bigints${suffix}[] = {`);
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
	const compiled: Array<CompiledFunction | null> = definition.functions.map((fn, i) =>
		useCompiled ? emitCompiledFunction(fn, i, suffix, debug) : null,
	);
	for (const fn of compiled) {
		if (fn !== null) {
			lines.push(fn.source, "");
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

	lines.push(...malVmDefinitionStruct(definition, suffix, debug, undefined, options));

	return lines.join("\n");
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
				`    { .path = "${cEscapeString(file.path)}", .data = ${symbol}, .length = ${file.size} },`,
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
		`    .string_constant_count = ${definition.stringConstants.length},`,
		`    .string_constants = ${definition.stringConstants.length > 0 ? `mal_strings${suffix}` : "nullptr"},`,
		`    .bigint_constant_count = ${definition.bigintConstants.length},`,
		`    .bigint_constants = ${definition.bigintConstants.length > 0 ? `mal_bigints${suffix}` : "nullptr"},`,
		`    .literal_template_data_count = ${definition.literalTemplateData.length},`,
		`    .literal_template_data = ${literalTemplatesSymbol},`,
		`    .global_count = ${definition.globalCount},`,
		`    .cjs_module_count = ${definition.cjsModuleFunctionIndices.length},`,
		`    .cjs_module_function_indices = ${hasCjs ? `mal_cjs_modules${suffix}` : "nullptr"},`,
		`    .file_count = ${hasFiles ? definition.files.length : 0},`,
		`    .files = ${hasFiles ? `mal_files${suffix}` : "nullptr"},`,
		`    .source_position_count = ${hasPositions ? definition.sourcePositions.length : 0},`,
		`    .source_positions = ${hasPositions ? `mal_source_positions${suffix}` : "nullptr"},`,
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
			return `{ .opcode = MAL_OP_CREATE_OBJECT_SHAPED, .as.create_object_shaped = { .dst = ${instruction.dst}, .data_offset = ${sideDataOffset()} } }`;
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
		case "LOAD_THIS":
			return `{ .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = ${instruction.dst} } }`;
		case "LOAD_NEW_TARGET":
			return `{ .opcode = MAL_OP_LOAD_NEW_TARGET, .as.load_new_target = { .dst = ${instruction.dst} } }`;
		case "LOAD_CALLEE":
			return `{ .opcode = MAL_OP_LOAD_CALLEE, .as.load_callee = { .dst = ${instruction.dst} } }`;
		case "CALL":
			return `{ .opcode = MAL_OP_CALL, .as.call = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .data_offset = ${sideDataOffset()} } }`;
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
			return `{ .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key} } }`;
		case "LOAD_PROPERTY_STATIC":
			return `{ .opcode = MAL_OP_LOAD_PROPERTY_STATIC, .as.load_property_static = { .dst = ${instruction.dst}, .object = ${instruction.object}, .string_index = ${instruction.stringIndex} } }`;
		case "STORE_PROPERTY":
			return `{ .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = ${instruction.object}, .key = ${instruction.key}, .value = ${instruction.value} } }`;
		case "STORE_PROPERTY_STATIC":
			return `{ .opcode = MAL_OP_STORE_PROPERTY_STATIC, .as.store_property_static = { .object = ${instruction.object}, .value = ${instruction.value}, .string_index = ${instruction.stringIndex} } }`;
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
