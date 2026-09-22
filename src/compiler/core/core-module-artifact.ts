import { CoreFunctionBuilder } from "./core-builder.ts";
import type { CoreProgramData } from "./core-compilation.ts";
import {
	coreBlockHandler,
	coreBlockParameters,
	coreInstructionOperands,
	coreInstructionResults,
	coreTerminatorPayload,
} from "./core-debug-view.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreFunctionMetadata,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import { CoreProgram } from "./core-store.ts";
import type { CoreSourcePosition } from "./core-store.ts";

const ATTRIBUTES: Readonly<Record<string, ReadonlyArray<string>>> = {
	createUndefined: [],
	createEmpty: [],
	createNull: [],
	createBoolean: ["value"],
	createNumber: ["value"],
	createF64: ["value"],
	createI32: ["value"],
	createString: ["stringIndex"],
	createFunction: ["functionIndex"],
	loadGlobal: ["index"],
	storeGlobal: ["index"],
	loadCaptured: ["functionIndex", "index"],
	storeCaptured: ["functionIndex", "index"],
	throwIfTdz: ["nameStringIndex"],
	binary: ["operator"],
	unary: ["operator"],
	typeofCompare: ["expected", "negated"],
	move: [],
	call: [],
	loadThis: [],
	loadArgument: ["index"],
	loadArgumentCount: [],
	loadStaticArgument: ["index"],
};

interface ModuleOperation {
	opcode: string;
	inputs: ReadonlyArray<CoreValueId>;
	outputs: ReadonlyArray<CoreValueId>;
	attributes: CoreInstructionAttributes;
	position?: number;
}
interface ModuleBlock {
	id: CoreBlockId;
	parameters: ReadonlyArray<CoreValueId>;
	operations: ReadonlyArray<ModuleOperation>;
	terminator: CoreTerminatorPayload;
	position?: number;
}
interface ModuleFunction {
	metadata: Omit<CoreFunctionMetadata, "sourcePath" | "sourceOrigin">;
	parameterCount: number;
	entry: CoreBlockId;
	bodyEntry?: CoreBlockId;
	blocks: ReadonlyArray<ModuleBlock>;
}
export interface CoreModuleArtifact {
	schema: 2;
	globals: number;
	strings: ReadonlyArray<ReadonlyArray<number>>;
	positions: ReadonlyArray<CoreSourcePosition>;
	functions: ReadonlyArray<ModuleFunction>;
	initializer: number;
	exports: ReadonlyArray<{ name: string; slot: number }>;
	singleAssignmentGlobalSlots: ReadonlyArray<number>;
	singleAssignmentCapturedSlots: ReadonlyArray<{ owner: number; index: number }>;
}
export interface CompletedCoreModule {
	artifact: CoreModuleArtifact;
	completedRecipe: "conservative-local-v1";
}
export const CORE_MODULE_MAX_ENCODED_LENGTH = 32 * 1024 * 1024;
const immutableDecodedModules = new WeakSet<CoreModuleArtifact>();

