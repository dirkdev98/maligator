import type { CoreCallGraph } from "./core-call-graph.ts";
import { coreClosedCapturedValueSlots } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
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

export interface CoreIndexedCallSite extends CoreLocalCallSite {
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
	readonly cellInputs: ReadonlyMap<CoreCellId, CoreCalleeTargets>;
	readonly cellWrites: ReadonlyMap<CoreCellId, CoreCalleeTargets>;
	readonly propertyInputs: ReadonlyMap<CoreFunctionPropertyId, CoreCalleeTargets>;
	readonly globalWrites: ReadonlyMap<number, CoreCalleeTargets>;
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
	identities: CoreGraphIdentityTable,
): ReadonlyMap<CoreFunctionPropertyId, CoreCalleeTargets> {
	const properties = new Map<CoreFunctionPropertyId, CoreCalleeTargets>();
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
		const property = functionPropertyId(identities, receiverFunction, stringIndex);
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
		if (opcode === "loadGlobal" || opcode === "loadCaptured") reads.add(id);
		else writes.add(id);
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
				const key = instructionCellId(fn, instruction, trackedCells, identities);
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
			targets,
			open: coreCalleeTargetsAreOpen(targets),
		});
	});
	const cellInputs = new Map<CoreCellId, CoreCalleeTargets>();
	const cellWrites = new Map<CoreCellId, CoreCalleeTargets>();
	const propertyInputs = new Map<CoreFunctionPropertyId, CoreCalleeTargets>();
	const globalWrites = new Map<number, CoreCalleeTargets>();
	for (let index = 0; index < localTransfers.operationCount; index++) {
		const instruction = localTransfers.operationAt(index);
		const opcode = fn.instructionOpcodeName(instruction);
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
		const key = instructionCellId(fn, instruction, trackedCells, identities);
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
