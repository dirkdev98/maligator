import type {
	CoreOptimizationPlan,
	CoreOptimizationPlanStatistics,
} from "./core-ir-regions.ts";
import type { CoreLocalOptimizerStatistics } from "./core-local-optimizer.ts";
import {
	coreOptimizationRuntimeCounterReaders,
	CORE_OPTIMIZATION_OWNER,
	CORE_OPTIMIZATION_OWNERS,
} from "./core-optimization-owners.ts";
import type {
	CoreOptimizationOwnerId,
	CoreOptimizationOwnerReport,
	CoreOptimizationRuntimeCounterReaders,
} from "./core-optimization-owners.ts";
import type { CoreConstructionStatistics, CoreProgram } from "./core-store.ts";

export type CoreInstrumentationMode = "off" | "phases" | "counters" | "full";

export interface CoreOptimizationCounts {
	readonly functions: number;
	readonly blocks: number;
	readonly instructions: number;
	readonly values: number;
	readonly facts: number;
	readonly planCandidates: number;
}

export interface CoreOptimizationPhaseReport {
	readonly phase: string;
	readonly elapsedMs: number;
}

export interface CoreLiveCapacityCounts {
	readonly live: number;
	readonly capacity: number;
}

export interface CoreOptimizationCheckpoint {
	readonly checkpoint: string;
	readonly functions: CoreLiveCapacityCounts;
	readonly blocks: CoreLiveCapacityCounts;
	readonly instructions: CoreLiveCapacityCounts;
	readonly values: CoreLiveCapacityCounts;
	readonly uses: CoreLiveCapacityCounts;
	readonly operands: CoreLiveCapacityCounts;
	readonly blockParameters: CoreLiveCapacityCounts;
	readonly terminatorEdges: CoreLiveCapacityCounts;
	readonly terminatorArguments: number;
	readonly handlerArguments: CoreLiveCapacityCounts;
	readonly facts: CoreLiveCapacityCounts;
	readonly effectRefinements: CoreLiveCapacityCounts;
	readonly abandonedStorage: {
		readonly operands: number;
		readonly blockParameters: number;
		readonly terminatorEdges: number;
		readonly handlerArguments: number;
		readonly effectRefinements: number;
	};
}

export interface CorePassWorkReport {
	readonly pass: string;
	readonly runs: number;
	readonly workItems: number;
	readonly changedItems: number;
	readonly edits: number;
	readonly elapsedMs: number;
}

export interface CoreAnalysisWorkReport {
	readonly analysis: string;
	readonly queries: number;
	readonly hits: number;
	readonly recomputations: number;
	readonly invalidations: number;
	readonly elapsedMs: number;
}

export interface CoreQueueWorkReport {
	readonly pushes: number;
	readonly pops: number;
	readonly maximumDepth: number;
}

export interface CoreBudgetWorkReport {
	readonly workItems: number;
	readonly edits: number;
	readonly exhaustedPasses: ReadonlyArray<string>;
}

export interface CoreOptimizationReport {
	readonly instrumentation: CoreInstrumentationMode;
	readonly construction: CoreConstructionStatistics;
	readonly input: CoreOptimizationCounts;
	readonly output: CoreOptimizationCounts;
	readonly phases: ReadonlyArray<CoreOptimizationPhaseReport>;
	readonly checkpoints: ReadonlyArray<CoreOptimizationCheckpoint>;
	readonly passes: ReadonlyArray<CorePassWorkReport>;
	readonly analyses: ReadonlyArray<CoreAnalysisWorkReport>;
	readonly owners: ReadonlyArray<CoreOptimizationOwnerReport>;
	readonly discovery: CoreCandidateDiscoveryReport;
	readonly program: CoreProgramWorkReport;
	readonly transforms: CoreTransformWorkReport;
	readonly plan: CorePlanWorkReport;
	readonly queue: CoreQueueWorkReport;
	readonly budget: CoreBudgetWorkReport;
	readonly counters: CoreCompilerWorkCounters;
}

export interface CoreCompilerWorkCounters {
	readonly analysisQueries: number;
	readonly analysisRecomputations: number;
	readonly localRulesConsidered: number;
	readonly localRulesApplied: number;
	readonly functionScans: number;
	readonly programFlowJournalEntries: number;
	readonly programFlowDirtyFunctions: number;
	readonly programFlowLocalScans: number;
	readonly programFlowLocalInstructionVisits: number;
	readonly programFlowTransferRecords: number;
	readonly programFlowTransferReuses: number;
	readonly programFlowTargetWakeups: number;
	readonly programFlowSummaryWakeups: number;
	readonly programFlowValueKindWakeups: number;
	readonly programFlowReachabilityWakeups: number;
	readonly programFlowSccPops: number;
	readonly programFlowSccWakeups: number;
	readonly programFlowFunctionPops: number;
	readonly programFlowFunctionWakeups: number;
	readonly explicitCallEdges: number;
	readonly wildcardCallSources: number;
	readonly wildcardCallSites: number;
	readonly opaqueCallSites: number;
	readonly aggregateDependencies: number;
	readonly storedCallGraphRows: number;
	readonly storedCallGraphEntries: number;
	readonly wildcardAggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
	readonly callTargetMs: number;
	readonly summaryMs: number;
	readonly reachabilityMs: number;
	readonly valueKindMs: number;
	readonly sccNodes: number;
	readonly sccEdges: number;
	readonly sccTransfers: number;
	readonly localFactRebuilds: number;
	readonly provenanceRebuilds: number;
	readonly memoryAccesses: number;
	readonly memoryLocations: number;
	readonly memoryPartitionsSolved: number;
	readonly memoryTouchedBlocks: number;
	readonly memoryStateRows: number;
	readonly memoryStateEntries: number;
	readonly memoryPhis: number;
	readonly memoryTransfers: number;
	readonly memoryFamilyWidens: number;
	readonly specializationFunctionsScanned: number;
	readonly specializationCandidatesDiscovered: number;
	readonly specializationCandidatesSelected: number;
	readonly specializationPayloadsMaterialized: number;
	readonly liveUseVisits: number;
	readonly deadUseSkips: number;
	readonly abandonedOperandStorage: number;
	readonly abandonedParameterStorage: number;
}

export interface CorePlanWorkReport {
	readonly discovery: CoreOptimizationPlanStatistics["discovery"];
	readonly admittedFunctions: number;
	readonly discovered: number;
	readonly selected: number;
	readonly declined: number;
	readonly discoveredByKind: Readonly<Record<string, number>>;
	readonly selectedByKind: Readonly<Record<string, number>>;
	readonly declinedByReason: Readonly<Record<string, number>>;
	readonly generatedCodeConsumed: number;
	readonly compilerWorkConsumed: number;
	readonly verificationMs: number;
}

