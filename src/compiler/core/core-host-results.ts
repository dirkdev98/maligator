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
	builtinInputContract,
	CAPTURED_HOST_RESULTS,
	PLATFORM_SOURCE_EXPORTS,
	PLATFORM_SOURCE_STATICS,
	PLATFORM_OBJECT_RESULTS,
	EMBEDDED_ASSET_RESULTS,
	GLOBAL_HOST_FUNCTION_RESULTS,
	GLOBAL_HOST_NAMESPACE_RESULTS,
	HOST_OBJECT_RESULTS,
	HOST_RESULT_CONTRACTS,
	hostHasInputContractMember,
	NODE_TEST_EXPORT_TARGETS,
} from "../shared/host-result-contracts.ts";
import type {
	HostObjectKind,
	HostResultContract,
	HostValueContract,
} from "../shared/host-result-contracts.ts";
import {
	compilerIntegerRange,
	compilerIntegerRangeIsValid,
} from "../shared/integer-range.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import {
	primordialNode,
	resolvePrimordialProperty,
} from "../shared/primordial-catalog.ts";
import { instantiateCoreCallInputFacts } from "./core-call-input-facts.ts";
import { coreDeferredHostSlots } from "./core-compilation.ts";
import type {
	ConstructedCoreCompilation,
	CoreCompilationContext,
} from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreNormalResultFacts } from "./core-editor.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
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
const nodeTestSlots = new WeakMap<
	CoreCompilationContext["data"],
	ReadonlyMap<number, string>
>();
const PROMISIFY_CUSTOM =
	'%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:child_process"].exec.[[SymbolKey:nodejs.util.promisify.custom]]';

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
	const node = coreHostCapturedValue(program, fn, producer, slots, 5);
	if (node === undefined || (!allowData && (node[2] & 2) === 0)) return undefined;
	const result = CAPTURED_HOST_RESULTS.get(node[0]);
	if (result !== undefined) return result;
	for (const alias of node[5]) {
		const separator = alias.indexOf(":");
		if (!alias.startsWith("mal_host_install_")) continue;
		const contract = HOST_RESULT_CONTRACTS.get(alias.slice(0, separator))?.get(
			alias.slice(separator + 1),
		);
		if (contract !== undefined) return contract;
	}
	return undefined;
}

function coreHostCapturedValue(
	program: CoreProgram,
	fn: CoreFunctionStore,
	id: CoreInstructionId,
	slots: CoreHostSlots,
	depth: number,
): ReturnType<typeof primordialNode> {
	if (depth === 0) return undefined;
	if (fn.instructionOpcodeName(id) === "loadGlobal") {
		const slot = fn.instructionAttributes(id).index;
		const root = typeof slot === "number" ? slots.get(slot)?.root : undefined;
		return root === undefined ? undefined : primordialNode(root);
	}
	const global = coreHostGlobalName(
		program,
		fn,
		fn.kernel.resultAt(fn.kernel.instructionResultStart(id)),
	);
	if (global === "process") return primordialNode("globalThis.process");
	const custom = coreHostCapturedPromisifiedValue(program, fn, id, slots, depth);
	if (custom !== undefined) return custom;
	const property = coreHostCapturedProperty(program, fn, id, slots, depth);
	return property?.getter?.[0] === "%MAL_INTRINSIC_NODE_FS_MODULE%.promises<get>"
		? primordialNode("mal_host_install_node_fs:promises")
		: property?.value;
}

export function coreHostCapturedPromisifiedValue(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots: CoreHostSlots,
	depth = 5,
) {
	if (
		depth < 2 ||
		fn.instructionOpcodeName(instruction) !== "call" ||
		fn.kernel.instructionOperandCount(instruction) !== 3 ||
		fn.instructionAttributes(instruction).argumentMode !== undefined
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const callee = definition(fn, fn.kernel.operandAt(start));
	if (
		callee === undefined ||
		!coreHostCapturedValue(program, fn, callee, slots, depth - 1)?.[5].includes(
			"mal_host_install_node_util:promisify",
		)
	)
		return undefined;
	const original = definition(fn, fn.kernel.operandAt(start + 2));
	if (original === undefined) return undefined;
	const target = coreHostCapturedValue(program, fn, original, slots, depth - 1);
	if (target === undefined) return undefined;
	const custom = resolvePrimordialProperty(target[0], {
		symbol: PROMISIFY_CUSTOM,
	})?.value;
	return custom !== undefined && CAPTURED_HOST_RESULTS.has(custom[0])
		? custom
		: undefined;
}

function coreHostCapturedProperty(
	program: CoreProgram,
	fn: CoreFunctionStore,
	id: CoreInstructionId,
	slots: CoreHostSlots,
	depth: number,
) {
	const key =
		coreHostPropertyName(program, fn, id) ??
		coreHostCapturedSymbolKey(program, fn, id, slots, depth);
	if (key === undefined) return undefined;
	const receiver = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(id)),
	);
	const parent =
		receiver === undefined
			? undefined
			: coreHostCapturedValue(program, fn, receiver, slots, depth - 1);
	return parent === undefined ? undefined : resolvePrimordialProperty(parent[0], key);
}

