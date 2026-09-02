import type {
	FunctionEffectSummary,
	ModuleEffectSummary,
	SummaryRootReason,
} from "../shared/effect-summary.ts";
import { CORE_ANY_SCRIPT_AGGREGATE } from "./core-call-graph.ts";
import type { CoreCallGraph, CoreCallGraphNode } from "./core-call-graph.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import {
	CORE_PROGRAM_FLOW_BODY,
	CORE_PROGRAM_FLOW_CALLS,
	CORE_PROGRAM_FLOW_CFG,
	CORE_PROGRAM_FLOW_EXCEPTION,
	CORE_PROGRAM_FLOW_MEMORY,
	CORE_PROGRAM_FLOW_REPRESENTATIONS,
} from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreProgram,
	CoreProgramFlowDomainMask,
} from "./core-store.ts";

export type CoreProgramFlowDimensionMask = number;

export const CORE_PROGRAM_FLOW_TARGETS = 1 << 0;
export const CORE_PROGRAM_FLOW_EFFECTS = 1 << 1;
export const CORE_PROGRAM_FLOW_ESCAPE = 1 << 2;
export const CORE_PROGRAM_FLOW_CONTAINMENT = 1 << 3;
export const CORE_PROGRAM_FLOW_RETURN_PROVENANCE = 1 << 4;
export const CORE_PROGRAM_FLOW_RETURN_KIND = 1 << 5;
export const CORE_PROGRAM_FLOW_RETURN_REPRESENTATION = 1 << 6;
export const CORE_PROGRAM_FLOW_REACHABILITY = 1 << 7;

export const CORE_PROGRAM_FLOW_RUNTIME_IDENTITY = 1 << 0;
export const CORE_PROGRAM_FLOW_INLINE_SOURCE = 1 << 1;

export type CoreProgramFlowReachabilityReason =
	| "program-entry"
	| "commonjs-module"
	| "host-install"
	| "open-world"
	| "finite-call"
	| "any-script"
	| "runtime-identity"
	| "inline-source";

export interface CoreProgramFlowReachabilityStatistics {
	readonly functions: number;
	readonly functionsIndexed: number;
	readonly structuralIndexEdges: number;
	readonly hostInstallSlotsRead: number;
	readonly functionsScanned: number;
	readonly exactCallEdgesFollowed: number;
	readonly wildcardCallerVisits: number;
	readonly aggregateDependencyVisits: number;
	readonly structuralEdgesFollowed: number;
	readonly resultSetUpdates: number;
	readonly deadFunctions: number;
}

export interface CoreProgramFlowTargetIndex {
	readonly sourceClosed: boolean;
	readonly graph: CoreCallGraph;
	readonly changedCallers: ReadonlySet<CoreFunctionId>;
	readonly changedEdgeCallers: ReadonlySet<CoreFunctionId>;
	globalStoreTargets(slot: number): {
		readonly functions: ReadonlyArray<CoreFunctionId>;
		readonly anyScript: boolean;
	};
	outgoing(functionId: CoreFunctionId): ReadonlyArray<{
		readonly receiver?: CoreValueId;
		readonly arguments?: ReadonlyArray<CoreValueId>;
		readonly targets: {
			readonly functions: ReadonlyArray<CoreFunctionId>;
			readonly anyScript: boolean;
			readonly opaque: boolean;
		};
	}>;
}

export interface CoreProgramFlowPublishedFunctionSummary {
	readonly version: number;
	readonly summary: FunctionEffectSummary;
}

export interface CoreProgramFlowSummaryStatistics {
	readonly functions: number;
	readonly functionsAnalyzed: number;
	readonly functionsReused: number;
	readonly sccs: number;
	readonly sccTransfers: number;
	readonly sccEdgeVisits: number;
	readonly summaryChanges: number;
	readonly callerWakeups: number;
	readonly affectedCallers: number;
	readonly sccNodesAnalyzed: number;
	readonly sccsReused: number;
	readonly aggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
}

export interface CoreProgramFlowSummaries<
	Targets extends CoreProgramFlowTargetIndex = CoreProgramFlowTargetIndex,
> {
	readonly targets: Targets;
	readonly sccs: ReadonlyArray<CoreProgramFlowScc>;
	readonly functionEffects: ReadonlyMap<string, FunctionEffectSummary>;
	readonly moduleEffects: ReadonlyMap<string, ModuleEffectSummary>;
	readonly changedFunctions: ReadonlySet<CoreFunctionId>;
	readonly statistics: CoreProgramFlowSummaryStatistics;
	summary(functionId: CoreFunctionId): FunctionEffectSummary | undefined;
	version(functionId: CoreFunctionId): number;
}

export interface CoreProgramFlowSummaryState<
	Local,
	Aggregate,
	Targets extends CoreProgramFlowTargetIndex = CoreProgramFlowTargetIndex,
> extends CoreProgramFlowSummaries<Targets> {
	readonly sourceClosed: boolean;
	readonly local: ReadonlyMap<CoreFunctionId, Local>;
	readonly published: ReadonlyMap<
		CoreFunctionId,
		CoreProgramFlowPublishedFunctionSummary
	>;
	readonly rootReasons: ReadonlyMap<CoreFunctionId, ReadonlyArray<SummaryRootReason>>;
	readonly anyScriptSummary: Aggregate | undefined;
}

export interface CoreProgramFlowSummarySemantics<
	Local,
	Aggregate,
	Targets extends CoreProgramFlowTargetIndex = CoreProgramFlowTargetIndex,
> {
	localIsCurrent(local: Local | undefined, fn: CoreFunctionStore): boolean;
	analyzeLocal(
		fn: CoreFunctionStore,
		controlFlow: CoreControlFlow,
		transfers: CoreProgramFlowLocalTransfers,
	): Local;
	summaryId(local: Local): string;
	rootReasons(
		program: CoreProgram,
		targets: Targets,
		context: CoreCompilationContext,
	): ReadonlyMap<CoreFunctionId, ReadonlyArray<SummaryRootReason>>;
	derive(
		program: CoreProgram,
		functionId: CoreFunctionId,
		local: Local,
		targets: Targets,
		current: ReadonlyMap<CoreFunctionId, FunctionEffectSummary>,
		aggregate: Aggregate | undefined,
		summaryIds: ReadonlyMap<CoreFunctionId, string>,
		reasons: ReadonlyMap<CoreFunctionId, ReadonlyArray<SummaryRootReason>>,
		includeCalls?: boolean,
	): FunctionEffectSummary;
	summarizeAggregate(
		current: ReadonlyMap<CoreFunctionId, FunctionEffectSummary>,
		parameterCount: number,
	): Aggregate;
	aggregateParameterCount(aggregate: Aggregate): number;
	sameAggregate(left: Aggregate | undefined, right: Aggregate | undefined): boolean;
	summariesEqual(left: FunctionEffectSummary, right: FunctionEffectSummary): boolean;
	moduleSummaries(
		program: CoreProgram,
		functions: ReadonlyMap<CoreFunctionId, CoreProgramFlowPublishedFunctionSummary>,
		context: CoreCompilationContext,
	): ReadonlyMap<string, ModuleEffectSummary>;
}

type CoreProgramFlowReachabilityEdges = ReadonlyMap<
	CoreFunctionId,
	ReadonlySet<CoreProgramFlowReachabilityReason>
>;

type CoreProgramFlowReachabilityMasks = ReadonlyMap<CoreFunctionId, number>;

export interface CoreProgramFlowReachabilityState<
	Targets extends CoreProgramFlowTargetIndex = CoreProgramFlowTargetIndex,
> {
	readonly executable: ReadonlySet<CoreFunctionId>;
	readonly retained: ReadonlySet<CoreFunctionId>;
	readonly dead: ReadonlySet<CoreFunctionId>;
	readonly liveFunctions: ReadonlyArray<CoreFunctionId>;
	readonly reasons: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreProgramFlowReachabilityReason>
	>;
	readonly sourceClosed: boolean;
	readonly statistics: CoreProgramFlowReachabilityStatistics;
	readonly bodyVersions: ReadonlyMap<CoreFunctionId, number>;
	readonly cfgVersions: ReadonlyMap<CoreFunctionId, number>;
	readonly programDataVersion: number;
	readonly structural: ReadonlyMap<CoreFunctionId, CoreProgramFlowReachabilityEdges>;
	readonly structuralMasks: ReadonlyMap<CoreFunctionId, CoreProgramFlowReachabilityMasks>;
	readonly structuralCallers: ReadonlyMap<
		CoreFunctionId,
		CoreProgramFlowReachabilityMasks
	>;
	readonly roots: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreProgramFlowReachabilityReason>
	>;
	readonly rootMasks: CoreProgramFlowReachabilityMasks;
	readonly targets: Targets;
}

