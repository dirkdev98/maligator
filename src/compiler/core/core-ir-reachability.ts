import { CORE_ANY_SCRIPT_AGGREGATE } from "./core-call-graph.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import {
	CORE_PROGRAM_FLOW_REACHABILITY,
	CORE_PROGRAM_FLOW_INLINE_SOURCE,
	CORE_PROGRAM_FLOW_RUNTIME_IDENTITY,
	buildCoreProgramFlowTopology,
	extractCoreProgramFlowLocalTransfers,
	solveCoreProgramFlowSccs,
} from "./core-program-flow.ts";
import type {
	CoreProgramFlowLocalTransfers,
	CoreProgramFlowSccSolver,
	CoreProgramFlowTopology,
} from "./core-program-flow.ts";
import type { CoreProgram } from "./core-store.ts";

export type CoreFunctionReachabilityReason =
	| "program-entry"
	| "commonjs-module"
	| "host-install"
	| "open-world"
	| "finite-call"
	| "any-script"
	| "runtime-identity"
	| "inline-source";

export interface CoreFunctionReachabilityStatistics {
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

export interface CoreFunctionReachability {
	readonly executable: ReadonlySet<CoreFunctionId>;
	readonly retained: ReadonlySet<CoreFunctionId>;
	readonly dead: ReadonlySet<CoreFunctionId>;
	readonly liveFunctions: ReadonlyArray<CoreFunctionId>;
	readonly reasons: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreFunctionReachabilityReason>
	>;
	readonly sourceClosed: boolean;
	readonly statistics: CoreFunctionReachabilityStatistics;
}

type CoreReachabilityEdges = ReadonlyMap<
	CoreFunctionId,
	ReadonlySet<CoreFunctionReachabilityReason>
>;

export interface CoreFunctionReachabilityState extends CoreFunctionReachability {
	readonly bodyVersions: ReadonlyMap<CoreFunctionId, number>;
	readonly cfgVersions: ReadonlyMap<CoreFunctionId, number>;
	readonly programDataVersion: number;
	readonly structural: ReadonlyMap<CoreFunctionId, CoreReachabilityEdges>;
	readonly roots: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreFunctionReachabilityReason>
	>;
	readonly targets: CoreCallGraphIndex;
}

const FINITE_CALL_REASONS: ReadonlySet<CoreFunctionReachabilityReason> = new Set([
	"finite-call",
]);
const ANY_SCRIPT_REASONS: ReadonlySet<CoreFunctionReachabilityReason> = new Set([
	"any-script",
]);

function validFunction(program: CoreProgram, value: unknown): value is CoreFunctionId {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value >= program.functionCapacity
	)
		return false;
	try {
		program.function(value as CoreFunctionId);
		return true;
	} catch {
		return false;
	}
}

function addEdge(
	edges: Map<CoreFunctionId, Set<CoreFunctionReachabilityReason>>,
	target: CoreFunctionId,
	reason: CoreFunctionReachabilityReason,
): void {
	const reasons = edges.get(target) ?? new Set();
	reasons.add(reason);
	edges.set(target, reasons);
}

function structuralEdges(
	localTransfers: CoreProgramFlowLocalTransfers,
): CoreReachabilityEdges {
	const edges = new Map<CoreFunctionId, Set<CoreFunctionReachabilityReason>>();
	for (let index = 0; index < localTransfers.structuralTargetCount; index++) {
		const target = localTransfers.structuralTargetAt(index);
		const reasons = localTransfers.structuralReasonMaskAt(index);
		if ((reasons & CORE_PROGRAM_FLOW_RUNTIME_IDENTITY) !== 0) {
			addEdge(edges, target, "runtime-identity");
		}
		if ((reasons & CORE_PROGRAM_FLOW_INLINE_SOURCE) !== 0) {
			addEdge(edges, target, "inline-source");
		}
	}
	return edges;
}

function sameReasons(
	left: ReadonlySet<CoreFunctionReachabilityReason> | undefined,
	right: ReadonlySet<CoreFunctionReachabilityReason> | undefined,
): boolean {
	return (
		(left?.size ?? 0) === (right?.size ?? 0) &&
		[...(left ?? [])].every((reason) => right?.has(reason))
	);
}

function sameFunctionSet(
	left: ReadonlySet<CoreFunctionId>,
	right: ReadonlySet<CoreFunctionId>,
): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameEdges(
	left: CoreReachabilityEdges | undefined,
	right: CoreReachabilityEdges | undefined,
): boolean {
	return (
		(left?.size ?? 0) === (right?.size ?? 0) &&
		[...(left ?? [])].every(([target, reasons]) =>
			sameReasons(reasons, right?.get(target)),
		)
	);
}

function sameRoots(
	left:
		| ReadonlyMap<CoreFunctionId, ReadonlySet<CoreFunctionReachabilityReason>>
		| undefined,
	right: ReadonlyMap<CoreFunctionId, ReadonlySet<CoreFunctionReachabilityReason>>,
): boolean {
	return (
		(left?.size ?? 0) === right.size &&
		[...(left ?? [])].every(([functionId, reasons]) =>
			sameReasons(reasons, right.get(functionId)),
		)
	);
}