export function coreHostCapturedSymbolKey(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots: CoreHostSlots,
	depth = 5,
) {
	if (depth < 2 || fn.instructionOpcodeName(instruction) !== "loadProperty")
		return undefined;
	const operand = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
	);
	if (operand === undefined) return undefined;
	const symbol = coreHostCapturedValue(program, fn, operand, slots, depth - 1);
	return symbol?.[0] === PROMISIFY_CUSTOM ? { symbol: PROMISIFY_CUSTOM } : undefined;
}

export function coreHostGlobalName(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
) {
	const load = definition(fn, value);
	if (load === undefined) return undefined;
	const opcode = fn.instructionOpcodeName(load);
	const attributes = fn.instructionAttributes(load);
	if (opcode === "loadGlobalProperty")
		return typeof attributes.nameStringIndex === "number"
			? program.stringConstantText(attributes.nameStringIndex)
			: undefined;
	if (opcode !== "loadPropertyStatic" || typeof attributes.stringIndex !== "number")
		return undefined;
	const parent = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)),
	);
	return parent !== undefined &&
		fn.instructionOpcodeName(parent) === "loadIntrinsic" &&
		fn.instructionAttributes(parent).intrinsic === "globalThis"
		? program.stringConstantText(attributes.stringIndex)
		: undefined;
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
			inputs: builtinInputContract(fromSlot.value.hostConstructor, true),
			value: {
				mask: COMPILER_VALUE_KIND_OBJECT,
				hostObject: fromSlot.value.hostConstructor,
				brand: fromSlot.value.brand,
			},
		};
	}
	return fromSlot ?? assetMember(program, fn, callee, slots, "methods", budget);
}

