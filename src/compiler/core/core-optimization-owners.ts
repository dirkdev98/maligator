export const CORE_OPTIMIZATION_OWNER = Object.freeze({
	unattributed: 0,
	semanticToCore: 1,
	constructionStructuralCleanup: 2,
	denseGenerationBarrier: 3,
	fusedLocalOptimization: 4,
	blockParameterSimplification: 5,
	forwardingAndLinearBlockNormalization: 6,
	cfgEdgeConstruction: 7,
	controlFlowTraversal: 8,
	immediateDominators: 9,
	loopsAndDominanceFrontiers: 10,
	localValueKinds: 11,
	canonicalValueRoots: 12,
	localFactAndProvenanceConstruction: 13,
	memoryEventExtraction: 14,
	memoryVersions: 15,
	programFlowLocalExtraction: 16,
	programFlowConvergence: 17,
	crossCallTransforms: 18,
	specializationDiscovery: 19,
	specializationSelection: 20,
	coreVerification: 21,
	coreToExecution: 22,
	executionToImage: 23,
	emission: 24,
	otherFunctionOptimizationPasses: 25,
	optimizerInstrumentation: 26,
	optimizerOrchestration: 27,
	moduleGraph: 28,
	semanticAnalysis: 29,
	outputSerialization: 30,
	outputWriting: 31,
} as const);

export type CoreOptimizationOwnerId =
	(typeof CORE_OPTIMIZATION_OWNER)[keyof typeof CORE_OPTIMIZATION_OWNER];

export interface CoreOptimizationOwnerDefinition {
	readonly id: CoreOptimizationOwnerId;
	readonly name: string;
}

export const CORE_OPTIMIZATION_OWNERS: ReadonlyArray<CoreOptimizationOwnerDefinition> =
	Object.freeze([
		{ id: 0, name: "unattributed" },
		{ id: 1, name: "semantic-to-Core construction" },
		{ id: 2, name: "construction structural cleanup" },
		{ id: 3, name: "dense generation barrier" },
		{ id: 4, name: "fused local optimization" },
		{ id: 5, name: "block-parameter simplification" },
		{ id: 6, name: "forwarding and linear block normalization" },
		{ id: 7, name: "CFG edge construction" },
		{ id: 8, name: "control-flow traversal" },
		{ id: 9, name: "immediate dominators" },
		{ id: 10, name: "loops and dominance frontiers" },
		{ id: 11, name: "local value kinds" },
		{ id: 12, name: "canonical value roots" },
		{ id: 13, name: "local fact and provenance construction" },
		{ id: 14, name: "memory event extraction" },
		{ id: 15, name: "memoryVersions / MemorySSA" },
		{ id: 16, name: "program-flow local extraction" },
		{ id: 17, name: "program-flow convergence" },
		{ id: 18, name: "cross-call transforms" },
		{ id: 19, name: "specialization discovery" },
		{ id: 20, name: "specialization selection" },
		{ id: 21, name: "Core verification" },
		{ id: 22, name: "Core-to-Execution lowering" },
		{ id: 23, name: "Execution-to-Image lowering" },
		{ id: 24, name: "emission" },
		{ id: 25, name: "other function optimization passes" },
		{ id: 26, name: "optimizer instrumentation" },
		{ id: 27, name: "optimizer orchestration" },
		{ id: 28, name: "module graph" },
		{ id: 29, name: "semantic analysis" },
		{ id: 30, name: "output serialization" },
		{ id: 31, name: "output writing" },
	]);

export function coreOptimizationOwnerIsOptimizeCore(owner: number): boolean {
	return (
		(owner >= CORE_OPTIMIZATION_OWNER.constructionStructuralCleanup &&
			owner <= CORE_OPTIMIZATION_OWNER.coreVerification) ||
		owner === CORE_OPTIMIZATION_OWNER.otherFunctionOptimizationPasses ||
		owner === CORE_OPTIMIZATION_OWNER.optimizerInstrumentation ||
		owner === CORE_OPTIMIZATION_OWNER.optimizerOrchestration
	);
}

export interface CoreOptimizationOwnerReport extends CoreOptimizationOwnerDefinition {
	readonly elapsedMs: number;
	readonly workUnits: number;
	readonly allocatedBytes?: number;
	readonly collections?: number;
}

export interface CompilerOptimizationOwnerPhases {
	readonly graphMs?: number;
	readonly semanticMs?: number;
	readonly constructCoreMs: number;
	readonly optimizeCoreMs: number;
	readonly coreToExecutionMs: number;
	readonly executionToImageMs: number;
	readonly emitMs: number;
	readonly serializeMs?: number;
	readonly writeMs?: number;
}

export interface CoreOptimizationRuntimeCounters {
	readonly allocatedBytes: number;
	readonly collections: number;
}

export interface CoreOptimizationRuntimeCounterReaders {
	readonly allocatedBytes: () => number;
	readonly collections: () => number;
}

export type CompilerOptimizationOwnerRuntimePhases = Readonly<
	Partial<Record<keyof CompilerOptimizationOwnerPhases, CoreOptimizationRuntimeCounters>>
>;

function runtimeCounterReader(name: string): (() => number) | undefined {
	const value = Reflect.get(globalThis, name) as unknown;
	return typeof value === "function" ? (value as () => number) : undefined;
}

export function coreOptimizationRuntimeCounterReaders():
	| CoreOptimizationRuntimeCounterReaders
	| undefined {
	const allocatedBytes = runtimeCounterReader("__mal_gc_allocated_bytes");
	const collections = runtimeCounterReader("__mal_gc_collections");
	if (allocatedBytes === undefined || collections === undefined) return undefined;
	return Object.freeze({ allocatedBytes, collections });
}

