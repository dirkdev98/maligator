import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import { EMBED_INSTALLER } from "../shared/embedded-asset.ts";
import {
	BUFFER_STRING_ENCODINGS,
	PLATFORM_SOURCE_EXPORTS,
	PLATFORM_OBJECT_RESULTS,
	EMBEDDED_ASSET_RESULTS,
	HOST_RESULT_CONTRACTS,
} from "../shared/host-result-contracts.ts";
import type {
	HostObjectKind,
	HostResultContract,
	HostValueContract,
} from "../shared/host-result-contracts.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import {
	primordialNode,
	resolvePrimordialProperty,
} from "../shared/primordial-catalog.ts";
import { coreDeferredHostSlots } from "./core-compilation.ts";
import type {
	ConstructedCoreCompilation,
	CoreCompilationContext,
} from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreNormalResultFacts } from "./core-editor.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreProgramFlowTargetIndex } from "./core-program-flow.ts";
import { coreSuccessfulAwaitInput } from "./core-promise-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface CoreHostSlot {
	readonly root: string;
	readonly contract?: HostResultContract;
}

export type CoreHostSlots = ReadonlyMap<number, CoreHostSlot>;
const hostSlots = new WeakMap<CoreCompilationContext["data"], CoreHostSlots>();
const noHostSlots: CoreHostSlots = new Map();

export function coreHostResultSlots(context: CoreCompilationContext): CoreHostSlots {
	const { data, facts } = context;
	// Host installers may reuse mutated module objects on later images or
	// when the runtime first loads a source builtin.
	if (
		data.inheritsHostComponents ||
		data.moduleLinks !== undefined ||
		facts.closure.scope.kind !== "whole-program" ||
		facts.closure.openings.some(
			({ kind }) => kind === "relocatable-artifact" || kind === "host-wire-splicing",
		)
	)
		return noHostSlots;
	const prior = hostSlots.get(context.data);
	if (prior !== undefined) return prior;
	const slots = new Map<number, CoreHostSlot>();
	const deferred = coreDeferredHostSlots(data);
	for (const candidate of context.data.hostInstallCandidates) {
		const contracts = HOST_RESULT_CONTRACTS.get(candidate.installer);
		if (contracts === undefined && candidate.installer !== EMBED_INSTALLER) continue;
		for (const installed of candidate.exports) {
			if (deferred.has(installed.slot)) continue;
			const asset =
				candidate.installer === EMBED_INSTALLER && installed.name === "default"
					? installed.data
					: undefined;
			const assetKind =
				typeof asset === "object" && asset !== null && "kind" in asset
					? asset.kind
					: undefined;
			const contract =
				assetKind === "file" || assetKind === "directory"
					? ({
							kind: "return",
							value: { mask: COMPILER_VALUE_KIND_OBJECT, assetHandle: assetKind },
						} as const)
					: contracts?.get(installed.name);
			slots.set(installed.slot, {
				root: `${candidate.installer}:${installed.name}`,
				contract,
			});
		}
	}
	hostSlots.set(context.data, slots);
	return slots;
}

function hostSlotContract(
	fn: CoreFunctionStore,
	producer: CoreInstructionId,
	slots: CoreHostSlots,
) {
	if (fn.instructionOpcodeName(producer) !== "loadGlobal") return undefined;
	const slot = fn.instructionAttributes(producer).index;
	return typeof slot === "number" ? slots.get(slot)?.contract : undefined;
}

export function coreHostSlotName(
	fn: CoreFunctionStore,
	producer: CoreInstructionId,
	slots: CoreHostSlots,
): string | undefined {
	if (fn.instructionOpcodeName(producer) !== "loadGlobal") return undefined;
	const index = fn.instructionAttributes(producer).index;
	const root = typeof index === "number" ? slots.get(index)?.root : undefined;
	return root?.slice(root.indexOf(":") + 1);
}

export function coreHostSlotValue(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	slots: CoreHostSlots,
): HostValueContract | undefined {
	if (slots.size === 0) return undefined;
	const producer = definition(fn, value);
	const contract =
		producer === undefined
			? undefined
			: (hostSlotContract(fn, producer, slots) ??
				catalogCallableContract(program, fn, producer, slots, true));
	return contract?.kind === "return" ? contract.value : undefined;
}

