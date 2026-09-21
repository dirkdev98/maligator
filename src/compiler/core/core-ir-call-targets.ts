import type { CoreCallGraph } from "./core-call-graph.ts";
import { coreClosedCapturedValueSlots } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
	coreValueControlFlowUseMask,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreLocalCallSite } from "./core-ir-interprocedural-flow.ts";
import { analyzeCoreInterproceduralValueFlow } from "./core-ir-interprocedural-flow.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CoreProgramFlowEngine } from "./core-program-flow.ts";
import type {
	CoreProgramFlowCallTargetSemantics,
	CoreProgramFlowCallTargetState,
	CoreProgramFlowCallTargetStatistics,
	CoreProgramFlowLocalTransfers,
} from "./core-program-flow.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_CALLEE_TARGET_CAP = 4;

type CoreCellId = number;
type CoreFunctionPropertyId = number;

class CoreGraphIdentityTable {
	readonly #ids: Map<number, Map<number, Map<number, number>>>;
	#next: number;

	constructor(previous?: CoreGraphIdentityTable) {
		const previousIds = previous === undefined ? [] : [...previous.#ids];
		this.#ids = new Map(
			previousIds.map(
				([kind, byLeft]) =>
					[
						kind,
						new Map(
							[...byLeft].map(([left, byRight]) => [left, new Map(byRight)] as const),
						),
					] as const,
			),
		);
		this.#next = previous === undefined ? 0 : previous.#next;
	}

	intern(kind: number, left: number, right: number): number {
		const byLeft = this.#ids.get(kind) ?? new Map<number, Map<number, number>>();
		const byRight = byLeft.get(left) ?? new Map<number, number>();
		const existing = byRight.get(right);
		if (existing !== undefined) return existing;
		const id = this.#next++;
		byRight.set(right, id);
		byLeft.set(left, byRight);
		this.#ids.set(kind, byLeft);
		return id;
	}
}

export interface CoreCalleeTargets {
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
	readonly nonCallable: boolean;
}

export const CORE_CALLEE_TARGETS_BOTTOM: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: false,
	nonCallable: false,
});

const CORE_CALLEE_TARGETS_NON_CALLABLE: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: false,
	nonCallable: true,
});

export const CORE_CALLEE_TARGETS_ANY_SCRIPT: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: true,
	opaque: false,
	nonCallable: false,
});

export const CORE_CALLEE_TARGETS_OPAQUE: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: true,
	nonCallable: true,
});

const CORE_CALLEE_TARGETS_OPEN: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: true,
	opaque: true,
	nonCallable: true,
});

export function coreCalleeTargetsFunction(functionId: number): CoreCalleeTargets {
	return Object.freeze({
		functions: Object.freeze([functionId as CoreFunctionId]),
		anyScript: false,
		opaque: false,
		nonCallable: false,
	});
}

export function coreCalleeTargetsIsBottom(targets: CoreCalleeTargets): boolean {
	return (
		targets.functions.length === 0 &&
		!targets.anyScript &&
		!targets.opaque &&
		!targets.nonCallable
	);
}

export function coreCalleeTargetsAreOpen(targets: CoreCalleeTargets): boolean {
	return targets.anyScript || targets.opaque || targets.nonCallable;
}

export function coreCalleeTargetsSingleFunction(
	targets: CoreCalleeTargets,
): CoreFunctionId | undefined {
	return targets.functions.length === 1 && !coreCalleeTargetsAreOpen(targets)
		? targets.functions[0]
		: undefined;
}

export const coreCalleeTargetsClosedFunction = coreCalleeTargetsSingleFunction;

export function coreCalleeTargetsEqual(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): boolean {
	return (
		left.anyScript === right.anyScript &&
		left.opaque === right.opaque &&
		left.nonCallable === right.nonCallable &&
		left.functions.length === right.functions.length &&
		left.functions.every((target, index) => target === right.functions[index])
	);
}

export function joinCoreCalleeTargets(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): CoreCalleeTargets {
	if (left === right || coreCalleeTargetsEqual(left, right)) return left;
	if (coreCalleeTargetsIsBottom(left)) return right;
	if (coreCalleeTargetsIsBottom(right)) return left;
	const functions = [...new Set([...left.functions, ...right.functions])].sort(
		(first, second) => first - second,
	);
	const anyScript =
		left.anyScript || right.anyScript || functions.length > CORE_CALLEE_TARGET_CAP;
	return Object.freeze({
		functions: Object.freeze(anyScript ? [] : functions),
		anyScript,
		opaque: left.opaque || right.opaque,
		nonCallable: left.nonCallable || right.nonCallable,
	});
}

export interface CoreIndexedCallSite extends CoreLocalCallSite {
	readonly targets: CoreCalleeTargets;
	readonly open: boolean;
}