function freezeDecodedValue(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	for (const child of Object.values(value)) freezeDecodedValue(child);
	Object.freeze(value);
}
export class UnsupportedCoreModuleError extends Error {}
function unsupported(message: string): never {
	throw new UnsupportedCoreModuleError(message);
}
function index(value: unknown, length: number): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value >= length
	)
		throw new Error("Invalid Core module index");
	return value;
}
function attributes(
	op: ModuleOperation,
	functions: ReadonlyArray<CoreFunctionId>,
	globals: number,
	strings: number,
	artifact: CoreModuleArtifact,
): CoreInstructionAttributes {
	const allowed = ATTRIBUTES[op.opcode];
	if (allowed === undefined)
		unsupported(`Unsupported reusable Core opcode: ${op.opcode}`);
	if (Object.keys(op.attributes).some((key) => !allowed.includes(key)))
		unsupported(`Unsupported reusable Core attributes: ${op.opcode}`);
	if (Object.keys(op.attributes).length !== allowed.length)
		throw new Error("Incomplete Core module attributes");
	switch (op.opcode) {
		case "typeofCompare":
			if (
				typeof op.attributes.negated !== "boolean" ||
				typeof op.attributes.expected !== "string" ||
				![
					"undefined",
					"object",
					"boolean",
					"number",
					"string",
					"symbol",
					"bigint",
					"function",
				].includes(op.attributes.expected)
			)
				throw new Error("Invalid typeof comparison");
			break;
		case "loadCaptured":
		case "storeCaptured": {
			const owner = index(op.attributes.functionIndex, functions.length);
			return {
				functionIndex: functions[owner]!,
				index: index(
					op.attributes.index,
					artifact.functions[owner]!.metadata.capturedCount,
				),
			};
		}
		case "createFunction":
			return {
				functionIndex: functions[index(op.attributes.functionIndex, functions.length)]!,
			};
		case "loadGlobal":
		case "storeGlobal":
			return { index: globals + index(op.attributes.index, artifact.globals) };
		case "createString":
			return {
				stringIndex: strings + index(op.attributes.stringIndex, artifact.strings.length),
			};
		case "throwIfTdz":
			return {
				nameStringIndex:
					strings + index(op.attributes.nameStringIndex, artifact.strings.length),
			};
		case "createF64":
		case "createI32":
		case "createNumber":
			if (typeof op.attributes.value !== "number") throw new Error("Invalid number");
			break;
		case "createBoolean":
			if (typeof op.attributes.value !== "boolean") throw new Error("Invalid boolean");
			break;
		case "unary":
			if (
				typeof op.attributes.operator !== "string" ||
				![
					"+",
					"-",
					"!",
					"~",
					"typeof",
					"tonumeric",
					"tostring",
					"increment",
					"decrement",
				].includes(op.attributes.operator)
			)
				throw new Error("Invalid unary operator");
			break;
		case "binary":
			if (
				typeof op.attributes.operator !== "string" ||
				![
					"+",
					"-",
					"*",
					"/",
					"%",
					"**",
					"<<",
					">>",
					">>>",
					"<",
					"<=",
					">",
					">=",
					"==",
					"!=",
					"===",
					"!==",
					"&",
					"|",
					"^",
					"in",
					"instanceof",
				].includes(op.attributes.operator)
			)
				throw new Error("Invalid binary operator");
			break;
		case "loadArgument":
		case "loadStaticArgument":
			index(op.attributes.index, 1_000_000);
			break;
	}
	return op.attributes;
}

