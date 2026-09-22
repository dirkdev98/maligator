import {
	remapLiteralTemplateConstants,
	scanLiteralTemplateSegment,
} from "../shared/literal-template-data.ts";
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
import { coreFunctionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreFunctionMetadata,
	CoreExceptionHandler,
	CoreImmediate,
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
	createBigint: ["bigintIndex"],
	instantiateLiteralTemplate: ["templateOffset"],
	createObject: [],
	createObjectShaped: ["keyStringIndices"],
	createArray: ["length"],
	createArrayFromIterable: [],
	loadGlobalProperty: ["nameStringIndex"],
	loadUndeclared: ["nameStringIndex"],
	loadIntrinsic: ["intrinsic"],
	loadProperty: [],
	storeProperty: [],
	loadPropertyStatic: ["stringIndex"],
	storePropertyStatic: ["stringIndex"],
	defineProperty: ["enumerable", "writable?", "configurable?"],
	defineAccessor: ["kind", "enumerable"],
	deleteProperty: [],
	setPrototype: ["literal"],
	checkSuperClass: [],
	construct: [],
	constructSuper: [],
	constructSuperExplicit: [],
	constructSpread: [],
	callSpread: [],
	callSpreadIterable: [],
	loadNewTarget: [],
	setThis: [],
	toPropertyKey: [],
	requireCoercible: [],
	mergeDataProperties: [],
	copyDataProperties: [],
	getIterator: [],
	iteratorStep: [],
	iteratorNext: [],
	iteratorClose: ["normal?"],
	forInKeys: [],
	createRestArguments: ["startIndex"],
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
	parameters: ReadonlyArray<{ value: CoreValueId; role: "value" | "exception" }>;
	handler?: CoreExceptionHandler;
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
	schema: 3;
	globals: number;
	strings: ReadonlyArray<ReadonlyArray<number>>;
	bigints: ReadonlyArray<string>;
	literalTemplates: ReadonlyArray<number>;
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
const preparedDecodedModules = new WeakMap<CoreModuleArtifact, CoreProgram | undefined>();
// These admitted operations carry program references; other attributes remain function-local.
const RELOCATED_OPERATIONS = new Set([
	"createFunction",
	"loadCaptured",
	"storeCaptured",
	"loadGlobal",
	"storeGlobal",
	"createString",
	"loadPropertyStatic",
	"storePropertyStatic",
	"throwIfTdz",
	"loadGlobalProperty",
	"loadUndeclared",
	"createObjectShaped",
	"createBigint",
	"instantiateLiteralTemplate",
]);

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
	op: Pick<ModuleOperation, "opcode" | "attributes">,
	inputCount: number,
	functions: ReadonlyArray<CoreFunctionId>,
	globals: number,
	strings: number,
	bigints: number,
	templates: number,
	templateRoots: ReadonlySet<number>,
	artifact: CoreModuleArtifact,
): CoreInstructionAttributes {
	const allowed = ATTRIBUTES[op.opcode];
	if (allowed === undefined)
		unsupported(`Unsupported reusable Core opcode: ${op.opcode}`);
	if (
		Object.keys(op.attributes).some(
			(key) => !allowed.includes(key) && !allowed.includes(`${key}?`),
		)
	)
		unsupported(`Unsupported reusable Core attributes: ${op.opcode}`);
	if (allowed.some((key) => !key.endsWith("?") && !Object.hasOwn(op.attributes, key)))
		throw new Error("Incomplete Core module attributes");
	switch (op.opcode) {
		case "createBigint":
			return {
				bigintIndex: bigints + index(op.attributes.bigintIndex, artifact.bigints.length),
			};
		case "instantiateLiteralTemplate": {
			const offset = index(
				op.attributes.templateOffset,
				artifact.literalTemplates.length,
			);
			if (!templateRoots.has(offset)) throw new Error("Invalid literal template root");
			return { templateOffset: templates + offset };
		}
		case "createObjectShaped": {
			const keys = op.attributes.keyStringIndices;
			if (!Array.isArray(keys) || keys.length > 64 || keys.length !== inputCount)
				throw new Error("Invalid shaped object keys");
			const names = keys.map((key: unknown) => {
				const units = artifact.strings[index(key, artifact.strings.length)]!;
				let name = "";
				for (let offset = 0; offset < units.length; offset += 1024)
					name += String.fromCharCode(...units.slice(offset, offset + 1024));
				return name;
			});
			if (
				new Set(names).size !== names.length ||
				names.some(
					(name) =>
						name === "__proto__" ||
						(String(Number(name) >>> 0) === name && Number(name) !== 0xffff_ffff),
				)
			)
				throw new Error("Invalid shaped object keys");
			return {
				keyStringIndices: keys.map(
					(key: unknown) => strings + index(key, artifact.strings.length),
				),
			};
		}
		case "createArray":
			index(op.attributes.length, 0x1_0000_0000);
			break;
		case "createRestArguments":
			index(op.attributes.startIndex, 1_000_000);
			break;
		case "loadIntrinsic":
			// Regex literals use the intrinsic even when the global RegExp binding is replaced.
			if (op.attributes.intrinsic !== "RegExp")
				unsupported("Unsupported reusable intrinsic");
			break;
		case "defineProperty":
			if (
				typeof op.attributes.enumerable !== "boolean" ||
				(op.attributes.writable !== undefined &&
					typeof op.attributes.writable !== "boolean") ||
				(op.attributes.configurable !== undefined &&
					typeof op.attributes.configurable !== "boolean")
			)
				throw new Error("Invalid property flags");
			break;
		case "defineAccessor":
			if (
				typeof op.attributes.enumerable !== "boolean" ||
				(op.attributes.kind !== "get" && op.attributes.kind !== "set")
			)
				throw new Error("Invalid accessor flags");
			break;
		case "setPrototype":
			if (typeof op.attributes.literal !== "boolean")
				throw new Error("Invalid prototype flag");
			break;
		case "iteratorClose":
			if (op.attributes.normal !== undefined && typeof op.attributes.normal !== "boolean")
				throw new Error("Invalid iterator close flag");
			break;
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
		case "loadPropertyStatic":
		case "storePropertyStatic":
			return {
				stringIndex: strings + index(op.attributes.stringIndex, artifact.strings.length),
			};
		case "throwIfTdz":
		case "loadGlobalProperty":
		case "loadUndeclared":
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
			index(op.attributes.index, 0x8000_0000);
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
	const ids = [...program.functionIds()];
	const ordinals = new Map(ids.map((id, ordinal) => [id, ordinal]));
	if (ids.length > 100_000 || program.globalCount > 100_000)
		unsupported("Reusable Core exceeds the module size limit");
	const functionOrdinal = (value: unknown) => {
		const ordinal = ordinals.get(value as CoreFunctionId);
		if (ordinal === undefined)
			unsupported("Reusable Core excludes external or synthetic function owners");
		return ordinal;
	};
	if (
		candidates?.singleAssignmentCapturedSlots.some(
			(slot) => !ordinals.has(slot.owner as CoreFunctionId),
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
		schema: 3,
		globals: program.globalCount,
		strings: program.stringConstants,
		bigints: program.bigintConstants.map(String),
		literalTemplates: program.literalTemplateData,
		positions,
		initializer: functionOrdinal(initializer),
		exports,
		singleAssignmentGlobalSlots: candidates?.singleAssignmentGlobalSlots ?? [],
		singleAssignmentCapturedSlots: (candidates?.singleAssignmentCapturedSlots ?? []).map(
			(slot) => ({
				owner: functionOrdinal(slot.owner),
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
				metadata.mappedArguments ||
				!metadata.strict ||
				[...fn.factIds()].length !== 0
			)
				unsupported(
					"Reusable Core requires strict synchronous functions without profiles or facts",
				);
			return {
				metadata,
				parameterCount: fn.parameterCount,
				entry: fn.entry,
				bodyEntry: fn.bodyEntry,
				blocks: [...fn.blockIds()].map((block) => {
					const parameters = coreBlockParameters(fn, block);
					if (parameters.some((p) => p.representation !== "boxed"))
						unsupported("Reusable Core pilot requires boxed parameters");
					const terminator = fn.blockTerminator(block);
					return {
						id: block,
						parameters: parameters.map(({ value, role }) => ({ value, role })),
						handler: coreBlockHandler(fn, block),
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
	prepareCoreModule(artifact);
}

function prepareCoreModule(artifact: CoreModuleArtifact): CoreProgram {
	const scratch = new CoreProgram(coreOpcodeRegistry);
	importValidatedCoreModule(scratch, artifact, "<validation>");
	if (!preparedDecodedModules.has(artifact))
		verifyCoreProgram(scratch, { stage: "pre-target" });
	return scratch;
}

export function importCoreModule(
	program: CoreProgram,
	artifact: CoreModuleArtifact,
	sourcePath: string,
) {
	if (
		program.registry !== coreOpcodeRegistry ||
		program.sealed ||
		sourcePath.length === 0
	)
		throw new Error("Unsupported Core module destination");
	const prepared = preparedDecodedModules.get(artifact) ?? prepareCoreModule(artifact);
	const functions = artifact.functions.map((_, ordinal) =>
		coreFunctionId(program.functionCapacity + ordinal),
	);
	const globalBase = program.globalCount;
	const stringBase = program.stringConstants.length;
	const bigintBase = program.bigintConstants.length;
	const templateBase = program.literalTemplateData.length;
	const templateRoots = new Set<number>();
	for (let offset = 0; offset < artifact.literalTemplates.length; ) {
		templateRoots.add(offset);
		offset = scanLiteralTemplateSegment(
			artifact.literalTemplates,
			offset,
			"Core module",
		).endOffset;
	}
	const templates = remapLiteralTemplateConstants(
		artifact.literalTemplates,
		[...templateRoots],
		"Core module",
		(value) => stringBase + index(value, artifact.strings.length),
		(value) => bigintBase + index(value, artifact.bigints.length),
	);
	const imported = importedModule(artifact, functions, globalBase);
	CoreEditor.transferFunctions(program, prepared, {
		data: {
			globalCount: globalBase + artifact.globals,
			stringConstants: [...program.stringConstants, ...prepared.stringConstants],
			bigintConstants: [...program.bigintConstants, ...prepared.bigintConstants],
			literalTemplateData: [...program.literalTemplateData, ...templates],
			sourcePositions: [...program.sourcePositions, ...prepared.sourcePositions],
		},
		sourcePositionOffset: program.sourcePositions.length,
		metadata: (fn) => ({
			...fn.metadata,
			sourcePath,
			nameStringIndex: stringBase + fn.metadata.nameStringIndex,
		}),
		attributes(fn, instruction) {
			const opcode = fn.instructionOpcodeName(instruction);
			const original = fn.instructionAttributes(instruction);
			if (!RELOCATED_OPERATIONS.has(opcode)) return original;
			return attributes(
				{
					opcode,
					attributes: original,
				},
				fn.kernel.instructionOperandCount(instruction),
				functions,
				globalBase,
				stringBase,
				bigintBase,
				templateBase,
				templateRoots,
				artifact,
			);
		},
		immediate: (value) =>
			value.kind === "string"
				? relocateImmediate(value, artifact.strings.length, stringBase)
				: value,
	});
	if (preparedDecodedModules.has(artifact))
		preparedDecodedModules.set(artifact, undefined);
	return imported;
}

function importValidatedCoreModule(
	program: CoreProgram,
	artifact: CoreModuleArtifact,
	sourcePath: string,
) {
	if (
		artifact.schema !== 3 ||
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
	const bigintBase = program.bigintConstants.length;
	const templateBase = program.literalTemplateData.length;
	const bigints = artifact.bigints.map((value) => {
		if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value))
			throw new Error("Invalid bigint encoding");
		return BigInt(value);
	});
	for (const word of artifact.literalTemplates) index(word, 0x1_0000_0000);
	const templateRoots = new Set<number>();
	for (let offset = 0; offset < artifact.literalTemplates.length; ) {
		templateRoots.add(offset);
		offset = scanLiteralTemplateSegment(
			artifact.literalTemplates,
			offset,
			"Core module",
		).endOffset;
	}
	const templates = remapLiteralTemplateConstants(
		artifact.literalTemplates,
		[...templateRoots],
		"Core module",
		(value) => stringBase + index(value, artifact.strings.length),
		(value) => bigintBase + index(value, artifact.bigints.length),
	);
	CoreEditor.configureProgram(program, {
		globalCount: globalBase + artifact.globals,
		stringConstants: [...program.stringConstants, ...artifact.strings],
		sourcePositions: [...program.sourcePositions, ...artifact.positions],
		bigintConstants: [...program.bigintConstants, ...bigints],
		literalTemplateData: [...program.literalTemplateData, ...templates],
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
			(m.isDerivedConstructor && !m.isClassConstructor) ||
			(m.isClassConstructor && (!m.hasPrototype || m.lexicalThis)) ||
			[
				m.strict,
				m.sourceStrict,
				m.mappedArguments,
				m.isClassConstructor,
				m.isDerivedConstructor,
				m.hasPrototype,
				m.lexicalThis,
			].some((value) => typeof value !== "boolean") ||
			!Number.isSafeInteger(m.length) ||
			m.length < 0 ||
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
			const id = builder.createBlock(
				block.parameters.map(({ role }) => {
					if (role !== "value" && role !== "exception")
						throw new Error("Invalid parameter role");
					return { role };
				}),
			);
			blocks.set(block.id, id);
			block.parameters.forEach(({ value }, i) =>
				setValue(value, builder.blockParameterValue(id, i)),
			);
		}
		const entry = mapped(blocks, fn.entry);
		// Serialized block order need not put dominators before their consumers.
		let placeholder: ReturnType<CoreEditor["appendInstruction"]> | undefined;
		const pending: Array<{
			instruction: CoreInstructionId;
			inputs: ReadonlyArray<CoreValueId>;
		}> = [];
		const position = (p: number | undefined) =>
			p === undefined ? undefined : positionBase + index(p, artifact.positions.length);
		for (const block of fn.blocks)
			for (const operation of block.operations) {
				let hasForwardInputs = false;
				const inputs = operation.inputs.map((value) => {
					const input = values.get(value);
					if (input !== undefined) return input;
					hasForwardInputs = true;
					placeholder ??= builder.editor.appendInstruction(entry, "createUndefined", []);
					return placeholder.outputs[0]!;
				});
				const created = builder.editor.appendInstruction(
					mapped(blocks, block.id),
					operation.opcode,
					inputs,
					{
						outputCount: operation.outputs.length,
						attributes: attributes(
							operation,
							operation.inputs.length,
							functions,
							globalBase,
							stringBase,
							bigintBase,
							templateBase,
							templateRoots,
							artifact,
						),
						sourcePosition: position(operation.position),
					},
				);
				operation.outputs.forEach((value, i) => setValue(value, created.outputs[i]!));
				if (hasForwardInputs)
					pending.push({ instruction: created.instruction, inputs: operation.inputs });
			}
		for (const operation of pending)
			builder.editor.replaceOperands(
				operation.instruction,
				operation.inputs.map((value) => mapped(values, value)),
			);
		if (placeholder !== undefined)
			builder.editor.removeInstruction(placeholder.instruction);
		const edge = (e: { block: CoreBlockId; arguments: ReadonlyArray<CoreValueId> }) => ({
			block: mapped(blocks, e.block),
			arguments: e.arguments.map((value) => mapped(values, value)),
		});
		for (const block of fn.blocks) {
			if (block.handler !== undefined) {
				const handler = edge(block.handler);
				builder.setHandler(mapped(blocks, block.id), handler.block, handler.arguments);
			}
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
				case "switch":
					relocated = {
						kind: "switch",
						discriminant: mapped(values, term.discriminant),
						cases: term.cases.map((item) => ({
							value: relocateImmediate(item.value, artifact.strings.length, stringBase),
							edge: edge(item.edge),
						})),
						default: edge(term.default),
					};
					break;
				case "unreachable":
					relocated = { kind: term.kind };
					break;
				default:
					unsupported("Reusable Core excludes proof guards");
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
	return importedModule(artifact, functions, globalBase);
}

function importedModule(
	artifact: CoreModuleArtifact,
	functions: ReadonlyArray<CoreFunctionId>,
	globalBase: number,
) {
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

function relocateImmediate(
	value: CoreImmediate,
	stringCount: number,
	stringBase: number,
): CoreImmediate {
	switch (value.kind) {
		case "undefined":
		case "null":
			return { kind: value.kind };
		case "boolean":
			if (typeof value.value !== "boolean") throw new Error("Invalid boolean case");
			return { kind: value.kind, value: value.value };
		case "number":
			if (typeof value.value !== "number") throw new Error("Invalid number case");
			return { kind: value.kind, value: value.value };
		case "string":
			return { kind: value.kind, index: stringBase + index(value.index, stringCount) };
		default:
			throw new Error("Invalid switch case");
	}
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
	const artifact = JSON.parse(encoded) as CoreModuleArtifact;
	// Only literal values admit special numbers; IDs and packed words must remain integers.
	for (const fn of artifact.functions) {
		for (const block of fn.blocks) {
			for (const operation of block.operations) {
				if (
					["createNumber", "createF64", "createI32"].includes(operation.opcode) &&
					typeof operation.attributes.value !== "number"
				)
					operation.attributes = {
						...operation.attributes,
						value: decodeNumber(operation.attributes.value),
					};
			}
			if (
				block.terminator.kind === "switch" &&
				block.terminator.cases.some(
					(item) => item.value.kind === "number" && typeof item.value.value !== "number",
				)
			)
				block.terminator = {
					...block.terminator,
					cases: block.terminator.cases.map((item) => ({
						...item,
						value:
							item.value.kind === "number"
								? { kind: "number", value: decodeNumber(item.value.value) }
								: item.value,
					})),
				};
		}
	}
	const prepared = prepareCoreModule(artifact);
	// Only freshly decoded, recursively immutable objects can reuse structural validation.
	freezeDecodedValue(artifact);
	preparedDecodedModules.set(artifact, prepared);
	return artifact;
}

function decodeNumber(value: unknown): number {
	if (typeof value === "number") return value;
	if (
		value === null ||
		typeof value !== "object" ||
		Object.keys(value).length !== 1 ||
		!("$number" in value) ||
		typeof value.$number !== "string" ||
		!["-0", "NaN", "Infinity", "-Infinity"].includes(value.$number)
	)
		throw new Error("Invalid Core numeric encoding");
	return Number(value.$number);
}
