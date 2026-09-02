import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { updateCoreCallGraph } from "./core-call-graph.ts";
import type { CoreCallGraph } from "./core-call-graph.ts";
import { coreCapturedSlotKey, coreClosedCapturedValueSlots } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
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
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";
import {
	CORE_PROGRAM_FLOW_TARGET_CONSUMER,
	CORE_PROGRAM_FLOW_TARGETS,
	extractCoreProgramFlowLocalTransfers,
} from "./core-program-flow.ts";
import type { CoreProgramFlowLocalTransfers } from "./core-program-flow.ts";

export const CORE_CALLEE_TARGET_CAP = 4;

export interface CoreCalleeTargets {
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
}

export const CORE_CALLEE_TARGETS_BOTTOM: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: false,
});

export const CORE_CALLEE_TARGETS_ANY_SCRIPT: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: true,
	opaque: false,
});

export const CORE_CALLEE_TARGETS_OPAQUE: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: false,
	opaque: true,
});

const CORE_CALLEE_TARGETS_OPEN: CoreCalleeTargets = Object.freeze({
	functions: Object.freeze([]),
	anyScript: true,
	opaque: true,
});

export function coreCalleeTargetsFunction(functionId: number): CoreCalleeTargets {
	return Object.freeze({
		functions: Object.freeze([functionId as CoreFunctionId]),
		anyScript: false,
		opaque: false,
	});
}

export function coreCalleeTargetsIsBottom(targets: CoreCalleeTargets): boolean {
	return targets.functions.length === 0 && !targets.anyScript && !targets.opaque;
}

export function coreCalleeTargetsAreOpen(targets: CoreCalleeTargets): boolean {
	return targets.anyScript || targets.opaque;
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
	});
}

export type CoreCallSiteId = string;

export function coreCallSiteId(
	caller: CoreFunctionId,
	instruction: CoreInstructionId,
): CoreCallSiteId {
	return `${caller}:${instruction}`;
}

export interface CoreIndexedCallSite extends CoreLocalCallSite {
	readonly id: CoreCallSiteId;
	readonly targets: CoreCalleeTargets;
	readonly open: boolean;
}

interface CoreLocalCallTargets {
	readonly function: CoreFunctionId;
	readonly bodyVersion: number;
	readonly cfgVersion: number;
	readonly callsVersion: number;
	readonly values: ReadonlyArray<CoreCalleeTargets>;
	readonly returnTargets: CoreCalleeTargets;
	readonly sites: ReadonlyArray<CoreIndexedCallSite>;
	readonly cellInputs: ReadonlyMap<string, CoreCalleeTargets>;
	readonly cellWrites: ReadonlyMap<string, CoreCalleeTargets>;
	readonly propertyInputs: ReadonlyMap<string, CoreCalleeTargets>;
	readonly globalWrites: ReadonlyMap<number, CoreCalleeTargets>;
}

export interface CoreCallGraphStatistics {
	readonly functions: number;
	readonly functionsAnalyzed: number;
	readonly functionsReused: number;
	readonly callSites: number;
	readonly exactCallEdges: number;
	readonly wildcardCallSites: number;
	readonly wildcardCallers: number;
	readonly opaqueCallSites: number;
	readonly aggregateDependencies: number;
	readonly storedGraphRows: number;
	readonly storedGraphEntries: number;
	readonly updatedCallSites: number;
	readonly accessFunctionsScanned: number;
	readonly propertyAggregateUpdates: number;
	readonly cellAggregateUpdates: number;
	readonly globalStoreAggregateUpdates: number;
	readonly callSiteIndexUpdates: number;
}

export interface CoreCallGraphIndex {
	readonly sourceClosed: boolean;
	readonly statistics: CoreCallGraphStatistics;
	readonly changedCallSites: ReadonlySet<CoreCallSiteId>;
	readonly changedCallers: ReadonlySet<CoreFunctionId>;
	readonly changedEdgeCallers: ReadonlySet<CoreFunctionId>;
	readonly graph: CoreCallGraph;
	targets(functionId: CoreFunctionId, value: CoreValueId): CoreCalleeTargets;
	returnTargets(functionId: CoreFunctionId): CoreCalleeTargets;
	globalStoreTargets(slot: number): CoreCalleeTargets;
	site(id: CoreCallSiteId): CoreIndexedCallSite | undefined;
	outgoing(functionId: CoreFunctionId): ReadonlyArray<CoreIndexedCallSite>;
}