const REACHABILITY_PROGRAM_ENTRY = 1 << 0;
const REACHABILITY_COMMONJS_MODULE = 1 << 1;
const REACHABILITY_HOST_INSTALL = 1 << 2;
const REACHABILITY_OPEN_WORLD = 1 << 3;
const REACHABILITY_FINITE_CALL = 1 << 4;
const REACHABILITY_ANY_SCRIPT = 1 << 5;
const REACHABILITY_RUNTIME_IDENTITY = 1 << 6;
const REACHABILITY_INLINE_SOURCE = 1 << 7;

const REACHABILITY_REASON_BITS: ReadonlyArray<
	readonly [number, CoreProgramFlowReachabilityReason]
> = [
	[REACHABILITY_PROGRAM_ENTRY, "program-entry"],
	[REACHABILITY_COMMONJS_MODULE, "commonjs-module"],
	[REACHABILITY_HOST_INSTALL, "host-install"],
	[REACHABILITY_OPEN_WORLD, "open-world"],
	[REACHABILITY_FINITE_CALL, "finite-call"],
	[REACHABILITY_ANY_SCRIPT, "any-script"],
	[REACHABILITY_RUNTIME_IDENTITY, "runtime-identity"],
	[REACHABILITY_INLINE_SOURCE, "inline-source"],
];

const FUNCTION_INDEX_ATTRIBUTES = [
	"functionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
] as const;

export const CORE_PROGRAM_FLOW_SUMMARIES =
	CORE_PROGRAM_FLOW_EFFECTS |
	CORE_PROGRAM_FLOW_ESCAPE |
	CORE_PROGRAM_FLOW_CONTAINMENT |
	CORE_PROGRAM_FLOW_RETURN_PROVENANCE |
	CORE_PROGRAM_FLOW_RETURN_REPRESENTATION;

export const CORE_PROGRAM_FLOW_ALL_DIMENSIONS =
	CORE_PROGRAM_FLOW_TARGETS |
	CORE_PROGRAM_FLOW_EFFECTS |
	CORE_PROGRAM_FLOW_ESCAPE |
	CORE_PROGRAM_FLOW_CONTAINMENT |
	CORE_PROGRAM_FLOW_RETURN_PROVENANCE |
	CORE_PROGRAM_FLOW_RETURN_KIND |
	CORE_PROGRAM_FLOW_RETURN_REPRESENTATION |
	CORE_PROGRAM_FLOW_REACHABILITY;

export class CoreProgramFlowLocalTransfers {
	readonly instructionVisits: number;
	readonly #operations: Uint32Array;
	readonly #calls: Uint32Array;
	readonly #cellAccesses: Uint32Array;
	readonly #propertyDefinitions: Uint32Array;
	readonly #structuralTargets: Uint32Array;
	readonly #structuralReasons: Uint8Array;

	constructor(
		instructionVisits: number,
		operations: ReadonlyArray<CoreInstructionId>,
		calls: ReadonlyArray<CoreInstructionId>,
		cellAccesses: ReadonlyArray<CoreInstructionId>,
		propertyDefinitions: ReadonlyArray<CoreInstructionId>,
		structuralTargets: ReadonlyArray<CoreFunctionId>,
		structuralReasons: ReadonlyArray<number>,
	) {
		this.instructionVisits = instructionVisits;
		this.#operations = Uint32Array.from(operations);
		this.#calls = Uint32Array.from(calls);
		this.#cellAccesses = Uint32Array.from(cellAccesses);
		this.#propertyDefinitions = Uint32Array.from(propertyDefinitions);
		this.#structuralTargets = Uint32Array.from(structuralTargets);
		this.#structuralReasons = Uint8Array.from(structuralReasons);
	}

	get operationCount(): number {
		return this.#operations.length;
	}

	operationAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#operations, index, "operation");
	}

	get callCount(): number {
		return this.#calls.length;
	}

	callAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#calls, index, "call");
	}

	get cellAccessCount(): number {
		return this.#cellAccesses.length;
	}

	cellAccessAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#cellAccesses, index, "cell access");
	}

	get propertyDefinitionCount(): number {
		return this.#propertyDefinitions.length;
	}

	propertyDefinitionAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#propertyDefinitions, index, "property definition");
	}

	get structuralTargetCount(): number {
		return this.#structuralTargets.length;
	}

	structuralTargetAt(index: number): CoreFunctionId {
		const target = this.#structuralTargets[index];
		if (target === undefined) throw new Error(`Unknown structural target ${index}`);
		return target as CoreFunctionId;
	}

	structuralReasonMaskAt(index: number): number {
		const reasons = this.#structuralReasons[index];
		if (reasons === undefined) throw new Error(`Unknown structural target ${index}`);
		return reasons;
	}

	get recordCount(): number {
		return (
			this.#operations.length +
			this.#calls.length +
			this.#cellAccesses.length +
			this.#propertyDefinitions.length +
			this.#structuralTargets.length
		);
	}

	#instructionAt(
		instructions: Uint32Array,
		index: number,
		kind: string,
	): CoreInstructionId {
		const instruction = instructions[index];
		if (instruction === undefined) throw new Error(`Unknown ${kind} transfer ${index}`);
		return coreInstructionId(instruction);
	}
}

function addStructuralTarget(
	targets: Map<CoreFunctionId, number>,
	program: CoreProgram,
	candidate: unknown,
	reason: number,
): void {
	if (
		typeof candidate !== "number" ||
		!Number.isSafeInteger(candidate) ||
		candidate < 0 ||
		candidate >= program.functionCapacity
	)
		return;
	const target = candidate as CoreFunctionId;
	if (!program.hasFunction(target)) return;
	targets.set(target, (targets.get(target) ?? 0) | reason);
}

function addSourceTargets(
	targets: Map<CoreFunctionId, number>,
	program: CoreProgram,
	initial: number,
): void {
	const seen = new Set<number>();
	let position = initial;
	while (
		position >= 0 &&
		position < program.sourcePositions.length &&
		!seen.has(position)
	) {
		seen.add(position);
		const source = program.sourcePositions[position]!;
		addStructuralTarget(
			targets,
			program,
			source.inlinedFunctionIndex,
			CORE_PROGRAM_FLOW_INLINE_SOURCE,
		);
		position = source.callerPosId ?? -1;
	}
}

export function extractCoreProgramFlowLocalTransfers(
	program: CoreProgram,
	fn: CoreFunctionStore,
): CoreProgramFlowLocalTransfers {
	const operations: Array<CoreInstructionId> = [];
	const calls: Array<CoreInstructionId> = [];
	const cellAccesses: Array<CoreInstructionId> = [];
	const propertyDefinitions: Array<CoreInstructionId> = [];
	const structural = new Map<CoreFunctionId, number>();
	let instructionVisits = 0;
	for (const instruction of fn.instructionIds()) {
		instructionVisits++;
		const sourcePosition = fn.kernel.instructionSourcePosition(instruction);
		if (sourcePosition >= 0) addSourceTargets(structural, program, sourcePosition);
		if (fn.kernel.instructionOpcode(instruction) < 0) continue;
		operations.push(instruction);
		const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
		if (descriptor.callTransfer !== undefined) calls.push(instruction);
		const opcode = descriptor.opcode;
		if (
			opcode === "loadGlobal" ||
			opcode === "storeGlobal" ||
			opcode === "loadCaptured" ||
			opcode === "storeCaptured"
		) {
			cellAccesses.push(instruction);
		}
		if (opcode === "defineProperty") propertyDefinitions.push(instruction);
		const attributes = fn.instructionAttributes(instruction);
		for (const key of FUNCTION_INDEX_ATTRIBUTES) {
			addStructuralTarget(
				structural,
				program,
				attributes[key],
				CORE_PROGRAM_FLOW_RUNTIME_IDENTITY,
			);
		}
		const guarded = attributes.guardedFunctionIndices;
		if (!Array.isArray(guarded)) continue;
		for (const target of guarded) {
			addStructuralTarget(
				structural,
				program,
				target,
				CORE_PROGRAM_FLOW_RUNTIME_IDENTITY,
			);
		}
	}
	const structuralTargets = [...structural.keys()].sort((left, right) => left - right);
	return new CoreProgramFlowLocalTransfers(
		instructionVisits,
		operations,
		calls,
		cellAccesses,
		propertyDefinitions,
		structuralTargets,
		structuralTargets.map((target) => structural.get(target)!),
	);
}

