import type {
	FunctionEffectSummary,
	ModuleEffectSummary,
	SummaryRootReason,
} from "../shared/effect-summary.ts";
import { CORE_ANY_SCRIPT_AGGREGATE, updateCoreCallGraph } from "./core-call-graph.ts";
import type { CoreCallGraph, CoreCallGraphNode } from "./core-call-graph.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { joinCoreHeapBrands } from "./core-heap-brands.ts";
import type { CoreHeapBrandState } from "./core-heap-brands.ts";
import type { CoreControlEdge, CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import {
	sameCoreRecordValueKind,
	joinCoreRecordValueKinds,
	coreRecordFieldInitialKind,
	coreRecordFieldInitialHeapBrand,
	coreRecordAccessInitialFields,
	coreRecordAccessProducerFields,
} from "./core-record-value-kinds.ts";
import type {
	CoreRecordValueKind,
	CoreRecordFieldAccess,
} from "./core-record-value-kinds.ts";
import {
	CORE_PROGRAM_FLOW_BODY,
	CORE_PROGRAM_FLOW_CALLS,
	CORE_PROGRAM_FLOW_CFG,
	CORE_PROGRAM_FLOW_EXCEPTION,
	CORE_PROGRAM_FLOW_NORMAL_RESULTS,
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
	| "source-builtin"
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
	publishedFunctions(functionId: CoreFunctionId): ReadonlyArray<CoreFunctionId>;
	globalStoreTargets(slot: number): {
		readonly functions: ReadonlyArray<CoreFunctionId>;
		readonly anyScript: boolean;
	};
	outgoing(functionId: CoreFunctionId): ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly receiver?: CoreValueId;
		readonly arguments?: ReadonlyArray<CoreValueId>;
		readonly targets: {
			readonly functions: ReadonlyArray<CoreFunctionId>;
			readonly anyScript: boolean;
			readonly opaque: boolean;
		};
	}>;
}

interface CoreProgramFlowKindInputs {
	readonly parameterKinds: ReadonlyArray<number>;
	readonly receiverKind: number;
}

export interface CoreProgramFlowValueKindSummary extends CoreProgramFlowKindInputs {
	readonly returnKind: number;
	readonly returnRecord?: CoreRecordValueKind;
	readonly returnHeapBrand?: CoreHeapBrandState;
}

export interface CoreProgramFlowValueKindStatistics {
	readonly functions: number;
	readonly functionsEvaluated: number;
	readonly functionsReused: number;
	readonly affectedFunctions: number;
	readonly callerWakeups: number;
	readonly calleeWakeups: number;
	readonly aggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
	readonly aggregateFunctionVisits: number;
}

export interface CoreProgramFlowValueKinds<Analysis> {
	readonly changedFunctions: ReadonlySet<CoreFunctionId>;
	readonly statistics: CoreProgramFlowValueKindStatistics;
	values(functionId: CoreFunctionId): Analysis;
	summary(functionId: CoreFunctionId): CoreProgramFlowValueKindSummary;
}

/**
 * What a call to any script function may return. Its arguments need no aggregate:
 * every function such a call can reach is externally reachable, so its parameters
 * are already unknown.
 */
export interface CoreProgramFlowValueKindAggregate {
	readonly returnKind: number;
	readonly returnHeapBrand?: CoreHeapBrandState;
}

export interface CoreProgramFlowValueKindState<
	Analysis,
	Targets extends CoreProgramFlowTargetIndex = CoreProgramFlowTargetIndex,
> extends CoreProgramFlowValueKinds<Analysis> {
	readonly sourceClosed: boolean;
	readonly dataEpoch: number;
	readonly targets: Targets;
	readonly external: ReadonlyMap<CoreFunctionId, boolean>;
	readonly boundaryInputs: ReadonlyMap<CoreFunctionId, CoreProgramFlowKindInputs>;
	readonly valueAnalyses: ReadonlyMap<CoreFunctionId, Analysis>;
	readonly summaries: ReadonlyMap<CoreFunctionId, CoreProgramFlowValueKindSummary>;
	readonly anyScriptAggregate: CoreProgramFlowValueKindAggregate | undefined;
}

export interface CoreValueAlternative {
	readonly value: CoreValueId;
	readonly instruction: CoreInstructionId;
	/** Carries predecessor-local facts without moving the originating operation. */
	readonly edge?: CoreControlEdge;
}

export interface CoreValueAlternatives {
	readonly values: ReadonlyArray<CoreValueAlternative>;
	/** A definite overwrite can remove every initial value without making the producer empty. */
	readonly hasNormalResult: boolean;
}

export interface CoreProgramFlowValueKindInputs {
	readonly context?: CoreCompilationContext;
	readonly operationResultHeapBrand?: (
		instruction: CoreInstructionId,
	) => CoreHeapBrandState;
	readonly demandedValues: ReadonlyArray<CoreValueId>;
	readonly parameterMasks?: ReadonlyArray<number>;
	readonly receiverMask?: number;
	readonly operationResultMask?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => number | undefined;
	readonly operationResultAlternatives?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => CoreValueAlternatives | undefined;
	readonly elementLoadMask?: (instruction: CoreInstructionId) => number | undefined;
}

export interface CoreProgramFlowValueKindSemantics<Analysis> {
	observationValues(
		program: CoreProgram,
		fn: CoreFunctionStore,
	): ReadonlyArray<CoreValueId>;
	analyze(
		program: CoreProgram,
		fn: CoreFunctionStore,
		controlFlow: CoreControlFlow,
		inputs: CoreProgramFlowValueKindInputs,
	): Analysis;
	latticeMask(analysis: Analysis, value: CoreValueId): number;
	heapBrand(analysis: Analysis, value: CoreValueId): CoreHeapBrandState;
	recordReads(
		fn: CoreFunctionStore,
		control: () => CoreControlFlow,
	): ReadonlyMap<CoreInstructionId, CoreRecordFieldAccess>;
	returnRecord(
		program: CoreProgram,
		fn: CoreFunctionStore,
		controlFlow: CoreControlFlow,
		analysis: Analysis,
		call: (instruction: CoreInstructionId) => CoreRecordValueKind,
	): CoreRecordValueKind;
	readonly top: number;
	readonly object: number;
	readonly undefined: number;
}

export interface CoreProgramFlowCallTargets {
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
}

export interface CoreProgramFlowIndexedCallSite<
	Targets extends CoreProgramFlowCallTargets = CoreProgramFlowCallTargets,
> {
	readonly instruction: CoreInstructionId;
	readonly receiver?: CoreValueId;
	readonly arguments?: ReadonlyArray<CoreValueId>;
	readonly targets: Targets;
}

export interface CoreProgramFlowFunctionCellAccesses {
	readonly reads: ReadonlySet<number>;
	readonly writes: ReadonlySet<number>;
	/** Cells whose every writer is visible once this function exists, in a closed source. */
	readonly closes?: ReadonlySet<number>;
}

export interface CoreProgramFlowLocalCallTargets<
	Targets extends CoreProgramFlowCallTargets,
	Site extends CoreProgramFlowIndexedCallSite<Targets>,
> {
	readonly function: CoreFunctionId;
	readonly values: ReadonlyArray<Targets>;
	readonly returnTargets: Targets;
	readonly returnRecord?: CoreRecordValueKind;
	readonly returnInputs: ReadonlyMap<CoreFunctionId, Targets>;
	readonly sites: ReadonlyArray<Site>;
	readonly invocationDependencies: ReadonlyArray<Targets>;
	readonly publishedFunctions: ReadonlyArray<CoreFunctionId>;
	readonly cellWrites: ReadonlyMap<number, Targets>;
	readonly propertyInputs: ReadonlyMap<number, Targets>;
	readonly globalWrites: ReadonlyMap<number, Targets>;
}