interface CoreLocalCallTargets {
	readonly function: CoreFunctionId;
	readonly bodyVersion: number;
	readonly cfgVersion: number;
	readonly exceptionFlowVersion: number;
	readonly memoryEffectsVersion: number;
	readonly callsVersion: number;
	readonly values: ReadonlyArray<CoreCalleeTargets>;
	readonly returnTargets: CoreCalleeTargets;
	readonly sites: ReadonlyArray<CoreIndexedCallSite>;
	readonly publishedFunctions: ReadonlyArray<CoreFunctionId>;
	readonly cellInputs: ReadonlyMap<CoreCellId, CoreCalleeTargets>;
	readonly cellWrites: ReadonlyMap<CoreCellId, CoreCalleeTargets>;
	readonly propertyInputs: ReadonlyMap<CoreFunctionPropertyId, CoreCalleeTargets>;
	readonly globalWrites: ReadonlyMap<number, CoreCalleeTargets>;
	readonly returnTargetDependencies: ReadonlyMap<
		CoreFunctionId,
		readonly [body: number, cfg: number]
	>;
}

export type CoreCallGraphStatistics = CoreProgramFlowCallTargetStatistics;

export interface CoreCallGraphIndex {
	readonly sourceClosed: boolean;
	readonly statistics: CoreCallGraphStatistics;
	readonly changedCallSites: ReadonlyArray<CoreIndexedCallSite>;
	readonly changedCallers: ReadonlySet<CoreFunctionId>;
	readonly changedEdgeCallers: ReadonlySet<CoreFunctionId>;
	readonly graph: CoreCallGraph;
	targets(functionId: CoreFunctionId, value: CoreValueId): CoreCalleeTargets;
	returnTargets(functionId: CoreFunctionId): CoreCalleeTargets;
	publishedFunctions(functionId: CoreFunctionId): ReadonlyArray<CoreFunctionId>;
	globalStoreTargets(slot: number): CoreCalleeTargets;
	site(
		functionId: CoreFunctionId,
		instruction: CoreInstructionId,
	): CoreIndexedCallSite | undefined;
	outgoing(functionId: CoreFunctionId): ReadonlyArray<CoreIndexedCallSite>;
}

function localTargetsAreCurrent(
	local: CoreLocalCallTargets | undefined,
	fn: CoreFunctionStore,
	program: CoreProgram,
): boolean {
	return (
		local !== undefined &&
		local.bodyVersion === fn.version("body") &&
		local.cfgVersion === fn.version("cfg") &&
		local.exceptionFlowVersion === fn.version("exceptionFlow") &&
		(fn.handlerBlockCount === 0 ||
			local.memoryEffectsVersion === fn.version("memoryEffects")) &&
		local.callsVersion === fn.version("calls") &&
		[...local.returnTargetDependencies].every(([functionId, [body, cfg]]) => {
			const target = program.function(functionId);
			return target.version("body") === body && target.version("cfg") === cfg;
		})
	);
}

const DEFINITELY_NON_CALLABLE_RESULTS = new Set([
	"createArgumentsObject",
	"createArray",
	"createBigint",
	"createBoolean",
	"createF64",
	"createModuleNamespace",
	"createNull",
	"createNumber",
	"createObject",
	"createObjectShaped",
	"createPrivateName",
	"createPrivateNames",
	"createRestArguments",
	"createString",
	"createTemplateObject",
	"createUndefined",
]);

function globalCellId(identities: CoreGraphIdentityTable, index: number): CoreCellId {
	return identities.intern(0, 0, index);
}

function capturedCellId(
	identities: CoreGraphIdentityTable,
	owner: number,
	index: number,
): CoreCellId {
	return identities.intern(1, owner, index);
}

function globalPropertyCellId(
	identities: CoreGraphIdentityTable,
	stringIndex: number,
): CoreCellId {
	return identities.intern(3, 0, stringIndex);
}

function functionPropertyId(
	identities: CoreGraphIdentityTable,
	functionId: CoreFunctionId,
	stringIndex: number,
): CoreFunctionPropertyId {
	return identities.intern(2, functionId, stringIndex);
}

function instructionOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): CoreValueId | undefined {
	return operand < fn.kernel.instructionOperandCount(instruction)
		? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + operand)
		: undefined;
}

export function coreValueIsLoadedGlobalProperty(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): boolean {
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return false;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition);
	if (opcode === "loadGlobalProperty") return true;
	if (opcode !== "move") return false;
	const input = instructionOperand(fn, definition, 0);
	return input !== undefined && coreValueIsLoadedGlobalProperty(fn, input, seen);
}

export function coreDirectCreatedFunction(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): CoreFunctionId | undefined {
	if (seen.has(value)) return undefined;
	seen.add(value);
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition);
	if (opcode === "move") {
		const input = instructionOperand(fn, definition, 0);
		return input === undefined ? undefined : coreDirectCreatedFunction(fn, input, seen);
	}
	if (opcode !== "createFunction") return undefined;
	const target = fn.instructionAttributes(definition).functionIndex;
	return typeof target === "number" && Number.isSafeInteger(target) && target >= 0
		? (target as CoreFunctionId)
		: undefined;
}

const DIRECT_CALLBACK_BUILTINS: ReadonlySet<string> = new Set([
	"Array.prototype.forEach",
	"Array.prototype.some",
	"Array.prototype.every",
	"Array.prototype.find",
	"Array.prototype.findIndex",
	"Array.prototype.map",
	"Array.prototype.filter",
	"Array.prototype.reduce",
	"Array.prototype.reduceRight",
	"Array.prototype.findLast",
	"Array.prototype.findLastIndex",
	"Array.prototype.flatMap",
]);