function reachabilityReasonMask(
	reasons: ReadonlySet<CoreProgramFlowReachabilityReason> | undefined,
): number {
	let mask = 0;
	for (const [bit, reason] of REACHABILITY_REASON_BITS) {
		if (reasons?.has(reason)) mask |= bit;
	}
	return mask;
}

function reachabilityReasonSet(
	mask: number,
	previous?: ReadonlySet<CoreProgramFlowReachabilityReason>,
): ReadonlySet<CoreProgramFlowReachabilityReason> {
	if (previous !== undefined && reachabilityReasonMask(previous) === mask)
		return previous;
	const reasons = new Set<CoreProgramFlowReachabilityReason>();
	for (const [bit, reason] of REACHABILITY_REASON_BITS) {
		if ((mask & bit) !== 0) reasons.add(reason);
	}
	return reasons;
}

function sameFunctionIds(
	left: ReadonlySet<CoreFunctionId>,
	right: ReadonlySet<CoreFunctionId>,
): boolean {
	return (
		left.size === right.size && [...left].every((functionId) => right.has(functionId))
	);
}

function sameNumericRows(
	left: CoreProgramFlowReachabilityMasks | undefined,
	right: CoreProgramFlowReachabilityMasks | undefined,
): boolean {
	return (
		(left?.size ?? 0) === (right?.size ?? 0) &&
		[...(left ?? [])].every(([functionId, mask]) => right?.get(functionId) === mask)
	);
}

function structuralReachabilityMasks(
	transfers: CoreProgramFlowLocalTransfers,
): ReadonlyMap<CoreFunctionId, number> {
	const result = new Map<CoreFunctionId, number>();
	for (let index = 0; index < transfers.structuralTargetCount; index++) {
		const target = transfers.structuralTargetAt(index);
		const localReasons = transfers.structuralReasonMaskAt(index);
		let reasons = 0;
		if ((localReasons & CORE_PROGRAM_FLOW_RUNTIME_IDENTITY) !== 0) {
			reasons |= REACHABILITY_RUNTIME_IDENTITY;
		}
		if ((localReasons & CORE_PROGRAM_FLOW_INLINE_SOURCE) !== 0) {
			reasons |= REACHABILITY_INLINE_SOURCE;
		}
		if (reasons !== 0) result.set(target, reasons);
	}
	return result;
}

function publicStructuralReachabilityEdges(
	masks: CoreProgramFlowReachabilityMasks,
	previous?: CoreProgramFlowReachabilityEdges,
): CoreProgramFlowReachabilityEdges {
	if (
		(previous?.size ?? 0) === masks.size &&
		[...masks].every(
			([functionId, reasons]) =>
				reachabilityReasonMask(previous?.get(functionId)) === reasons,
		)
	) {
		return previous ?? new Map();
	}
	return new Map(
		[...masks].map(([functionId, reasons]) => [
			functionId,
			reachabilityReasonSet(reasons),
		]),
	);
}

function coreProgramFlowReachabilityRoots(
	program: CoreProgram,
	targets: CoreProgramFlowTargetIndex,
	context: CoreCompilationContext,
): {
	readonly masks: ReadonlyMap<CoreFunctionId, number>;
	readonly roots: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreProgramFlowReachabilityReason>
	>;
	readonly hostInstallSlotsRead: number;
} {
	const masks = new Map<CoreFunctionId, number>();
	const enter = (candidate: unknown, reason: number): void => {
		if (
			typeof candidate !== "number" ||
			!Number.isSafeInteger(candidate) ||
			candidate < 0 ||
			candidate >= program.functionCapacity
		)
			return;
		const functionId = candidate as CoreFunctionId;
		if (!program.hasFunction(functionId)) return;
		masks.set(functionId, (masks.get(functionId) ?? 0) | reason);
	};
	const functions = targets.graph.functions;
	if (!targets.sourceClosed) {
		for (const functionId of functions) enter(functionId, REACHABILITY_OPEN_WORLD);
	} else {
		enter(functions[0], REACHABILITY_PROGRAM_ENTRY);
		for (const functionId of context.data.cjsModuleFunctionIndices) {
			enter(functionId, REACHABILITY_COMMONJS_MODULE);
		}
	}
	const hostInstallSlots = new Set<number>();
	for (const candidate of context.data.hostInstallCandidates) {
		for (const { slot } of candidate.exports) hostInstallSlots.add(slot);
	}
	for (const slot of hostInstallSlots) {
		const installed = targets.globalStoreTargets(slot);
		for (const target of installed.functions) enter(target, REACHABILITY_HOST_INSTALL);
		if (installed.anyScript) {
			for (const functionId of functions) enter(functionId, REACHABILITY_HOST_INSTALL);
		}
	}
	return {
		masks,
		roots: new Map(
			[...masks].map(([functionId, reasons]) => [
				functionId,
				reachabilityReasonSet(reasons),
			]),
		),
		hostInstallSlotsRead: hostInstallSlots.size,
	};
}

export interface CoreProgramFlowScc {
	readonly id: string;
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly hasAnyScriptAggregate: boolean;
}

export interface CoreProgramFlowTopology {
	readonly graph: CoreCallGraph;
	readonly sccs: ReadonlyArray<CoreProgramFlowScc>;
	readonly owner: ReadonlyMap<CoreCallGraphNode, number>;
	readonly nodesAnalyzed: number;
	readonly edgeVisits: number;
	readonly sccsReused: number;
}

export type CoreProgramFlowSccEnqueue = (
	scc: number | undefined,
	dimensions: CoreProgramFlowDimensionMask,
) => boolean;

export type CoreProgramFlowSccTransfer = (
	scc: number,
	dimensions: CoreProgramFlowDimensionMask,
	enqueue: CoreProgramFlowSccEnqueue,
) => void;

export interface CoreProgramFlowSccSeed {
	readonly scc: number | undefined;
	readonly dimensions: CoreProgramFlowDimensionMask;
}

export interface CoreProgramFlowSccWorkStatistics {
	readonly pops: number;
	readonly wakeups: number;
}

export interface CoreProgramFlowSccSolver {
	solveSccs(
		topology: CoreProgramFlowTopology,
		seeds: Iterable<CoreProgramFlowSccSeed>,
		transfer: CoreProgramFlowSccTransfer,
	): CoreProgramFlowSccWorkStatistics;
}

export type CoreProgramFlowFunctionEnqueue = (functionId: CoreFunctionId) => boolean;

export type CoreProgramFlowFunctionTransfer = (
	functionId: CoreFunctionId,
	enqueue: CoreProgramFlowFunctionEnqueue,
) => void;

export interface CoreProgramFlowFunctionWorkStatistics {
	readonly pops: number;
	readonly wakeups: number;
}

export interface CoreProgramFlowFunctionSolver {
	solveFunctions(
		seeds: Iterable<CoreFunctionId>,
		transfer: CoreProgramFlowFunctionTransfer,
	): CoreProgramFlowFunctionWorkStatistics;
}

class CoreProgramFlowFunctionWorklist {
	readonly #queue: Array<CoreFunctionId> = [];
	readonly #queued = new Set<CoreFunctionId>();