export function coreHostCallInputCandidate(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const callee = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	const producer = definition(fn, callee);
	if (producer === undefined) return false;
	const name =
		coreHostPropertyName(program, fn, producer) ??
		coreHostGlobalName(program, fn, callee);
	return (
		name !== undefined &&
		(fn.instructionOpcodeName(instruction) === "construct"
			? builtinInputContract(name, true) !== undefined
			: hostHasInputContractMember(name))
	);
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
	const owner = sourceFunction(callee);
	if (owner !== undefined) {
		const { platform, name } = owner;
		const contract = PLATFORM_SOURCE_EXPORTS.get(platform)?.get(name);
		if (contract !== undefined && (opcode === "call" || name === "FileSystemError"))
			return contract;
		if (opcode === "construct" && platform === "maligator:fs") {
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
	if (load === undefined) return undefined;
	if (fn.instructionOpcodeName(load) === "call") {
		const produced = corePlatformSourceResult(
			program,
			fn,
			load,
			targets,
			context,
			budget - 1,
		);
		if (produced?.kind === "return" && produced.value.platformCallable === "testEach")
			return { kind: "return", value: { mask: COMPILER_VALUE_KIND_UNDEFINED } };
	}
	if (
		coreHostPropertyName(program, fn, load) === undefined ||
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)) !==
			fn.kernel.operandAt(start + 1)
	)
		return undefined;
	return member(load, "methods");

	function sourceFunction(value: CoreValueId) {
		const load = definition(fn, value);
		if (load !== undefined && fn.instructionOpcodeName(load) === "loadGlobal") {
			const index = fn.instructionAttributes(load).index;
			if (typeof index === "number" && targets.sourceClosed) {
				const name = nodeTestSourceBindings(program, context).get(index);
				if (name !== undefined) return { platform: "node:test", name };
			}
		}
		let possible = targets.targets?.(fn.id, value);
		if (possible?.opaque) {
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
			possible === undefined ||
			possible.opaque ||
			possible.anyScript ||
			possible.functions.length !== 1
		)
			return undefined;
		const target = program.function(possible.functions[0]!);
		const platform = target.metadata.canonicalPlatformSource;
		return platform === undefined
			? undefined
			: {
					platform,
					name: program.stringConstantText(target.metadata.nameStringIndex),
				};
	}

	function member(load: CoreInstructionId, kind: "properties" | "methods") {
		const key = coreHostPropertyName(program, fn, load);
		if (key === undefined) return undefined;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(load));
		const receiver = definition(fn, value);
		if (receiver === undefined) return undefined;
		if (kind === "methods") {
			const owner = sourceFunction(value);
			const result =
				owner === undefined
					? undefined
					: PLATFORM_SOURCE_STATICS.get(owner.platform)?.get(owner.name)?.get(key);
			if (result !== undefined) return result;
		}
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

function nodeTestSourceBindings(program: CoreProgram, context: CoreCompilationContext) {
	const data = context.data;
	const prior = nodeTestSlots.get(data);
	if (prior !== undefined) return prior;
	const slots = new Map<number, string>();
	const provider = data.sourceBuiltinProviders?.find(({ id }) => id === "node:test");
	if (
		provider !== undefined &&
		program.hasFunction(coreFunctionId(provider.functionIndex)) &&
		program.function(coreFunctionId(provider.functionIndex)).metadata
			.canonicalPlatformSource === provider.id
	) {
		for (const { module, kind, name, slot } of provider.state) {
			if (module !== provider.id) continue;
			const exported =
				kind === "default"
					? "default"
					: kind === "binding" && name.startsWith("0:")
						? name.slice(2)
						: undefined;
			const target =
				exported === undefined ? undefined : NODE_TEST_EXPORT_TARGETS.get(exported);
			if (target !== undefined) slots.set(slot, target);
		}
	}
	nodeTestSlots.set(data, slots);
	return slots;
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

export function coreHostArrayIndex(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const key = coreHostPropertyName(program, fn, instruction);
	const value =
		key !== undefined
			? Number(key)
			: fn.instructionOpcodeName(instruction) === "loadProperty"
				? literal(
						program,
						fn,
						definition(
							fn,
							fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
						),
					)
				: undefined;
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value < 0xffff_ffff &&
		(key === undefined || String(value) === key)
	);
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
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "loadGlobal") {
		const installed = hostSlotContract(fn, instruction, slots);
		return installed?.kind === "return" && installed.value.installedObject
			? coreHostCompletion(program, fn, instruction, installed, locked)
			: undefined;
	}
	const contract =
		opcode === "loadPropertyStatic" || opcode === "loadProperty"
			? (assetMember(program, fn, instruction, slots, "properties", 4) ??
				(membersStable ? capturedGetter(program, fn, instruction, slots) : undefined))
			: coreHostDirectCallContract(program, fn, instruction, slots, 4, membersStable);
	return coreHostCompletion(program, fn, instruction, contract, locked);
}

function capturedGetter(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots: CoreHostSlots,
) {
	const key = coreHostPropertyName(program, fn, instruction);
	if (key === undefined || !CAPTURED_GETTERS.has(key)) return undefined;
	const getter = coreHostCapturedProperty(program, fn, instruction, slots, 5)?.getter;
	return getter === undefined ? undefined : CAPTURED_HOST_RESULTS.get(getter[0]);
}

const CAPTURED_GETTERS = new Set(
	[...CAPTURED_HOST_RESULTS.keys()].flatMap((path) => {
		const suffix = path.match(/\.([^.]+)<get>$/);
		return suffix?.[1] ? [suffix[1]] : [];
	}),
);

interface CoreHostValueFacts extends CoreNormalResultFacts {
	readonly hostObject?: HostObjectKind;
}

interface CoreHostCompletion {
	readonly immediate: CoreHostValueFacts;
	readonly fulfilled?: CoreHostValueFacts;
}