export function coreDirectBuiltinCallbackTarget(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreFunctionId | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	const attributes = fn.instructionAttributes(instruction);
	const known = attributes.knownBuiltinCall as
		| { readonly operation?: unknown }
		| undefined;
	const operation =
		opcode === "callKnown"
			? attributes.operation
			: opcode === "call" && known !== undefined
				? known.operation
				: undefined;
	if (typeof operation !== "string" || !DIRECT_CALLBACK_BUILTINS.has(operation)) {
		return undefined;
	}
	const callback = instructionOperand(fn, instruction, opcode === "callKnown" ? 1 : 2);
	return callback === undefined ? undefined : coreDirectCreatedFunction(fn, callback);
}

function directReturnedFunctionTargets(
	program: CoreProgram,
	functionId: CoreFunctionId,
): CoreCalleeTargets | undefined {
	const fn = program.function(functionId);
	let targets = CORE_CALLEE_TARGETS_BOTTOM;
	let returns = 0;
	for (const block of fn.blockIds()) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		returns++;
		const returned = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
		const target = coreDirectCreatedFunction(fn, returned);
		if (target === undefined || target >= program.functionCapacity) return undefined;
		targets = joinCoreCalleeTargets(targets, coreCalleeTargetsFunction(target));
	}
	return returns === 0 || coreCalleeTargetsIsBottom(targets) ? undefined : targets;
}

function directStringIndex(
	fn: CoreFunctionStore,
	value: CoreValueId,
): number | undefined {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (fn.instructionOpcodeName(definition) !== "createString") return undefined;
	const index = fn.instructionAttributes(definition).stringIndex;
	return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
		? index
		: undefined;
}

function directNumberIndex(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): number | undefined {
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition);
	if (opcode === "move") {
		const input = instructionOperand(fn, definition, 0);
		return input === undefined ? undefined : directNumberIndex(fn, input, seen);
	}
	if (opcode !== "createNumber" && opcode !== "createF64") return undefined;
	const constant = fn.instructionAttributes(definition).value;
	return typeof constant === "number" && Number.isSafeInteger(constant)
		? constant
		: undefined;
}

function privateArrayIndexIsInBounds(
	fn: CoreFunctionStore,
	value: CoreValueId,
	length: number,
): boolean {
	const constant = directNumberIndex(fn, value);
	if (constant !== undefined) return constant >= 0 && constant < length;
	if ((length & (length - 1)) !== 0 || fn.kernel.valueDefinitionKind(value) !== 1)
		return false;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (
		fn.instructionOpcodeName(definition) !== "binary" ||
		fn.instructionAttributes(definition).operator !== "&"
	)
		return false;
	const left = instructionOperand(fn, definition, 0);
	const right = instructionOperand(fn, definition, 1);
	if (left === undefined || right === undefined) return false;
	const masked =
		directNumberIndex(fn, left) === length - 1
			? right
			: directNumberIndex(fn, right) === length - 1
				? left
				: undefined;
	return (
		masked !== undefined &&
		(fn.valueRepresentation(masked) === "f64" || fn.valueRepresentation(masked) === "i32")
	);
}

function instructionDominatesInstruction(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	dominator: CoreInstructionId,
	instruction: CoreInstructionId,
): boolean {
	const dominatorBlock = fn.instructionBlock(dominator);
	const instructionBlock = fn.instructionBlock(instruction);
	if (dominatorBlock !== instructionBlock) {
		return cfg.dominates(dominatorBlock, instructionBlock);
	}
	for (
		let cursor = fn.kernel.blockFirstInstruction(dominatorBlock);
		cursor >= 0;
		cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
	) {
		if (cursor === dominator) return true;
		if (cursor === instruction) return false;
	}
	return false;
}