export interface CoreTransformWorkReport {
	readonly considered: number;
	readonly applied: number;
	readonly declined: number;
	readonly appliedByKind: Readonly<Record<string, number>>;
	readonly declinedByReason: Readonly<Record<string, number>>;
	readonly generatedCodeConsumed: number;
	readonly compilerWorkConsumed: number;
	readonly waves: number;
	readonly callerEditSessions: number;
	readonly callerLocalOptimizations: number;
	readonly programFlowResolves: number;
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
	readonly callGraphFunctionsAnalyzed: number;
	readonly summaryFunctionsAnalyzed: number;
	readonly sccNodesAnalyzed: number;
	readonly sccEdgeVisits: number;
	readonly sccTransfers: number;
	readonly callerWakeups: number;
	readonly valueKindFunctionEvaluations: number;
	readonly valueKindFolds: number;
	readonly wildcardAggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
}

export interface CoreProgramWorkReport {
	readonly functionsAnalyzed: number;
	readonly functionsReused: number;
	readonly summaryFunctionsAnalyzed: number;
	readonly reachabilityFunctionsScanned: number;
	readonly callSites: number;
	readonly exactCallEdges: number;
	readonly wildcardCallers: number;
	readonly wildcardCallSites: number;
	readonly opaqueCallSites: number;
	readonly aggregateDependencies: number;
	readonly storedGraphRows: number;
	readonly storedGraphEntries: number;
	readonly sccs: number;
	readonly sccNodesAnalyzed: number;
	readonly sccEdgeVisits: number;
	readonly sccTransfers: number;
	readonly summaryChanges: number;
	readonly callerWakeups: number;
	readonly affectedCallers: number;
	readonly deadFunctions: number;
}

export interface CoreCandidateDiscoveryReport {
	readonly candidates: number;
	readonly byKind: Readonly<Record<string, number>>;
	readonly stackObjects: number;
	readonly denseArrays: number;
	readonly numericFusions: number;
	readonly largestFanOut: number;
}

interface MutablePassWorkReport {
	runs: number;
	workItems: number;
	changedItems: number;
	edits: number;
	elapsedMs: number;
}

interface MutableAnalysisWorkReport {
	queries: number;
	hits: number;
	recomputations: number;
	invalidations: number;
	elapsedMs: number;
}

const COUNTER_KEYS = [
	"analysisQueries",
	"analysisRecomputations",
	"localRulesConsidered",
	"localRulesApplied",
	"functionScans",
	"programFlowJournalEntries",
	"programFlowDirtyFunctions",
	"programFlowLocalScans",
	"programFlowLocalInstructionVisits",
	"programFlowTransferRecords",
	"programFlowTransferReuses",
	"programFlowTargetWakeups",
	"programFlowSummaryWakeups",
	"programFlowValueKindWakeups",
	"programFlowReachabilityWakeups",
	"programFlowSccPops",
	"programFlowSccWakeups",
	"programFlowFunctionPops",
	"programFlowFunctionWakeups",
	"explicitCallEdges",
	"wildcardCallSources",
	"wildcardCallSites",
	"opaqueCallSites",
	"aggregateDependencies",
	"storedCallGraphRows",
	"storedCallGraphEntries",
	"wildcardAggregateRecomputations",
	"exactReverseCallerVisits",
	"wildcardReverseCallerVisits",
	"callTargetMs",
	"summaryMs",
	"reachabilityMs",
	"valueKindMs",
	"sccNodes",
	"sccEdges",
	"sccTransfers",
	"localFactRebuilds",
	"provenanceRebuilds",
	"memoryAccesses",
	"memoryLocations",
	"memoryPartitionsSolved",
	"memoryTouchedBlocks",
	"memoryStateRows",
	"memoryStateEntries",
	"memoryPhis",
	"memoryTransfers",
	"memoryFamilyWidens",
	"specializationFunctionsScanned",
	"specializationCandidatesDiscovered",
	"specializationCandidatesSelected",
	"specializationPayloadsMaterialized",
	"liveUseVisits",
	"deadUseSkips",
	"abandonedOperandStorage",
	"abandonedParameterStorage",
] as const satisfies ReadonlyArray<keyof CoreCompilerWorkCounters>;

type CoreCompilerWorkCounter = (typeof COUNTER_KEYS)[number];

const COUNTER_INDEX = new Map(COUNTER_KEYS.map((key, index) => [key, index] as const));
const PHASE_KEYS = [
	"pre-optimization-verification",
	"construction-cleanup",
	"initial-local-optimization",
	"structural-cfg-optimization",
	"dense-generation-barrier",
	"post-barrier-local-optimization",
	"advanced-cfg-optimization",
	"proof-and-representation-optimization",
	"memory-and-provenance-optimization",
	"late-local-cleanup",
	"program-flow",
	"cross-call-transforms",
	"specialization-discovery",
	"specialization-selection",
	"plan-verification",
	"final-core-verification",
	"sealing",
] as const;
export type CoreOptimizationPhase = (typeof PHASE_KEYS)[number];
const PHASE_INDEX = new Map(PHASE_KEYS.map((key, index) => [key, index] as const));

const EMPTY_COUNTS: CoreOptimizationCounts = Object.freeze({
	functions: 0,
	blocks: 0,
	instructions: 0,
	values: 0,
	facts: 0,
	planCandidates: 0,
});

const EMPTY_CONSTRUCTION_STATISTICS: CoreConstructionStatistics = Object.freeze({
	virtualPhisCreated: 0,
	virtualPhisCollapsed: 0,
	materializedBlockParameters: 0,
	edgeArgumentsEmitted: 0,
	definitionSnapshotEntriesCopied: 0,
	aliasResolutions: 0,
	maximumUnresolvedPhiDepth: 0,
});

function liveCounts(
	program: CoreProgram,
): Omit<CoreOptimizationCounts, "planCandidates"> {
	let functions = 0;
	let blocks = 0;
	let instructions = 0;
	let values = 0;
	let facts = 0;
	for (const functionId of program.functionIds()) {
		functions++;
		const counts = program.function(functionId).liveStorageCounts();
		blocks += counts.blocks;
		instructions += counts.instructions;
		values += counts.values;
		facts += counts.facts;
	}
	return { functions, blocks, instructions, values, facts };
}

export function coreOptimizationCounts(
	program: CoreProgram,
	plan?: Pick<CoreOptimizationPlan, "directEntries"> & {
		readonly recipes?: Pick<CoreOptimizationPlan["recipes"], "count">;
		readonly specializations?: ReadonlyArray<unknown>;
	},
): CoreOptimizationCounts {
	return {
		...liveCounts(program),
		planCandidates:
			(plan?.directEntries.length ?? 0) +
			(plan?.recipes?.count ?? plan?.specializations?.length ?? 0),
	};
}