const numericHostMembers = new Set<string>();
for (const definitions of [
	...HOST_RESULT_CONTRACTS.values(),
	...Object.values(HOST_OBJECT_RESULTS.methods),
	...Object.values(HOST_OBJECT_RESULTS.properties),
	...Object.values(HOST_OBJECT_RESULTS.statics),
	...Object.values(HOST_OBJECT_RESULTS.staticProperties),
	...GLOBAL_HOST_NAMESPACE_RESULTS.values(),
	GLOBAL_HOST_FUNCTION_RESULTS,
	...Object.values(EMBEDDED_ASSET_RESULTS).map(({ properties }) => properties),
	...Object.values(PLATFORM_OBJECT_RESULTS).flatMap(({ properties, methods }) => [
		properties,
		methods,
	]),
]) {
	for (const [name, contract] of definitions)
		if (
			contract.kind === "return" &&
			((contract.value.mask === COMPILER_VALUE_KIND_NUMBER &&
				contract.value.integerRange !== undefined) ||
				contract.value.selector?.kind === "random-int")
		)
			numericHostMembers.add(name);
}
for (const [path, contract] of CAPTURED_HOST_RESULTS) {
	if (contract.kind !== "return" || contract.value.integerRange === undefined) continue;
	const name = path.slice(path.lastIndexOf(".") + 1).replace(/<get>$/, "");
	numericHostMembers.add(name);
}