function privateFunctionArrayLoadTargets(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	localTransfers: CoreProgramFlowLocalTransfers,
): ReadonlyMap<CoreInstructionId, CoreCalleeTargets> {
	const roots = coreCanonicalValueRoots(fn, cfg);
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	interface Candidate {
		readonly length: number;
		readonly definitions: Map<number, CoreInstructionId>;
		readonly targets: Map<number, CoreFunctionId>;
		readonly loads: Array<CoreInstructionId>;
		readonly receiverCalls: Array<CoreInstructionId>;
		invalid: boolean;
	}
	const candidates = new Map<CoreValueId, Candidate>();
	for (let index = 0; index < localTransfers.operationCount; index++) {
		const instruction = localTransfers.operationAt(index);
		if (
			fn.instructionOpcodeName(instruction) !== "createArray" ||
			fn.kernel.instructionResultCount(instruction) !== 1
		)
			continue;
		const length = fn.instructionAttributes(instruction).length;
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 2 ||
			length > CORE_CALLEE_TARGET_CAP
		)
			continue;
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		candidates.set(root(value), {
			length,
			definitions: new Map(),
			targets: new Map(),
			loads: [],
			receiverCalls: [],
			invalid: false,
		});
	}
	if (candidates.size === 0) return new Map();
	const edgeUses = coreValueControlFlowUseMask(fn);
	for (let valueIndex = 0; valueIndex < fn.valueCapacity; valueIndex++) {
		const value = valueIndex as CoreValueId;
		if (!fn.isValueLive(value) || edgeUses[value] === 0) continue;
		const candidate = candidates.get(root(value));
		if (candidate !== undefined) candidate.invalid = true;
	}

	for (let index = 0; index < localTransfers.operationCount; index++) {
		const instruction = localTransfers.operationAt(index);
		const opcode = fn.instructionOpcodeName(instruction);
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		for (let position = 0; position < operandCount; position++) {
			const candidate = candidates.get(
				root(fn.kernel.operandAt(operandStart + position)),
			);
			if (candidate === undefined || candidate.invalid) continue;
			if (
				position === 0 &&
				(opcode === "move" || opcode === "rootUse" || opcode === "throwIfTdz")
			)
				continue;
			if (position === 0 && opcode === "defineProperty" && operandCount === 3) {
				const key = directNumberIndex(fn, fn.kernel.operandAt(operandStart + 1));
				const target = coreDirectCreatedFunction(
					fn,
					fn.kernel.operandAt(operandStart + 2),
				);
				if (
					key === undefined ||
					key < 0 ||
					key >= candidate.length ||
					target === undefined ||
					target >= program.functionCapacity ||
					!program.function(target).metadata.lexicalThis ||
					candidate.targets.has(key)
				) {
					candidate.invalid = true;
					continue;
				}
				candidate.definitions.set(key, instruction);
				candidate.targets.set(key, target);
				continue;
			}
			if (position === 0 && opcode === "loadProperty" && operandCount === 2) {
				if (
					!privateArrayIndexIsInBounds(
						fn,
						fn.kernel.operandAt(operandStart + 1),
						candidate.length,
					)
				) {
					candidate.invalid = true;
					continue;
				}
				candidate.loads.push(instruction);
				continue;
			}
			if (position === 1 && opcode === "call") {
				candidate.receiverCalls.push(instruction);
				continue;
			}
			candidate.invalid = true;
		}
	}

	const result = new Map<CoreInstructionId, CoreCalleeTargets>();
	for (const candidate of candidates.values()) {
		if (
			candidate.invalid ||
			candidate.targets.size !== candidate.length ||
			candidate.loads.length === 0
		)
			continue;
		if (
			candidate.loads.some((load) =>
				[...candidate.definitions.values()].some(
					(definition) => !instructionDominatesInstruction(fn, cfg, definition, load),
				),
			)
		)
			continue;
		const loadResults = new Set(
			candidate.loads.map((load) =>
				root(fn.kernel.resultAt(fn.kernel.instructionResultStart(load))),
			),
		);
		if (
			candidate.receiverCalls.some((call) => {
				const callee = instructionOperand(fn, call, 0);
				return callee === undefined || !loadResults.has(root(callee));
			})
		)
			continue;
		const targets = [...new Set(candidate.targets.values())].sort(
			(left, right) => left - right,
		);
		if (targets.length < 2 || targets.length > CORE_CALLEE_TARGET_CAP) continue;
		const closed = Object.freeze({
			functions: Object.freeze(targets),
			anyScript: false,
			opaque: false,
			nonCallable: false,
		});
		for (const load of candidate.loads) result.set(load, closed);
	}
	return result;
}