function reachabilityRoots(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	context: CoreCompilationContext,
): {
	readonly roots: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreFunctionReachabilityReason>
	>;
	readonly hostInstallSlotsRead: number;
} {
	const roots = new Map<CoreFunctionId, Set<CoreFunctionReachabilityReason>>();
	const enter = (candidate: unknown, reason: CoreFunctionReachabilityReason): void => {
		if (!validFunction(program, candidate)) return;
		const reasons = roots.get(candidate) ?? new Set();
		reasons.add(reason);
		roots.set(candidate, reasons);
	};
	const all = [...program.functionIds()];
	if (!targets.sourceClosed) {
		for (const functionId of all) enter(functionId, "open-world");
	} else {
		enter(all[0], "program-entry");
		for (const functionId of context.data.cjsModuleFunctionIndices) {
			enter(functionId, "commonjs-module");
		}
	}
	const hostInstallSlots = new Set<number>();
	for (const candidate of context.data.hostInstallCandidates) {
		for (const { slot } of candidate.exports) hostInstallSlots.add(slot);
	}
	for (const slot of hostInstallSlots) {
		const installed = targets.globalStoreTargets(slot);
		for (const target of installed.functions) {
			enter(target, "host-install");
		}
		if (installed.anyScript) {
			for (const functionId of all) enter(functionId, "host-install");
		}
	}
	return { roots, hostInstallSlotsRead: hostInstallSlots.size };
}