function catalogCallableContract(
	program: CoreProgram,
	fn: CoreFunctionStore,
	producer: CoreInstructionId,
	slots: CoreHostSlots,
	allowData = false,
): HostResultContract | undefined {
	const node = capturedValue(producer, 5);
	if (node === undefined || (!allowData && (node[2] & 2) === 0)) return undefined;
	for (const alias of node[5]) {
		const separator = alias.indexOf(":");
		if (!alias.startsWith("mal_host_install_")) continue;
		const contract = HOST_RESULT_CONTRACTS.get(alias.slice(0, separator))?.get(
			alias.slice(separator + 1),
		);
		if (contract !== undefined) return contract;
	}
	return undefined;

	function capturedValue(
		id: CoreInstructionId,
		depth: number,
	): ReturnType<typeof primordialNode> {
		if (depth === 0) return undefined;
		if (fn.instructionOpcodeName(id) === "loadGlobal") {
			const slot = fn.instructionAttributes(id).index;
			const root = typeof slot === "number" ? slots.get(slot)?.root : undefined;
			return root === undefined ? undefined : primordialNode(root);
		}
		const key = coreHostPropertyName(program, fn, id);
		if (key === undefined) return undefined;
		const receiver = definition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(id)),
		);
		const parent =
			receiver === undefined ? undefined : capturedValue(receiver, depth - 1);
		if (parent === undefined) return undefined;
		const property = resolvePrimordialProperty(parent[0], key);
		return property?.getter?.[0] === "%MAL_INTRINSIC_NODE_FS_MODULE%.promises<get>"
			? primordialNode("mal_host_install_node_fs:promises")
			: property?.value;
	}
}

export function coreHostPropertyName(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): string | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "loadPropertyStatic") {
		const index = fn.instructionAttributes(instruction).stringIndex;
		return typeof index === "number" ? program.stringConstantText(index) : undefined;
	}
	if (opcode !== "loadProperty") return undefined;
	const key = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
	);
	if (key !== undefined && fn.instructionOpcodeName(key) === "loadPrimordial") {
		const index = fn.instructionAttributes(key).nodeIndex;
		const name =
			typeof index === "number" ? getPrimordialCatalog().nodes[index]?.[0] : undefined;
		if (name?.startsWith("%Symbol.") && name.endsWith("%"))
			return `[${name.slice(1, -1)}]`;
	}
	const result = literal(program, fn, key);
	return typeof result === "string" ? result : undefined;
}

function assetMember(
	program: CoreProgram,
	fn: CoreFunctionStore,
	load: CoreInstructionId,
	slots: CoreHostSlots,
	kind: "methods" | "properties",
	budget: number,
): HostResultContract | undefined {
	if (budget === 0) return undefined;
	const key = coreHostPropertyName(program, fn, load);
	if (key === undefined) return undefined;
	const receiver = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)),
	);
	if (receiver === undefined) return undefined;
	const contract =
		hostSlotContract(fn, receiver, slots) ??
		coreHostDirectCallContract(program, fn, receiver, slots, budget - 1);
	const asset = contract?.kind === "return" ? contract.value.assetHandle : undefined;
	return asset === undefined ? undefined : EMBEDDED_ASSET_RESULTS[asset][kind].get(key);
}

export function coreHostDirectCallContract(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots: CoreHostSlots,
	budget: number,
	membersStable = false,
): HostResultContract | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode !== "call" && opcode !== "construct") return undefined;
	const callee = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
	);
	if (callee === undefined) return undefined;
	const fromSlot =
		hostSlotContract(fn, callee, slots) ??
		(membersStable ? catalogCallableContract(program, fn, callee, slots) : undefined);
	if (opcode === "construct") {
		if (fromSlot?.kind !== "return" || fromSlot.value.hostConstructor === undefined)
			return undefined;
		return {
			kind: "return",
			value: {
				mask: COMPILER_VALUE_KIND_OBJECT,
				hostObject: fromSlot.value.hostConstructor,
				brand: fromSlot.value.brand,
			},
		};
	}
	return fromSlot ?? assetMember(program, fn, callee, slots, "methods", budget);
}