function localTargetsAreCurrent(
	local: CoreLocalCallTargets | undefined,
	fn: CoreFunctionStore,
): boolean {
	return (
		local !== undefined &&
		local.bodyVersion === fn.version("body") &&
		local.cfgVersion === fn.version("cfg") &&
		local.callsVersion === fn.version("calls")
	);
}

const DEFINITELY_NON_CALLABLE_RESULTS = new Set([
	"createArgumentsObject",
	"createArray",
	"createBigint",
	"createBoolean",
	"createEmpty",
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

function globalCellKey(index: number): string {
	return `global:${index}`;
}

function capturedCellKey(owner: number, index: number): string {
	return `captured:${coreCapturedSlotKey(owner, index)}`;
}

function functionPropertyKey(functionId: CoreFunctionId, stringIndex: number): string {
	return `function-property:${functionId}:${stringIndex}`;
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

function directCreatedFunction(
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
		return input === undefined ? undefined : directCreatedFunction(fn, input, seen);
	}
	if (opcode !== "createFunction") return undefined;
	const target = fn.instructionAttributes(definition).functionIndex;
	return typeof target === "number" && Number.isSafeInteger(target) && target >= 0
		? (target as CoreFunctionId)
		: undefined;
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

function collectKnownFunctionProperties(
	fn: CoreFunctionStore,
	functionCapacity: number,
	localTransfers: CoreProgramFlowLocalTransfers,
): ReadonlyMap<string, CoreCalleeTargets> {
	const properties = new Map<string, CoreCalleeTargets>();
	for (let index = 0; index < localTransfers.propertyDefinitionCount; index++) {
		const instruction = localTransfers.propertyDefinitionAt(index);
		const receiver = instructionOperand(fn, instruction, 0);
		const key = instructionOperand(fn, instruction, 1);
		const value = instructionOperand(fn, instruction, 2);
		if (receiver === undefined || key === undefined || value === undefined) continue;
		const receiverFunction = directCreatedFunction(fn, receiver);
		const stringIndex = directStringIndex(fn, key);
		const valueFunction = directCreatedFunction(fn, value);
		if (
			receiverFunction === undefined ||
			stringIndex === undefined ||
			valueFunction === undefined ||
			receiverFunction >= functionCapacity ||
			valueFunction >= functionCapacity
		)
			continue;
		const property = functionPropertyKey(receiverFunction, stringIndex);
		properties.set(
			property,
			joinCoreCalleeTargets(
				properties.get(property) ?? CORE_CALLEE_TARGETS_BOTTOM,
				coreCalleeTargetsFunction(valueFunction),
			),
		);
	}
	return properties;
}

function rawInstructionCellKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): string | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const attributes = fn.instructionAttributes(instruction);
	let key: string | undefined;
	if (opcode === "loadGlobal" || opcode === "storeGlobal") {
		const index = attributes.index;
		if (typeof index === "number") key = globalCellKey(index);
	} else if (opcode === "loadCaptured" || opcode === "storeCaptured") {
		const owner = attributes.functionIndex;
		const index = attributes.index;
		if (typeof owner === "number" && typeof index === "number") {
			key = capturedCellKey(owner, index);
		}
	}
	return key;
}

interface CoreFunctionCellAccesses {
	readonly reads: ReadonlySet<string>;
	readonly writes: ReadonlySet<string>;
}

function collectFunctionCellAccesses(
	fn: CoreFunctionStore,
	localTransfers: CoreProgramFlowLocalTransfers,
): CoreFunctionCellAccesses {
	const reads = new Set<string>();
	const writes = new Set<string>();
	for (let index = 0; index < localTransfers.cellAccessCount; index++) {
		const instruction = localTransfers.cellAccessAt(index);
		const key = rawInstructionCellKey(fn, instruction);
		if (key === undefined) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "loadGlobal" || opcode === "loadCaptured") reads.add(key);
		else writes.add(key);
	}
	return Object.freeze({ reads, writes });
}

function instructionCellKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	trackedCells: ReadonlySet<string>,
): string | undefined {
	const key = rawInstructionCellKey(fn, instruction);
	return key !== undefined && trackedCells.has(key) ? key : undefined;
}