export function coreHostImmediateRangeCandidate(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	if (fn.instructionKind(instruction) !== "operation") return false;
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "call") {
		const callee = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		const producer = definition(fn, callee);
		if (producer === undefined) return false;
		const global = coreHostGlobalName(program, fn, callee);
		const name = global ?? coreHostPropertyName(program, fn, producer);
		return name !== undefined && numericHostMembers.has(name);
	}
	if (opcode !== "loadProperty" && opcode !== "loadPropertyStatic") return false;
	const name = coreHostPropertyName(program, fn, instruction);
	return name !== undefined && numericHostMembers.has(name);
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
	const returnsImmediately = contract.kind === "return";
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
	return returnsImmediately
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
		const integerRange =
			value.mask === COMPILER_VALUE_KIND_NUMBER ? value.integerRange : undefined;
		const selector = value.selector;
		if (selector === undefined)
			return {
				mask: value.mask,
				heapBrand: value.brand,
				hostObject: value.hostObject,
				integerRange,
			};
		if (fn.instructionAttributes(instruction).argumentMode !== undefined)
			return { mask: value.mask, integerRange };
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
			case "random-int": {
				const argumentAt = (index: number) =>
					index + 2 < fn.kernel.instructionOperandCount(instruction)
						? literal(program, fn, definition(fn, fn.kernel.operandAt(start + index + 2)))
						: undefined;
				const first = primitive();
				const second = argumentAt(1);
				const third = argumentAt(2);
				if (second !== undefined && (typeof second !== "number" || third !== undefined))
					break;
				const minimum = second === undefined ? 0 : first;
				const maximum = second === undefined ? first : second;
				const range = compilerIntegerRange(
					typeof minimum === "number" && Number.isSafeInteger(minimum)
						? minimum + 0
						: Number.MIN_SAFE_INTEGER,
					typeof maximum === "number" && Number.isSafeInteger(maximum)
						? maximum - 1
						: Number.MAX_SAFE_INTEGER - 1,
				);
				return {
					mask: COMPILER_VALUE_KIND_NUMBER,
					integerRange: compilerIntegerRangeIsValid(range) ? range : undefined,
				};
			}
			case "buffer-signed-width":
			case "buffer-unsigned-width":
			case "buffer-write-width": {
				const width = primitive();
				if (
					typeof width !== "number" ||
					!Number.isInteger(width) ||
					width < 1 ||
					width > 6
				)
					break;
				if (selector.kind === "buffer-write-width")
					return {
						mask: value.mask,
						integerRange: compilerIntegerRange(width, 0xffff_ffff),
					};
				const signed = selector.kind === "buffer-signed-width";
				const limit = 2 ** (width * 8 - Number(signed));
				return {
					mask: value.mask,
					integerRange: compilerIntegerRange(signed ? -limit : 0, limit - 1),
				};
			}
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
			case "stat-options":
			case "fstat-options": {
				const flag = selector.kind === "fstat-options" ? true : option("throwIfNoEntry");
				const bigint = option("bigint");
				return {
					mask:
						flag === UNKNOWN_LITERAL || flag === false
							? value.mask
							: COMPILER_VALUE_KIND_OBJECT,
					hostObject:
						bigint === UNKNOWN_LITERAL ? "Stats" : bigint ? "BigIntStats" : "NumberStats",
				};
			}
			case "directory-entries": {
				const flag = option("withFileTypes");
				return {
					mask: COMPILER_VALUE_KIND_OBJECT,
					heapBrand: "Array",
					hostObject:
						flag === UNKNOWN_LITERAL
							? "DirectoryEntries"
							: flag
								? "DirectoryDirents"
								: "DirectoryNames",
				};
			}
			case "temporary-directory": {
				const encoding = option("encoding", true);
				const [unknownPath, textPath, bufferPath] = returnsImmediately
					? ([
							"TemporaryDirectorySync",
							"TemporaryDirectorySyncText",
							"TemporaryDirectorySyncBuffer",
						] as const)
					: ([
							"TemporaryDirectory",
							"TemporaryDirectoryText",
							"TemporaryDirectoryBuffer",
						] as const);
				return {
					mask: COMPILER_VALUE_KIND_OBJECT,
					hostObject:
						encoding === UNKNOWN_LITERAL
							? unknownPath
							: typeof encoding === "string" && encoding.toLowerCase() === "buffer"
								? bufferPath
								: textPath,
				};
			}
			case "tls-socket": {
				if (option("socket") === undefined)
					return { mask: COMPILER_VALUE_KIND_OBJECT, hostObject: "TlsSocket" };
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
			case "exec-output":
			case "exec-file-output":
			case "exec-fulfillment":
			case "exec-file-fulfillment": {
				const async = selector.kind.endsWith("-fulfillment");
				let opts = operand;
				if (selector.kind.startsWith("exec-file")) {
					const producer = definition(fn, operand);
					const supplied = primitive();
					if (
						supplied !== UNKNOWN_LITERAL ||
						(producer !== undefined &&
							fn.instructionOpcodeName(producer) === "createArray")
					) {
						opts =
							argument + 1 < fn.kernel.instructionOperandCount(instruction)
								? fn.kernel.operandAt(start + argument + 1)
								: undefined;
					} else if (
						producer === undefined ||
						fn.instructionOpcodeName(producer) !== "createObjectShaped"
					) {
						return { mask: value.mask, hostObject: async ? "ExecOutput" : undefined };
					}
				}
				const encoding =
					opts === undefined
						? undefined
						: stableOptionValue(program, fn, opts, locked, "encoding", false);
				const stdio =
					opts === undefined
						? undefined
						: stableOptionValue(program, fn, opts, locked, "stdio", false);
				const text =
					(typeof encoding === "string" &&
						BUFFER_STRING_ENCODINGS.has(encoding.toLowerCase())) ||
					(async && (encoding === undefined || encoding === null));
				if (async)
					return {
						mask: COMPILER_VALUE_KIND_OBJECT,
						hostObject:
							encoding === UNKNOWN_LITERAL
								? "ExecOutput"
								: text
									? "ExecTextOutput"
									: "ExecBufferOutput",
					};
				if (encoding === UNKNOWN_LITERAL) break;
				if (stdio === undefined) return text ? string : buffer;
				return {
					mask:
						(text ? COMPILER_VALUE_KIND_STRING : COMPILER_VALUE_KIND_OBJECT) |
						COMPILER_VALUE_KIND_NULL,
				};
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
		return { mask: value.mask, hostObject: value.hostObject, integerRange };
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
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) === "loadGlobal"
			)
				continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "call" || opcode === "construct") {
				const contract = coreHostDirectCallContract(program, fn, instruction, slots, 4);
				const inputs = instantiateCoreCallInputFacts(
					fn,
					instruction,
					contract?.inputs,
					locked && !context.facts.world.realms && contract?.kind === "fulfill",
				);
				if (inputs !== undefined)
					(editor ??= CoreEditor.open(program, functionId)).setCallInputFacts(
						instruction,
						inputs,
					);
				const result = coreHostCompletion(
					program,
					fn,
					instruction,
					contract,
					locked,
				)?.immediate;
				if (result !== undefined)
					(editor ??= CoreEditor.open(program, functionId)).setNormalResultFacts(
						instruction,
						result,
					);
				continue;
			}
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