export function captureCoreModule(
	program: CoreProgram,
	exports: CoreModuleArtifact["exports"],
	initializer: CoreFunctionId,
	candidates?: Pick<
		CoreProgramData,
		"singleAssignmentGlobalSlots" | "singleAssignmentCapturedSlots"
	>,
): CoreModuleArtifact {
	if (program.bigintConstants.length !== 0 || program.literalTemplateData.length !== 0)
		unsupported("Reusable Core pilot excludes bigint and literal templates");
	const ids = [...program.functionIds()];
	if (ids.length > 100_000 || program.globalCount > 100_000)
		unsupported("Reusable Core exceeds the module size limit");
	const functionOrdinal = (value: unknown) => {
		const ordinal = ids.indexOf(value as CoreFunctionId);
		if (ordinal < 0)
			unsupported("Reusable Core excludes external or synthetic function owners");
		return ordinal;
	};
	if (
		candidates?.singleAssignmentCapturedSlots.some(
			(slot) => !ids.includes(slot.owner as CoreFunctionId),
		)
	)
		unsupported("Reusable Core excludes synthetic captured environments");
	const positions = program.sourcePositions;
	if (
		positions.some(
			(p) => p.inlinedFunctionIndex !== undefined || p.callerPosId !== undefined,
		)
	)
		unsupported("Reusable Core pilot excludes inlined source chains");
	const artifact: CoreModuleArtifact = {
		schema: 2,
		globals: program.globalCount,
		strings: program.stringConstants,
		positions,
		initializer: ids.indexOf(initializer),
		exports,
		singleAssignmentGlobalSlots: candidates?.singleAssignmentGlobalSlots ?? [],
		singleAssignmentCapturedSlots: (candidates?.singleAssignmentCapturedSlots ?? []).map(
			(slot) => ({
				owner: ids.indexOf(slot.owner as CoreFunctionId),
				index: slot.index,
			}),
		),
		functions: ids.map((id) => {
			const fn = program.function(id);
			if (
				fn.blockCapacity > 1_000_000 ||
				fn.valueCapacity > 1_000_000 ||
				fn.parameterCount > 100_000
			)
				unsupported("Reusable Core exceeds the function size limit");
			const { sourcePath: _path, sourceOrigin, ...metadata } = fn.metadata;
			if (
				sourceOrigin !== undefined ||
				fn.isAsync ||
				fn.isGenerator ||
				metadata.isClassConstructor ||
				metadata.isDerivedConstructor ||
				metadata.mappedArguments ||
				!metadata.strict ||
				[...fn.factIds()].length !== 0
			)
				unsupported(
					"Reusable Core requires strict functions without profiles, classes or facts",
				);
			return {
				metadata,
				parameterCount: fn.parameterCount,
				entry: fn.entry,
				bodyEntry: fn.bodyEntry,
				blocks: [...fn.blockIds()].map((block) => {
					if (coreBlockHandler(fn, block) !== undefined)
						unsupported("Reusable Core pilot excludes exception handlers");
					const parameters = coreBlockParameters(fn, block);
					if (parameters.some((p) => p.representation !== "boxed" || p.role !== "value"))
						unsupported("Reusable Core pilot requires boxed parameters");
					const terminator = fn.blockTerminator(block);
					return {
						id: block,
						parameters: parameters.map((p) => p.value),
						terminator: coreTerminatorPayload(fn, terminator),
						position: fn.instructionSourcePosition(terminator),
						operations: [...fn.bodyInstructionIds(block)].map((instruction) => {
							const outputs = coreInstructionResults(fn, instruction);
							if (
								fn.instructionEffectRefinement(instruction) !== undefined ||
								outputs.some((value) => fn.valueRepresentation(value) !== "boxed")
							)
								unsupported(
									"Reusable Core pilot excludes effect refinements and target representations",
								);
							const opcode = fn.instructionOpcodeName(instruction);
							const attrs = fn.instructionAttributes(instruction);
							return {
								opcode,
								inputs: coreInstructionOperands(fn, instruction),
								outputs,
								attributes:
									opcode === "createFunction" ||
									opcode === "loadCaptured" ||
									opcode === "storeCaptured"
										? {
												...attrs,
												functionIndex: functionOrdinal(attrs.functionIndex),
											}
										: attrs,
								position: fn.instructionSourcePosition(instruction),
							};
						}),
					};
				}),
			};
		}),
	};
	validateCoreModule(artifact);
	return artifact;
}

export function validateCoreModule(artifact: CoreModuleArtifact): void {
	const scratch = new CoreProgram(coreOpcodeRegistry);
	importValidatedCoreModule(scratch, artifact, "<validation>");
	verifyCoreProgram(scratch, { stage: "pre-target" });
}

export function importCoreModule(
	program: CoreProgram,
	artifact: CoreModuleArtifact,
	sourcePath: string,
) {
	if (program.registry !== coreOpcodeRegistry || sourcePath.length === 0)
		throw new Error("Unsupported Core module destination");
	// Core editors have no rollback; reject malformed artifacts before reserving destination IDs.
	if (!immutableDecodedModules.has(artifact)) validateCoreModule(artifact);
	return importValidatedCoreModule(program, artifact, sourcePath);
}