function analyzeFunctionTargets(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	cells: ReadonlyMap<string, CoreCalleeTargets>,
	trackedCells: ReadonlySet<string>,
	knownFunctionProperties: ReadonlyMap<string, CoreCalleeTargets>,
	localTransfers: CoreProgramFlowLocalTransfers,
): CoreLocalCallTargets {
	const values = Array<CoreCalleeTargets>(fn.valueCapacity).fill(
		CORE_CALLEE_TARGETS_BOTTOM,
	);
	const queue: Array<CoreBlockId> = [];
	const queued = new Uint8Array(fn.blockCapacity);
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
		for (const edge of cfg.predecessors[block] ?? []) {
			if (edge.kind !== "ordinary") continue;
			for (let index = 0; index < parameterCount; index++) {
				const argument = edge.arguments[index];
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
			if (opcode === "createFunction" || opcode === "guardFunctionIndex") {
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
			} else if (opcode === "loadGlobal" || opcode === "loadCaptured") {
				const key = instructionCellKey(fn, instruction, trackedCells);
				resultTargets =
					key === undefined
						? CORE_CALLEE_TARGETS_OPEN
						: (cells.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM);
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
								functionPropertyKey(receiverFunction, stringIndex),
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
			} else if (DEFINITELY_NON_CALLABLE_RESULTS.has(opcode)) {
				resultTargets = CORE_CALLEE_TARGETS_BOTTOM;
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
			id: coreCallSiteId(call.caller, call.instruction),
			targets,
			open: coreCalleeTargetsAreOpen(targets),
		});
	});
	const cellInputs = new Map<string, CoreCalleeTargets>();
	const cellWrites = new Map<string, CoreCalleeTargets>();
	const propertyInputs = new Map<string, CoreCalleeTargets>();
	const globalWrites = new Map<number, CoreCalleeTargets>();
	for (let index = 0; index < localTransfers.operationCount; index++) {
		const instruction = localTransfers.operationAt(index);
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "loadPropertyStatic") {
			const receiver = instructionOperand(fn, instruction, 0);
			const stringIndex = fn.instructionAttributes(instruction).stringIndex;
			if (receiver !== undefined && typeof stringIndex === "number") {
				for (const receiverFunction of values[receiver]?.functions ?? []) {
					const property = functionPropertyKey(receiverFunction, stringIndex);
					propertyInputs.set(
						property,
						knownFunctionProperties.get(property) ?? CORE_CALLEE_TARGETS_BOTTOM,
					);
				}
			}
		}
		const key = instructionCellKey(fn, instruction, trackedCells);
		if (key === undefined) continue;
		if (opcode === "loadGlobal" || opcode === "loadCaptured") {
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
	return Object.freeze({
		function: fn.id,
		bodyVersion: fn.version("body"),
		cfgVersion: fn.version("cfg"),
		callsVersion: fn.version("calls"),
		values: Object.freeze(values),
		returnTargets,
		sites: Object.freeze(sites),
		cellInputs,
		cellWrites,
		propertyInputs,
		globalWrites,
	});
}

interface CoreCallGraphIndexState extends CoreCallGraphIndex {
	readonly local: ReadonlyMap<CoreFunctionId, CoreLocalCallTargets>;
	readonly cells: ReadonlyMap<string, CoreCalleeTargets>;
	readonly cellAccesses: ReadonlyMap<CoreFunctionId, CoreFunctionCellAccesses>;
	readonly propertyWrites: ReadonlyMap<
		CoreFunctionId,
		ReadonlyMap<string, CoreCalleeTargets>
	>;
	readonly propertyWriters: ReadonlyMap<
		string,
		ReadonlyMap<CoreFunctionId, CoreCalleeTargets>
	>;
	readonly properties: ReadonlyMap<string, CoreCalleeTargets>;
	readonly propertyReaders: ReadonlyMap<string, ReadonlySet<CoreFunctionId>>;
	readonly cellReaders: ReadonlyMap<string, ReadonlySet<CoreFunctionId>>;
	readonly cellWriters: ReadonlyMap<
		string,
		ReadonlyMap<CoreFunctionId, CoreCalleeTargets>
	>;
	readonly globalStoreWriters: ReadonlyMap<
		number,
		ReadonlyMap<CoreFunctionId, CoreCalleeTargets>
	>;
	readonly globalStores: ReadonlyMap<number, CoreCalleeTargets>;
	readonly sites: ReadonlyMap<CoreCallSiteId, CoreIndexedCallSite>;
	readonly outgoingIndex: ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreIndexedCallSite>>;
}

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