export function readCoreOptimizationRuntimeCounters(
	readers = coreOptimizationRuntimeCounterReaders(),
): CoreOptimizationRuntimeCounters | undefined {
	if (readers === undefined) return undefined;
	return Object.freeze({
		allocatedBytes: readers.allocatedBytes(),
		collections: readers.collections(),
	});
}

export function subtractCoreOptimizationRuntimeCounters(
	before: CoreOptimizationRuntimeCounters | undefined,
	after: CoreOptimizationRuntimeCounters | undefined,
): CoreOptimizationRuntimeCounters | undefined {
	if (before === undefined || after === undefined) return undefined;
	return Object.freeze({
		allocatedBytes: Math.max(0, after.allocatedBytes - before.allocatedBytes),
		collections: Math.max(0, after.collections - before.collections),
	});
}

export function completeCompilerOptimizationOwners(
	coreOwners: ReadonlyArray<CoreOptimizationOwnerReport>,
	phases: CompilerOptimizationOwnerPhases,
	work: {
		readonly inputInstructions: number;
		readonly outputInstructions: number;
		readonly generatedCodeUnits: number;
	},
	runtimePhases: CompilerOptimizationOwnerRuntimePhases = {},
): ReadonlyArray<CoreOptimizationOwnerReport> {
	if (coreOwners.length === 0) return Object.freeze([]);
	const core = new Map(coreOwners.map((owner) => [owner.id, owner]));
	const explicit = new Map<
		CoreOptimizationOwnerId,
		{ readonly elapsedMs: number; readonly workUnits: number }
	>([
		[
			CORE_OPTIMIZATION_OWNER.semanticToCore,
			{ elapsedMs: phases.constructCoreMs, workUnits: work.inputInstructions },
		],
		[
			CORE_OPTIMIZATION_OWNER.coreToExecution,
			{ elapsedMs: phases.coreToExecutionMs, workUnits: work.outputInstructions },
		],
		[
			CORE_OPTIMIZATION_OWNER.executionToImage,
			{ elapsedMs: phases.executionToImageMs, workUnits: work.outputInstructions },
		],
		[
			CORE_OPTIMIZATION_OWNER.emission,
			{ elapsedMs: phases.emitMs, workUnits: work.generatedCodeUnits },
		],
		[
			CORE_OPTIMIZATION_OWNER.moduleGraph,
			{ elapsedMs: phases.graphMs ?? 0, workUnits: 0 },
		],
		[
			CORE_OPTIMIZATION_OWNER.semanticAnalysis,
			{ elapsedMs: phases.semanticMs ?? 0, workUnits: work.inputInstructions },
		],
		[
			CORE_OPTIMIZATION_OWNER.outputSerialization,
			{ elapsedMs: phases.serializeMs ?? 0, workUnits: work.generatedCodeUnits },
		],
		[
			CORE_OPTIMIZATION_OWNER.outputWriting,
			{ elapsedMs: phases.writeMs ?? 0, workUnits: work.generatedCodeUnits },
		],
	]);
	const runtimeForOwner = new Map<
		CoreOptimizationOwnerId,
		CoreOptimizationRuntimeCounters
	>([
		...(runtimePhases.constructCoreMs === undefined
			? []
			: [
					[
						CORE_OPTIMIZATION_OWNER.semanticToCore,
						runtimePhases.constructCoreMs,
					] as const,
				]),
		...(runtimePhases.coreToExecutionMs === undefined
			? []
			: [
					[
						CORE_OPTIMIZATION_OWNER.coreToExecution,
						runtimePhases.coreToExecutionMs,
					] as const,
				]),
		...(runtimePhases.executionToImageMs === undefined
			? []
			: [
					[
						CORE_OPTIMIZATION_OWNER.executionToImage,
						runtimePhases.executionToImageMs,
					] as const,
				]),
		...(runtimePhases.emitMs === undefined
			? []
			: [[CORE_OPTIMIZATION_OWNER.emission, runtimePhases.emitMs] as const]),
		...(runtimePhases.graphMs === undefined
			? []
			: [[CORE_OPTIMIZATION_OWNER.moduleGraph, runtimePhases.graphMs] as const]),
		...(runtimePhases.semanticMs === undefined
			? []
			: [[CORE_OPTIMIZATION_OWNER.semanticAnalysis, runtimePhases.semanticMs] as const]),
		...(runtimePhases.serializeMs === undefined
			? []
			: [
					[
						CORE_OPTIMIZATION_OWNER.outputSerialization,
						runtimePhases.serializeMs,
					] as const,
				]),
		...(runtimePhases.writeMs === undefined
			? []
			: [[CORE_OPTIMIZATION_OWNER.outputWriting, runtimePhases.writeMs] as const]),
	]);
	return Object.freeze(
		CORE_OPTIMIZATION_OWNERS.map(({ id, name }) => {
			const measured = explicit.get(id) ?? core.get(id);
			const runtime = runtimeForOwner.get(id) ?? core.get(id);
			const allocatedBytes =
				runtime?.allocatedBytes === undefined ? undefined : runtime.allocatedBytes;
			const collections =
				runtime?.collections === undefined ? undefined : runtime.collections;
			return Object.freeze({
				id,
				name,
				elapsedMs: measured?.elapsedMs ?? 0,
				workUnits: measured?.workUnits ?? 0,
				...(allocatedBytes === undefined ? {} : { allocatedBytes }),
				...(collections === undefined ? {} : { collections }),
			});
		}),
	);
}

export type CoreOptimizationOwnerRunner = <Result>(
	owner: CoreOptimizationOwnerId,
	run: () => Result,
) => Result;