export interface CoreProgramFlowCallTargetStatistics {
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

export interface CoreProgramFlowCallTargetState<
	Local extends CoreProgramFlowLocalCallTargets<Targets, Site>,
	Targets extends CoreProgramFlowCallTargets,
	Site extends CoreProgramFlowIndexedCallSite<Targets>,
	Identities,
> extends CoreProgramFlowTargetIndex {
	readonly identities: Identities;
	readonly statistics: CoreProgramFlowCallTargetStatistics;
	readonly changedCallSites: ReadonlyArray<Site>;
	readonly local: ReadonlyMap<CoreFunctionId, Local>;
	readonly cells: ReadonlyMap<number, Targets>;
	readonly cellAccesses: ReadonlyMap<CoreFunctionId, CoreProgramFlowFunctionCellAccesses>;
	readonly propertyWrites: ReadonlyMap<CoreFunctionId, ReadonlyMap<number, Targets>>;
	readonly propertyWriters: ReadonlyMap<number, ReadonlyMap<CoreFunctionId, Targets>>;
	readonly properties: ReadonlyMap<number, Targets>;
	readonly propertyReaders: ReadonlyMap<number, ReadonlySet<CoreFunctionId>>;
	readonly cellReaders: ReadonlyMap<number, ReadonlySet<CoreFunctionId>>;
	readonly cellWriters: ReadonlyMap<number, ReadonlyMap<CoreFunctionId, Targets>>;
	readonly globalStoreWriters: ReadonlyMap<number, ReadonlyMap<CoreFunctionId, Targets>>;
	readonly globalStores: ReadonlyMap<number, Targets>;
	readonly sites: ReadonlyMap<CoreFunctionId, ReadonlyMap<CoreInstructionId, Site>>;
	readonly outgoingIndex: ReadonlyMap<CoreFunctionId, ReadonlyArray<Site>>;
	readonly returnGraph: CoreCallGraph;
	readonly returnTopology: CoreProgramFlowTopology;
	targets(functionId: CoreFunctionId, value: CoreValueId): Targets;
	returnTargets(functionId: CoreFunctionId): Targets;
	globalStoreTargets(slot: number): Targets;
	site(functionId: CoreFunctionId, instruction: CoreInstructionId): Site | undefined;
	outgoing(functionId: CoreFunctionId): ReadonlyArray<Site>;
}

export interface CoreProgramFlowCallTargetSemantics<
	Local extends CoreProgramFlowLocalCallTargets<Targets, Site>,
	Targets extends CoreProgramFlowCallTargets,
	Site extends CoreProgramFlowIndexedCallSite<Targets>,
	Identities,
> {
	createIdentities(previous?: Identities): Identities;
	localIsCurrent(
		local: Local | undefined,
		fn: CoreFunctionStore,
		program: CoreProgram,
	): boolean;
	collectCellAccesses(
		program: CoreProgram,
		fn: CoreFunctionStore,
		transfers: CoreProgramFlowLocalTransfers,
		identities: Identities,
	): CoreProgramFlowFunctionCellAccesses;
	collectPropertyWrites(
		fn: CoreFunctionStore,
		functionCapacity: number,
		transfers: CoreProgramFlowLocalTransfers,
		identities: Identities,
	): ReadonlyMap<number, Targets>;
	closedCells(
		program: CoreProgram,
		context: CoreCompilationContext | undefined,
		identities: Identities,
	): ReadonlySet<number>;
	/** Values closed cells hold before any Core store, where that is not bottom. */
	initialCells?(
		program: CoreProgram,
		context: CoreCompilationContext | undefined,
		identities: Identities,
	): ReadonlyMap<number, Targets>;
	analyzeLocal(
		program: CoreProgram,
		fn: CoreFunctionStore,
		controlFlow: CoreControlFlow,
		cells: ReadonlyMap<number, Targets>,
		trackedCells: ReadonlySet<number>,
		properties: ReadonlyMap<number, Targets>,
		transfers: CoreProgramFlowLocalTransfers,
		identities: Identities,
		returnSummary: (
			functionId: CoreFunctionId,
		) =>
			| { readonly returnTargets: Targets; readonly returnRecord?: CoreRecordValueKind }
			| undefined,
	): Local;
	callSiteEqual(left: Site, right: Site): boolean;
	join(left: Targets, right: Targets): Targets;
	equal(left: Targets, right: Targets): boolean;
	isBottom(targets: Targets): boolean;
	readonly bottom: Targets;
	readonly opaque: Targets;
	readonly open: Targets;
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
const REACHABILITY_SOURCE_BUILTIN = 1 << 8;

const REACHABILITY_REASON_BITS: ReadonlyArray<
	readonly [number, CoreProgramFlowReachabilityReason]
> = [
	[REACHABILITY_PROGRAM_ENTRY, "program-entry"],
	[REACHABILITY_COMMONJS_MODULE, "commonjs-module"],
	[REACHABILITY_SOURCE_BUILTIN, "source-builtin"],
	[REACHABILITY_HOST_INSTALL, "host-install"],
	[REACHABILITY_OPEN_WORLD, "open-world"],
	[REACHABILITY_FINITE_CALL, "finite-call"],
	[REACHABILITY_ANY_SCRIPT, "any-script"],
	[REACHABILITY_RUNTIME_IDENTITY, "runtime-identity"],
	[REACHABILITY_INLINE_SOURCE, "inline-source"],
];

const FUNCTION_INDEX_ATTRIBUTES = [
	"functionIndex",
	"methodFunctionIndex",
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
	// IDs only append within a generation; Infinity means every structural target exists.
	readonly nextUnresolvedFunction: number;
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
		nextUnresolvedFunction: number,
	) {
		this.instructionVisits = instructionVisits;
		this.nextUnresolvedFunction = nextUnresolvedFunction;
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
	if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)
		return;
	const target = candidate as CoreFunctionId;
	if (!program.hasFunction(target)) {
		targets.set(target, 0);
		return;
	}
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
		const descriptor = fn.instructionHeader(instruction);
		if (typeof descriptor === "string") continue;
		operations.push(instruction);
		if (descriptor.callTransfer !== undefined) calls.push(instruction);
		const opcode = descriptor.opcode;
		if (
			opcode === "loadGlobal" ||
			opcode === "storeGlobal" ||
			opcode === "loadGlobalProperty" ||
			opcode === "storeGlobalProperty" ||
			opcode === "loadCaptured" ||
			opcode === "storeCaptured"
		) {
			cellAccesses.push(instruction);
		}
		if (opcode === "defineProperty" || opcode === "storePropertyStatic") {
			propertyDefinitions.push(instruction);
		}
		const attributes = fn.kernel.instructionAttributes(instruction);
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
	const structuralTargets: Array<CoreFunctionId> = [];
	let nextUnresolvedFunction = Infinity;
	for (const target of structural.keys()) {
		if (structural.get(target) === 0)
			nextUnresolvedFunction = Math.min(nextUnresolvedFunction, target);
		else structuralTargets.push(target);
	}
	structuralTargets.sort((left, right) => left - right);
	return new CoreProgramFlowLocalTransfers(
		instructionVisits,
		operations,
		calls,
		cellAccesses,
		propertyDefinitions,
		structuralTargets,
		structuralTargets.map((target) => structural.get(target)!),
		nextUnresolvedFunction,
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
		for (const provider of context.data.sourceBuiltinProviders ?? [])
			enter(provider.functionIndex, REACHABILITY_SOURCE_BUILTIN);
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
	if ((domains & CORE_PROGRAM_FLOW_NORMAL_RESULTS) !== 0)
		dimensions |= CORE_PROGRAM_FLOW_RETURN_KIND;
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

function joinCallTargetWrites<Targets>(
	earlier: ReadonlyMap<number, Targets>,
	later: ReadonlyMap<number, Targets>,
	join: (left: Targets, right: Targets) => Targets,
): ReadonlyMap<number, Targets> {
	const joined = new Map(earlier);
	for (const [key, targets] of later) {
		const prior = joined.get(key);
		joined.set(key, prior === undefined ? targets : join(prior, targets));
	}
	return joined;
}

function mutableCallTargetWriters<Targets>(
	index: Map<number, ReadonlyMap<CoreFunctionId, Targets>>,
	previous: ReadonlyMap<number, ReadonlyMap<CoreFunctionId, Targets>> | undefined,
	key: number,
): Map<CoreFunctionId, Targets> {
	const writers = index.get(key);
	// Rows borrowed from the preceding solve stay immutable; all other rows are ours.
	if (writers !== undefined && writers !== previous?.get(key))
		return writers as Map<CoreFunctionId, Targets>;
	const owned = new Map(writers);
	index.set(key, owned);
	return owned;
}

function mutableCallTargetReaders(
	index: Map<number, ReadonlySet<CoreFunctionId>>,
	previous: ReadonlyMap<number, ReadonlySet<CoreFunctionId>> | undefined,
	key: number,
): Set<CoreFunctionId> {
	const readers = index.get(key);
	if (readers !== undefined && readers !== previous?.get(key))
		return readers as Set<CoreFunctionId>;
	const owned = new Set(readers);
	index.set(key, owned);
	return owned;
}

interface LocalTransferEntry {
	readonly body: number;
	readonly calls: number;
	readonly transfers: CoreProgramFlowLocalTransfers;
}

interface LocalTransferStore {
	generation: number;
	dataEpoch: number;
	entries: WeakMap<CoreFunctionStore, LocalTransferEntry>;
}

const localTransferStores = new WeakMap<CoreProgram, LocalTransferStore>();

export class CoreProgramFlowEngine {
	readonly #program: CoreProgram;
	readonly #report: CoreOptimizationReportBuilder | undefined;
	readonly #epoch = new CoreProgramFlowEpoch();
	readonly #localTransfers: LocalTransferStore;
	readonly #functionWorklist = new CoreProgramFlowFunctionWorklist();
	readonly #sccWorklist = new CoreProgramFlowSccWorklist();
	#topology: CoreProgramFlowTopology | undefined;
	#reportedRevision = 0;

	constructor(program: CoreProgram, report?: CoreOptimizationReportBuilder) {
		this.#program = program;
		this.#report = report;
		let store = localTransferStores.get(program);
		if (store === undefined) {
			store = {
				generation: program.generation,
				dataEpoch: program.dataEpoch,
				entries: new WeakMap(),
			};
			localTransferStores.set(program, store);
		}
		this.#localTransfers = store;
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
		const store = this.#localTransfers;
		if (
			store.generation !== this.#program.generation ||
			store.dataEpoch !== this.#program.dataEpoch
		) {
			store.entries = new WeakMap();
			store.generation = this.#program.generation;
			store.dataEpoch = this.#program.dataEpoch;
			this.#report?.increment("programFlowTransferEpochResets");
		}
		const fn = this.#program.function(functionId);
		const body = fn.version("body"),
			calls = fn.version("calls");
		const current = store.entries.get(fn);
		if (
			current !== undefined &&
			current.body === body &&
			current.calls === calls &&
			this.#program.functionCapacity <= current.transfers.nextUnresolvedFunction
		) {
			this.#report?.increment("programFlowTransferReuses");
			return current.transfers;
		}
		if (current !== undefined)
			this.#report?.increment(
				current.body !== body
					? "programFlowTransferBodyRebuilds"
					: current.calls !== calls
						? "programFlowTransferCallRebuilds"
						: "programFlowTransferMembershipRebuilds",
			);
		const next =
			this.#report?.measureOwner(CORE_OPTIMIZATION_OWNER.programFlowLocalExtraction, () =>
				extractCoreProgramFlowLocalTransfers(this.#program, fn),
			) ?? extractCoreProgramFlowLocalTransfers(this.#program, fn);
		this.#report?.recordOwnerWork(
			CORE_OPTIMIZATION_OWNER.programFlowLocalExtraction,
			next.instructionVisits,
		);
		store.entries.set(fn, { body, calls, transfers: next });
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

	solveCallTargets<
		Local extends CoreProgramFlowLocalCallTargets<Targets, Site>,
		Targets extends CoreProgramFlowCallTargets,
		Site extends CoreProgramFlowIndexedCallSite<Targets>,
		Identities,
	>(
		sourceClosed: boolean,
		controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
		semantics: CoreProgramFlowCallTargetSemantics<Local, Targets, Site, Identities>,
		previous?: CoreProgramFlowCallTargetState<Local, Targets, Site, Identities>,
		context?: CoreCompilationContext,
		dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
	): CoreProgramFlowCallTargetState<Local, Targets, Site, Identities> {
		const functionIds = [...this.#program.functionIds()];
		const functionSet = new Set(functionIds);
		const identities = semantics.createIdentities(previous?.identities);
		const cellAccesses = new Map(previous?.cellAccesses ?? []);
		const propertyWrites = new Map(previous?.propertyWrites ?? []);
		const propertyWriters = new Map(previous?.propertyWriters ?? []);
		const cellReaders = new Map(previous?.cellReaders ?? []);
		const changedFunctions = new Set<CoreFunctionId>();
		const propertyKeys = new Set<number>();
		let accessFunctionsScanned = 0;
		for (const functionId of previous === undefined
			? functionIds
			: (dirtyFunctions ?? functionIds)) {
			if (!functionSet.has(functionId)) continue;
			const fn = this.#program.function(functionId);
			const prior = previous?.local.get(functionId);
			if (semantics.localIsCurrent(prior, fn, this.#program)) continue;
			changedFunctions.add(functionId);
			accessFunctionsScanned++;
			const oldAccess = cellAccesses.get(functionId);
			const transfers = this.local(functionId);
			const nextAccess = semantics.collectCellAccesses(
				this.#program,
				fn,
				transfers,
				identities,
			);
			cellAccesses.set(functionId, nextAccess);
			for (const key of new Set([...(oldAccess?.reads ?? []), ...nextAccess.reads])) {
				const readers = mutableCallTargetReaders(cellReaders, previous?.cellReaders, key);
				readers.delete(functionId);
				if (nextAccess.reads.has(key)) readers.add(functionId);
				if (readers.size === 0) cellReaders.delete(key);
			}

			const oldWrites = propertyWrites.get(functionId) ?? new Map<number, Targets>();
			const nextWrites = semantics.collectPropertyWrites(
				fn,
				this.#program.functionCapacity,
				transfers,
				identities,
			);
			propertyWrites.set(functionId, nextWrites);
			for (const key of new Set([...oldWrites.keys(), ...nextWrites.keys()])) {
				propertyKeys.add(key);
				const writers = mutableCallTargetWriters(
					propertyWriters,
					previous?.propertyWriters,
					key,
				);
				writers.delete(functionId);
				const next = nextWrites.get(key);
				if (next !== undefined) writers.set(functionId, next);
				if (writers.size === 0) propertyWriters.delete(key);
			}
		}
		for (const functionId of previous?.local.keys() ?? []) {
			if (functionSet.has(functionId)) continue;
			const access = cellAccesses.get(functionId);
			for (const key of access?.reads ?? []) {
				const readers = mutableCallTargetReaders(cellReaders, previous?.cellReaders, key);
				readers.delete(functionId);
				if (readers.size === 0) cellReaders.delete(key);
			}
			for (const key of propertyWrites.get(functionId)?.keys() ?? []) {
				propertyKeys.add(key);
				const writers = mutableCallTargetWriters(
					propertyWriters,
					previous?.propertyWriters,
					key,
				);
				writers.delete(functionId);
				if (writers.size === 0) propertyWriters.delete(key);
			}
			cellAccesses.delete(functionId);
			propertyWrites.delete(functionId);
		}
		const joinContributions = <Key>(
			contributions: ReadonlyMap<Key, Targets> | undefined,
		): Targets => {
			let result = semantics.bottom;
			for (const targets of contributions?.values() ?? []) {
				result = semantics.join(result, targets);
			}
			return result;
		};
		const knownFunctionProperties = new Map(previous?.properties ?? []);
		let propertyAggregateUpdates = 0;
		for (const key of propertyKeys) {
			propertyAggregateUpdates++;
			const next = joinContributions(propertyWriters.get(key));
			if (semantics.isBottom(next)) knownFunctionProperties.delete(key);
			else knownFunctionProperties.set(key, next);
		}

		const local = new Map<CoreFunctionId, Local>();
		for (const functionId of functionIds) {
			const fn = this.#program.function(functionId);
			const prior = previous?.local.get(functionId);
			if (semantics.localIsCurrent(prior, fn, this.#program)) {
				local.set(functionId, prior!);
			} else {
				changedFunctions.add(functionId);
			}
		}
		const propertyReaders = new Map(previous?.propertyReaders ?? []);
		for (const key of propertyKeys) {
			for (const reader of propertyReaders.get(key) ?? []) changedFunctions.add(reader);
		}
		const closedCells = new Set(
			semantics.closedCells(this.#program, context, identities),
		);
		if (sourceClosed && context?.facts.closure.sourceClosure.kind === "known")
			for (const access of cellAccesses.values())
				for (const key of access.closes ?? []) closedCells.add(key);
		const initialCells =
			semantics.initialCells?.(this.#program, context, identities) ??
			new Map<number, Targets>();
		const trackedCells = new Set(closedCells);
		for (const access of cellAccesses.values()) {
			for (const key of access.reads) trackedCells.add(key);
			for (const key of access.writes) trackedCells.add(key);
		}
		// Readers rerun only when a cell they read changes. Reseeding every transitive reader
		// of a changed writer reran nearly the whole program once parameter cells linked
		// each caller to its callees, while any reached state is already a post-fixpoint.
		const affectedFunctions = new Set(changedFunctions);
		const resetReturnComponents = new Set<string>();
		if (previous !== undefined) {
			for (const functionId of changedFunctions) {
				const owner = previous.returnTopology.owner.get(functionId);
				if (owner === undefined) continue;
				const component = previous.returnTopology.sccs[owner]!;
				if (
					component.functions.length === 1 &&
					!previous.returnGraph.exactOutgoing(functionId).includes(functionId)
				)
					continue;
				// Recursive returns restart at bottom so an old bound cannot certify itself.
				for (const member of component.functions) affectedFunctions.add(member);
				resetReturnComponents.add(component.id);
			}
		}
		const returnReaders = new Map<CoreFunctionId, Set<CoreFunctionId>>();
		const mutableReturnReaders = (target: CoreFunctionId): Set<CoreFunctionId> => {
			let readers = returnReaders.get(target);
			if (readers === undefined) {
				readers = new Set(previous?.returnGraph.exactCallers(target));
				returnReaders.set(target, readers);
			}
			return readers;
		};

		const cellWriters = new Map(previous?.cellWriters ?? []);
		const globalStoreWriters = new Map(previous?.globalStoreWriters ?? []);
		const cells = new Map(previous?.cells ?? []);
		const globalStores = new Map(previous?.globalStores ?? []);
		const cellKeys = new Set<number>();
		const globalSlots = new Set<number>();
		// Keys whose aggregate already joins every current writer contribution. A writer rerun
		// that leaves its contribution untouched cannot change such an aggregate, so it skips
		// refolding the contributions of the key's other writers.
		const syncedCells = new Set<number>();
		const syncedGlobalSlots = new Set<number>();
		const removeLocalContributions = (
			functionId: CoreFunctionId,
			entry: Local | undefined,
		): void => {
			if (entry === undefined) return;
			for (const target of entry.returnInputs.keys())
				mutableReturnReaders(target).delete(functionId);
			for (const key of entry.cellWrites.keys()) {
				cellKeys.add(key);
				const writers = mutableCallTargetWriters(cellWriters, previous?.cellWriters, key);
				writers.delete(functionId);
				syncedCells.delete(key);
				if (writers.size === 0) cellWriters.delete(key);
			}
			for (const slot of entry.globalWrites.keys()) {
				globalSlots.add(slot);
				const writers = mutableCallTargetWriters(
					globalStoreWriters,
					previous?.globalStoreWriters,
					slot,
				);
				writers.delete(functionId);
				syncedGlobalSlots.delete(slot);
				if (writers.size === 0) globalStoreWriters.delete(slot);
			}
			for (const key of entry.propertyInputs.keys()) {
				const readers = mutableCallTargetReaders(
					propertyReaders,
					previous?.propertyReaders,
					key,
				);
				readers.delete(functionId);
				if (readers.size === 0) propertyReaders.delete(key);
			}
		};
		// A changed writer's rerun recomputes its cells against their previous values, so a
		// rerun that restores a value wakes none of the cell's readers.
		const rewrittenKeys = new Set<number>();
		for (const functionId of affectedFunctions) {
			const entry = local.get(functionId) ?? previous?.local.get(functionId);
			for (const key of entry?.cellWrites.keys() ?? []) rewrittenKeys.add(key);
			removeLocalContributions(functionId, entry);
			local.delete(functionId);
		}
		for (const key of trackedCells) {
			if (!previous?.cells.has(key)) cellKeys.add(key);
		}
		for (const key of previous?.cells.keys() ?? []) {
			if (!trackedCells.has(key)) cellKeys.add(key);
		}
		let cellAggregateUpdates = 0;
		const recomputeCell = (key: number): boolean => {
			cellAggregateUpdates++;
			let next = closedCells.has(key)
				? (initialCells.get(key) ?? semantics.bottom)
				: semantics.opaque;
			next = semantics.join(next, joinContributions(cellWriters.get(key)));
			const prior = cells.get(key) ?? semantics.bottom;
			const bottom = semantics.isBottom(next);
			if (!trackedCells.has(key) || bottom) cells.delete(key);
			else cells.set(key, next);
			// An untracked key with writes reports a change on every recompute, so it never syncs.
			if (bottom || trackedCells.has(key)) syncedCells.add(key);
			return !semantics.equal(prior, next);
		};
		for (const key of cellKeys) {
			if (rewrittenKeys.has(key) || !recomputeCell(key)) continue;
			for (const reader of cellReaders.get(key) ?? []) affectedFunctions.add(reader);
		}
		let globalStoreAggregateUpdates = 0;
		const recomputeGlobalStore = (slot: number): void => {
			globalStoreAggregateUpdates++;
			const next = joinContributions(globalStoreWriters.get(slot));
			if (semantics.isBottom(next)) globalStores.delete(slot);
			else globalStores.set(slot, next);
			syncedGlobalSlots.add(slot);
		};
		for (const slot of globalSlots) recomputeGlobalStore(slot);

		const analyzed = new Set<CoreFunctionId>();
		const transferFunction: CoreProgramFlowFunctionTransfer = (functionId, enqueue) => {
			const currentLocal = local.get(functionId);
			const repeated = analyzed.has(functionId);
			const previousLocal =
				currentLocal ?? (repeated ? undefined : previous?.local.get(functionId));
			// A rerun only adds to the writes it made earlier in this solve. Replacing
			// them let a function that writes each of two cells from the other, as a
			// recursive call with permuted arguments does, swap their values forever.
			if (!repeated) removeLocalContributions(functionId, currentLocal);
			const analyzedLocal = semantics.analyzeLocal(
				this.#program,
				this.#program.function(functionId),
				controlFlow(functionId),
				cells,
				trackedCells,
				knownFunctionProperties,
				this.local(functionId),
				identities,
				(target) => local.get(target),
			);
			const next =
				repeated && currentLocal !== undefined
					? {
							...analyzedLocal,
							cellWrites: joinCallTargetWrites(
								currentLocal.cellWrites,
								analyzedLocal.cellWrites,
								(left, right) => semantics.join(left, right),
							),
							globalWrites: joinCallTargetWrites(
								currentLocal.globalWrites,
								analyzedLocal.globalWrites,
								(left, right) => semantics.join(left, right),
							),
						}
					: analyzedLocal;
			for (const [key, targets] of next.cellWrites) {
				cellKeys.add(key);
				if (cellWriters.get(key)?.get(functionId) === targets) continue;
				const writers = mutableCallTargetWriters(cellWriters, previous?.cellWriters, key);
				writers.set(functionId, targets);
				syncedCells.delete(key);
			}
			for (const [slot, targets] of next.globalWrites) {
				globalSlots.add(slot);
				if (globalStoreWriters.get(slot)?.get(functionId) === targets) continue;
				const writers = mutableCallTargetWriters(
					globalStoreWriters,
					previous?.globalStoreWriters,
					slot,
				);
				writers.set(functionId, targets);
				syncedGlobalSlots.delete(slot);
			}
			for (const key of next.propertyInputs.keys()) {
				const readers = mutableCallTargetReaders(
					propertyReaders,
					previous?.propertyReaders,
					key,
				);
				readers.add(functionId);
			}
			local.set(functionId, next);
			for (const target of previousLocal?.returnInputs.keys() ?? [])
				if (!next.returnInputs.has(target))
					mutableReturnReaders(target).delete(functionId);
			for (const target of next.returnInputs.keys())
				mutableReturnReaders(target).add(functionId);
			if (
				previousLocal === undefined ||
				!semantics.equal(previousLocal.returnTargets, next.returnTargets) ||
				!sameCoreRecordValueKind(previousLocal.returnRecord, next.returnRecord)
			) {
				for (const reader of returnReaders.get(functionId) ??
					previous?.returnGraph.exactCallers(functionId) ??
					[])
					if (functionSet.has(reader)) enqueue(reader);
			}
			analyzed.add(functionId);
			const writeKeys = new Set([
				...(previousLocal?.cellWrites.keys() ?? []),
				...next.cellWrites.keys(),
			]);
			for (const key of writeKeys) {
				if (syncedCells.has(key) || !recomputeCell(key)) continue;
				for (const reader of cellReaders.get(key) ?? []) enqueue(reader);
			}
			for (const slot of new Set([
				...(previousLocal?.globalWrites.keys() ?? []),
				...next.globalWrites.keys(),
			])) {
				if (!syncedGlobalSlots.has(slot)) recomputeGlobalStore(slot);
			}
		};
		let returnGraph = previous?.returnGraph;
		let returnTopology = previous?.returnTopology;
		let seeds = [...affectedFunctions].sort((left, right) => left - right);
		for (;;) {
			this.solveFunctions(seeds, transferFunction);
			returnGraph = updateCoreCallGraph(
				returnGraph,
				functionIds,
				[...local].map(([caller, entry]) => ({
					caller,
					exactTargets: [...entry.returnInputs.keys()],
					wildcard: false,
				})),
			);
			returnTopology = buildCoreProgramFlowTopology(returnGraph, returnTopology);
			if (previous === undefined) break;
			const restart = new Set<CoreFunctionId>();
			for (const component of returnTopology.sccs) {
				if (
					resetReturnComponents.has(component.id) ||
					!component.functions.some((member) => analyzed.has(member)) ||
					(component.functions.length === 1 &&
						!returnGraph
							.exactOutgoing(component.functions[0]!)
							.includes(component.functions[0]!))
				)
					continue;
				resetReturnComponents.add(component.id);
				for (const member of component.functions) {
					local.set(member, {
						...local.get(member)!,
						returnTargets: semantics.bottom,
						returnRecord: null,
					});
					restart.add(member);
				}
			}
			if (restart.size === 0) break;
			seeds = [...restart];
		}
		const functionsAnalyzed = analyzed.size;
		const functionsReused = local.size - functionsAnalyzed;
		const sites = new Map(previous?.sites ?? []);
		const outgoing = new Map(previous?.outgoingIndex ?? []);
		const changedCallSites: Array<Site> = [];
		const changedCallers = new Set<CoreFunctionId>();
		const changedEdgeCallers = new Set<CoreFunctionId>();
		let wildcardCallSites = previous?.statistics.wildcardCallSites ?? 0;
		let opaqueCallSites = previous?.statistics.opaqueCallSites ?? 0;
		for (const functionId of analyzed) {
			const priorOutgoing = previous?.outgoingIndex.get(functionId) ?? [];
			const priorSites = previous?.sites.get(functionId);
			const nextRaw = local.get(functionId)?.sites ?? [];
			const priorInvocations =
				previous?.local.get(functionId)?.invocationDependencies ?? [];
			const nextInvocations = local.get(functionId)!.invocationDependencies;
			if (
				priorInvocations.length !== nextInvocations.length ||
				priorInvocations.some(
					(target, index) => !semantics.equal(target, nextInvocations[index]!),
				)
			)
				changedCallers.add(functionId);
			const nextOutgoing = nextRaw.map((site) => {
				const prior = priorSites?.get(site.instruction);
				return prior !== undefined && semantics.callSiteEqual(prior, site) ? prior : site;
			});
			const oldByInstruction = new Map(
				priorOutgoing.map((site) => [site.instruction, site] as const),
			);
			const nextByInstruction = new Map(
				nextOutgoing.map((site) => [site.instruction, site] as const),
			);
			for (const instruction of new Set([
				...oldByInstruction.keys(),
				...nextByInstruction.keys(),
			])) {
				const prior = oldByInstruction.get(instruction);
				const next = nextByInstruction.get(instruction);
				if (
					prior !== undefined &&
					next !== undefined &&
					semantics.callSiteEqual(prior, next)
				)
					continue;
				changedCallSites.push(next ?? prior!);
				changedCallers.add(functionId);
			}
			if (nextByInstruction.size === 0) sites.delete(functionId);
			else sites.set(functionId, nextByInstruction);
			const priorExact = [
				...new Set([
					...priorOutgoing.flatMap((site) => site.targets.functions),
					...priorInvocations.flatMap((target) => target.functions),
				]),
			].sort((left, right) => left - right);
			const nextExact = [
				...new Set([
					...nextOutgoing.flatMap((site) => site.targets.functions),
					...nextInvocations.flatMap((target) => target.functions),
				]),
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
				exactTargets: [
					...callSites.flatMap((site) => site.targets.functions),
					...local
						.get(caller)!
						.invocationDependencies.flatMap((target) => target.functions),
				],
				wildcard: callSites.some((site) => site.targets.anyScript),
			})),
		);
		const updatedCallSites = changedCallSites.length;
		let callSites = 0;
		for (const indexed of sites.values()) callSites += indexed.size;
		const statistics = Object.freeze({
			functions: local.size,
			functionsAnalyzed,
			functionsReused,
			callSites,
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
			callSiteIndexUpdates: changedCallSites.length,
		});
		return Object.freeze({
			sourceClosed,
			identities,
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
			returnGraph,
			returnTopology,
			targets(functionId: CoreFunctionId, value: CoreValueId) {
				return local.get(functionId)?.values[value] ?? semantics.open;
			},
			returnTargets(functionId: CoreFunctionId) {
				return local.get(functionId)?.returnTargets ?? semantics.open;
			},
			publishedFunctions(functionId: CoreFunctionId) {
				return local.get(functionId)?.publishedFunctions ?? [];
			},
			globalStoreTargets(slot: number) {
				return globalStores.get(slot) ?? semantics.bottom;
			},
			site(functionId: CoreFunctionId, instruction: CoreInstructionId) {
				return sites.get(functionId)?.get(instruction);
			},
			outgoing(functionId: CoreFunctionId) {
				return outgoing.get(functionId) ?? [];
			},
		});
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
		// Each SCC drains its queue and clears membership before the next SCC runs.
		const memberQueued = new Uint8Array(this.#program.functionCapacity);
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

	solveValueKinds<Analysis, Targets extends CoreProgramFlowTargetIndex>(
		targets: Targets,
		externallyReachable: (functionId: CoreFunctionId) => boolean,
		controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
		semantics: CoreProgramFlowValueKindSemantics<Analysis>,
		previous?: CoreProgramFlowValueKindState<Analysis, Targets>,
		dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
		externallyChangedFunctions?: ReadonlySet<CoreFunctionId>,
		context?: CoreCompilationContext,
	): CoreProgramFlowValueKindState<Analysis, Targets> {
		const dataEpoch = this.#program.dataEpoch;
		if (previous?.dataEpoch !== dataEpoch) previous = undefined;
		const sameInputs = (
			left: CoreProgramFlowKindInputs | undefined,
			right: CoreProgramFlowKindInputs,
		): boolean =>
			left?.receiverKind === right.receiverKind &&
			left.parameterKinds.length === right.parameterKinds.length &&
			left.parameterKinds.every((mask, index) => mask === right.parameterKinds[index]);
		const sameReturn = (
			left: CoreProgramFlowValueKindSummary | undefined,
			right: CoreProgramFlowValueKindSummary,
		): boolean =>
			left?.returnKind === right.returnKind &&
			left.returnHeapBrand === right.returnHeapBrand &&
			sameCoreRecordValueKind(left.returnRecord, right.returnRecord);
		const functionIds = targets.graph.functions;
		const external = new Map(
			functionIds.map((functionId) => [functionId, externallyReachable(functionId)]),
		);
		type Site = ReturnType<Targets["outgoing"]>[number];
		const dependencies = new Map<CoreFunctionId, Array<CoreFunctionId>>();
		const returnReaders = new Map<CoreFunctionId, Set<CoreFunctionId>>();
		const incoming = new Map<
			CoreFunctionId,
			Array<{ caller: CoreFunctionId; site: Site }>
		>();
		const argumentTargets = new Map<CoreFunctionId, Set<CoreFunctionId>>();
		const wildcardReaders = new Set<CoreFunctionId>();
		for (const functionId of functionIds) dependencies.set(functionId, []);
		for (const caller of functionIds) {
			for (const site of targets.outgoing(caller)) {
				if (targets.sourceClosed && !site.targets.opaque && site.targets.anyScript)
					wildcardReaders.add(caller);
				for (const callee of site.targets.functions) {
					if (!external.has(callee)) continue;
					if (!site.targets.opaque && !site.targets.anyScript) {
						let readers = returnReaders.get(callee);
						if (readers === undefined) returnReaders.set(callee, (readers = new Set()));
						if (!readers.has(caller)) dependencies.get(caller)!.push(callee);
						readers.add(caller);
					}
					if (external.get(callee) === true) continue;
					let sites = incoming.get(callee);
					if (sites === undefined) incoming.set(callee, (sites = []));
					sites.push({ caller, site });
					let recipients = argumentTargets.get(caller);
					if (recipients === undefined)
						argumentTargets.set(caller, (recipients = new Set()));
					if (!recipients.has(callee)) dependencies.get(callee)!.push(caller);
					recipients.add(callee);
				}
			}
		}
		// A return and an argument can feed back through the same site even when the call
		// graph is acyclic. Solve the actual dependencies in dependency-first order.
		const dependencyGraph = updateCoreCallGraph(
			undefined,
			functionIds,
			functionIds.map((caller) => ({
				caller,
				exactTargets: dependencies.get(caller)!,
				wildcard: wildcardReaders.has(caller),
			})),
		);
		const { owner, sccs } = buildCoreProgramFlowTopology(dependencyGraph);
		const forced = new Uint8Array(sccs.length);
		const checkBoundary = new Uint8Array(sccs.length);
		const force = (functionId: CoreFunctionId): void => {
			const scc = owner.get(functionId);
			if (scc !== undefined) forced[scc] = 1;
		};
		const checkInputs = (functionId: CoreFunctionId): void => {
			const scc = owner.get(functionId);
			if (scc !== undefined) checkBoundary[scc] = 1;
		};
		let anyScriptAggregate = dependencyGraph.hasAggregate()
			? previous?.anyScriptAggregate
			: undefined;
		const aggregateScc = owner.get(CORE_ANY_SCRIPT_AGGREGATE);
		if (
			aggregateScc !== undefined &&
			(anyScriptAggregate === undefined ||
				previous?.targets.graph.functions.some((id) => !external.has(id)))
		) {
			forced[aggregateScc] = 1;
		}
		if (previous === undefined || previous.sourceClosed !== targets.sourceClosed) {
			forced.fill(1);
		} else {
			for (const functionId of dirtyFunctions ?? functionIds) force(functionId);
			for (const functionId of externallyChangedFunctions ?? functionIds) {
				if (previous.external.get(functionId) !== external.get(functionId))
					force(functionId);
			}
			for (const functionId of functionIds) {
				const before = previous.targets.outgoing(functionId);
				const after = targets.outgoing(functionId);
				if (before === after || (before.length === 0 && after.length === 0)) continue;
				force(functionId);
				const retained = new Set(after);
				for (const site of before) {
					if (retained.has(site)) continue;
					// A removed internal contribution can leave the boundary masks unchanged.
					for (const callee of site.targets.functions) {
						if (external.get(callee) === false) force(callee);
					}
				}
			}
			for (const functionId of previous.targets.graph.functions) {
				if (external.has(functionId)) continue;
				for (const site of previous.targets.outgoing(functionId)) {
					for (const callee of site.targets.functions) {
						if (external.get(callee) === false) force(callee);
					}
				}
			}
		}
		const summaries = new Map<CoreFunctionId, CoreProgramFlowValueKindSummary>();
		const valueAnalyses = new Map<CoreFunctionId, Analysis>();
		const boundaryInputs = new Map<CoreFunctionId, CoreProgramFlowKindInputs>();
		for (const functionId of functionIds) {
			const summary = previous?.summaries.get(functionId);
			const analysis = previous?.valueAnalyses.get(functionId);
			const inputs = previous?.boundaryInputs.get(functionId);
			if (summary !== undefined && analysis !== undefined && inputs !== undefined) {
				summaries.set(functionId, summary);
				valueAnalyses.set(functionId, analysis);
				boundaryInputs.set(functionId, inputs);
			} else force(functionId);
		}
		const mergeArguments = (
			fn: CoreFunctionStore,
			site: Site,
			values: Analysis,
			inputs: CoreProgramFlowKindInputs,
		): CoreProgramFlowKindInputs => {
			let parameters: Array<number> | undefined;
			for (let index = 0; index < fn.parameterCount; index++) {
				const argument = site.arguments?.[index];
				const mask =
					site.arguments === undefined
						? semantics.top
						: argument === undefined
							? semantics.undefined
							: semantics.latticeMask(values, argument);
				const old = inputs.parameterKinds[index]!;
				if ((old | mask) !== old)
					(parameters ??= [...inputs.parameterKinds])[index] = old | mask;
			}
			const receiverKind =
				inputs.receiverKind |
				(!fn.metadata.strict
					? semantics.object
					: site.receiver === undefined
						? semantics.top
						: semantics.latticeMask(values, site.receiver));
			return parameters === undefined && receiverKind === inputs.receiverKind
				? inputs
				: { parameterKinds: parameters ?? inputs.parameterKinds, receiverKind };
		};
		let callerWakeups = 0;
		let calleeWakeups = 0;
		let functionsEvaluated = 0;
		let affectedFunctions = 0;
		const changedFunctions = new Set<CoreFunctionId>();
		const demands = new Map<CoreFunctionId, ReadonlyArray<CoreValueId>>();
		const callSiteIndices = new Map<
			CoreFunctionId,
			ReadonlyMap<CoreInstructionId, ReturnType<Targets["outgoing"]>[number]>
		>();
		const recordReadIndices = new Map<
			CoreFunctionId,
			ReadonlyMap<CoreInstructionId, CoreRecordFieldAccess>
		>();
		const recordAlternativeIndices = new Map<
			CoreFunctionId,
			Map<CoreInstructionId, ReadonlyArray<CoreValueAlternative>>
		>();
		const noRecordAlternatives: ReadonlyArray<CoreValueAlternative> = [];
		let aggregateRecomputations = 0;
		let exactReverseCallerVisits = 0;
		let wildcardReverseCallerVisits = 0;
		let aggregateFunctionVisits = 0;
		for (const [sccIndex, component] of sccs.entries()) {
			if (forced[sccIndex] === 0 && checkBoundary[sccIndex] === 0) continue;
			let reset = forced[sccIndex] !== 0;
			// Every caller outside this component has converged. Rebuild its contribution
			// from the current value snapshot before resetting any cyclic inputs.
			for (const functionId of component.functions) {
				const fn = this.#program.function(functionId);
				const seed = external.get(functionId) ? semantics.top : 0;
				let inputs: CoreProgramFlowKindInputs = {
					parameterKinds: Array<number>(fn.parameterCount).fill(seed),
					receiverKind: seed,
				};
				for (const { caller, site } of incoming.get(functionId) ?? []) {
					if (owner.get(caller) === sccIndex) continue;
					inputs = mergeArguments(fn, site, valueAnalyses.get(caller)!, inputs);
				}
				const previousInputs = boundaryInputs.get(functionId);
				if (sameInputs(previousInputs, inputs)) continue;
				Object.freeze(inputs.parameterKinds);
				boundaryInputs.set(functionId, Object.freeze(inputs));
				reset = true;
			}
			if (!reset) continue;
			affectedFunctions += component.functions.length;
			const priorAggregate = anyScriptAggregate;
			if (component.hasAnyScriptAggregate) anyScriptAggregate = undefined;
			for (const id of component.functions) {
				summaries.set(id, {
					...boundaryInputs.get(id)!,
					returnKind: 0,
					returnHeapBrand: null,
				});
			}
			const queue = [...component.functions];
			const queued = new Set(queue);
			const enqueue = (id: CoreFunctionId): boolean => {
				if (owner.get(id) !== sccIndex || queued.has(id)) return false;
				queued.add(id);
				queue.push(id);
				return true;
			};
			let cursor = 0;
			let aggregateDirty = component.hasAnyScriptAggregate;
			while (cursor < queue.length || aggregateDirty) {
				if (cursor === queue.length) {
					aggregateDirty = false;
					aggregateRecomputations++;
					let returnKind = 0;
					let returnHeapBrand: CoreHeapBrandState = null;
					for (const summary of summaries.values()) {
						aggregateFunctionVisits++;
						returnKind |= summary.returnKind;
						if (summary.returnKind !== 0)
							returnHeapBrand = joinCoreHeapBrands(
								returnHeapBrand,
								summary.returnHeapBrand,
							);
						if (returnKind === semantics.top && returnHeapBrand === undefined) break;
					}
					if (
						anyScriptAggregate?.returnKind === returnKind &&
						anyScriptAggregate.returnHeapBrand === returnHeapBrand
					)
						continue;
					anyScriptAggregate = Object.freeze({ returnKind, returnHeapBrand });
					for (const caller of wildcardReaders) {
						wildcardReverseCallerVisits++;
						if (enqueue(caller)) callerWakeups++;
					}
					continue;
				}
				const functionId = queue[cursor++]!;
				queued.delete(functionId);
				const fn = this.#program.function(functionId);
				const summary = summaries.get(functionId)!;
				const sites = targets.outgoing(functionId);
				let byInstruction = callSiteIndices.get(functionId);
				if (byInstruction === undefined) {
					byInstruction = new Map(sites.map((site) => [site.instruction, site]));
					callSiteIndices.set(functionId, byInstruction);
				}
				let recordReads = recordReadIndices.get(functionId);
				if (recordReads === undefined) {
					recordReads = semantics.recordReads(fn, () => controlFlow(functionId));
					recordReadIndices.set(functionId, recordReads);
					let alternatives:
						| Map<CoreInstructionId, ReadonlyArray<CoreValueAlternative>>
						| undefined;
					for (const [instruction, read] of recordReads) {
						if (read.writes === undefined) continue;
						alternatives ??= new Map();
						// An unknown contract must override a previously published field bound.
						alternatives.set(instruction, noRecordAlternatives);
					}
					if (alternatives !== undefined)
						recordAlternativeIndices.set(functionId, alternatives);
				}
				const returnedRecords = new Map<CoreInstructionId, CoreRecordValueKind>();
				const recordResult = (instruction: CoreInstructionId): CoreRecordValueKind => {
					if (returnedRecords.has(instruction)) return returnedRecords.get(instruction);
					const site = byInstruction.get(instruction);
					if (
						site === undefined ||
						site.targets.opaque ||
						site.targets.anyScript ||
						site.targets.functions.length === 0
					)
						return undefined;
					let record: CoreRecordValueKind = null;
					for (const callee of site.targets.functions) {
						const returned = summaries.get(callee)!;
						record = joinCoreRecordValueKinds(
							record,
							returned.returnKind === 0 ? null : returned.returnRecord,
						);
						if (record === undefined) break;
					}
					returnedRecords.set(instruction, record);
					return record;
				};
				const alternatives = recordAlternativeIndices.get(functionId);
				for (const [instruction, values] of alternatives ?? []) {
					if (values.length !== 0) continue;
					const read = recordReads.get(instruction)!;
					const record = coreRecordAccessProducerFields(read, recordResult);
					const producerKind = coreRecordFieldInitialKind(read, record, semantics.top);
					if (producerKind === 0) continue;
					const initial = coreRecordAccessInitialFields(read, record, recordResult);
					if (
						(initial === record
							? producerKind
							: coreRecordFieldInitialKind(read, initial, semantics.top)) ===
						semantics.top
					)
						continue;
					alternatives!.set(instruction, read.writes!);
					// Producer contracts can emerge after the caller's first demand set was solved.
					demands.delete(functionId);
				}
				const cfg = controlFlow(functionId);
				let demandedValues = demands.get(functionId);
				if (demandedValues === undefined) {
					const roots = new Set(semantics.observationValues(this.#program, fn));
					for (const [instruction, values] of alternatives ?? [])
						if (values.length !== 0)
							roots.add(
								fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
							);
					for (const block of cfg.reachable) {
						const terminator = fn.blockTerminator(block);
						if (fn.instructionKind(terminator) === "return")
							roots.add(
								fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
							);
					}
					for (const site of sites) {
						let parameterCount = 0;
						for (const callee of site.targets.functions) {
							const target = this.#program.function(callee);
							parameterCount = Math.max(parameterCount, target.parameterCount);
						}
						for (let index = 0; index < parameterCount; index++) {
							const argument = site.arguments?.[index];
							if (argument !== undefined) roots.add(argument);
						}
						if (site.targets.functions.length > 0 && site.receiver !== undefined)
							roots.add(site.receiver);
					}
					demandedValues = [...roots];
					demands.set(functionId, demandedValues);
				}
				const values = semantics.analyze(this.#program, fn, cfg, {
					context,
					operationResultHeapBrand(instruction) {
						const construct =
							fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer?.result ===
							"construct-completion";
						const site = byInstruction.get(instruction);
						if (site === undefined) {
							const read = recordReads.get(instruction);
							if (read === undefined) return undefined;
							const record = coreRecordAccessProducerFields(read, recordResult);
							return coreRecordFieldInitialHeapBrand(
								read,
								coreRecordAccessInitialFields(read, record, recordResult),
							);
						}
						if (site.targets.opaque || (site.targets.anyScript && !targets.sourceClosed))
							return undefined;
						if (site.targets.anyScript)
							return anyScriptAggregate === undefined
								? null
								: anyScriptAggregate.returnHeapBrand;
						if (site.targets.functions.length === 0) return undefined;
						let brand: CoreHeapBrandState = null;
						for (const callee of site.targets.functions) {
							const returned = summaries.get(callee)!;
							if (returned.returnKind !== 0)
								brand = joinCoreHeapBrands(
									brand,
									construct && returned.returnKind !== semantics.object
										? undefined
										: returned.returnHeapBrand,
								);
						}
						return brand;
					},
					demandedValues,
					parameterMasks: summary.parameterKinds,
					receiverMask: summary.receiverKind,
					operationResultAlternatives:
						alternatives === undefined
							? undefined
							: (instruction) => {
									const values = alternatives.get(instruction);
									if (values === undefined) return undefined;
									const read = recordReads.get(instruction)!;
									return {
										values,
										hasNormalResult:
											coreRecordFieldInitialKind(
												read,
												coreRecordAccessProducerFields(read, recordResult),
												semantics.top,
											) !== 0,
									};
								},
					operationResultMask(instruction) {
						const site = byInstruction.get(instruction);
						if (site === undefined) {
							const read = recordReads.get(instruction);
							if (read === undefined) return undefined;
							const record = coreRecordAccessProducerFields(read, recordResult);
							const producerKind = coreRecordFieldInitialKind(
								read,
								record,
								semantics.top,
							);
							if (producerKind === 0 || read.initialProducers === undefined)
								return producerKind;
							const initial = coreRecordAccessInitialFields(read, record, recordResult);
							return initial === record
								? producerKind
								: coreRecordFieldInitialKind(read, initial, semantics.top);
						}
						if (
							site.targets.opaque ||
							(!targets.sourceClosed && site.targets.anyScript)
						) {
							return semantics.top;
						}
						if (site.targets.anyScript) {
							return anyScriptAggregate?.returnKind ?? 0;
						}
						const callees = site.targets.functions;
						if (callees.length === 0) return semantics.top;
						return callees.reduce(
							(mask, callee) => mask | summaries.get(callee)!.returnKind,
							0,
						);
					},
				});
				valueAnalyses.set(functionId, values);
				functionsEvaluated++;
				let returnKind = 0;
				let returnHeapBrand: CoreHeapBrandState = null;
				// A call to an async function or a generator returns its promise or iterator;
				// the body's return value only settles or completes that object.
				if (fn.isAsync || fn.isGenerator) returnKind = semantics.object;
				else
					for (const block of cfg.reachable) {
						const terminator = fn.blockTerminator(block);
						if (fn.instructionKind(terminator) === "return") {
							const returned = fn.kernel.operandAt(
								fn.kernel.instructionOperandStart(terminator),
							);
							const mask = semantics.latticeMask(values, returned);
							if (mask !== 0)
								returnHeapBrand = joinCoreHeapBrands(
									returnHeapBrand,
									mask === semantics.object
										? semantics.heapBrand(values, returned)
										: undefined,
								);
							returnKind |= mask;
						}
					}
				if (fn.isAsync || fn.isGenerator) returnHeapBrand = undefined;
				const returnRecord =
					returnKind === 0
						? undefined
						: semantics.returnRecord(this.#program, fn, cfg, values, recordResult);
				if (
					returnKind !== summary.returnKind ||
					returnHeapBrand !== summary.returnHeapBrand ||
					!sameCoreRecordValueKind(returnRecord, summary.returnRecord)
				) {
					summaries.set(functionId, {
						...summary,
						returnKind,
						returnRecord,
						returnHeapBrand,
					});
					for (const caller of returnReaders.get(functionId) ?? []) {
						exactReverseCallerVisits++;
						if (enqueue(caller)) callerWakeups++;
					}
					aggregateDirty ||=
						component.hasAnyScriptAggregate &&
						(returnKind !== summary.returnKind ||
							returnHeapBrand !== summary.returnHeapBrand);
				}
				for (const site of sites) {
					for (const callee of site.targets.functions) {
						if (external.get(callee) !== false || owner.get(callee) !== sccIndex)
							continue;
						const prior = summaries.get(callee)!;
						const next = mergeArguments(
							this.#program.function(callee),
							site,
							values,
							prior,
						);
						if (next === prior) continue;
						summaries.set(callee, { ...prior, ...next });
						if (enqueue(callee)) calleeWakeups++;
					}
				}
			}
			for (const functionId of component.functions) {
				const next = summaries.get(functionId)!;
				const prior = previous?.summaries.get(functionId);
				const returnChanged = !sameReturn(prior, next);
				if (returnChanged || !sameInputs(prior, next)) {
					changedFunctions.add(functionId);
					Object.freeze(next.parameterKinds);
					Object.freeze(next);
				} else summaries.set(functionId, prior!);
				if (returnChanged) {
					for (const caller of returnReaders.get(functionId) ?? []) {
						if (owner.get(caller) === sccIndex) continue;
						exactReverseCallerVisits++;
						force(caller);
					}
					if (
						aggregateScc !== undefined &&
						aggregateScc !== sccIndex &&
						(prior?.returnKind !== next.returnKind ||
							prior.returnHeapBrand !== next.returnHeapBrand)
					) {
						forced[aggregateScc] = 1;
					}
				}
				for (const callee of argumentTargets.get(functionId) ?? []) {
					if (owner.get(callee) !== sccIndex) checkInputs(callee);
				}
			}
			if (
				component.hasAnyScriptAggregate &&
				(priorAggregate?.returnKind !== anyScriptAggregate?.returnKind ||
					priorAggregate?.returnHeapBrand !== anyScriptAggregate?.returnHeapBrand)
			) {
				for (const caller of wildcardReaders) {
					if (owner.get(caller) !== sccIndex) force(caller);
				}
			}
		}
		const statistics = Object.freeze({
			functions: functionIds.length,
			functionsEvaluated,
			functionsReused: functionIds.length - affectedFunctions,
			affectedFunctions,
			callerWakeups,
			calleeWakeups,
			aggregateRecomputations,
			exactReverseCallerVisits,
			wildcardReverseCallerVisits,
			aggregateFunctionVisits,
		});
		return Object.freeze({
			sourceClosed: targets.sourceClosed,
			targets,
			dataEpoch,
			external,
			boundaryInputs,
			valueAnalyses,
			summaries,
			anyScriptAggregate,
			changedFunctions,
			statistics,
			values(functionId: CoreFunctionId) {
				const result = valueAnalyses.get(functionId);
				if (result === undefined)
					throw new Error(`No value-kind analysis for ${functionId}`);
				return result;
			},
			summary(functionId: CoreFunctionId) {
				const result = summaries.get(functionId);
				if (result === undefined)
					throw new Error(`No value-kind summary for ${functionId}`);
				return result;
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
			for (const functionId of functions) affected[functionId] = 1;
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
			let previousWildcardExpanded = false;
			const previousGraph = previous.targets.graph;
			for (let cursor = 0; cursor < closureQueue.length; cursor++) {
				const functionId = closureQueue[cursor]!;
				for (const callee of targets.graph.exactOutgoing(functionId)) {
					markAffected(callee);
				}
				if (targets.graph.isWildcardCaller(functionId)) {
					for (const callee of targets.graph.functions) markAffected(callee);
					break;
				}
				if (previousGraph !== targets.graph) {
					for (const callee of previousGraph.exactOutgoing(functionId)) {
						markAffected(callee);
					}
					if (!previousWildcardExpanded && previousGraph.isWildcardCaller(functionId)) {
						previousWildcardExpanded = true;
						for (const callee of previousGraph.functions) markAffected(callee);
					}
				}
				for (const rows of [
					structuralMasks.get(functionId),
					previous.structuralMasks.get(functionId),
				]) {
					for (const target of rows?.keys() ?? []) markAffected(target);
				}
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
}