export function corePlatformSourceResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	targets: CoreProgramFlowTargetIndex,
	context: CoreCompilationContext,
	budget = 8,
): HostResultContract | undefined {
	if (budget === 0) return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	if (
		opcode !== "call" &&
		opcode !== "construct" &&
		opcode !== "loadProperty" &&
		opcode !== "loadPropertyStatic"
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	if (opcode === "loadProperty" || opcode === "loadPropertyStatic")
		return member(instruction, "properties");
	const callee = fn.kernel.operandAt(start);
	let possible = targets.targets?.(fn.id, callee);
	if (possible?.opaque) {
		const load = definition(fn, callee);
		if (load !== undefined && fn.instructionOpcodeName(load) === "loadGlobal") {
			const index = fn.instructionAttributes(load).index;
			if (
				typeof index === "number" &&
				targets.sourceClosed &&
				context.data.moduleBindingSlots?.includes(index)
			) {
				// Initialization may leave a slot uncallable, but only the
				// closed module's stores can supply a successful target.
				const stored = targets.globalStoreTargets(index);
				if (stored.opaque === false) possible = { ...stored, opaque: false };
			}
		}
	}
	if (
		possible !== undefined &&
		!possible.opaque &&
		!possible.anyScript &&
		possible.functions.length === 1
	) {
		const target = program.function(possible.functions[0]!);
		const platform = target.metadata.canonicalPlatformSource;
		if (platform !== undefined) {
			const name = program.stringConstantText(target.metadata.nameStringIndex);
			const contracts = PLATFORM_SOURCE_EXPORTS.get(platform);
			if (opcode === "call" || name === "FileSystemError") return contracts?.get(name);
			if (platform !== "maligator:fs") return undefined;
			const platformObject =
				name === "DiskFileHandle"
					? "file"
					: name === "DiskDirectoryHandle"
						? "directory"
						: undefined;
			if (platformObject !== undefined)
				return {
					kind: "return",
					value: { mask: COMPILER_VALUE_KIND_OBJECT, platformObject },
				};
		}
	}
	if (opcode !== "call") return undefined;
	const load = definition(fn, callee);
	if (
		load === undefined ||
		coreHostPropertyName(program, fn, load) === undefined ||
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)) !==
			fn.kernel.operandAt(start + 1)
	)
		return undefined;
	return member(load, "methods");

	function member(load: CoreInstructionId, kind: "properties" | "methods") {
		const key = coreHostPropertyName(program, fn, load);
		if (key === undefined) return undefined;
		const receiver = definition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)),
		);
		if (receiver === undefined) return undefined;
		const awaited =
			fn.instructionOpcodeName(receiver) === "awaitFulfilled"
				? coreSuccessfulAwaitInput(fn, receiver)
				: undefined;
		const producer = awaited === undefined ? receiver : definition(fn, awaited);
		if (
			producer === undefined ||
			(awaited !== undefined &&
				(fn.valueUseCount(awaited) !== 1 ||
					fn.kernel.valueHandlerUseCount(awaited) !== 0))
		)
			return undefined;
		const result = corePlatformSourceResult(
			program,
			fn,
			producer,
			targets,
			context,
			budget - 1,
		);
		const expected = awaited === undefined ? "return" : "fulfill";
		const brand = result?.kind === expected ? result.value.platformObject : undefined;
		return brand === undefined
			? undefined
			: PLATFORM_OBJECT_RESULTS[brand][kind].get(key);
	}
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId | undefined,
): CoreInstructionId | undefined {
	return value !== undefined && fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function literal(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId | undefined,
): null | undefined | string | number | boolean | typeof UNKNOWN_LITERAL {
	if (instruction !== undefined) {
		const attributes = fn.instructionAttributes(instruction);
		switch (fn.instructionOpcodeName(instruction)) {
			case "createUndefined":
				return undefined;
			case "createNull":
				return null;
			case "createBoolean":
			case "createNumber":
			case "createF64":
				if (typeof attributes.value === "boolean" || typeof attributes.value === "number")
					return attributes.value;
				break;
			case "createString":
				if (typeof attributes.stringIndex === "number")
					return program.stringConstantText(attributes.stringIndex);
				break;
		}
	}
	return UNKNOWN_LITERAL;
}

const UNKNOWN_LITERAL = Symbol("unknown host argument");

function stableOptionValue(
	program: CoreProgram,
	fn: CoreFunctionStore,
	opts: CoreValueId,
	locked: boolean,
	property: string,
	acceptPrimitive: boolean,
) {
	const producer = definition(fn, opts);
	const primitive = literal(program, fn, producer);
	if (primitive !== UNKNOWN_LITERAL) return acceptPrimitive ? primitive : undefined;
	if (producer === undefined) return UNKNOWN_LITERAL;
	// Deferred native calls inspect the options later. Other uses of the object
	// can change its encoding before the task reads it.
	if (
		!locked ||
		fn.valueUseCount(opts) !== 1 ||
		fn.kernel.valueHandlerUseCount(opts) !== 0 ||
		fn.instructionOpcodeName(producer) !== "createObjectShaped"
	)
		return UNKNOWN_LITERAL;
	const keys = fn.instructionAttributes(producer).keyStringIndices;
	if (!Array.isArray(keys) || keys.length !== fn.kernel.instructionOperandCount(producer))
		return UNKNOWN_LITERAL;
	const keyIndex = keys.findIndex(
		(key) => typeof key === "number" && program.stringConstantText(key) === property,
	);
	if (keyIndex < 0) return undefined;
	return literal(
		program,
		fn,
		definition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(producer) + keyIndex),
		),
	);
}