function coreOptimizationCheckpoint(
	program: CoreProgram,
	checkpoint: string,
): CoreOptimizationCheckpoint {
	let functions = 0;
	let blocksLive = 0;
	let blocksCapacity = 0;
	let instructionsLive = 0;
	let instructionsCapacity = 0;
	let valuesLive = 0;
	let valuesCapacity = 0;
	let usesLive = 0;
	let usesCapacity = 0;
	let operandsLive = 0;
	let operandsCapacity = 0;
	let blockParametersLive = 0;
	let blockParametersCapacity = 0;
	let terminatorEdgesLive = 0;
	let terminatorEdgesCapacity = 0;
	let terminatorArguments = 0;
	let handlerArgumentsLive = 0;
	let handlerArgumentsCapacity = 0;
	let factsLive = 0;
	let factsCapacity = 0;
	let effectRefinementsLive = 0;
	let effectRefinementsCapacity = 0;
	for (const functionId of program.functionIds()) {
		functions++;
		const fn = program.function(functionId);
		const live = fn.liveStorageCounts();
		blocksCapacity += fn.blockCapacity;
		instructionsCapacity += fn.instructionCapacity;
		valuesCapacity += fn.valueCapacity;
		usesCapacity += fn.useCapacity;
		operandsCapacity += fn.operandCapacity;
		blockParametersCapacity += fn.blockParameterCapacity;
		terminatorEdgesCapacity += fn.terminatorEdgeCapacity;
		handlerArgumentsCapacity += fn.handlerArgumentCapacity;
		factsCapacity += fn.factCapacity;
		effectRefinementsCapacity += fn.effectRefinementCapacity;
		blocksLive += live.blocks;
		instructionsLive += live.instructions;
		valuesLive += live.values;
		usesLive += live.uses;
		operandsLive += live.operands;
		blockParametersLive += live.blockParameters;
		terminatorEdgesLive += live.terminatorEdges;
		terminatorArguments += live.terminatorArguments;
		handlerArgumentsLive += live.handlerArguments;
		factsLive += live.facts;
		effectRefinementsLive += live.effectRefinements;
	}
	const count = (live: number, capacity: number): CoreLiveCapacityCounts =>
		Object.freeze({ live, capacity });
	return Object.freeze({
		checkpoint,
		functions: count(functions, program.functionCapacity),
		blocks: count(blocksLive, blocksCapacity),
		instructions: count(instructionsLive, instructionsCapacity),
		values: count(valuesLive, valuesCapacity),
		uses: count(usesLive, usesCapacity),
		operands: count(operandsLive, operandsCapacity),
		blockParameters: count(blockParametersLive, blockParametersCapacity),
		terminatorEdges: count(terminatorEdgesLive, terminatorEdgesCapacity),
		terminatorArguments,
		handlerArguments: count(handlerArgumentsLive, handlerArgumentsCapacity),
		facts: count(factsLive, factsCapacity),
		effectRefinements: count(effectRefinementsLive, effectRefinementsCapacity),
		abandonedStorage: Object.freeze({
			operands: operandsCapacity - operandsLive,
			blockParameters: blockParametersCapacity - blockParametersLive,
			terminatorEdges: terminatorEdgesCapacity - terminatorEdgesLive,
			handlerArguments: handlerArgumentsCapacity - handlerArgumentsLive,
			effectRefinements: effectRefinementsCapacity - effectRefinementsLive,
		}),
	});
}

let EMPTY_CORE_OPTIMIZATION_REPORT: CoreOptimizationReport | undefined;

