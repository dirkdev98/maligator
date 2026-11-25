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
	DISK_HANDLE_EXPORTS,
	DISK_HANDLE_RESULTS,
	EMBEDDED_ASSET_RESULTS,
	HOST_RESULT_CONTRACTS,
	NODE_FILE_HANDLE_RESULTS,
} from "../shared/host-result-contracts.ts";
import type {
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

export function coreHostSlotValue(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	slots: CoreHostSlots,
): HostValueContract | undefined {
	const producer = definition(fn, value);
	const contract =
		producer === undefined
			? undefined
			: (hostSlotContract(fn, producer, slots) ??
				catalogCallableContract(program, fn, producer, slots));
	return contract?.kind === "return" ? contract.value : undefined;
}

function catalogCallableContract(
	program: CoreProgram,
	fn: CoreFunctionStore,
	producer: CoreInstructionId,
	slots: CoreHostSlots,
): HostResultContract | undefined {
	const node = capturedValue(producer, 5);
	if (node === undefined || (node[2] & 2) === 0) return undefined;
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
		const key = propertyString(program, fn, id);
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

function propertyString(
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
	const key = propertyString(program, fn, load);
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
	return opcode === "construct" &&
		(fromSlot?.kind !== "return" || fromSlot.value.hostConstructor === undefined)
		? undefined
		: (fromSlot ?? assetMember(program, fn, callee, slots, "methods", budget));
}

function nodeFileHandleMember(
	program: CoreProgram,
	fn: CoreFunctionStore,
	load: CoreInstructionId,
	slots: CoreHostSlots,
	kind: "methods" | "properties",
) {
	if (fn.instructionOpcodeName(load) !== "loadPropertyStatic") return undefined;
	const index = fn.instructionAttributes(load).stringIndex;
	const receiver = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)),
	);
	if (
		receiver === undefined ||
		fn.instructionOpcodeName(receiver) !== "awaitFulfilled" ||
		typeof index !== "number"
	)
		return undefined;
	const awaited = coreSuccessfulAwaitInput(fn, receiver);
	if (
		awaited === undefined ||
		fn.valueUseCount(awaited) !== 1 ||
		fn.kernel.valueHandlerUseCount(awaited) !== 0
	)
		return undefined;
	const call = definition(fn, awaited);
	const producer =
		call === undefined
			? undefined
			: coreHostDirectCallContract(program, fn, call, slots, 0);
	return producer?.kind === "fulfill" && producer.value.nodeFileHandle === true
		? NODE_FILE_HANDLE_RESULTS[kind].get(program.stringConstantText(index))
		: undefined;
}

export function coreDiskHandleResult(
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
		if (target.metadata.canonicalPlatformSource === "maligator:fs") {
			const name = program.stringConstantText(target.metadata.nameStringIndex);
			if (opcode === "call") return DISK_HANDLE_EXPORTS.get(name);
			if (name === "FileSystemError") return DISK_HANDLE_EXPORTS.get(name);
			const diskHandle =
				name === "DiskFileHandle"
					? "file"
					: name === "DiskDirectoryHandle"
						? "directory"
						: undefined;
			if (diskHandle !== undefined)
				return {
					kind: "return",
					value: { mask: COMPILER_VALUE_KIND_OBJECT, diskHandle },
				};
		}
	}
	if (opcode !== "call") return undefined;
	const load = definition(fn, callee);
	if (
		load === undefined ||
		propertyString(program, fn, load) === undefined ||
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)) !==
			fn.kernel.operandAt(start + 1)
	)
		return undefined;
	return member(load, "methods");

	function member(load: CoreInstructionId, kind: "properties" | "methods") {
		const key = propertyString(program, fn, load);
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
		const result = coreDiskHandleResult(
			program,
			fn,
			producer,
			targets,
			context,
			budget - 1,
		);
		const expected = awaited === undefined ? "return" : "fulfill";
		const brand = result?.kind === expected ? result.value.diskHandle : undefined;
		return brand === undefined ? undefined : DISK_HANDLE_RESULTS[brand][kind].get(key);
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
):
	| {
			readonly immediate: CoreNormalResultFacts;
			readonly fulfilled?: CoreNormalResultFacts;
	  }
	| undefined {
	if (slots.size === 0) return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const opcode = fn.instructionOpcodeName(instruction);
	const contract =
		(opcode === "loadPropertyStatic" || opcode === "loadProperty"
			? assetMember(program, fn, instruction, slots, "properties", 4)
			: coreHostDirectCallContract(program, fn, instruction, slots, 4, membersStable)) ??
		(membersStable ? nodeFileHandleContract() : undefined);
	if (
		contract?.kind !== "return" &&
		contract?.kind !== "fulfill" &&
		contract?.kind !== "resolve"
	)
		return undefined;
	const result = valueFacts(contract.value);
	return contract.kind === "return"
		? { immediate: result }
		: {
				immediate: {
					mask:
						contract.kind === "fulfill"
							? (contract.immediateMask ?? COMPILER_VALUE_KIND_OBJECT)
							: COMPILER_VALUE_KIND_OBJECT,
				},
				fulfilled:
					contract.kind === "fulfill" ||
					locked ||
					(result.mask & COMPILER_VALUE_KIND_OBJECT) === 0
						? result
						: undefined,
			};

	function nodeFileHandleContract() {
		if (opcode === "loadPropertyStatic")
			return nodeFileHandleMember(program, fn, instruction, slots, "properties");
		if (opcode !== "call") return undefined;
		const load = definition(fn, fn.kernel.operandAt(start));
		return load === undefined
			? undefined
			: nodeFileHandleMember(program, fn, load, slots, "methods");
	}

	function valueFacts(value: HostValueContract): CoreNormalResultFacts {
		const selector = value.selector;
		if (selector === undefined) return { mask: value.mask, heapBrand: value.brand };
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
		const buffer = { mask: COMPILER_VALUE_KIND_OBJECT, heapBrand: "Uint8Array" } as const;
		const string = { mask: COMPILER_VALUE_KIND_STRING };
		switch (selector.kind) {
			case "text-flag": {
				const flag = primitive();
				if (flag !== UNKNOWN_LITERAL) return flag ? string : buffer;
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
					return { mask: COMPILER_VALUE_KIND_OBJECT };
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
				if (flag !== UNKNOWN_LITERAL && !flag) return buffer;
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
		return { mask: value.mask };
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