function importValidatedCoreModule(
	program: CoreProgram,
	artifact: CoreModuleArtifact,
	sourcePath: string,
) {
	if (
		artifact.schema !== 2 ||
		!Number.isSafeInteger(artifact.globals) ||
		artifact.globals < 0 ||
		artifact.globals > 100_000 ||
		artifact.functions.length === 0 ||
		artifact.functions.length > 100_000
	)
		throw new Error("Invalid Core module header");
	index(artifact.initializer, artifact.functions.length);
	for (const slot of artifact.singleAssignmentGlobalSlots) index(slot, artifact.globals);
	for (const slot of artifact.singleAssignmentCapturedSlots) {
		const owner = index(slot.owner, artifact.functions.length);
		index(slot.index, artifact.functions[owner]!.metadata.capturedCount);
	}
	for (const units of artifact.strings) for (const unit of units) index(unit, 65536);
	for (const position of artifact.positions) {
		if (
			Object.keys(position).some((key) => key !== "line" && key !== "column") ||
			!Number.isSafeInteger(position.line) ||
			!Number.isSafeInteger(position.column) ||
			position.line < 0 ||
			position.column < 0
		)
			throw new Error("Invalid Core module position");
	}
	const names = new Set<string>();
	for (const exported of artifact.exports) {
		if (typeof exported.name !== "string" || names.has(exported.name))
			throw new Error("Invalid Core module export");
		names.add(exported.name);
		index(exported.slot, artifact.globals);
	}
	const globalBase = program.globalCount;
	const stringBase = program.stringConstants.length;
	const positionBase = program.sourcePositions.length;
	CoreEditor.configureProgram(program, {
		globalCount: globalBase + artifact.globals,
		stringConstants: [...program.stringConstants, ...artifact.strings],
		sourcePositions: [...program.sourcePositions, ...artifact.positions],
		bigintConstants: program.bigintConstants,
		literalTemplateData: program.literalTemplateData,
	});
	const builders = artifact.functions.map((fn) => {
		const m = fn.metadata;
		if (
			!m.strict ||
			!m.sourceStrict ||
			!Number.isSafeInteger(m.capturedCount) ||
			m.capturedCount < 0 ||
			m.capturedCount > 100_000 ||
			m.mappedArguments ||
			m.mappedArgumentSlots.length !== 0 ||
			m.isClassConstructor ||
			m.isDerivedConstructor ||
			Object.keys(m).some(
				(key) =>
					![
						"sourceStrict",
						"nameStringIndex",
						"length",
						"mappedArguments",
						"mappedArgumentSlots",
						"capturedCount",
						"strict",
						"isClassConstructor",
						"isDerivedConstructor",
						"hasPrototype",
						"lexicalThis",
					].includes(key),
			)
		)
			unsupported("Unsupported Core module metadata");
		index(m.nameStringIndex, artifact.strings.length);
		if (
			!Number.isSafeInteger(fn.parameterCount) ||
			fn.parameterCount < 0 ||
			fn.parameterCount > 100_000
		)
			throw new Error("Invalid parameter count");
		return new CoreFunctionBuilder(program, {
			parameterCount: fn.parameterCount,
			metadata: { ...m, sourcePath, nameStringIndex: stringBase + m.nameStringIndex },
		});
	});
	const functions = builders.map((builder) => builder.functionId);
	artifact.functions.forEach((fn, ordinal) => {
		const builder = builders[ordinal]!;
		const blocks = new Map<CoreBlockId, CoreBlockId>();
		const values = new Map<CoreValueId, CoreValueId>();
		const mapped = <K, V>(map: ReadonlyMap<K, V>, key: K): V => {
			const value = map.get(key);
			if (value === undefined) throw new Error("Missing Core relocation");
			return value;
		};
		const setValue = (old: CoreValueId, value: CoreValueId) => {
			index(old, 1_000_000);
			if (values.has(old)) throw new Error("Duplicate Core value");
			values.set(old, value);
		};
		for (const block of fn.blocks) {
			index(block.id, 1_000_000);
			if (blocks.has(block.id)) throw new Error("Duplicate Core block");
			const id = builder.createBlock(block.parameters.map(() => ({})));
			blocks.set(block.id, id);
			block.parameters.forEach((value, i) =>
				setValue(value, builder.blockParameterValue(id, i)),
			);
		}
		const entry = mapped(blocks, fn.entry);
		const placeholder = builder.editor.appendInstruction(entry, "createUndefined", []);
		const pending: Array<{
			instruction: CoreInstructionId;
			inputs: ReadonlyArray<CoreValueId>;
		}> = [];
		const position = (p: number | undefined) =>
			p === undefined ? undefined : positionBase + index(p, artifact.positions.length);
		for (const block of fn.blocks)
			for (const operation of block.operations) {
				const created = builder.editor.appendInstruction(
					mapped(blocks, block.id),
					operation.opcode,
					operation.inputs.map(() => placeholder.outputs[0]!),
					{
						outputCount: operation.outputs.length,
						attributes: attributes(
							operation,
							functions,
							globalBase,
							stringBase,
							artifact,
						),
						sourcePosition: position(operation.position),
					},
				);
				operation.outputs.forEach((value, i) => setValue(value, created.outputs[i]!));
				pending.push({ instruction: created.instruction, inputs: operation.inputs });
			}
		for (const operation of pending)
			builder.editor.replaceOperands(
				operation.instruction,
				operation.inputs.map((value) => mapped(values, value)),
			);
		builder.editor.removeInstruction(placeholder.instruction);
		const edge = (e: { block: CoreBlockId; arguments: ReadonlyArray<CoreValueId> }) => ({
			block: mapped(blocks, e.block),
			arguments: e.arguments.map((value) => mapped(values, value)),
		});
		for (const block of fn.blocks) {
			const term = block.terminator;
			let relocated: CoreTerminatorPayload;
			switch (term.kind) {
				case "jump":
					relocated = { kind: term.kind, edge: edge(term.edge) };
					break;
				case "branch":
					relocated = {
						kind: term.kind,
						condition: mapped(values, term.condition),
						consequent: edge(term.consequent),
						alternate: edge(term.alternate),
					};
					break;
				case "return":
				case "throw":
					relocated = { kind: term.kind, value: mapped(values, term.value) };
					break;
				case "unreachable":
					relocated = { kind: term.kind };
					break;
				default:
					unsupported("Reusable Core pilot excludes guards and switches");
			}
			builder.setTerminator(mapped(blocks, block.id), {
				...relocated,
				sourcePosition: position(block.position),
			});
		}
		builder.finish(
			entry,
			fn.bodyEntry === undefined ? undefined : mapped(blocks, fn.bodyEntry),
		);
	});
	return {
		initializer: functions[artifact.initializer]!,
		functions,
		exports: new Map(artifact.exports.map((item) => [item.name, globalBase + item.slot])),
		globals: artifact.globals,
		singleAssignmentGlobalSlots: artifact.singleAssignmentGlobalSlots.map(
			(slot) => globalBase + slot,
		),
		singleAssignmentCapturedSlots: artifact.singleAssignmentCapturedSlots.map((slot) => ({
			owner: functions[slot.owner]!,
			index: slot.index,
		})),
	};
}

export function encodeCoreModule(artifact: CoreModuleArtifact): string {
	return JSON.stringify(artifact, (_key, value: unknown) =>
		typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))
			? { $number: Object.is(value, -0) ? "-0" : String(value) }
			: value,
	);
}
export function decodeCoreModule(encoded: string): CoreModuleArtifact {
	if (encoded.length > CORE_MODULE_MAX_ENCODED_LENGTH)
		throw new Error("Core module exceeds pilot size limit");
	const artifact = JSON.parse(encoded, (_key, value: unknown) => {
		if (value !== null && typeof value === "object" && "$number" in value) {
			if (
				Object.keys(value).length !== 1 ||
				!["-0", "NaN", "Infinity", "-Infinity"].includes(String(value.$number))
			)
				throw new Error("Invalid Core numeric encoding");
			return Number(value.$number);
		}
		return value;
	}) as CoreModuleArtifact;
	validateCoreModule(artifact);
	// Only freshly decoded, recursively immutable objects can reuse structural validation.
	freezeDecodedValue(artifact);
	immutableDecodedModules.add(artifact);
	return artifact;
}