export function coreHostResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots: CoreHostSlots,
	locked: boolean,
	membersStable = false,
): CoreHostCompletion | undefined {
	if (slots.size === 0) return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	const contract =
		opcode === "loadPropertyStatic" || opcode === "loadProperty"
			? assetMember(program, fn, instruction, slots, "properties", 4)
			: coreHostDirectCallContract(program, fn, instruction, slots, 4, membersStable);
	return coreHostCompletion(program, fn, instruction, contract, locked);
}

interface CoreHostValueFacts extends CoreNormalResultFacts {
	readonly hostObject?: HostObjectKind;
}

interface CoreHostCompletion {
	readonly immediate: CoreHostValueFacts;
	readonly fulfilled?: CoreHostValueFacts;
}

export function coreHostCompletion(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	contract: HostResultContract | undefined,
	locked: boolean,
): CoreHostCompletion | undefined {
	if (
		contract?.kind !== "return" &&
		contract?.kind !== "fulfill" &&
		contract?.kind !== "resolve"
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const result = valueFacts(contract.value);
	let immediate =
		contract.kind === "fulfill"
			? (contract.immediateMask ?? COMPILER_VALUE_KIND_OBJECT)
			: COMPILER_VALUE_KIND_OBJECT;
	if (
		contract.kind === "fulfill" &&
		contract.optionalCallback !== undefined &&
		fn.instructionAttributes(instruction).argumentMode === undefined
	) {
		const index = contract.optionalCallback + 2;
		const argument =
			index < fn.kernel.instructionOperandCount(instruction)
				? definition(fn, fn.kernel.operandAt(start + index))
				: undefined;
		const opcode =
			argument === undefined ? undefined : fn.instructionOpcodeName(argument);
		if (
			index >= fn.kernel.instructionOperandCount(instruction) ||
			opcode === "createUndefined"
		)
			immediate = COMPILER_VALUE_KIND_OBJECT;
		else if (opcode === "createFunction")
			return { immediate: { mask: COMPILER_VALUE_KIND_UNDEFINED } };
	}
	return contract.kind === "return"
		? { immediate: result }
		: {
				immediate: { mask: immediate },
				fulfilled:
					contract.kind === "fulfill" ||
					locked ||
					(result.mask & COMPILER_VALUE_KIND_OBJECT) === 0
						? result
						: undefined,
			};

	function valueFacts(value: HostValueContract): CoreHostValueFacts {
		const selector = value.selector;
		if (selector === undefined)
			return { mask: value.mask, heapBrand: value.brand, hostObject: value.hostObject };
		if (fn.instructionAttributes(instruction).argumentMode !== undefined)
			return { mask: value.mask };
		const argument = selector.argument + 2;
		const operand =
			argument < fn.kernel.instructionOperandCount(instruction)
				? fn.kernel.operandAt(start + argument)
				: undefined;
		const primitive = () =>
			operand === undefined ? undefined : literal(program, fn, definition(fn, operand));
		const option = (key: string, acceptPrimitive = false) =>
			operand === undefined
				? undefined
				: stableOptionValue(program, fn, operand, locked, key, acceptPrimitive);
		const bytes = { mask: COMPILER_VALUE_KIND_OBJECT, heapBrand: "Uint8Array" } as const;
		const buffer = { ...bytes, hostObject: "Buffer" } as const;
		const string = { mask: COMPILER_VALUE_KIND_STRING };
		switch (selector.kind) {
			case "text-flag": {
				const flag = primitive();
				if (flag !== UNKNOWN_LITERAL) return flag ? string : bytes;
				break;
			}
			case "encoding":
			case "buffer-encoding":
			case "output-encoding": {
				const encoding =
					selector.kind === "output-encoding" ? primitive() : option("encoding", true);
				if (typeof encoding === "string")
					return selector.kind !== "encoding" && encoding.toLowerCase() === "buffer"
						? buffer
						: string;
				if (encoding === null || encoding === undefined)
					return selector.kind === "encoding" ? buffer : string;
				break;
			}
			case "stat-options": {
				const flag = option("throwIfNoEntry");
				if (flag !== UNKNOWN_LITERAL && flag !== false)
					return { mask: COMPILER_VALUE_KIND_OBJECT, hostObject: value.hostObject };
				break;
			}
			case "digest-encoding": {
				const encoding = primitive();
				if (encoding !== UNKNOWN_LITERAL)
					return typeof encoding === "string" &&
						BUFFER_STRING_ENCODINGS.has(encoding.toLowerCase())
						? string
						: buffer;
				break;
			}
			case "signature-argument": {
				const specified = primitive();
				if (specified !== UNKNOWN_LITERAL)
					return {
						mask:
							operand !== undefined && specified === undefined
								? COMPILER_VALUE_KIND_OBJECT
								: COMPILER_VALUE_KIND_BOOLEAN,
					};
				const source = definition(fn, operand);
				if (
					source !== undefined &&
					(fn.instructionOpcodeName(source) === "construct" ||
						(fn.instructionOpcodeName(source) === "callKnown" &&
							fn.instructionAttributes(source).construct === true))
				)
					return { mask: COMPILER_VALUE_KIND_BOOLEAN };
				break;
			}
			case "read-size": {
				if (primitive() === 0) return { mask: COMPILER_VALUE_KIND_NULL };
				break;
			}
			case "callback-chunk": {
				if (primitive() !== UNKNOWN_LITERAL) return buffer;
				const source = definition(fn, operand);
				if (source !== undefined && fn.instructionOpcodeName(source) === "createFunction")
					return { mask: COMPILER_VALUE_KIND_UNDEFINED };
				break;
			}
			case "mkdir-options": {
				const flag = option("recursive");
				if (flag === false || flag === undefined)
					return { mask: COMPILER_VALUE_KIND_UNDEFINED };
				break;
			}
			case "compression-info": {
				const flag = option("info");
				if (flag !== UNKNOWN_LITERAL)
					return flag
						? { mask: COMPILER_VALUE_KIND_OBJECT, hostObject: "CompressionInfo" }
						: buffer;
				break;
			}
			case "resolve-value": {
				const resolved = primitive();
				if (resolved === null) return { mask: COMPILER_VALUE_KIND_NULL };
				switch (typeof resolved) {
					case "undefined":
						return { mask: COMPILER_VALUE_KIND_UNDEFINED };
					case "string":
						return string;
					case "number":
						return { mask: COMPILER_VALUE_KIND_NUMBER };
					case "boolean":
						return { mask: COMPILER_VALUE_KIND_BOOLEAN };
				}
				break;
			}
		}
		return { mask: value.mask, hostObject: value.hostObject };
	}
}

/** Installer-backed named slots establish exact callees before any script runs. */
export function specializeCoreHostResults(compilation: ConstructedCoreCompilation): void {
	const { program, context } = compilation;
	const slots = coreHostResultSlots(context);
	if (slots.size === 0) return;
	const locked = context.facts.world.primordialPolicy === "locked";
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		let editor: CoreEditor | undefined;
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const facts = coreHostResult(program, fn, instruction, slots, locked)?.immediate;
			if (facts === undefined) continue;
			(editor ??= CoreEditor.open(program, functionId)).setNormalResultFacts(
				instruction,
				facts,
			);
		}
		editor?.commit();
	}
}