function joinContributions<Key>(
	contributions: ReadonlyMap<Key, CoreCalleeTargets> | undefined,
): CoreCalleeTargets {
	let result = CORE_CALLEE_TARGETS_BOTTOM;
	for (const targets of contributions?.values() ?? []) {
		result = joinCoreCalleeTargets(result, targets);
	}
	return result;
}

export function analyzeCoreCallGraph(
	program: CoreProgram,
	sourceClosed: boolean,
	previous?: CoreCallGraphIndexState,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow = (functionId) =>
		buildCoreControlFlow(program, functionId),
	context?: CoreCompilationContext,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
	localTransfers: (functionId: CoreFunctionId) => CoreProgramFlowLocalTransfers =
		(functionId) =>
			extractCoreProgramFlowLocalTransfers(program, program.function(functionId)),
): CoreCallGraphIndexState {
	const functionIds = [...program.functionIds()];
	const functionSet = new Set(functionIds);
	const cellAccesses = new Map(previous?.cellAccesses ?? []);
	const propertyWrites = new Map(previous?.propertyWrites ?? []);
	const propertyWriters = new Map(previous?.propertyWriters ?? []);
	const cellReaders = new Map(previous?.cellReaders ?? []);
	const changedFunctions = new Set<CoreFunctionId>();
	const propertyKeys = new Set<string>();
	let accessFunctionsScanned = 0;
	for (const functionId of previous === undefined ? functionIds : (dirtyFunctions ?? functionIds)) {
		if (!functionSet.has(functionId)) continue;
		const fn = program.function(functionId);
		const prior = previous?.local.get(functionId);
		if (localTargetsAreCurrent(prior, fn)) continue;
		changedFunctions.add(functionId);
		accessFunctionsScanned++;
		const oldAccess = cellAccesses.get(functionId);
		const transfers = localTransfers(functionId);
		const nextAccess = collectFunctionCellAccesses(fn, transfers);
		cellAccesses.set(functionId, nextAccess);
		for (const key of new Set([...(oldAccess?.reads ?? []), ...nextAccess.reads])) {
			const readers = new Set(cellReaders.get(key) ?? []);
			readers.delete(functionId);
			if (nextAccess.reads.has(key)) readers.add(functionId);
			if (readers.size === 0) cellReaders.delete(key);
			else cellReaders.set(key, readers);
		}

		const oldWrites =
			propertyWrites.get(functionId) ?? new Map<string, CoreCalleeTargets>();
		const nextWrites = collectKnownFunctionProperties(
			fn,
			program.functionCapacity,
			transfers,
		);
		propertyWrites.set(functionId, nextWrites);
		for (const key of new Set([...oldWrites.keys(), ...nextWrites.keys()])) {
			propertyKeys.add(key);
			const writers = new Map(propertyWriters.get(key) ?? []);
			writers.delete(functionId);
			const next = nextWrites.get(key);
			if (next !== undefined) writers.set(functionId, next);
			if (writers.size === 0) propertyWriters.delete(key);
			else propertyWriters.set(key, writers);
		}
	}
	for (const functionId of previous?.local.keys() ?? []) {
		if (functionSet.has(functionId)) continue;
		const access = cellAccesses.get(functionId);
		for (const key of access?.reads ?? []) {
			const readers = new Set(cellReaders.get(key) ?? []);
			readers.delete(functionId);
			if (readers.size === 0) cellReaders.delete(key);
			else cellReaders.set(key, readers);
		}
		for (const key of propertyWrites.get(functionId)?.keys() ?? []) {
			propertyKeys.add(key);
			const writers = new Map(propertyWriters.get(key) ?? []);
			writers.delete(functionId);
			if (writers.size === 0) propertyWriters.delete(key);
			else propertyWriters.set(key, writers);
		}
		cellAccesses.delete(functionId);
		propertyWrites.delete(functionId);
	}
	const knownFunctionProperties = new Map(previous?.properties ?? []);
	let propertyAggregateUpdates = 0;
	for (const key of propertyKeys) {
		propertyAggregateUpdates++;
		const next = joinContributions(propertyWriters.get(key));
		if (coreCalleeTargetsIsBottom(next)) knownFunctionProperties.delete(key);
		else knownFunctionProperties.set(key, next);
	}

	const local = new Map<CoreFunctionId, CoreLocalCallTargets>();
	for (const functionId of functionIds) {
		const fn = program.function(functionId);
		const prior = previous?.local.get(functionId);
		if (localTargetsAreCurrent(prior, fn)) local.set(functionId, prior!);
	}
	const propertyReaders = new Map(previous?.propertyReaders ?? []);
	for (const key of propertyKeys) {
		for (const reader of propertyReaders.get(key) ?? []) changedFunctions.add(reader);
	}
	const closedCells = new Set<string>();
	for (const index of context?.data.singleAssignmentGlobalSlots ?? []) {
		closedCells.add(globalCellKey(index));
	}
	for (const key of coreClosedCapturedValueSlots(program, context)) {
		closedCells.add(`captured:${key}`);
	}
	const trackedCells = new Set(closedCells);
	for (const access of cellAccesses.values()) {
		for (const key of access.reads) trackedCells.add(key);
		for (const key of access.writes) trackedCells.add(key);
	}
	const affectedFunctions = new Set(changedFunctions);
	const dependencyQueue = [...affectedFunctions];
	for (let cursor = 0; cursor < dependencyQueue.length; cursor++) {
		const functionId = dependencyQueue[cursor]!;
		const writeKeys = new Set([
			...(previous?.local.get(functionId)?.cellWrites.keys() ?? []),
			...(cellAccesses.get(functionId)?.writes ?? []),
		]);
		for (const key of writeKeys) {
			for (const reader of cellReaders.get(key) ?? []) {
				if (affectedFunctions.has(reader)) continue;
				affectedFunctions.add(reader);
				dependencyQueue.push(reader);
			}
		}
	}

	const cellWriters = new Map(previous?.cellWriters ?? []);
	const globalStoreWriters = new Map(previous?.globalStoreWriters ?? []);
	const cells = new Map(previous?.cells ?? []);
	const globalStores = new Map(previous?.globalStores ?? []);
	const cellKeys = new Set<string>();
	const globalSlots = new Set<number>();
	const removeLocalContributions = (
		functionId: CoreFunctionId,
		entry: CoreLocalCallTargets | undefined,
	): void => {
		if (entry === undefined) return;
		for (const key of entry.cellWrites.keys()) {
			cellKeys.add(key);
			const writers = new Map(cellWriters.get(key) ?? []);
			writers.delete(functionId);
			if (writers.size === 0) cellWriters.delete(key);
			else cellWriters.set(key, writers);
		}
		for (const slot of entry.globalWrites.keys()) {
			globalSlots.add(slot);
			const writers = new Map(globalStoreWriters.get(slot) ?? []);
			writers.delete(functionId);
			if (writers.size === 0) globalStoreWriters.delete(slot);
			else globalStoreWriters.set(slot, writers);
		}
		for (const key of entry.propertyInputs.keys()) {
			const readers = new Set(propertyReaders.get(key) ?? []);
			readers.delete(functionId);
			if (readers.size === 0) propertyReaders.delete(key);
			else propertyReaders.set(key, readers);
		}
	};
	for (const functionId of affectedFunctions) {
		removeLocalContributions(
			functionId,
			local.get(functionId) ?? previous?.local.get(functionId),
		);
		local.delete(functionId);
	}
	for (const key of trackedCells) {
		if (!previous?.cells.has(key)) cellKeys.add(key);
	}
	for (const key of previous?.cells.keys() ?? []) {
		if (!trackedCells.has(key)) cellKeys.add(key);
	}
	let cellAggregateUpdates = 0;
	const recomputeCell = (key: string): boolean => {
		cellAggregateUpdates++;
		let next = closedCells.has(key)
			? CORE_CALLEE_TARGETS_BOTTOM
			: CORE_CALLEE_TARGETS_OPAQUE;
		next = joinCoreCalleeTargets(next, joinContributions(cellWriters.get(key)));
		const prior = cells.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM;
		if (!trackedCells.has(key) || coreCalleeTargetsIsBottom(next)) cells.delete(key);
		else cells.set(key, next);
		return !coreCalleeTargetsEqual(prior, next);
	};
	for (const key of cellKeys) recomputeCell(key);
	let globalStoreAggregateUpdates = 0;
	const recomputeGlobalStore = (slot: number): void => {
		globalStoreAggregateUpdates++;
		const next = joinContributions(globalStoreWriters.get(slot));
		if (coreCalleeTargetsIsBottom(next)) globalStores.delete(slot);
		else globalStores.set(slot, next);
	};
	for (const slot of globalSlots) recomputeGlobalStore(slot);

	const queue = [...affectedFunctions].sort((left, right) => left - right);
	const queued = new Set(queue);
	const analyzed = new Set<CoreFunctionId>();
	const enqueue = (functionId: CoreFunctionId): void => {
		if (queued.has(functionId)) return;
		queued.add(functionId);
		queue.push(functionId);
	};
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const functionId = queue[cursor]!;
		queued.delete(functionId);
		const previousLocal =
			local.get(functionId) ??
			(analyzed.has(functionId) ? undefined : previous?.local.get(functionId));
		removeLocalContributions(functionId, previousLocal);
		const next = analyzeFunctionTargets(
			program,
			program.function(functionId),
			controlFlow(functionId),
			cells,
			trackedCells,
			knownFunctionProperties,
			localTransfers(functionId),
		);
		for (const [key, targets] of next.cellWrites) {
			cellKeys.add(key);
			const writers = new Map(cellWriters.get(key) ?? []);
			writers.set(functionId, targets);
			cellWriters.set(key, writers);
		}
		for (const [slot, targets] of next.globalWrites) {
			globalSlots.add(slot);
			const writers = new Map(globalStoreWriters.get(slot) ?? []);
			writers.set(functionId, targets);
			globalStoreWriters.set(slot, writers);
		}
		for (const key of next.propertyInputs.keys()) {
			const readers = new Set(propertyReaders.get(key) ?? []);
			readers.add(functionId);
			propertyReaders.set(key, readers);
		}
		local.set(functionId, next);
		analyzed.add(functionId);
		const writeKeys = new Set([
			...(previousLocal?.cellWrites.keys() ?? []),
			...next.cellWrites.keys(),
		]);
		for (const key of writeKeys) {
			if (!recomputeCell(key)) continue;
			for (const reader of cellReaders.get(key) ?? []) enqueue(reader);
		}
		for (const slot of new Set([
			...(previousLocal?.globalWrites.keys() ?? []),
			...next.globalWrites.keys(),
		])) {
			recomputeGlobalStore(slot);
		}
	}
	const functionsAnalyzed = analyzed.size;
	const functionsReused = local.size - functionsAnalyzed;
	const sites = new Map(previous?.sites ?? []);
	const outgoing = new Map(previous?.outgoingIndex ?? []);
	const changedCallSites = new Set<CoreCallSiteId>();
	const changedCallers = new Set<CoreFunctionId>();
	const changedEdgeCallers = new Set<CoreFunctionId>();
	let wildcardCallSites = previous?.statistics.wildcardCallSites ?? 0;
	let opaqueCallSites = previous?.statistics.opaqueCallSites ?? 0;
	for (const functionId of analyzed) {
		const priorOutgoing = previous?.outgoingIndex.get(functionId) ?? [];
		const nextRaw = local.get(functionId)?.sites ?? [];
		const nextOutgoing = nextRaw.map((site) => {
			const prior = previous?.sites.get(site.id);
			return prior !== undefined && callSiteEqual(prior, site) ? prior : site;
		});
		const oldById = new Map(priorOutgoing.map((site) => [site.id, site]));
		const nextById = new Map(nextOutgoing.map((site) => [site.id, site]));
		for (const id of new Set([...oldById.keys(), ...nextById.keys()])) {
			const prior = oldById.get(id);
			const next = nextById.get(id);
			if (prior !== undefined && next !== undefined && callSiteEqual(prior, next))
				continue;
			changedCallSites.add(id);
			changedCallers.add(functionId);
			if (prior !== undefined) sites.delete(id);
			if (next !== undefined) sites.set(id, next);
		}
		const priorExact = [
			...new Set(priorOutgoing.flatMap((site) => site.targets.functions)),
		].sort((left, right) => left - right);
		const nextExact = [
			...new Set(nextOutgoing.flatMap((site) => site.targets.functions)),
		].sort((left, right) => left - right);
		if (
			priorExact.length !== nextExact.length ||
			priorExact.some((target, index) => target !== nextExact[index]) ||
			priorOutgoing.some((site) => site.targets.anyScript) !==
				nextOutgoing.some((site) => site.targets.anyScript)
		) {
			changedEdgeCallers.add(functionId);
		}
		wildcardCallSites +=
			nextOutgoing.filter((site) => site.targets.anyScript).length -
			priorOutgoing.filter((site) => site.targets.anyScript).length;
		opaqueCallSites +=
			nextOutgoing.filter((site) => site.targets.opaque).length -
			priorOutgoing.filter((site) => site.targets.opaque).length;
		const stableOutgoing =
			priorOutgoing.length === nextOutgoing.length &&
			priorOutgoing.every((site, index) => site === nextOutgoing[index]);
		outgoing.set(
			functionId,
			stableOutgoing ? priorOutgoing : Object.freeze(nextOutgoing),
		);
	}
	const graph = updateCoreCallGraph(
		previous?.graph,
		functionIds,
		[...outgoing].map(([caller, callSites]) => ({
			caller,
			exactTargets: callSites.flatMap((site) => site.targets.functions),
			wildcard: callSites.some((site) => site.targets.anyScript),
		})),
	);
	const updatedCallSites = changedCallSites.size;
	const statistics = Object.freeze({
		functions: local.size,
		functionsAnalyzed,
		functionsReused,
		callSites: sites.size,
		exactCallEdges: graph.statistics.exactCallEdges,
		wildcardCallSites,
		wildcardCallers: graph.statistics.wildcardCallers,
		opaqueCallSites,
		aggregateDependencies: graph.statistics.aggregateDependencies,
		storedGraphRows: graph.statistics.storedRows,
		storedGraphEntries: graph.statistics.storedEntries,
		updatedCallSites,
		accessFunctionsScanned,
		propertyAggregateUpdates,
		cellAggregateUpdates,
		globalStoreAggregateUpdates,
		callSiteIndexUpdates: changedCallSites.size,
	});
	return Object.freeze({
		sourceClosed,
		statistics,
		changedCallSites,
		changedCallers,
		changedEdgeCallers,
		graph,
		local,
		cells,
		cellAccesses,
		propertyWrites,
		propertyWriters,
		properties: knownFunctionProperties,
		propertyReaders,
		cellReaders,
		cellWriters,
		globalStoreWriters,
		globalStores,
		sites,
		outgoingIndex: outgoing,
		targets(functionId: CoreFunctionId, value: CoreValueId) {
			return local.get(functionId)?.values[value] ?? CORE_CALLEE_TARGETS_OPEN;
		},
		returnTargets(functionId: CoreFunctionId) {
			return local.get(functionId)?.returnTargets ?? CORE_CALLEE_TARGETS_OPEN;
		},
		globalStoreTargets(slot: number) {
			return globalStores.get(slot) ?? CORE_CALLEE_TARGETS_BOTTOM;
		},
		site(id: CoreCallSiteId) {
			return sites.get(id);
		},
		outgoing(functionId: CoreFunctionId) {
			return outgoing.get(functionId) ?? [];
		},
	});
}