function collectKnownFunctionProperties(
	fn: CoreFunctionStore,
	functionCapacity: number,
	localTransfers: CoreProgramFlowLocalTransfers,
	identities: CoreGraphIdentityTable,
): ReadonlyMap<CoreFunctionPropertyId, CoreCalleeTargets> {
	const globalSlots = new Map<number, CoreCalleeTargets>();
	const globalProperties = new Map<number, CoreCalleeTargets>();
	for (let index = 0; index < localTransfers.operationCount; index++) {
		const instruction = localTransfers.operationAt(index);
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "storeGlobal" && opcode !== "storeGlobalProperty") continue;
		const value = instructionOperand(fn, instruction, 0);
		if (value === undefined) continue;
		const target = coreDirectCreatedFunction(fn, value);
		if (target === undefined || target >= functionCapacity) continue;
		const attributes = fn.instructionAttributes(instruction);
		const key = opcode === "storeGlobal" ? attributes.index : attributes.nameStringIndex;
		if (typeof key !== "number") continue;
		const destinations = opcode === "storeGlobal" ? globalSlots : globalProperties;
		destinations.set(
			key,
			joinCoreCalleeTargets(
				destinations.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM,
				coreCalleeTargetsFunction(target),
			),
		);
	}
	const localTargets = (
		value: CoreValueId,
		seen = new Set<CoreValueId>(),
	): CoreCalleeTargets => {
		if (seen.has(value)) return CORE_CALLEE_TARGETS_BOTTOM;
		seen.add(value);
		const direct = coreDirectCreatedFunction(fn, value);
		if (direct !== undefined && direct < functionCapacity) {
			return coreCalleeTargetsFunction(direct);
		}
		if (fn.kernel.valueDefinitionKind(value) !== 1) return CORE_CALLEE_TARGETS_BOTTOM;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(definition);
		if (opcode === "move") {
			const input = instructionOperand(fn, definition, 0);
			return input === undefined ? CORE_CALLEE_TARGETS_BOTTOM : localTargets(input, seen);
		}
		const attributes = fn.instructionAttributes(definition);
		if (opcode === "loadGlobal" && typeof attributes.index === "number") {
			return globalSlots.get(attributes.index) ?? CORE_CALLEE_TARGETS_BOTTOM;
		}
		if (
			opcode === "loadGlobalProperty" &&
			typeof attributes.nameStringIndex === "number"
		) {
			return (
				globalProperties.get(attributes.nameStringIndex) ?? CORE_CALLEE_TARGETS_BOTTOM
			);
		}
		return CORE_CALLEE_TARGETS_BOTTOM;
	};
	const properties = new Map<CoreFunctionPropertyId, CoreCalleeTargets>();
	for (let index = 0; index < localTransfers.propertyDefinitionCount; index++) {
		const instruction = localTransfers.propertyDefinitionAt(index);
		const opcode = fn.instructionOpcodeName(instruction);
		const receiver = instructionOperand(fn, instruction, 0);
		const key =
			opcode === "defineProperty" ? instructionOperand(fn, instruction, 1) : undefined;
		const value = instructionOperand(
			fn,
			instruction,
			opcode === "defineProperty" ? 2 : 1,
		);
		const stringIndex =
			opcode === "defineProperty"
				? key === undefined
					? undefined
					: directStringIndex(fn, key)
				: fn.instructionAttributes(instruction).stringIndex;
		if (
			receiver === undefined ||
			value === undefined ||
			typeof stringIndex !== "number"
		) {
			continue;
		}
		const receiverTargets = localTargets(receiver);
		const valueTargets = localTargets(value);
		if (coreCalleeTargetsIsBottom(valueTargets)) continue;
		for (const receiverFunction of receiverTargets.functions) {
			const property = functionPropertyId(identities, receiverFunction, stringIndex);
			properties.set(
				property,
				joinCoreCalleeTargets(
					properties.get(property) ?? CORE_CALLEE_TARGETS_BOTTOM,
					valueTargets,
				),
			);
		}
	}
	return properties;
}

function rawInstructionCellId(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	identities: CoreGraphIdentityTable,
): CoreCellId | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const attributes = fn.instructionAttributes(instruction);
	let id: CoreCellId | undefined;
	if (opcode === "loadGlobal" || opcode === "storeGlobal") {
		const index = attributes.index;
		if (typeof index === "number") id = globalCellId(identities, index);
	} else if (opcode === "loadGlobalProperty" || opcode === "storeGlobalProperty") {
		const stringIndex = attributes.nameStringIndex;
		if (typeof stringIndex === "number") {
			id = globalPropertyCellId(identities, stringIndex);
		}
	} else if (opcode === "loadCaptured" || opcode === "storeCaptured") {
		const owner = attributes.functionIndex;
		const index = attributes.index;
		if (typeof owner === "number" && typeof index === "number") {
			id = capturedCellId(identities, owner, index);
		}
	}
	return id;
}

interface CoreFunctionCellAccesses {
	readonly reads: ReadonlySet<CoreCellId>;
	readonly writes: ReadonlySet<CoreCellId>;
}

function collectFunctionCellAccesses(
	fn: CoreFunctionStore,
	localTransfers: CoreProgramFlowLocalTransfers,
	identities: CoreGraphIdentityTable,
): CoreFunctionCellAccesses {
	const reads = new Set<CoreCellId>();
	const writes = new Set<CoreCellId>();
	for (let index = 0; index < localTransfers.cellAccessCount; index++) {
		const instruction = localTransfers.cellAccessAt(index);
		const id = rawInstructionCellId(fn, instruction, identities);
		if (id === undefined) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			opcode === "loadGlobal" ||
			opcode === "loadGlobalProperty" ||
			opcode === "loadCaptured"
		) {
			reads.add(id);
		} else {
			writes.add(id);
			// Publication depends on whether all writers still fit the tracked identity set.
			if (opcode === "storeGlobal" || opcode === "storeCaptured") reads.add(id);
		}
	}
	return Object.freeze({ reads, writes });
}

function instructionCellId(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	trackedCells: ReadonlySet<CoreCellId>,
	identities: CoreGraphIdentityTable,
): CoreCellId | undefined {
	const id = rawInstructionCellId(fn, instruction, identities);
	return id !== undefined && trackedCells.has(id) ? id : undefined;
}