export function analyzeCoreFunctionReachability(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	context: CoreCompilationContext,
	previous?: CoreFunctionReachabilityState,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
	localTransfers: (functionId: CoreFunctionId) => CoreProgramFlowLocalTransfers = (
		functionId,
	) => extractCoreProgramFlowLocalTransfers(program, program.function(functionId)),
	topology: CoreProgramFlowTopology = buildCoreProgramFlowTopology(targets.graph),
	scheduler: CoreProgramFlowSccSolver = { solveSccs: solveCoreProgramFlowSccs },
): CoreFunctionReachabilityState {
	const all = [...program.functionIds()];
	const allSet = new Set(all);
	const bodyVersions = new Map(previous?.bodyVersions ?? []);
	const cfgVersions = new Map(previous?.cfgVersions ?? []);
	const structural = new Map(previous?.structural ?? []);
	let functionsIndexed = 0;
	let structuralIndexEdges = 0;
	const structurallyChanged = new Set<CoreFunctionId>();
	const dataChanged = previous?.programDataVersion !== program.programVersion("data");
	for (const functionId of previous === undefined || dataChanged
		? all
		: (dirtyFunctions ?? all)) {
		if (!allSet.has(functionId)) continue;
		const fn = program.function(functionId);
		const bodyVersion = fn.version("body") + 1;
		const cfgVersion = fn.version("cfg") + 1;
		if (
			dataChanged ||
			bodyVersions.get(functionId) !== bodyVersion ||
			cfgVersions.get(functionId) !== cfgVersion
		) {
			const edges = structuralEdges(localTransfers(functionId));
			const priorEdges = structural.get(functionId);
			if (sameEdges(priorEdges, edges)) {
				if (priorEdges !== undefined) structural.set(functionId, priorEdges);
			} else {
				structural.set(functionId, edges);
				structurallyChanged.add(functionId);
			}
			bodyVersions.set(functionId, bodyVersion);
			cfgVersions.set(functionId, cfgVersion);
			functionsIndexed++;
			for (const reasons of edges.values()) structuralIndexEdges += reasons.size;
		}
	}
	for (const functionId of previous?.structural.keys() ?? []) {
		if (allSet.has(functionId)) continue;
		structural.delete(functionId);
		bodyVersions.delete(functionId);
		cfgVersions.delete(functionId);
	}

	const { roots, hostInstallSlotsRead } = reachabilityRoots(program, targets, context);
	const liveGraphChanged = [...targets.changedEdgeCallers].some(
		(functionId) => previous?.executable.has(functionId) ?? true,
	);
	const liveStructureChanged = [...structurallyChanged].some(
		(functionId) => previous?.executable.has(functionId) ?? true,
	);
	const liveFunctionRemoved =
		previous !== undefined &&
		[...previous.executable].some((functionId) => !allSet.has(functionId));
	const liveWildcardUniverseChanged =
		previous !== undefined &&
		targets.graph.changedNodes.has(CORE_ANY_SCRIPT_AGGREGATE) &&
		[...previous.targets.graph.wildcardCallers, ...targets.graph.wildcardCallers].some(
			(functionId) => previous.executable.has(functionId),
		);
	if (
		previous !== undefined &&
		previous.sourceClosed === targets.sourceClosed &&
		sameRoots(previous.roots, roots) &&
		!liveGraphChanged &&
		!liveStructureChanged &&
		!liveFunctionRemoved &&
		!liveWildcardUniverseChanged
	) {
		const dead = new Set(
			all.filter((functionId) => !previous.executable.has(functionId)),
		);
		return Object.freeze({
			executable: previous.executable,
			retained: previous.retained,
			dead: sameFunctionSet(previous.dead, dead) ? previous.dead : dead,
			liveFunctions: previous.liveFunctions,
			reasons: previous.reasons,
			sourceClosed: targets.sourceClosed,
			bodyVersions,
			cfgVersions,
			programDataVersion: program.programVersion("data"),
			structural,
			roots,
			targets,
			statistics: Object.freeze({
				functions: all.length,
				functionsIndexed,
				structuralIndexEdges,
				hostInstallSlotsRead,
				functionsScanned: 0,
				exactCallEdgesFollowed: 0,
				wildcardCallerVisits: 0,
				aggregateDependencyVisits: 0,
				structuralEdgesFollowed: 0,
				resultSetUpdates: 0,
				deadFunctions: dead.size,
			}),
		});
	}
	const executable = new Set<CoreFunctionId>();
	const reasons = new Map<CoreFunctionId, ReadonlySet<CoreFunctionReachabilityReason>>();
	const pending = new Map<number, Set<CoreFunctionId>>();
	const seedSccs = new Set<number>();
	const seed = (
		functionId: CoreFunctionId,
		incoming: ReadonlySet<CoreFunctionReachabilityReason>,
	): void => {
		const current = new Set(reasons.get(functionId) ?? []);
		for (const reason of incoming) current.add(reason);
		reasons.set(functionId, current);
		if (executable.has(functionId)) return;
		executable.add(functionId);
		const scc = topology.owner.get(functionId);
		if (scc === undefined) return;
		const functions = pending.get(scc) ?? new Set();
		functions.add(functionId);
		pending.set(scc, functions);
		seedSccs.add(scc);
	};
	for (const [functionId, rootReasons] of roots) seed(functionId, rootReasons);

	let aggregateReached = false;
	let functionsScanned = 0;
	let exactCallEdgesFollowed = 0;
	let wildcardCallerVisits = 0;
	let aggregateDependencyVisits = 0;
	let structuralEdgesFollowed = 0;
	scheduler.solveSccs(
		topology,
		[...seedSccs].map((scc) => ({
			scc,
			dimensions: CORE_PROGRAM_FLOW_REACHABILITY,
		})),
		(sccIndex, dimensions, enqueueScc) => {
			if ((dimensions & CORE_PROGRAM_FLOW_REACHABILITY) === 0) return;
			const queue = [...(pending.get(sccIndex) ?? [])];
			pending.delete(sccIndex);
			const enter = (
				functionId: CoreFunctionId,
				incoming: ReadonlySet<CoreFunctionReachabilityReason>,
			): void => {
				const current = new Set(reasons.get(functionId) ?? []);
				for (const reason of incoming) current.add(reason);
				reasons.set(functionId, current);
				if (executable.has(functionId)) return;
				executable.add(functionId);
				const targetScc = topology.owner.get(functionId);
				if (targetScc === undefined) return;
				if (targetScc === sccIndex) queue.push(functionId);
				else {
					const functions = pending.get(targetScc) ?? new Set();
					functions.add(functionId);
					pending.set(targetScc, functions);
					enqueueScc(targetScc, CORE_PROGRAM_FLOW_REACHABILITY);
				}
			};
			for (let cursor = 0; cursor < queue.length; cursor++) {
				const functionId = queue[cursor]!;
				functionsScanned++;
				for (const callee of targets.graph.exactOutgoing(functionId)) {
					exactCallEdgesFollowed++;
					enter(callee, FINITE_CALL_REASONS);
				}
				if (targets.graph.isWildcardCaller(functionId)) {
					wildcardCallerVisits++;
					if (!aggregateReached) {
						aggregateReached = true;
						for (const callee of targets.graph.functions) {
							aggregateDependencyVisits++;
							enter(callee, ANY_SCRIPT_REASONS);
						}
					}
				}
				for (const [target, edgeReasons] of structural.get(functionId) ?? []) {
					structuralEdgesFollowed += edgeReasons.size;
					enter(target, edgeReasons);
				}
			}
		},
	);

	for (const functionId of executable) {
		const prior = previous?.reasons.get(functionId);
		const next = reasons.get(functionId);
		if (prior !== undefined && sameReasons(prior, next)) reasons.set(functionId, prior);
	}
	let resultSetUpdates = 0;
	for (const functionId of new Set([...(previous?.executable ?? []), ...executable])) {
		if ((previous?.executable.has(functionId) ?? false) !== executable.has(functionId)) {
			resultSetUpdates++;
		}
	}
	const stableExecutable =
		previous !== undefined && sameFunctionSet(previous.executable, executable);
	const finalExecutable = stableExecutable ? previous.executable : executable;
	const computedDead = new Set(all.filter((functionId) => !executable.has(functionId)));
	const dead =
		previous !== undefined && sameFunctionSet(previous.dead, computedDead)
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
		programDataVersion: program.programVersion("data"),
		structural,
		roots,
		targets,
		statistics: Object.freeze({
			functions: all.length,
			functionsIndexed,
			structuralIndexEdges,
			hostInstallSlotsRead,
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