export const CORE_CALL_GRAPH_ANALYSIS: CoreAnalysisDefinition<CoreCallGraphIndexState> = {
	key: "call-graph",
	scope: "program",
	functionDependencies: ["body", "cfg", "calls"],
	programDependencies: ["functions", "calls"],
	contextIdentity(context) {
		return context.facts.closure.sourceClosure.kind;
	},
	compute({ program, context, request, previous, get, programFlow }) {
		if (request.scope !== "program") throw new Error("Expected program analysis request");
		const flow = programFlow.refresh(
			CORE_PROGRAM_FLOW_TARGET_CONSUMER,
			CORE_PROGRAM_FLOW_TARGETS,
		);
		const dirtyFunctions = new Array<CoreFunctionId>();
		if (previous !== undefined) {
			for (let index = 0; index < flow.dirtyFunctionCount; index++) {
				dirtyFunctions.push(flow.dirtyFunctionAt(index));
			}
		}
		return analyzeCoreCallGraph(
			program,
			context.facts.closure.sourceClosure.kind === "known",
			previous as CoreCallGraphIndexState | undefined,
			(functionId) =>
				get(CORE_CONTROL_FLOW_ANALYSIS, {
					scope: "function",
					function: functionId,
				}),
			context,
			dirtyFunctions,
			(functionId) => programFlow.local(functionId),
		);
	},
};

export function analyzeCoreCalleeTargets(program: CoreProgram): CoreCallGraphIndex {
	return analyzeCoreCallGraph(program, false);
}

export type CoreCalleeTargetAnalysis = CoreCallGraphIndex;