function analyzeFunctionTargets(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	cells: ReadonlyMap<CoreCellId, CoreCalleeTargets>,
	trackedCells: ReadonlySet<CoreCellId>,
	knownFunctionProperties: ReadonlyMap<CoreFunctionPropertyId, CoreCalleeTargets>,
	localTransfers: CoreProgramFlowLocalTransfers,
	identities: CoreGraphIdentityTable,
): CoreLocalCallTargets {
	const values = Array<CoreCalleeTargets>(fn.valueCapacity).fill(
		CORE_CALLEE_TARGETS_BOTTOM,
	);
	const privateArrayLoads = privateFunctionArrayLoadTargets(
		program,
		fn,
		cfg,
		localTransfers,
	);
	const queue: Array<CoreBlockId> = [];
	const queued = new Uint8Array(fn.blockCapacity);
	const returnTargetDependencies = new Map<
		CoreFunctionId,
		readonly [body: number, cfg: number]
	>();
	const enqueue = (block: CoreBlockId): void => {
		if (queued[block] !== 0) return;
		queued[block] = 1;
		queue.push(block);
	};
	const raise = (value: CoreValueId, incoming: CoreCalleeTargets): boolean => {
		const current = values[value] ?? CORE_CALLEE_TARGETS_BOTTOM;
		const joined = joinCoreCalleeTargets(current, incoming);
		if (coreCalleeTargetsEqual(current, joined)) return false;
		values[value] = joined;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			const instruction = fn.kernel.useInstruction(use);
			const block = fn.instructionBlock(instruction);
			if (fn.instructionKind(instruction) === "operation") {
				enqueue(block);
				continue;
			}
			for (const edge of cfg.successors[block] ?? []) enqueue(edge.to);
		}
		for (
			let use = fn.kernel.valueFirstHandlerUse(value);
			use >= 0;
			use = fn.kernel.handlerArgumentNextUse(use)
		) {
			const handler = fn.kernel.blockHandlerBlock(fn.kernel.handlerArgumentBlock(use));
			if (handler !== undefined && cfg.reachable.has(handler)) enqueue(handler);
		}
		return true;
	};
	for (let index = 0; index < fn.parameterCount; index++) {
		raise(fn.kernel.functionParameter(index), CORE_CALLEE_TARGETS_OPAQUE);
	}
	for (const block of cfg.reversePostorder) enqueue(block);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const block = queue[cursor]!;
		queued[block] = 0;
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const row = parameterStart + index;
			if (fn.kernel.blockParameterRole(row) === 1)
				raise(fn.kernel.blockParameterValue(row), CORE_CALLEE_TARGETS_OPEN);
		}
		for (const edge of cfg.predecessors[block] ?? []) {
			for (let index = 0; index < parameterCount; index++) {
				const argument = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (argument !== undefined) {
					raise(fn.kernel.blockParameterValue(parameterStart + index), values[argument]!);
				}
			}
		}
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			const resultStart = fn.kernel.instructionResultStart(instruction);
			const resultCount = fn.kernel.instructionResultCount(instruction);
			if (resultCount === 0) continue;
			let resultTargets = CORE_CALLEE_TARGETS_OPEN;
			if (
				opcode === "createFunction" ||
				opcode === "guardFunctionIndex" ||
				opcode === "guardBaseConstructorLayout"
			) {
				const target = fn.instructionAttributes(instruction).functionIndex;
				resultTargets =
					typeof target === "number" &&
					Number.isSafeInteger(target) &&
					target >= 0 &&
					target < program.functionCapacity
						? coreCalleeTargetsFunction(target)
						: CORE_CALLEE_TARGETS_OPEN;
			} else if (opcode === "loadCallee") {
				resultTargets = coreCalleeTargetsFunction(fn.id);
			} else if (opcode === "move") {
				const operand = instructionOperand(fn, instruction, 0);
				resultTargets =
					operand === undefined ? CORE_CALLEE_TARGETS_OPEN : values[operand]!;
			} else if (
				opcode === "loadGlobal" ||
				opcode === "loadGlobalProperty" ||
				opcode === "loadCaptured"
			) {
				const key = instructionCellId(fn, instruction, trackedCells, identities);
				resultTargets =
					key === undefined
						? CORE_CALLEE_TARGETS_OPEN
						: (cells.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM);
			} else if (opcode === "loadProperty" && privateArrayLoads.has(instruction)) {
				resultTargets = privateArrayLoads.get(instruction)!;
			} else if (opcode === "loadPropertyStatic") {
				const receiver = instructionOperand(fn, instruction, 0);
				const stringIndex = fn.instructionAttributes(instruction).stringIndex;
				let knownTargets = CORE_CALLEE_TARGETS_BOTTOM;
				resultTargets = CORE_CALLEE_TARGETS_OPEN;
				if (receiver !== undefined && typeof stringIndex === "number") {
					const receiverTargets = values[receiver] ?? CORE_CALLEE_TARGETS_OPEN;
					for (const receiverFunction of receiverTargets.functions) {
						knownTargets = joinCoreCalleeTargets(
							knownTargets,
							knownFunctionProperties.get(
								functionPropertyId(identities, receiverFunction, stringIndex),
							) ?? CORE_CALLEE_TARGETS_BOTTOM,
						);
					}
					if (!coreCalleeTargetsIsBottom(knownTargets)) {
						resultTargets = joinCoreCalleeTargets(
							knownTargets,
							CORE_CALLEE_TARGETS_OPAQUE,
						);
						if (receiverTargets.anyScript)
							resultTargets = joinCoreCalleeTargets(
								resultTargets,
								CORE_CALLEE_TARGETS_ANY_SCRIPT,
							);
					}
				}
			} else if (opcode === "call") {
				const callee = instructionOperand(fn, instruction, 0);
				const callees = callee === undefined ? CORE_CALLEE_TARGETS_OPEN : values[callee]!;
				if (callees.functions.length > 0) {
					let returned = CORE_CALLEE_TARGETS_BOTTOM;
					let hasUnknownReturn = coreCalleeTargetsAreOpen(callees);
					const dependencies: Array<
						readonly [CoreFunctionId, readonly [body: number, cfg: number]]
					> = [];
					for (const target of callees.functions) {
						const targetFunction = program.function(target);
						dependencies.push(
							Object.freeze([
								target,
								Object.freeze([
									targetFunction.version("body"),
									targetFunction.version("cfg"),
								] as const),
							] as const),
						);
						const targetReturns = directReturnedFunctionTargets(program, target);
						if (targetReturns === undefined) {
							hasUnknownReturn = true;
							continue;
						}
						returned = joinCoreCalleeTargets(returned, targetReturns);
					}
					if (!coreCalleeTargetsIsBottom(returned)) {
						for (const [target, versions] of dependencies) {
							returnTargetDependencies.set(target, versions);
						}
						resultTargets = hasUnknownReturn
							? Object.freeze({
									functions: returned.functions,
									anyScript: true,
									opaque: true,
									nonCallable: true,
								})
							: returned;
					}
				}
			} else if (opcode === "createEmpty") {
				// TDZ sentinels are rejected by throwIfTdz before an observable use.
				resultTargets = CORE_CALLEE_TARGETS_BOTTOM;
			} else if (DEFINITELY_NON_CALLABLE_RESULTS.has(opcode)) {
				resultTargets = CORE_CALLEE_TARGETS_NON_CALLABLE;
			}
			for (let offset = 0; offset < resultCount; offset++) {
				raise(fn.kernel.resultAt(resultStart + offset), resultTargets);
			}
		}
	}

	let returnTargets = CORE_CALLEE_TARGETS_BOTTOM;
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) === "return") {
			returnTargets = joinCoreCalleeTargets(
				returnTargets,
				values[fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator))]!,
			);
		}
	}
	const flow = analyzeCoreInterproceduralValueFlow(fn, localTransfers);
	const sites = flow.calls.map((call) => {
		const targets = coreCalleeTargetsIsBottom(values[call.callee]!)
			? CORE_CALLEE_TARGETS_OPEN
			: values[call.callee]!;
		return Object.freeze({
			...call,
			targets,
			open: coreCalleeTargetsAreOpen(targets),
		});
	});
	const cellInputs = new Map<CoreCellId, CoreCalleeTargets>();
	const cellWrites = new Map<CoreCellId, CoreCalleeTargets>();
	const propertyInputs = new Map<CoreFunctionPropertyId, CoreCalleeTargets>();
	const globalWrites = new Map<number, CoreCalleeTargets>();
	const publishedFunctions = new Set<CoreFunctionId>();
	const publishedValues = new Uint8Array(fn.valueCapacity);
	const pendingPublications: Array<CoreValueId> = [];
	const publish = (value: CoreValueId): void => {
		if (publishedValues[value] !== 0) return;
		publishedValues[value] = 1;
		const targets = values[value];
		for (const target of targets?.functions ?? []) publishedFunctions.add(target);
		if (targets?.anyScript === true) pendingPublications.push(value);
	};
	for (let index = 0; index < localTransfers.operationCount; index++) {
		const instruction = localTransfers.operationAt(index);
		if (!cfg.reachable.has(fn.instructionBlock(instruction))) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
		const operator = fn.instructionAttributes(instruction).operator;
		const observesIdentity =
			descriptor.observesOperands ||
			opcode === "guardFunctionIndex" ||
			opcode === "guardBaseConstructorLayout" ||
			(opcode === "unary" && (operator === "typeof" || operator === "!")) ||
			(opcode === "binary" && (operator === "===" || operator === "!=="));
		const key = instructionCellId(fn, instruction, trackedCells, identities);
		const privateStore =
			(opcode === "storeGlobal" || opcode === "storeCaptured") &&
			key !== undefined &&
			cells.get(key)?.anyScript === false;
		if (!observesIdentity && !privateStore) {
			const start = fn.kernel.instructionOperandStart(instruction);
			for (
				let operand = 0;
				operand < fn.kernel.instructionOperandCount(instruction);
				operand++
			) {
				if (descriptor.callTransfer?.calleeOperand === operand) continue;
				publish(fn.kernel.operandAt(start + operand));
			}
		}
		if (opcode === "loadPropertyStatic") {
			const receiver = instructionOperand(fn, instruction, 0);
			const stringIndex = fn.instructionAttributes(instruction).stringIndex;
			if (receiver !== undefined && typeof stringIndex === "number") {
				for (const receiverFunction of values[receiver]?.functions ?? []) {
					const property = functionPropertyId(identities, receiverFunction, stringIndex);
					propertyInputs.set(
						property,
						knownFunctionProperties.get(property) ?? CORE_CALLEE_TARGETS_BOTTOM,
					);
				}
			}
		}
		if (key === undefined) continue;
		if (
			opcode === "loadGlobal" ||
			opcode === "loadGlobalProperty" ||
			opcode === "loadCaptured"
		) {
			cellInputs.set(key, cells.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM);
			continue;
		}
		const value = instructionOperand(fn, instruction, 0);
		if (value === undefined) continue;
		const written = values[value] ?? CORE_CALLEE_TARGETS_OPEN;
		cellWrites.set(
			key,
			joinCoreCalleeTargets(cellWrites.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM, written),
		);
		if (opcode === "storeGlobal") {
			const slot = fn.instructionAttributes(instruction).index;
			if (typeof slot === "number") {
				globalWrites.set(
					slot,
					joinCoreCalleeTargets(
						globalWrites.get(slot) ?? CORE_CALLEE_TARGETS_BOTTOM,
						written,
					),
				);
			}
		}
	}
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind === "return" || kind === "throw") {
			publish(fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)));
		}
	}
	// Recover identities discarded by the finite-target cap only at an escaping use.
	for (let cursor = 0; cursor < pendingPublications.length; cursor++) {
		const value = pendingPublications[cursor]!;
		const kind = fn.kernel.valueDefinitionKind(value);
		const owner = fn.kernel.valueDefinitionOwner(value);
		if (kind === 0) {
			const index = fn.kernel.valueDefinitionIndex(value);
			for (const edge of cfg.predecessors[owner] ?? []) {
				const argument = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (argument !== undefined) publish(argument);
			}
		} else if (kind === 1) {
			const definition = coreInstructionId(owner);
			if (fn.instructionOpcodeName(definition) === "move") {
				const input = instructionOperand(fn, definition, 0);
				if (input !== undefined) publish(input);
			}
		}
	}
	return Object.freeze({
		function: fn.id,
		bodyVersion: fn.version("body"),
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: fn.version("exceptionFlow"),
		memoryEffectsVersion: fn.version("memoryEffects"),
		callsVersion: fn.version("calls"),
		values: Object.freeze(values),
		returnTargets,
		sites: Object.freeze(sites),
		publishedFunctions: Object.freeze([...publishedFunctions]),
		cellInputs,
		cellWrites,
		propertyInputs,
		globalWrites,
		returnTargetDependencies,
	});
}