export class CoreOptimizationReportBuilder {
	readonly instrumentation: CoreInstrumentationMode;
	#input: CoreOptimizationCounts = EMPTY_COUNTS;
	readonly #phaseTimes = new Float64Array(PHASE_KEYS.length);
	readonly #phaseSeen = new Uint8Array(PHASE_KEYS.length);
	readonly #detailedPhases: Array<CoreOptimizationPhaseReport> | undefined;
	readonly #checkpoints: Array<CoreOptimizationCheckpoint> | undefined;
	readonly #passes: Map<string, MutablePassWorkReport> | undefined;
	readonly #analyses: Map<string, MutableAnalysisWorkReport> | undefined;
	readonly #ownerStartedAt: number;
	readonly #ownerTimes: Float64Array | undefined;
	readonly #ownerWork: Float64Array | undefined;
	readonly #ownerTimeStarts: Array<number> | undefined;
	readonly #ownerNestedTimes: Array<number> | undefined;
	readonly #ownerRuntimeReaders: CoreOptimizationRuntimeCounterReaders | undefined;
	readonly #ownerAllocatedStartedAt: number;
	readonly #ownerCollectionsStartedAt: number;
	readonly #ownerAllocated: Float64Array | undefined;
	readonly #ownerCollections: Float64Array | undefined;
	readonly #ownerAllocatedStarts: Array<number> | undefined;
	readonly #ownerNestedAllocated: Array<number> | undefined;
	readonly #ownerCollectionStarts: Array<number> | undefined;
	readonly #ownerNestedCollections: Array<number> | undefined;
	#ownerDepth = 0;
	readonly #exhaustedPasses: Set<string> | undefined;
	readonly #counters = new Float64Array(COUNTER_KEYS.length);
	#queuePushes = 0;
	#queuePops = 0;
	#queueMaximumDepth = 0;
	#budgetWorkItems = 0;
	#budgetEdits = 0;
	#discoveredStackObjects = 0;
	#discoveredDenseArrays = 0;
	#discoveredNumericFusions = 0;
	readonly #discoveredCandidatesByKind: Map<string, number> | undefined;
	#largestCandidateFanOut = 0;
	#programWork: CoreProgramWorkReport = Object.freeze({
		functionsAnalyzed: 0,
		functionsReused: 0,
		summaryFunctionsAnalyzed: 0,
		reachabilityFunctionsScanned: 0,
		callSites: 0,
		exactCallEdges: 0,
		wildcardCallers: 0,
		wildcardCallSites: 0,
		opaqueCallSites: 0,
		aggregateDependencies: 0,
		storedGraphRows: 0,
		storedGraphEntries: 0,
		sccs: 0,
		sccNodesAnalyzed: 0,
		sccEdgeVisits: 0,
		sccTransfers: 0,
		summaryChanges: 0,
		callerWakeups: 0,
		affectedCallers: 0,
		deadFunctions: 0,
	});
	#transformWork: CoreTransformWorkReport = Object.freeze({
		considered: 0,
		applied: 0,
		declined: 0,
		appliedByKind: Object.freeze({}),
		declinedByReason: Object.freeze({}),
		generatedCodeConsumed: 0,
		compilerWorkConsumed: 0,
		waves: 0,
		callerEditSessions: 0,
		callerLocalOptimizations: 0,
		programFlowResolves: 0,
		instructionsIntroduced: 0,
		blocksIntroduced: 0,
		callGraphFunctionsAnalyzed: 0,
		summaryFunctionsAnalyzed: 0,
		sccNodesAnalyzed: 0,
		sccEdgeVisits: 0,
		sccTransfers: 0,
		callerWakeups: 0,
		valueKindFunctionEvaluations: 0,
		valueKindFolds: 0,
		wildcardAggregateRecomputations: 0,
		exactReverseCallerVisits: 0,
		wildcardReverseCallerVisits: 0,
	});
	#planWork: CorePlanWorkReport = Object.freeze({
		discovery: Object.freeze({
			opportunities: 0,
			attempted: 0,
			skipped: 0,
			compilerWork: 0,
			skippedByReason: {},
		}),
		admittedFunctions: 0,
		discovered: 0,
		selected: 0,
		declined: 0,
		discoveredByKind: Object.freeze({}),
		selectedByKind: Object.freeze({}),
		declinedByReason: Object.freeze({}),
		generatedCodeConsumed: 0,
		compilerWorkConsumed: 0,
		verificationMs: 0,
	});

	constructor(_program: CoreProgram, instrumentation: CoreInstrumentationMode = "full") {
		this.instrumentation = instrumentation;
		this.#passes = instrumentation === "full" ? new Map() : undefined;
		this.#analyses = instrumentation === "full" ? new Map() : undefined;
		this.#ownerStartedAt = instrumentation === "full" ? Date.now() : 0;
		this.#ownerTimes =
			instrumentation === "full"
				? new Float64Array(CORE_OPTIMIZATION_OWNERS.length)
				: undefined;
		this.#ownerWork =
			instrumentation === "full"
				? new Float64Array(CORE_OPTIMIZATION_OWNERS.length)
				: undefined;
		this.#ownerTimeStarts = instrumentation === "full" ? [] : undefined;
		this.#ownerNestedTimes = instrumentation === "full" ? [] : undefined;
		this.#ownerRuntimeReaders =
			instrumentation === "full" ? coreOptimizationRuntimeCounterReaders() : undefined;
		this.#ownerAllocated =
			this.#ownerRuntimeReaders === undefined
				? undefined
				: new Float64Array(CORE_OPTIMIZATION_OWNERS.length);
		this.#ownerCollections =
			this.#ownerRuntimeReaders === undefined
				? undefined
				: new Float64Array(CORE_OPTIMIZATION_OWNERS.length);
		this.#ownerAllocatedStarts = this.#ownerRuntimeReaders === undefined ? undefined : [];
		this.#ownerNestedAllocated = this.#ownerRuntimeReaders === undefined ? undefined : [];
		this.#ownerCollectionStarts =
			this.#ownerRuntimeReaders === undefined ? undefined : [];
		this.#ownerNestedCollections =
			this.#ownerRuntimeReaders === undefined ? undefined : [];
		this.#ownerAllocatedStartedAt = this.#ownerRuntimeReaders?.allocatedBytes() ?? 0;
		this.#ownerCollectionsStartedAt = this.#ownerRuntimeReaders?.collections() ?? 0;
		this.#exhaustedPasses = instrumentation === "full" ? new Set() : undefined;
		this.#discoveredCandidatesByKind = instrumentation === "full" ? new Map() : undefined;
		this.#detailedPhases = instrumentation === "full" ? [] : undefined;
		this.#checkpoints = instrumentation === "off" ? undefined : [];
	}

	get collectsCounters(): boolean {
		return this.instrumentation === "counters" || this.instrumentation === "full";
	}

	get collectsPhases(): boolean {
		return this.instrumentation === "phases" || this.instrumentation === "full";
	}

	get collectsDetails(): boolean {
		return this.instrumentation === "full";
	}

	measureOwner<Result>(owner: CoreOptimizationOwnerId, run: () => Result): Result {
		if (
			this.#ownerTimes === undefined ||
			this.#ownerTimeStarts === undefined ||
			this.#ownerNestedTimes === undefined
		)
			return run();
		const definition = CORE_OPTIMIZATION_OWNERS[owner];
		if (definition?.id !== owner)
			throw new Error(`Unknown Core optimization owner ${owner}`);
		const depth = this.#ownerDepth++;
		this.#ownerTimeStarts[depth] = Date.now();
		this.#ownerNestedTimes[depth] = 0;
		if (this.#ownerRuntimeReaders !== undefined) {
			this.#ownerAllocatedStarts![depth] = this.#ownerRuntimeReaders.allocatedBytes();
			this.#ownerNestedAllocated![depth] = 0;
			this.#ownerCollectionStarts![depth] = this.#ownerRuntimeReaders.collections();
			this.#ownerNestedCollections![depth] = 0;
		}
		try {
			return run();
		} finally {
			if (this.#ownerRuntimeReaders !== undefined) {
				const allocatedBytes = Math.max(
					0,
					this.#ownerRuntimeReaders.allocatedBytes() -
						this.#ownerAllocatedStarts![depth]!,
				);
				const collections = Math.max(
					0,
					this.#ownerRuntimeReaders.collections() - this.#ownerCollectionStarts![depth]!,
				);
				this.#ownerAllocated![owner] =
					this.#ownerAllocated![owner]! +
					Math.max(0, allocatedBytes - this.#ownerNestedAllocated![depth]!);
				this.#ownerCollections![owner] =
					this.#ownerCollections![owner]! +
					Math.max(0, collections - this.#ownerNestedCollections![depth]!);
				if (depth > 0) {
					this.#ownerNestedAllocated![depth - 1] =
						this.#ownerNestedAllocated![depth - 1]! + allocatedBytes;
					this.#ownerNestedCollections![depth - 1] =
						this.#ownerNestedCollections![depth - 1]! + collections;
				}
			}
			const totalMs = Date.now() - this.#ownerTimeStarts[depth];
			this.#ownerDepth--;
			this.#ownerTimes[owner] =
				this.#ownerTimes[owner]! + Math.max(0, totalMs - this.#ownerNestedTimes[depth]);
			if (depth > 0) {
				this.#ownerNestedTimes[depth - 1] = this.#ownerNestedTimes[depth - 1]! + totalMs;
			}
		}
	}

	recordOwnerWork(owner: CoreOptimizationOwnerId, workUnits: number): void {
		if (this.#ownerWork === undefined) return;
		if (!Number.isFinite(workUnits) || workUnits < 0) {
			throw new Error(`Invalid work for Core optimization owner ${owner}: ${workUnits}`);
		}
		this.#ownerWork[owner] = this.#ownerWork[owner]! + workUnits;
	}

	recordOwnerElapsed(owner: CoreOptimizationOwnerId, elapsedMs: number): void {
		if (this.#ownerTimes === undefined) return;
		if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
			throw new Error(`Invalid elapsed time for Core optimization owner ${owner}`);
		}
		this.#ownerTimes[owner] = this.#ownerTimes[owner]! + elapsedMs;
	}

	increment(counter: CoreCompilerWorkCounter, value = 1): void {
		if (!this.collectsCounters) return;
		const index = COUNTER_INDEX.get(counter)!;
		this.#counters[index] = this.#counters[index]! + value;
	}

	recordPhase(phase: CoreOptimizationPhase, elapsedMs: number): void {
		if (!this.collectsPhases) return;
		const index = PHASE_INDEX.get(phase)!;
		this.#phaseTimes[index] = this.#phaseTimes[index]! + elapsedMs;
		this.#phaseSeen[index] = 1;
		this.#detailedPhases?.push(Object.freeze({ phase, elapsedMs }));
	}

	recordCheckpoint(checkpoint: string, program: CoreProgram): void {
		if (this.#checkpoints === undefined) return;
		this.measureOwner(CORE_OPTIMIZATION_OWNER.optimizerInstrumentation, () => {
			const report = coreOptimizationCheckpoint(program, checkpoint);
			this.#checkpoints!.push(report);
			this.recordOwnerWork(CORE_OPTIMIZATION_OWNER.optimizerInstrumentation, 1);
			if (this.#checkpoints!.length === 1) {
				this.#input = Object.freeze({
					functions: report.functions.live,
					blocks: report.blocks.live,
					instructions: report.instructions.live,
					values: report.values.live,
					facts: report.facts.live,
					planCandidates: 0,
				});
			}
		});
	}

	recordPassRun(
		pass: string,
		workItems: number,
		changed: boolean,
		edits: number,
		elapsedMs: number,
	): void {
		if (!this.collectsCounters) return;
		this.increment("localRulesConsidered", workItems);
		if (changed) this.increment("localRulesApplied");
		if (this.#passes === undefined) return;
		const report = this.#passes.get(pass) ?? {
			runs: 0,
			workItems: 0,
			changedItems: 0,
			edits: 0,
			elapsedMs: 0,
		};
		report.runs++;
		report.workItems += workItems;
		if (changed) report.changedItems++;
		report.edits += edits;
		report.elapsedMs += elapsedMs;
		this.#passes.set(pass, report);
	}

	recordLocalOptimizerWork(pass: string, statistics: CoreLocalOptimizerStatistics): void {
		if (!this.collectsCounters) return;
		this.increment("localRulesConsidered", statistics.rulesConsidered);
		this.increment("localRulesApplied", statistics.rulesApplied);
		this.#queuePushes += statistics.instructionQueuePushes + statistics.blockQueuePushes;
		this.#queuePops += statistics.instructionQueuePops + statistics.blockQueuePops;
		this.#queueMaximumDepth = Math.max(
			this.#queueMaximumDepth,
			statistics.instructionQueueMaximumDepth,
			statistics.blockQueueMaximumDepth,
		);
		this.#budgetWorkItems += statistics.instructionQueuePops + statistics.blockQueuePops;
		this.#budgetEdits += statistics.edits;
		if (statistics.workBudgetExhausted || statistics.editBudgetExhausted) {
			this.#exhaustedPasses?.add(pass);
		}
		if (this.#passes === undefined) return;
		const report = this.#passes.get(pass) ?? {
			runs: 0,
			workItems: 0,
			changedItems: 0,
			edits: 0,
			elapsedMs: 0,
		};
		report.runs++;
		report.workItems += statistics.rulesConsidered;
		report.changedItems += statistics.rulesApplied;
		report.edits += statistics.edits;
		this.#passes.set(pass, report);
	}

	recordAnalysis(
		analysis: string,
		outcome: "hit" | "recompute",
		invalidated: boolean,
		elapsedMs: number,
	): void {
		if (!this.collectsCounters) return;
		this.increment("analysisQueries");
		if (outcome === "recompute") this.increment("analysisRecomputations");
		if (outcome === "recompute") {
			switch (analysis) {
				case "call-graph":
					this.increment("callTargetMs", elapsedMs);
					break;
				case "program-summaries":
					this.increment("summaryMs", elapsedMs);
					break;
				case "function-reachability":
					this.increment("reachabilityMs", elapsedMs);
					break;
				case "program-value-kinds":
					this.increment("valueKindMs", elapsedMs);
					break;
			}
		}
		if (outcome === "recompute" && analysis === "local-fact-bundle") {
			this.increment("provenanceRebuilds");
			this.increment("localFactRebuilds");
		}
		if (this.#analyses === undefined) return;
		const report = this.#analyses.get(analysis) ?? {
			queries: 0,
			hits: 0,
			recomputations: 0,
			invalidations: 0,
			elapsedMs: 0,
		};
		report.queries++;
		if (outcome === "hit") report.hits++;
		else report.recomputations++;
		if (invalidated) report.invalidations++;
		report.elapsedMs += elapsedMs;
		this.#analyses.set(analysis, report);
	}

	timesAnalysis(_analysis: string): boolean {
		return this.collectsDetails;
	}

	recordAnalysisResult(analysis: string, value: unknown): void {
		if (!this.collectsCounters) return;
		if (analysis === "program-flow") {
			const flow = value as {
				readonly targets?: {
					readonly statistics?: { readonly functionsAnalyzed?: number };
				};
				readonly summaries?: {
					readonly statistics?: { readonly functionsAnalyzed?: number };
				};
				readonly reachability?: {
					readonly statistics?: { readonly functionsScanned?: number };
				};
			};
			this.recordOwnerWork(
				CORE_OPTIMIZATION_OWNER.programFlowConvergence,
				(flow.targets?.statistics?.functionsAnalyzed ?? 0) +
					(flow.summaries?.statistics?.functionsAnalyzed ?? 0) +
					(flow.reachability?.statistics?.functionsScanned ?? 0),
			);
			return;
		}
		if (analysis !== "local-memory-versions") return;
		const statistics = (
			value as {
				readonly statistics?: {
					readonly accesses?: number;
					readonly partitions?: number;
					readonly solvedPartitions?: number;
					readonly touchedBlocks?: number;
					readonly stateRows?: number;
					readonly stateEntries?: number;
					readonly phis?: number;
					readonly transfers?: number;
					readonly familyWidenings?: number;
				};
			}
		).statistics;
		this.increment("memoryAccesses", statistics?.accesses ?? 0);
		this.increment("memoryLocations", statistics?.partitions ?? 0);
		this.increment("memoryPartitionsSolved", statistics?.solvedPartitions ?? 0);
		this.increment("memoryTouchedBlocks", statistics?.touchedBlocks ?? 0);
		this.increment("memoryStateRows", statistics?.stateRows ?? 0);
		this.increment("memoryStateEntries", statistics?.stateEntries ?? 0);
		this.increment("memoryPhis", statistics?.phis ?? 0);
		this.increment("memoryTransfers", statistics?.transfers ?? 0);
		this.increment("memoryFamilyWidens", statistics?.familyWidenings ?? 0);
		this.recordOwnerWork(
			CORE_OPTIMIZATION_OWNER.memoryEventExtraction,
			statistics?.accesses ?? 0,
		);
		this.recordOwnerWork(
			CORE_OPTIMIZATION_OWNER.memoryVersions,
			statistics?.transfers ?? 0,
		);
	}

	recordQueuePush(depth: number): void {
		if (!this.collectsCounters) return;
		this.#queuePushes++;
		this.#queueMaximumDepth = Math.max(this.#queueMaximumDepth, depth);
	}

	recordQueuePop(): void {
		if (!this.collectsCounters) return;
		this.#queuePops++;
	}

	recordBudget(workItems: number, edits: number): void {
		if (!this.collectsCounters) return;
		this.#budgetWorkItems += workItems;
		this.#budgetEdits += edits;
	}

	recordBudgetExhaustion(pass: string): void {
		this.#exhaustedPasses?.add(pass);
	}

	recordCandidateDiscovery(
		candidates: ReadonlyArray<{
			readonly kind: string;
			readonly fanOut: number;
		}>,
	): void {
		if (!this.collectsCounters) return;
		this.increment("specializationCandidatesDiscovered", candidates.length);
		for (const candidate of candidates) {
			this.#discoveredCandidatesByKind?.set(
				candidate.kind,
				(this.#discoveredCandidatesByKind.get(candidate.kind) ?? 0) + 1,
			);
			switch (candidate.kind) {
				case "stack-object":
					this.#discoveredStackObjects++;
					break;
				case "dense-array":
					this.#discoveredDenseArrays++;
					break;
				case "numeric-fusion":
					this.#discoveredNumericFusions++;
					break;
				case "string-split-projection":
				case "string-slice-number":
				case "regexp-exec-projection":
				case "regexp-iterator-projection":
					break;
			}
			this.#largestCandidateFanOut = Math.max(
				this.#largestCandidateFanOut,
				candidate.fanOut,
			);
		}
	}

	recordProgramWork(
		callGraph: {
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
		},
		summaries: {
			readonly functionsAnalyzed: number;
			readonly sccs: number;
			readonly sccNodesAnalyzed: number;
			readonly sccTransfers: number;
			readonly sccEdgeVisits: number;
			readonly summaryChanges: number;
			readonly callerWakeups: number;
			readonly affectedCallers: number;
		},
		reachability: {
			readonly functionsScanned: number;
			readonly deadFunctions: number;
		},
	): void {
		if (!this.collectsCounters) return;
		this.increment("functionScans", reachability.functionsScanned);
		this.increment("explicitCallEdges", callGraph.exactCallEdges);
		this.increment("wildcardCallSources", callGraph.wildcardCallers);
		this.increment("wildcardCallSites", callGraph.wildcardCallSites);
		this.increment("opaqueCallSites", callGraph.opaqueCallSites);
		this.increment("aggregateDependencies", callGraph.aggregateDependencies);
		this.increment("storedCallGraphRows", callGraph.storedGraphRows);
		this.increment("storedCallGraphEntries", callGraph.storedGraphEntries);
		this.#programWork = Object.freeze({
			functionsAnalyzed: callGraph.functionsAnalyzed,
			functionsReused: callGraph.functionsReused,
			summaryFunctionsAnalyzed: summaries.functionsAnalyzed,
			reachabilityFunctionsScanned: reachability.functionsScanned,
			callSites: callGraph.callSites,
			exactCallEdges: callGraph.exactCallEdges,
			wildcardCallers: callGraph.wildcardCallers,
			wildcardCallSites: callGraph.wildcardCallSites,
			opaqueCallSites: callGraph.opaqueCallSites,
			aggregateDependencies: callGraph.aggregateDependencies,
			storedGraphRows: callGraph.storedGraphRows,
			storedGraphEntries: callGraph.storedGraphEntries,
			sccs: summaries.sccs,
			sccNodesAnalyzed: summaries.sccNodesAnalyzed,
			sccEdgeVisits: summaries.sccEdgeVisits,
			sccTransfers: summaries.sccTransfers,
			summaryChanges: summaries.summaryChanges,
			callerWakeups: summaries.callerWakeups,
			affectedCallers: summaries.affectedCallers,
			deadFunctions: reachability.deadFunctions,
		});
	}

	recordTransformWork(report: CoreTransformWorkReport): void {
		if (!this.collectsCounters) return;
		this.increment(
			"functionScans",
			report.callGraphFunctionsAnalyzed +
				report.summaryFunctionsAnalyzed +
				report.valueKindFunctionEvaluations,
		);
		this.increment("sccNodes", report.sccNodesAnalyzed);
		this.increment("sccEdges", report.sccEdgeVisits);
		this.increment("sccTransfers", report.sccTransfers);
		this.increment(
			"wildcardAggregateRecomputations",
			report.wildcardAggregateRecomputations,
		);
		this.increment("exactReverseCallerVisits", report.exactReverseCallerVisits);
		this.increment("wildcardReverseCallerVisits", report.wildcardReverseCallerVisits);
		this.#transformWork = this.collectsDetails
			? Object.freeze({ ...report })
			: Object.freeze({
					...report,
					appliedByKind: Object.freeze({}),
					declinedByReason: Object.freeze({}),
				});
	}

	recordPlanWork(report: CoreOptimizationPlanStatistics): void {
		if (!this.collectsCounters) return;
		this.increment("specializationCandidatesSelected", report.applied);
		this.#planWork = Object.freeze({
			discovery: report.discovery,
			admittedFunctions: report.admittedFunctions,
			discovered: Object.values(report.discoveredByKind).reduce(
				(sum, count) => sum + count,
				0,
			),
			selected: report.applied,
			declined: report.declined,
			discoveredByKind: this.collectsDetails
				? Object.freeze({ ...report.discoveredByKind })
				: Object.freeze({}),
			selectedByKind: this.collectsDetails
				? Object.freeze({ ...report.selectedByKind })
				: Object.freeze({}),
			declinedByReason: this.collectsDetails
				? Object.freeze({
						...report.declinedByReason,
						...report.declinedByPlanReason,
					})
				: Object.freeze({}),
			generatedCodeConsumed: report.generatedCodeConsumed,
			compilerWorkConsumed: report.compilerWorkConsumed,
			verificationMs: report.verificationMs,
		});
	}

	#recordStorageWork(program: CoreProgram): void {
		if (!this.collectsCounters) return;
		let liveUses = 0;
		let deadUses = 0;
		for (const functionId of program.functionIds()) {
			const fn = program.function(functionId);
			const useTraversal = fn.useTraversalStatistics();
			liveUses += useTraversal.liveVisits;
			deadUses += useTraversal.deadSkips;
		}
		this.increment("liveUseVisits", liveUses);
		this.increment("deadUseSkips", deadUses);
		const finalCheckpoint = this.#checkpoints?.at(-1);
		this.increment(
			"abandonedOperandStorage",
			finalCheckpoint?.abandonedStorage.operands ?? 0,
		);
		this.increment(
			"abandonedParameterStorage",
			finalCheckpoint?.abandonedStorage.blockParameters ?? 0,
		);
	}

	finish(
		program: CoreProgram,
		plan: Pick<CoreOptimizationPlan, "directEntries"> & {
			readonly recipes?: Pick<CoreOptimizationPlan["recipes"], "count">;
			readonly specializations?: ReadonlyArray<unknown>;
		},
	): CoreOptimizationReport {
		if (this.instrumentation === "off") {
			EMPTY_CORE_OPTIMIZATION_REPORT ??= Object.freeze({
				instrumentation: "off",
				construction: EMPTY_CONSTRUCTION_STATISTICS,
				input: EMPTY_COUNTS,
				output: EMPTY_COUNTS,
				phases: Object.freeze([]),
				checkpoints: Object.freeze([]),
				passes: Object.freeze([]),
				analyses: Object.freeze([]),
				owners: Object.freeze([]),
				discovery: Object.freeze({
					candidates: 0,
					byKind: Object.freeze({}),
					stackObjects: 0,
					denseArrays: 0,
					numericFusions: 0,
					largestFanOut: 0,
				}),
				program: this.#programWork,
				transforms: this.#transformWork,
				plan: this.#planWork,
				queue: Object.freeze({ pushes: 0, pops: 0, maximumDepth: 0 }),
				budget: Object.freeze({
					workItems: 0,
					edits: 0,
					exhaustedPasses: Object.freeze([]),
				}),
				counters: Object.freeze(
					Object.fromEntries(
						COUNTER_KEYS.map((key) => [key, 0]),
					) as unknown as CoreCompilerWorkCounters,
				),
			});
			return EMPTY_CORE_OPTIMIZATION_REPORT;
		}
		this.#recordStorageWork(program);
		const passes = this.#passes;
		const analyses = this.#analyses;
		const discoveredCandidatesByKind = this.#discoveredCandidatesByKind;
		const counters = Object.freeze(
			Object.fromEntries(
				COUNTER_KEYS.map((key, index) => [key, this.#counters[index]]),
			) as unknown as CoreCompilerWorkCounters,
		);
		const owners =
			this.#ownerTimes === undefined || this.#ownerWork === undefined
				? Object.freeze([])
				: (() => {
						const totalMs = Date.now() - this.#ownerStartedAt;
						const totalAllocated = Math.max(
							0,
							(this.#ownerRuntimeReaders?.allocatedBytes() ?? 0) -
								this.#ownerAllocatedStartedAt,
						);
						const totalCollections = Math.max(
							0,
							(this.#ownerRuntimeReaders?.collections() ?? 0) -
								this.#ownerCollectionsStartedAt,
						);
						const attributedMs = this.#ownerTimes.reduce(
							(sum, elapsedMs, id) =>
								id === CORE_OPTIMIZATION_OWNER.unattributed ? sum : sum + elapsedMs,
							0,
						);
						// The builder lifetime is optimizeCore, so its exclusive residual is orchestration.
						this.#ownerTimes[CORE_OPTIMIZATION_OWNER.optimizerOrchestration] =
							this.#ownerTimes[CORE_OPTIMIZATION_OWNER.optimizerOrchestration]! +
							Math.max(0, totalMs - attributedMs);
						this.#ownerTimes[CORE_OPTIMIZATION_OWNER.unattributed] = 0;
						if (this.#ownerAllocated !== undefined) {
							const attributed = this.#ownerAllocated.reduce(
								(sum, bytes, id) =>
									id === CORE_OPTIMIZATION_OWNER.unattributed ? sum : sum + bytes,
								0,
							);
							this.#ownerAllocated[CORE_OPTIMIZATION_OWNER.optimizerOrchestration] =
								this.#ownerAllocated[CORE_OPTIMIZATION_OWNER.optimizerOrchestration]! +
								Math.max(0, totalAllocated - attributed);
							this.#ownerAllocated[CORE_OPTIMIZATION_OWNER.unattributed] = 0;
						}
						if (this.#ownerCollections !== undefined) {
							const attributed = this.#ownerCollections.reduce(
								(sum, collections, id) =>
									id === CORE_OPTIMIZATION_OWNER.unattributed ? sum : sum + collections,
								0,
							);
							this.#ownerCollections[CORE_OPTIMIZATION_OWNER.optimizerOrchestration] =
								this.#ownerCollections[CORE_OPTIMIZATION_OWNER.optimizerOrchestration]! +
								Math.max(0, totalCollections - attributed);
							this.#ownerCollections[CORE_OPTIMIZATION_OWNER.unattributed] = 0;
						}
						return Object.freeze(
							CORE_OPTIMIZATION_OWNERS.map(({ id, name }) =>
								Object.freeze({
									id,
									name,
									elapsedMs: this.#ownerTimes![id]!,
									workUnits: this.#ownerWork![id]!,
									...(this.#ownerAllocated === undefined
										? {}
										: { allocatedBytes: this.#ownerAllocated[id]! }),
									...(this.#ownerCollections === undefined
										? {}
										: { collections: this.#ownerCollections[id]! }),
								}),
							),
						);
					})();
		return Object.freeze({
			instrumentation: this.instrumentation,
			construction: program.constructionStatistics,
			input: this.#input,
			output: Object.freeze({
				functions: this.#checkpoints?.at(-1)?.functions.live ?? 0,
				blocks: this.#checkpoints?.at(-1)?.blocks.live ?? 0,
				instructions: this.#checkpoints?.at(-1)?.instructions.live ?? 0,
				values: this.#checkpoints?.at(-1)?.values.live ?? 0,
				facts: this.#checkpoints?.at(-1)?.facts.live ?? 0,
				planCandidates:
					plan.directEntries.length +
					(plan.recipes?.count ?? plan.specializations?.length ?? 0),
			}),
			phases:
				this.#detailedPhases === undefined
					? Object.freeze(
							PHASE_KEYS.flatMap((phase, index) =>
								this.#phaseSeen[index] === 0
									? []
									: [
											Object.freeze({
												phase,
												elapsedMs: this.#phaseTimes[index]!,
											}),
										],
							),
						)
					: Object.freeze([...this.#detailedPhases]),
			checkpoints: Object.freeze([...(this.#checkpoints ?? [])]),
			passes: Object.freeze(
				[...(passes?.entries() ?? [])].map(([pass, report]) =>
					Object.freeze({ pass, ...report }),
				),
			),
			analyses: Object.freeze(
				[...(analyses?.entries() ?? [])].map(([analysis, report]) =>
					Object.freeze({ analysis, ...report }),
				),
			),
			owners,
			discovery: Object.freeze({
				candidates: [...(discoveredCandidatesByKind?.values() ?? [])].reduce(
					(total, count) => total + count,
					0,
				),
				byKind: Object.freeze(Object.fromEntries(discoveredCandidatesByKind ?? [])),
				stackObjects: this.#discoveredStackObjects,
				denseArrays: this.#discoveredDenseArrays,
				numericFusions: this.#discoveredNumericFusions,
				largestFanOut: this.#largestCandidateFanOut,
			}),
			program: this.#programWork,
			transforms: this.#transformWork,
			plan: this.#planWork,
			queue: Object.freeze({
				pushes: this.#queuePushes,
				pops: this.#queuePops,
				maximumDepth: this.#queueMaximumDepth,
			}),
			budget: Object.freeze({
				workItems: this.#budgetWorkItems,
				edits: this.#budgetEdits,
				exhaustedPasses: Object.freeze([...(this.#exhaustedPasses ?? [])]),
			}),
			counters,
		});
	}
}

function countsLine(counts: CoreOptimizationCounts): string {
	return `${counts.functions} functions, ${counts.blocks} blocks, ${counts.instructions} instructions, ${counts.values} values, ${counts.facts} facts, ${counts.planCandidates} candidates`;
}

export function formatCoreOptimizationReport(
	report: CoreOptimizationReport,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
	const passes =
		report.passes.length === 0
			? "none"
			: report.passes
					.map(
						(pass) =>
							`${pass.pass} ${pass.runs} runs/${pass.workItems} work/${pass.changedItems} changed/${pass.edits} edits/${pass.elapsedMs.toFixed(1)}ms`,
					)
					.join("; ");
	const analyses =
		report.analyses.length === 0
			? "none"
			: report.analyses
					.map(
						(analysis) =>
							`${analysis.analysis} ${analysis.queries} queries/${analysis.hits} hits/${analysis.recomputations} recomputes/${analysis.invalidations} invalidations/${analysis.elapsedMs.toFixed(1)}ms`,
					)
					.join("; ");
	return [
		{
			label: "Core construction",
			value: `${report.construction.virtualPhisCreated} virtual phis/${report.construction.virtualPhisCollapsed} collapsed/${report.construction.materializedBlockParameters} materialized, ${report.construction.edgeArgumentsEmitted} edge arguments, ${report.construction.definitionSnapshotEntriesCopied} snapshot entries copied, ${report.construction.aliasResolutions} alias resolutions, depth ${report.construction.maximumUnresolvedPhiDepth}`,
		},
		{ label: "Core optimizer input", value: countsLine(report.input) },
		{ label: "Core optimizer output", value: countsLine(report.output) },
		{
			label: "Core optimizer phases",
			value: report.phases
				.map(({ phase, elapsedMs }) => `${phase} ${elapsedMs.toFixed(1)}ms`)
				.join(", "),
		},
		{ label: "Core optimizer passes", value: passes },
		{ label: "Core optimizer analyses", value: analyses },
		{
			label: "Core optimizer program",
			value: `${report.program.functionsAnalyzed} callgraph functions analyzed/${report.program.functionsReused} reused, ${report.program.summaryFunctionsAnalyzed} summary functions, ${report.program.reachabilityFunctionsScanned} reachability functions, ${report.program.callSites} callsites/${report.program.exactCallEdges} exact edges/${report.program.wildcardCallers} wildcard callers/${report.program.opaqueCallSites} opaque sites, ${report.program.storedGraphRows} stored rows/${report.program.storedGraphEntries} entries, ${report.program.sccs} SCCs/${report.program.sccNodesAnalyzed} nodes/${report.program.sccEdgeVisits} edges/${report.program.sccTransfers} transfers, ${report.program.summaryChanges} summary changes/${report.program.callerWakeups} caller wakeups/${report.program.affectedCallers} callers, ${report.program.deadFunctions} dead omitted`,
		},
		{
			label: "Core optimizer program timing",
			value: `call targets ${report.counters.callTargetMs.toFixed(1)}ms, summaries ${report.counters.summaryMs.toFixed(1)}ms, reachability ${report.counters.reachabilityMs.toFixed(1)}ms, value kinds ${report.counters.valueKindMs.toFixed(1)}ms`,
		},
		{
			label: "Core optimizer transforms",
			value: `${report.transforms.considered} considered/${report.transforms.applied} applied/${report.transforms.declined} declined; applied ${
				Object.entries(report.transforms.appliedByKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}; declined ${
				Object.entries(report.transforms.declinedByReason)
					.filter(([, count]) => count > 0)
					.map(([reason, count]) => `${reason}=${count}`)
					.join(", ") || "none"
			}; ${report.transforms.waves} waves/${report.transforms.programFlowResolves} flow solves, ${report.transforms.callerEditSessions} caller editors/${report.transforms.callerLocalOptimizations} local optimizations, generated ${report.transforms.generatedCodeConsumed}, compiler work ${report.transforms.compilerWorkConsumed}, introduced ${report.transforms.instructionsIntroduced} instructions/${report.transforms.blocksIntroduced} blocks, callgraph analyzed ${report.transforms.callGraphFunctionsAnalyzed}, summaries analyzed ${report.transforms.summaryFunctionsAnalyzed}, SCC ${report.transforms.sccNodesAnalyzed} nodes/${report.transforms.sccEdgeVisits} edges/${report.transforms.sccTransfers} transfers, caller wakeups ${report.transforms.callerWakeups}, value kinds evaluated ${report.transforms.valueKindFunctionEvaluations}/folded ${report.transforms.valueKindFolds}`,
		},
		{
			label: "Core optimizer discovery",
			value: `${report.discovery.candidates} candidates (${
				Object.entries(report.discovery.byKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}), largest fan-out ${report.discovery.largestFanOut}`,
		},
		{
			label: "Core optimizer specialization plan",
			value: `${report.plan.discovered} discovered/${report.plan.selected} selected/${report.plan.declined} declined; discovered ${
				Object.entries(report.plan.discoveredByKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}; selected ${
				Object.entries(report.plan.selectedByKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}; declined ${
				Object.entries(report.plan.declinedByReason)
					.filter(([, count]) => count > 0)
					.map(([reason, count]) => `${reason}=${count}`)
					.join(", ") || "none"
			}; discovery ${report.plan.discovery.attempted}/${report.plan.discovery.opportunities} attempted, ${report.plan.discovery.skipped} skipped, work ${report.plan.discovery.compilerWork}; generated ${report.plan.generatedCodeConsumed}, compiler work ${report.plan.compilerWorkConsumed}, verified ${report.plan.verificationMs.toFixed(1)}ms`,
		},
		{
			label: "Core optimizer queue",
			value: `${report.queue.pushes} pushes, ${report.queue.pops} pops, depth ${report.queue.maximumDepth}`,
		},
		{
			label: "Core optimizer budget",
			value: `${report.budget.workItems} work items, ${report.budget.edits} edits, exhausted ${report.budget.exhaustedPasses.join(", ") || "none"}`,
		},
	];
}