	solve(
		seeds: Iterable<CoreFunctionId>,
		transfer: CoreProgramFlowFunctionTransfer,
	): CoreProgramFlowFunctionWorkStatistics {
		this.#queue.length = 0;
		this.#queued.clear();
		let wakeups = 0;
		const enqueue: CoreProgramFlowFunctionEnqueue = (functionId) => {
			if (this.#queued.has(functionId)) return false;
			this.#queued.add(functionId);
			this.#queue.push(functionId);
			wakeups++;
			return true;
		};
		for (const seed of seeds) enqueue(seed);
		let cursor = 0;
		while (cursor < this.#queue.length) {
			const functionId = this.#queue[cursor++]!;
			this.#queued.delete(functionId);
			transfer(functionId, enqueue);
		}
		return Object.freeze({ pops: cursor, wakeups });
	}
}

class CoreProgramFlowSccWorklist {
	#dimensions = new Uint16Array(0);
	#queued = new Uint8Array(0);
	readonly #queue: Array<number> = [];

	solve(
		topology: CoreProgramFlowTopology,
		seeds: Iterable<CoreProgramFlowSccSeed>,
		transfer: CoreProgramFlowSccTransfer,
	): CoreProgramFlowSccWorkStatistics {
		for (const scc of this.#queue) {
			this.#dimensions[scc] = 0;
			this.#queued[scc] = 0;
		}
		this.#queue.length = 0;
		this.#ensureCapacity(topology.sccs.length);
		let wakeups = 0;
		const enqueue: CoreProgramFlowSccEnqueue = (scc, mask) => {
			if (scc === undefined || mask === 0) return false;
			this.#dimensions[scc] = this.#dimensions[scc]! | mask;
			if (this.#queued[scc] !== 0) return false;
			this.#queued[scc] = 1;
			this.#queue.push(scc);
			wakeups++;
			return true;
		};
		for (const seed of seeds) enqueue(seed.scc, seed.dimensions);
		let cursor = 0;
		while (cursor < this.#queue.length) {
			const scc = this.#queue[cursor++]!;
			this.#queued[scc] = 0;
			const mask = this.#dimensions[scc]!;
			this.#dimensions[scc] = 0;
			transfer(scc, mask, enqueue);
		}
		return Object.freeze({ pops: cursor, wakeups });
	}

	#ensureCapacity(capacity: number): void {
		if (this.#dimensions.length >= capacity) return;
		const dimensions = new Uint16Array(capacity);
		dimensions.set(this.#dimensions);
		this.#dimensions = dimensions;
		const queued = new Uint8Array(capacity);
		queued.set(this.#queued);
		this.#queued = queued;
	}
}

export function solveCoreProgramFlowFunctions(
	seeds: Iterable<CoreFunctionId>,
	transfer: CoreProgramFlowFunctionTransfer,
): CoreProgramFlowFunctionWorkStatistics {
	return new CoreProgramFlowFunctionWorklist().solve(seeds, transfer);
}

export function solveCoreProgramFlowSccs(
	topology: CoreProgramFlowTopology,
	seeds: Iterable<CoreProgramFlowSccSeed>,
	transfer: CoreProgramFlowSccTransfer,
): CoreProgramFlowSccWorkStatistics {
	return new CoreProgramFlowSccWorklist().solve(topology, seeds, transfer);
}

export function buildCoreProgramFlowTopology(
	graph: CoreCallGraph,
	previous?: CoreProgramFlowTopology,
): CoreProgramFlowTopology {
	if (previous !== undefined && graph.changedNodes.size === 0) {
		return Object.freeze({
			graph,
			sccs: previous.sccs,
			owner: previous.owner,
			nodesAnalyzed: 0,
			edgeVisits: 0,
			sccsReused: previous.sccs.length,
		});
	}
	const all: Array<CoreCallGraphNode> = [
		...graph.functions,
		...(graph.hasAggregate() ? [CORE_ANY_SCRIPT_AGGREGATE] : []),
	];
	let edgeVisits = 0;
	let fullRebuild =
		previous === undefined ||
		graph.hasAggregate() ||
		previous.graph.hasAggregate() ||
		graph.functions.length !== previous.graph.functions.length ||
		graph.functions.some(
			(functionId, index) => functionId !== previous.graph.functions[index],
		);
	const affected = new Set<CoreCallGraphNode>();
	if (fullRebuild) {
		for (const node of all) affected.add(node);
	} else {
		for (const node of graph.changedNodes) affected.add(node);
		const queue = [...affected];
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const node = queue[cursor]!;
			if (node === CORE_ANY_SCRIPT_AGGREGATE) {
				fullRebuild = true;
				break;
			}
			const functionId = node;
			const neighbors = [
				...graph.exactCallers(functionId),
				...previous!.graph.exactCallers(functionId),
				...graph.exactOutgoing(functionId),
				...previous!.graph.exactOutgoing(functionId),
			];
			edgeVisits += neighbors.length;
			for (const neighbor of neighbors) {
				if (affected.has(neighbor)) continue;
				affected.add(neighbor);
				queue.push(neighbor);
			}
		}
		if (fullRebuild) {
			affected.clear();
			for (const node of all) affected.add(node);
		}
	}
	if (previous !== undefined && affected.size === 0) {
		return Object.freeze({
			graph,
			sccs: previous.sccs,
			owner: previous.owner,
			nodesAnalyzed: 0,
			edgeVisits,
			sccsReused: previous.sccs.length,
		});
	}

	let nextIndex = 0;
	const indices = new Map<CoreCallGraphNode, number>();
	const lowlinks = new Map<CoreCallGraphNode, number>();
	const stack: Array<CoreCallGraphNode> = [];
	const onStack = new Set<CoreCallGraphNode>();
	const components: Array<Array<CoreCallGraphNode>> = [];
	const visit = (node: CoreCallGraphNode): void => {
		indices.set(node, nextIndex);
		lowlinks.set(node, nextIndex++);
		stack.push(node);
		onStack.add(node);
		graph.visitSuccessors(node, (successor) => {
			edgeVisits++;
			if (!affected.has(successor)) return;
			if (!indices.has(successor)) {
				visit(successor);
				lowlinks.set(node, Math.min(lowlinks.get(node)!, lowlinks.get(successor)!));
			} else if (onStack.has(successor)) {
				lowlinks.set(node, Math.min(lowlinks.get(node)!, indices.get(successor)!));
			}
		});
		if (lowlinks.get(node) !== indices.get(node)) return;
		const component: Array<CoreCallGraphNode> = [];
		while (stack.length > 0) {
			const member = stack.pop()!;
			onStack.delete(member);
			component.push(member);
			if (member === node) break;
		}
		components.push(component.sort((left, right) => left - right));
	};
	for (const node of affected) {
		if (!indices.has(node)) visit(node);
	}
	const preserved = fullRebuild
		? []
		: (previous?.sccs.filter(
				(scc) =>
					scc.functions.every((functionId) => !affected.has(functionId)) &&
					!scc.hasAnyScriptAggregate,
			) ?? []);
	const rebuilt = components.map((nodes) => {
		const functions = nodes.filter(
			(node): node is CoreFunctionId => node !== CORE_ANY_SCRIPT_AGGREGATE,
		);
		return Object.freeze({
			id: `scc:${nodes.map((node) => (node === CORE_ANY_SCRIPT_AGGREGATE ? "any" : node)).join(",")}`,
			functions: Object.freeze(functions),
			hasAnyScriptAggregate: nodes.includes(CORE_ANY_SCRIPT_AGGREGATE),
		});
	});
	const sccs = Object.freeze([...preserved, ...rebuilt]);
	const owner = new Map<CoreCallGraphNode, number>();
	for (const [index, scc] of sccs.entries()) {
		for (const functionId of scc.functions) owner.set(functionId, index);
		if (scc.hasAnyScriptAggregate) owner.set(CORE_ANY_SCRIPT_AGGREGATE, index);
	}
	return Object.freeze({
		graph,
		sccs,
		owner,
		nodesAnalyzed: affected.size,
		edgeVisits,
		sccsReused: preserved.length,
	});
}

export function coreProgramFlowDimensionsForDomains(
	domains: CoreProgramFlowDomainMask,
): CoreProgramFlowDimensionMask {
	let dimensions = 0;
	if (
		(domains &
			(CORE_PROGRAM_FLOW_BODY |
				CORE_PROGRAM_FLOW_CFG |
				CORE_PROGRAM_FLOW_EXCEPTION |
				CORE_PROGRAM_FLOW_CALLS)) !==
		0
	)
		dimensions |= CORE_PROGRAM_FLOW_ALL_DIMENSIONS;
	if ((domains & CORE_PROGRAM_FLOW_MEMORY) !== 0) {
		dimensions |=
			CORE_PROGRAM_FLOW_EFFECTS |
			CORE_PROGRAM_FLOW_ESCAPE |
			CORE_PROGRAM_FLOW_CONTAINMENT |
			CORE_PROGRAM_FLOW_RETURN_PROVENANCE;
	}
	if ((domains & CORE_PROGRAM_FLOW_REPRESENTATIONS) !== 0) {
		dimensions |= CORE_PROGRAM_FLOW_RETURN_KIND | CORE_PROGRAM_FLOW_RETURN_REPRESENTATION;
	}
	return dimensions;
}

export class CoreProgramFlowEpoch {
	#cursor = 0;
	#revision = 0;
	#epoch = 0;
	#membership = new Uint32Array(0);
	#domains = new Uint16Array(0);
	#dimensions = new Uint16Array(0);
	readonly #dirtyFunctions: Array<CoreFunctionId> = [];

	get revision(): number {
		return this.#revision;
	}

	get dirtyFunctionCount(): number {
		return this.#dirtyFunctions.length;
	}

	refresh(
		program: CoreProgram,
		dimensionMask: CoreProgramFlowDimensionMask,
		report?: CoreOptimizationReportBuilder,
	): this {
		const revision = program.programFlowRevision;
		if (revision === this.#revision) return this;
		this.#ensureCapacity(program.functionCapacity);
		this.#epoch++;
		if (this.#epoch === 0xffff_ffff) {
			this.#membership.fill(0);
			this.#epoch = 1;
		}
		this.#dirtyFunctions.length = 0;
		for (let cursor = this.#cursor; cursor < revision; cursor++) {
			const functionId = program.programFlowFunctionAt(cursor);
			const domains = program.programFlowDomainMaskAt(cursor);
			const dimensions = coreProgramFlowDimensionsForDomains(domains);
			if ((dimensions & dimensionMask) === 0) continue;
			if (this.#membership[functionId] !== this.#epoch) {
				this.#membership[functionId] = this.#epoch;
				this.#domains[functionId] = 0;
				this.#dimensions[functionId] = 0;
				this.#dirtyFunctions.push(functionId);
			}
			this.#domains[functionId] = this.#domains[functionId]! | domains;
			this.#dimensions[functionId] = this.#dimensions[functionId]! | dimensions;
		}
		this.#cursor = revision;
		this.#revision = revision;
		report?.increment("programFlowDirtyFunctions", this.#dirtyFunctions.length);
		return this;
	}

	dirtyFunctionAt(index: number): CoreFunctionId {
		const functionId = this.#dirtyFunctions[index];
		if (functionId === undefined)
			throw new Error(`Unknown dirty function index ${index}`);
		return functionId;
	}

	dirtyDomains(functionId: CoreFunctionId): CoreProgramFlowDomainMask {
		return this.#membership[functionId] === this.#epoch ? this.#domains[functionId]! : 0;
	}

	dirtyDimensions(functionId: CoreFunctionId): CoreProgramFlowDimensionMask {
		return this.#membership[functionId] === this.#epoch
			? this.#dimensions[functionId]!
			: 0;
	}

	#ensureCapacity(capacity: number): void {
		if (this.#membership.length >= capacity) return;
		const membership = new Uint32Array(capacity);
		membership.set(this.#membership);
		this.#membership = membership;
		const domains = new Uint16Array(capacity);
		domains.set(this.#domains);
		this.#domains = domains;
		const dimensions = new Uint16Array(capacity);
		dimensions.set(this.#dimensions);
		this.#dimensions = dimensions;
	}
}

export class CoreProgramFlowEngine {
	readonly #program: CoreProgram;
	readonly #report: CoreOptimizationReportBuilder | undefined;
	readonly #epoch = new CoreProgramFlowEpoch();
	readonly #localTransfers: Array<CoreProgramFlowLocalTransfers | undefined> = [];
	readonly #functionWorklist = new CoreProgramFlowFunctionWorklist();
	readonly #sccWorklist = new CoreProgramFlowSccWorklist();
	#topology: CoreProgramFlowTopology | undefined;
	#reportedRevision = 0;
	#localRevision = 0;
	#localDataVersion = 0;
	#localSourcePositionsVersion = 0;

	constructor(program: CoreProgram, report?: CoreOptimizationReportBuilder) {
		this.#program = program;
		this.#report = report;
	}

	refresh(dimensions: CoreProgramFlowDimensionMask): CoreProgramFlowEpoch {
		const revision = this.#program.programFlowRevision;
		this.#report?.increment(
			"programFlowJournalEntries",
			revision - this.#reportedRevision,
		);
		this.#reportedRevision = revision;
		const epoch = this.#epoch;
		epoch.refresh(this.#program, dimensions, this.#report);
		const count = epoch.dirtyFunctionCount;
		let targetWakeups = 0;
		let summaryWakeups = 0;
		let valueKindWakeups = 0;
		let reachabilityWakeups = 0;
		for (let index = 0; index < count; index++) {
			const dirty = epoch.dirtyDimensions(epoch.dirtyFunctionAt(index));
			if ((dirty & CORE_PROGRAM_FLOW_TARGETS) !== 0) targetWakeups++;
			if ((dirty & CORE_PROGRAM_FLOW_SUMMARIES) !== 0) summaryWakeups++;
			if ((dirty & CORE_PROGRAM_FLOW_RETURN_KIND) !== 0) valueKindWakeups++;
			if ((dirty & CORE_PROGRAM_FLOW_REACHABILITY) !== 0) reachabilityWakeups++;
		}
		this.#report?.increment("programFlowTargetWakeups", targetWakeups);
		this.#report?.increment("programFlowSummaryWakeups", summaryWakeups);
		this.#report?.increment("programFlowValueKindWakeups", valueKindWakeups);
		this.#report?.increment("programFlowReachabilityWakeups", reachabilityWakeups);
		return epoch;
	}

	local(functionId: CoreFunctionId): CoreProgramFlowLocalTransfers {
		this.#invalidateLocalTransfers();
		const current = this.#localTransfers[functionId];
		if (current !== undefined) {
			this.#report?.increment("programFlowTransferReuses");
			return current;
		}
		const next = extractCoreProgramFlowLocalTransfers(
			this.#program,
			this.#program.function(functionId),
		);
		this.#localTransfers[functionId] = next;
		this.#report?.increment("programFlowLocalScans");
		this.#report?.increment("programFlowLocalInstructionVisits", next.instructionVisits);
		this.#report?.increment("programFlowTransferRecords", next.recordCount);
		return next;
	}

	topology(graph: CoreCallGraph): CoreProgramFlowTopology {
		if (this.#topology?.graph === graph) return this.#topology;
		const next = buildCoreProgramFlowTopology(graph, this.#topology);
		this.#topology = next;
		this.#report?.increment("sccNodes", next.nodesAnalyzed);
		this.#report?.increment("sccEdges", next.edgeVisits);
		return next;
	}

	solveSccs(
		topology: CoreProgramFlowTopology,
		seeds: Iterable<CoreProgramFlowSccSeed>,
		transfer: CoreProgramFlowSccTransfer,
	): CoreProgramFlowSccWorkStatistics {
		const statistics = this.#sccWorklist.solve(topology, seeds, transfer);
		this.#report?.increment("programFlowSccPops", statistics.pops);
		this.#report?.increment("programFlowSccWakeups", statistics.wakeups);
		return statistics;
	}

	solveFunctions(
		seeds: Iterable<CoreFunctionId>,
		transfer: CoreProgramFlowFunctionTransfer,
	): CoreProgramFlowFunctionWorkStatistics {
		const statistics = this.#functionWorklist.solve(seeds, transfer);
		this.#report?.increment("programFlowFunctionPops", statistics.pops);
		this.#report?.increment("programFlowFunctionWakeups", statistics.wakeups);
		return statistics;
	}

	solveSummaries<Local, Aggregate, Targets extends CoreProgramFlowTargetIndex>(
		context: CoreCompilationContext,
		targets: Targets,
		controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
		semantics: CoreProgramFlowSummarySemantics<Local, Aggregate, Targets>,
		previous?: CoreProgramFlowSummaryState<Local, Aggregate, Targets>,
		dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
	): CoreProgramFlowSummaryState<Local, Aggregate, Targets> {
		const functions = targets.graph.functions;
		const dirty = new Uint8Array(this.#program.functionCapacity);
		if (previous === undefined) {
			for (const functionId of functions) dirty[functionId] = 1;
		} else {
			for (const functionId of dirtyFunctions ?? functions) dirty[functionId] = 1;
		}
		const local = new Map<CoreFunctionId, Local>();
		const changedFunctions = new Set<CoreFunctionId>();
		let functionsAnalyzed = 0;
		let functionsReused = 0;
		for (const functionId of functions) {
			const fn = this.#program.function(functionId);
			const prior = previous?.local.get(functionId);
			if (dirty[functionId] === 0 || semantics.localIsCurrent(prior, fn)) {
				if (prior === undefined)
					throw new Error(`Missing local summary for ${functionId}`);
				local.set(functionId, prior);
				functionsReused++;
			} else {
				local.set(
					functionId,
					semantics.analyzeLocal(fn, controlFlow(functionId), this.local(functionId)),
				);
				changedFunctions.add(functionId);
				functionsAnalyzed++;
			}
		}
		const topology = this.topology(targets.graph);
		const {
			sccs,
			owner,
			nodesAnalyzed: sccNodesAnalyzed,
			edgeVisits: sccEdgeVisits,
			sccsReused,
		} = topology;
		const reasons = semantics.rootReasons(this.#program, targets, context);
		const summaryIds = new Map(
			[...local].map(([functionId, summary]) => [
				functionId,
				semantics.summaryId(summary),
			]),
		);
		const current = new Map<CoreFunctionId, FunctionEffectSummary>();
		for (const functionId of functions) {
			const prior = previous?.published.get(functionId)?.summary;
			if (prior !== undefined) current.set(functionId, prior);
		}
		for (const functionId of functions) {
			if (current.has(functionId)) continue;
			current.set(
				functionId,
				semantics.derive(
					this.#program,
					functionId,
					local.get(functionId)!,
					targets,
					current,
					undefined,
					summaryIds,
					reasons,
					false,
				),
			);
		}
		let maximumWildcardArgumentCount = 0;
		for (const functionId of functions) {
			for (const site of targets.outgoing(functionId)) {
				if (!site.targets.anyScript) continue;
				maximumWildcardArgumentCount = Math.max(
					maximumWildcardArgumentCount,
					site.arguments?.length ?? 0,
				);
			}
		}
		let anyScriptSummary = targets.graph.hasAggregate()
			? previous?.anyScriptSummary
			: undefined;
		if (
			targets.graph.hasAggregate() &&
			(anyScriptSummary === undefined ||
				semantics.aggregateParameterCount(anyScriptSummary) !==
					maximumWildcardArgumentCount)
		) {
			anyScriptSummary = semantics.summarizeAggregate(
				current,
				maximumWildcardArgumentCount,
			);
		}
		const initialSccMembership = new Uint8Array(sccs.length);
		const initialSccs: Array<CoreProgramFlowSccSeed> = [];
		const seed = (scc: number | undefined): void => {
			if (scc === undefined || initialSccMembership[scc] !== 0) return;
			initialSccMembership[scc] = 1;
			initialSccs.push({ scc, dimensions: CORE_PROGRAM_FLOW_SUMMARIES });
		};
		if (previous === undefined || previous.sourceClosed !== targets.sourceClosed) {
			for (const index of sccs.keys()) seed(index);
		} else {
			for (const functionId of changedFunctions) seed(owner.get(functionId));
			for (const functionId of targets.changedCallers) seed(owner.get(functionId));
			if (targets.graph.changedNodes.has(CORE_ANY_SCRIPT_AGGREGATE)) {
				seed(owner.get(CORE_ANY_SCRIPT_AGGREGATE));
			}
			for (const functionId of functions) {
				const prior = previous.rootReasons.get(functionId) ?? [];
				const next = reasons.get(functionId) ?? [];
				if (
					prior.length !== next.length ||
					prior.some((reason, index) => reason !== next[index])
				) {
					seed(owner.get(functionId));
				}
			}
		}
		let sccTransfers = 0;
		let callerWakeups = 0;
		let aggregateRecomputations = 0;
		let exactReverseCallerVisits = 0;
		let wildcardReverseCallerVisits = 0;
		const affectedCallers = new Set<CoreFunctionId>();
		this.solveSccs(topology, initialSccs, (sccIndex, dimensions, enqueue) => {
			if ((dimensions & CORE_PROGRAM_FLOW_SUMMARIES) === 0) return;
			const scc = sccs[sccIndex]!;
			const aggregateBefore = anyScriptSummary;
			for (const functionId of scc.functions) {
				current.set(
					functionId,
					semantics.derive(
						this.#program,
						functionId,
						local.get(functionId)!,
						targets,
						current,
						anyScriptSummary,
						summaryIds,
						reasons,
						false,
					),
				);
			}
			const memberQueue: Array<CoreCallGraphNode> = [];
			const memberQueued = new Uint8Array(this.#program.functionCapacity);
			let aggregateQueued = false;
			const enqueueMember = (node: CoreCallGraphNode): void => {
				if (node === CORE_ANY_SCRIPT_AGGREGATE) {
					if (aggregateQueued) return;
					aggregateQueued = true;
				} else {
					if (memberQueued[node] !== 0) return;
					memberQueued[node] = 1;
				}
				memberQueue.push(node);
			};
			if (scc.hasAnyScriptAggregate) enqueueMember(CORE_ANY_SCRIPT_AGGREGATE);
			for (const functionId of scc.functions) enqueueMember(functionId);
			for (let cursor = 0; cursor < memberQueue.length; cursor++) {
				const node = memberQueue[cursor]!;
				if (node === CORE_ANY_SCRIPT_AGGREGATE) {
					aggregateQueued = false;
					const nextAggregate = semantics.summarizeAggregate(
						current,
						maximumWildcardArgumentCount,
					);
					aggregateRecomputations++;
					if (semantics.sameAggregate(anyScriptSummary, nextAggregate)) continue;
					anyScriptSummary = nextAggregate;
					for (const caller of targets.graph.wildcardCallers) {
						wildcardReverseCallerVisits++;
						if (owner.get(caller) === sccIndex) enqueueMember(caller);
					}
					continue;
				}
				memberQueued[node] = 0;
				const next = semantics.derive(
					this.#program,
					node,
					local.get(node)!,
					targets,
					current,
					anyScriptSummary,
					summaryIds,
					reasons,
				);
				const prior = current.get(node);
				current.set(node, next);
				sccTransfers++;
				if (prior !== undefined && semantics.summariesEqual(prior, next)) continue;
				for (const caller of targets.graph.exactCallers(node)) {
					exactReverseCallerVisits++;
					if (owner.get(caller) === sccIndex) enqueueMember(caller);
				}
				if (scc.hasAnyScriptAggregate) enqueueMember(CORE_ANY_SCRIPT_AGGREGATE);
			}
			for (const functionId of scc.functions) {
				const next = current.get(functionId)!;
				const prior = previous?.published.get(functionId)?.summary;
				if (prior !== undefined && semantics.summariesEqual(prior, next)) continue;
				for (const caller of targets.graph.exactCallers(functionId)) {
					exactReverseCallerVisits++;
					const callerScc = owner.get(caller);
					if (callerScc === sccIndex) continue;
					if (enqueue(callerScc, CORE_PROGRAM_FLOW_SUMMARIES)) callerWakeups++;
					affectedCallers.add(caller);
				}
				if (targets.graph.hasAggregate()) {
					const aggregateScc = owner.get(CORE_ANY_SCRIPT_AGGREGATE);
					if (
						aggregateScc !== sccIndex &&
						enqueue(aggregateScc, CORE_PROGRAM_FLOW_SUMMARIES)
					) {
						callerWakeups++;
					}
				}
			}
			if (
				scc.hasAnyScriptAggregate &&
				!semantics.sameAggregate(aggregateBefore, anyScriptSummary)
			) {
				for (const caller of targets.graph.wildcardCallers) {
					wildcardReverseCallerVisits++;
					const callerScc = owner.get(caller);
					if (callerScc === sccIndex) continue;
					if (enqueue(callerScc, CORE_PROGRAM_FLOW_SUMMARIES)) callerWakeups++;
					affectedCallers.add(caller);
				}
			}
		});
		const published = new Map<CoreFunctionId, CoreProgramFlowPublishedFunctionSummary>();
		const changedPublished = new Set<CoreFunctionId>();
		for (const [functionId, summary] of current) {
			const prior = previous?.published.get(functionId);
			if (prior !== undefined && semantics.summariesEqual(prior.summary, summary)) {
				published.set(functionId, prior);
			} else {
				changedPublished.add(functionId);
				published.set(
					functionId,
					Object.freeze({
						version: (prior?.version ?? 0) + 1,
						summary,
					}),
				);
			}
		}
		const functionEffects = new Map(
			[...published.values()].map(({ summary }) => [summary.id, summary]),
		);
		const modules = semantics.moduleSummaries(this.#program, published, context);
		const statistics = Object.freeze({
			functions: local.size,
			functionsAnalyzed,
			functionsReused,
			sccs: sccs.length,
			sccTransfers,
			sccEdgeVisits,
			summaryChanges: changedPublished.size,
			callerWakeups,
			affectedCallers: affectedCallers.size,
			sccNodesAnalyzed,
			sccsReused,
			aggregateRecomputations,
			exactReverseCallerVisits,
			wildcardReverseCallerVisits,
		});
		return Object.freeze({
			sourceClosed: targets.sourceClosed,
			targets,
			sccs,
			local,
			published,
			rootReasons: reasons,
			anyScriptSummary,
			functionEffects,
			moduleEffects: modules,
			changedFunctions: changedPublished,
			statistics,
			summary(functionId: CoreFunctionId) {
				return published.get(functionId)?.summary;
			},
			version(functionId: CoreFunctionId) {
				return published.get(functionId)?.version ?? 0;
			},
		});
	}

	solveReachability<Targets extends CoreProgramFlowTargetIndex>(
		targets: Targets,
		context: CoreCompilationContext,
		previous?: CoreProgramFlowReachabilityState<Targets>,
		dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
	): CoreProgramFlowReachabilityState<Targets> {
		const functions = targets.graph.functions;
		const functionMembership = new Uint8Array(this.#program.functionCapacity);
		for (const functionId of functions) functionMembership[functionId] = 1;
		const bodyVersions = new Map(previous?.bodyVersions ?? []);
		const cfgVersions = new Map(previous?.cfgVersions ?? []);
		const structuralMasks = new Map(previous?.structuralMasks ?? []);
		const structural = new Map(previous?.structural ?? []);
		const structuralCallers = new Map(previous?.structuralCallers ?? []);
		const structurallyChanged: Array<CoreFunctionId> = [];
		const dataChanged =
			previous?.programDataVersion !== this.#program.programVersion("data");
		const dirtyMembership = new Uint8Array(this.#program.functionCapacity);
		if (previous === undefined || dataChanged) {
			for (const functionId of functions) dirtyMembership[functionId] = 1;
		} else {
			for (const functionId of dirtyFunctions ?? functions) {
				if (functionMembership[functionId] !== 0) dirtyMembership[functionId] = 1;
			}
			for (const functionId of functions) {
				if (!structuralMasks.has(functionId)) dirtyMembership[functionId] = 1;
			}
		}
		let functionsIndexed = 0;
		let structuralIndexEdges = 0;
		for (const functionId of functions) {
			if (dirtyMembership[functionId] === 0) continue;
			const fn = this.#program.function(functionId);
			const bodyVersion = fn.version("body") + 1;
			const cfgVersion = fn.version("cfg") + 1;
			if (
				!dataChanged &&
				bodyVersions.get(functionId) === bodyVersion &&
				cfgVersions.get(functionId) === cfgVersion
			)
				continue;
			const priorMasks = structuralMasks.get(functionId);
			const nextMasks = structuralReachabilityMasks(this.local(functionId));
			if (!sameNumericRows(priorMasks, nextMasks)) {
				for (const target of priorMasks?.keys() ?? []) {
					const callers = new Map(structuralCallers.get(target) ?? []);
					callers.delete(functionId);
					if (callers.size === 0) structuralCallers.delete(target);
					else structuralCallers.set(target, callers);
				}
				for (const [target, reasons] of nextMasks) {
					const callers = new Map(structuralCallers.get(target) ?? []);
					callers.set(functionId, reasons);
					structuralCallers.set(target, callers);
				}
				structuralMasks.set(functionId, nextMasks);
				structural.set(
					functionId,
					publicStructuralReachabilityEdges(nextMasks, structural.get(functionId)),
				);
				structurallyChanged.push(functionId);
			}
			bodyVersions.set(functionId, bodyVersion);
			cfgVersions.set(functionId, cfgVersion);
			functionsIndexed++;
			for (const reasons of nextMasks.values()) {
				if ((reasons & REACHABILITY_RUNTIME_IDENTITY) !== 0) structuralIndexEdges++;
				if ((reasons & REACHABILITY_INLINE_SOURCE) !== 0) structuralIndexEdges++;
			}
		}
		for (const functionId of previous?.structuralMasks.keys() ?? []) {
			if (functionMembership[functionId] !== 0) continue;
			for (const target of structuralMasks.get(functionId)?.keys() ?? []) {
				const callers = new Map(structuralCallers.get(target) ?? []);
				callers.delete(functionId);
				if (callers.size === 0) structuralCallers.delete(target);
				else structuralCallers.set(target, callers);
			}
			structuralMasks.delete(functionId);
			structural.delete(functionId);
			bodyVersions.delete(functionId);
			cfgVersions.delete(functionId);
		}

		const rootState = coreProgramFlowReachabilityRoots(this.#program, targets, context);
		const roots = new Map(
			[...rootState.masks].map(([functionId, reasons]) => [
				functionId,
				reachabilityReasonSet(reasons, previous?.roots.get(functionId)),
			]),
		);
		const affected = new Uint8Array(this.#program.functionCapacity);
		const closureQueue: Array<CoreFunctionId> = [];
		const markAffected = (functionId: CoreFunctionId): void => {
			if (functionMembership[functionId] === 0 || affected[functionId] !== 0) return;
			affected[functionId] = 1;
			closureQueue.push(functionId);
		};
		if (previous === undefined) {
			for (const functionId of functions) markAffected(functionId);
		} else {
			const previousFunctionMembership = new Uint8Array(this.#program.functionCapacity);
			for (const functionId of previous.targets.graph.functions) {
				previousFunctionMembership[functionId] = 1;
			}
			const previousAggregateReached = previous.targets.graph.wildcardCallers.some(
				(functionId) => previous.executable.has(functionId),
			);
			for (const functionId of functions) {
				if (
					(previous.rootMasks.get(functionId) ?? 0) !==
					(rootState.masks.get(functionId) ?? 0)
				) {
					markAffected(functionId);
				}
				if (previousAggregateReached && previousFunctionMembership[functionId] === 0) {
					markAffected(functionId);
				}
			}
			for (const functionId of targets.changedEdgeCallers) {
				if (previous.executable.has(functionId) || rootState.masks.has(functionId)) {
					markAffected(functionId);
				}
			}
			for (const functionId of structurallyChanged) {
				if (previous.executable.has(functionId) || rootState.masks.has(functionId)) {
					markAffected(functionId);
				}
			}
			for (const functionId of previous.executable) {
				if (functionMembership[functionId] !== 0) continue;
				for (const callee of previous.targets.graph.exactOutgoing(functionId)) {
					markAffected(callee);
				}
				for (const target of previous.structuralMasks.get(functionId)?.keys() ?? []) {
					markAffected(target);
				}
			}
		}
		for (let cursor = 0; cursor < closureQueue.length; cursor++) {
			const functionId = closureQueue[cursor]!;
			for (const graph of [targets.graph, previous?.targets.graph]) {
				if (graph === undefined) continue;
				for (const callee of graph.exactOutgoing(functionId)) markAffected(callee);
				if (graph.isWildcardCaller(functionId)) {
					for (const callee of graph.functions) markAffected(callee);
				}
			}
			for (const rows of [
				structuralMasks.get(functionId),
				previous?.structuralMasks.get(functionId),
			]) {
				for (const target of rows?.keys() ?? []) markAffected(target);
			}
		}

		const executableMarks = new Uint8Array(this.#program.functionCapacity);
		const reasonMasks = new Uint16Array(this.#program.functionCapacity);
		if (previous !== undefined) {
			for (const functionId of previous.executable) {
				if (functionMembership[functionId] === 0 || affected[functionId] !== 0) continue;
				executableMarks[functionId] = 1;
				reasonMasks[functionId] = reachabilityReasonMask(
					previous.reasons.get(functionId),
				);
			}
		}
		const topology = this.topology(targets.graph);
		const pendingFunctions = new Uint8Array(this.#program.functionCapacity);
		const seedSccMembership = new Uint8Array(topology.sccs.length);
		const seedSccs: Array<CoreProgramFlowSccSeed> = [];
		const seed = (functionId: CoreFunctionId, reasons: number): void => {
			if (affected[functionId] === 0 || reasons === 0) return;
			reasonMasks[functionId] = reasonMasks[functionId]! | reasons;
			if (executableMarks[functionId] !== 0) return;
			executableMarks[functionId] = 1;
			pendingFunctions[functionId] = 1;
			const scc = topology.owner.get(functionId);
			if (scc === undefined || seedSccMembership[scc] !== 0) return;
			seedSccMembership[scc] = 1;
			seedSccs.push({ scc, dimensions: CORE_PROGRAM_FLOW_REACHABILITY });
		};
		let outsideWildcardReached = false;
		for (const caller of targets.graph.wildcardCallers) {
			if (affected[caller] === 0 && executableMarks[caller] !== 0) {
				outsideWildcardReached = true;
				break;
			}
		}
		for (const functionId of functions) {
			if (affected[functionId] === 0) continue;
			let reasons = rootState.masks.get(functionId) ?? 0;
			for (const caller of targets.graph.exactCallers(functionId)) {
				if (affected[caller] === 0 && executableMarks[caller] !== 0) {
					reasons |= REACHABILITY_FINITE_CALL;
				}
			}
			for (const [caller, edgeReasons] of structuralCallers.get(functionId) ?? []) {
				if (affected[caller] === 0 && executableMarks[caller] !== 0) {
					reasons |= edgeReasons;
				}
			}
			if (outsideWildcardReached) reasons |= REACHABILITY_ANY_SCRIPT;
			seed(functionId, reasons);
		}

		let aggregateReached = outsideWildcardReached;
		let functionsScanned = 0;
		let exactCallEdgesFollowed = 0;
		let wildcardCallerVisits = 0;
		let aggregateDependencyVisits = 0;
		let structuralEdgesFollowed = 0;
		this.solveSccs(topology, seedSccs, (sccIndex, dimensions, enqueueScc) => {
			if ((dimensions & CORE_PROGRAM_FLOW_REACHABILITY) === 0) return;
			const queue: Array<CoreFunctionId> = [];
			for (const functionId of topology.sccs[sccIndex]!.functions) {
				if (pendingFunctions[functionId] === 0) continue;
				pendingFunctions[functionId] = 0;
				queue.push(functionId);
			}
			const enter = (functionId: CoreFunctionId, reasons: number): void => {
				if (affected[functionId] === 0) return;
				reasonMasks[functionId] = reasonMasks[functionId]! | reasons;
				if (executableMarks[functionId] !== 0) return;
				executableMarks[functionId] = 1;
				const targetScc = topology.owner.get(functionId);
				if (targetScc === undefined) return;
				if (targetScc === sccIndex) queue.push(functionId);
				else {
					pendingFunctions[functionId] = 1;
					enqueueScc(targetScc, CORE_PROGRAM_FLOW_REACHABILITY);
				}
			};
			for (let cursor = 0; cursor < queue.length; cursor++) {
				const functionId = queue[cursor]!;
				functionsScanned++;
				for (const callee of targets.graph.exactOutgoing(functionId)) {
					exactCallEdgesFollowed++;
					enter(callee, REACHABILITY_FINITE_CALL);
				}
				if (targets.graph.isWildcardCaller(functionId)) {
					wildcardCallerVisits++;
					if (!aggregateReached) {
						aggregateReached = true;
						for (const callee of functions) {
							aggregateDependencyVisits++;
							enter(callee, REACHABILITY_ANY_SCRIPT);
						}
					}
				}
				for (const [target, edgeReasons] of structuralMasks.get(functionId) ?? []) {
					structuralEdgesFollowed +=
						((edgeReasons & REACHABILITY_RUNTIME_IDENTITY) !== 0 ? 1 : 0) +
						((edgeReasons & REACHABILITY_INLINE_SOURCE) !== 0 ? 1 : 0);
					enter(target, edgeReasons);
				}
			}
		});

		const executable = new Set<CoreFunctionId>();
		const reasons = new Map<
			CoreFunctionId,
			ReadonlySet<CoreProgramFlowReachabilityReason>
		>();
		for (const functionId of functions) {
			if (executableMarks[functionId] === 0) continue;
			executable.add(functionId);
			reasons.set(
				functionId,
				reachabilityReasonSet(
					reasonMasks[functionId]!,
					previous?.reasons.get(functionId),
				),
			);
		}
		let resultSetUpdates = 0;
		for (const functionId of functions) {
			if (
				(previous?.executable.has(functionId) ?? false) !== executable.has(functionId)
			) {
				resultSetUpdates++;
			}
		}
		for (const functionId of previous?.executable ?? []) {
			if (functionMembership[functionId] === 0) resultSetUpdates++;
		}
		const stableExecutable =
			previous !== undefined && sameFunctionIds(previous.executable, executable);
		const finalExecutable = stableExecutable ? previous.executable : executable;
		const computedDead = new Set(
			functions.filter((functionId) => !executable.has(functionId)),
		);
		const dead =
			previous !== undefined && sameFunctionIds(previous.dead, computedDead)
				? previous.dead
				: computedDead;
		const liveFunctions = stableExecutable
			? previous.liveFunctions
			: Object.freeze([...executable].sort((left, right) => left - right));
		return Object.freeze({
			executable: finalExecutable,
			retained: finalExecutable,
			dead,
			liveFunctions,
			reasons,
			sourceClosed: targets.sourceClosed,
			bodyVersions,
			cfgVersions,
			programDataVersion: this.#program.programVersion("data"),
			structural,
			structuralMasks,
			structuralCallers,
			roots,
			rootMasks: rootState.masks,
			targets,
			statistics: Object.freeze({
				functions: functions.length,
				functionsIndexed,
				structuralIndexEdges,
				hostInstallSlotsRead: rootState.hostInstallSlotsRead,
				functionsScanned,
				exactCallEdgesFollowed,
				wildcardCallerVisits,
				aggregateDependencyVisits,
				structuralEdgesFollowed,
				resultSetUpdates,
				deadFunctions: dead.size,
			}),
		});
	}

	#invalidateLocalTransfers(): void {
		const dataVersion = this.#program.programVersion("data");
		const sourcePositionsVersion = this.#program.programVersion("sourcePositions");
		if (
			dataVersion !== this.#localDataVersion ||
			sourcePositionsVersion !== this.#localSourcePositionsVersion
		) {
			this.#localTransfers.length = 0;
			this.#localDataVersion = dataVersion;
			this.#localSourcePositionsVersion = sourcePositionsVersion;
		}
		const revision = this.#program.programFlowRevision;
		for (let cursor = this.#localRevision; cursor < revision; cursor++) {
			if (
				(this.#program.programFlowDomainMaskAt(cursor) &
					(CORE_PROGRAM_FLOW_BODY | CORE_PROGRAM_FLOW_CALLS)) ===
				0
			)
				continue;
			this.#localTransfers[this.#program.programFlowFunctionAt(cursor)] = undefined;
		}
		this.#localRevision = revision;
	}
}