export type CoreCallGraphIndexState = CoreProgramFlowCallTargetState<
	CoreLocalCallTargets,
	CoreCalleeTargets,
	CoreIndexedCallSite,
	CoreGraphIdentityTable
>;

function callSiteEqual(left: CoreIndexedCallSite, right: CoreIndexedCallSite): boolean {
	return (
		left.callee === right.callee &&
		left.receiver === right.receiver &&
		left.aggregateArguments === right.aggregateArguments &&
		left.transfer === right.transfer &&
		(left.arguments?.length ?? 0) === (right.arguments?.length ?? 0) &&
		(left.arguments ?? []).every(
			(argument, index) => argument === right.arguments?.[index],
		) &&
		coreCalleeTargetsEqual(left.targets, right.targets)
	);
}

export const CORE_PROGRAM_FLOW_CALL_TARGET_SEMANTICS: CoreProgramFlowCallTargetSemantics<
	CoreLocalCallTargets,
	CoreCalleeTargets,
	CoreIndexedCallSite,
	CoreGraphIdentityTable
> = Object.freeze({
	createIdentities(previous?: CoreGraphIdentityTable) {
		return new CoreGraphIdentityTable(previous);
	},
	localIsCurrent: localTargetsAreCurrent,
	collectCellAccesses: collectFunctionCellAccesses,
	collectPropertyWrites: collectKnownFunctionProperties,
	closedCells(
		program: CoreProgram,
		context: CoreCompilationContext | undefined,
		identities: CoreGraphIdentityTable,
	) {
		const cells = new Set<CoreCellId>();
		for (const index of context?.data.singleAssignmentGlobalSlots ?? []) {
			cells.add(globalCellId(identities, index));
		}
		for (const { owner, index } of coreClosedCapturedValueSlots(program, context)) {
			cells.add(capturedCellId(identities, owner, index));
		}
		return cells;
	},
	analyzeLocal: analyzeFunctionTargets,
	callSiteEqual,
	join: joinCoreCalleeTargets,
	equal: coreCalleeTargetsEqual,
	isBottom: coreCalleeTargetsIsBottom,
	bottom: CORE_CALLEE_TARGETS_BOTTOM,
	opaque: CORE_CALLEE_TARGETS_OPAQUE,
	open: CORE_CALLEE_TARGETS_OPEN,
});

export function analyzeCoreCallGraph(
	program: CoreProgram,
	sourceClosed: boolean,
	previous?: CoreCallGraphIndexState,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow = (functionId) =>
		buildCoreControlFlow(program, functionId),
	context?: CoreCompilationContext,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
): CoreCallGraphIndexState {
	return new CoreProgramFlowEngine(program).solveCallTargets(
		sourceClosed,
		controlFlow,
		CORE_PROGRAM_FLOW_CALL_TARGET_SEMANTICS,
		previous,
		context,
		dirtyFunctions,
	);
}

export function analyzeCoreCalleeTargets(program: CoreProgram): CoreCallGraphIndex {
	return analyzeCoreCallGraph(program, false);
}

export type CoreCalleeTargetAnalysis = CoreCallGraphIndex;
