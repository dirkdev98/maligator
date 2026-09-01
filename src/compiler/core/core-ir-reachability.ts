import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_CALL_GRAPH_ANALYSIS } from "./core-ir-call-targets.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreFunctionReachabilityReason =
	| "program-entry"
	| "commonjs-module"
	| "host-install"
	| "finite-call"
	| "any-script"
	| "runtime-identity"
	| "inline-source";

export interface CoreFunctionReachabilityStatistics {
	readonly functions: number;
	readonly functionsIndexed: number;
	readonly structuralIndexEdges: number;
	readonly reachabilityEdgesUpdated: number;
	readonly logicalReachabilityEdgesUpdated: number;
	readonly hostInstallSlotsRead: number;
	readonly functionsScanned: number;
	readonly callEdgesFollowed: number;
	readonly logicalCallEdgesFollowed: number;
	readonly openSourceExpansions: number;
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
	readonly functionVersions: ReadonlyMap<CoreFunctionId, string>;
	readonly programDataVersion: number;
	readonly structural: ReadonlyMap<CoreFunctionId, CoreReachabilityEdges>;
	readonly specificOutgoingEdges: ReadonlyMap<CoreFunctionId, CoreReachabilityEdges>;
	readonly specificReverseEdges: ReadonlyMap<CoreFunctionId, ReadonlySet<CoreFunctionId>>;
	readonly openSources: ReadonlySet<CoreFunctionId>;
	readonly roots: ReadonlyMap<
		CoreFunctionId,
		ReadonlySet<CoreFunctionReachabilityReason>
	>;
	readonly targets: CoreCallGraphIndex;
}

const FUNCTION_INDEX_ATTRIBUTES = new Set([
	"functionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
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

function sourceFunctionIndices(
	program: CoreProgram,
	initial: number | undefined,
): ReadonlyArray<CoreFunctionId> {
	const functions = new Set<CoreFunctionId>();
	const seen = new Set<number>();
	let position = initial;
	while (
		position !== undefined &&
		position >= 0 &&
		position < program.sourcePositions.length &&
		!seen.has(position)
	) {
		seen.add(position);
		const source = program.sourcePositions[position]!;
		if (validFunction(program, source.inlinedFunctionIndex)) {
			functions.add(source.inlinedFunctionIndex);
		}
		position = source.callerPosId;
	}
	return [...functions];
}

function functionVersionKey(fn: CoreFunctionStore): string {
	return `${fn.versions.body}:${fn.versions.cfg}`;
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
	program: CoreProgram,
	fn: CoreFunctionStore,
): CoreReachabilityEdges {
	const edges = new Map<CoreFunctionId, Set<CoreFunctionReachabilityReason>>();
	for (const instruction of fn.instructionIds()) {
		for (const sourceFunction of sourceFunctionIndices(
			program,
			fn.instructionSourcePosition(instruction),
		)) {
			addEdge(edges, sourceFunction, "inline-source");
		}
		if (fn.instructionKind(instruction) !== "operation") continue;
		const attributes = fn.instructionAttributes(instruction);
		for (const key of FUNCTION_INDEX_ATTRIBUTES) {
			const target = attributes[key];
			if (validFunction(program, target)) addEdge(edges, target, "runtime-identity");
		}
		const guarded = attributes.guardedFunctionIndices;
		if (!Array.isArray(guarded)) continue;
		for (const target of guarded) {
			if (validFunction(program, target)) addEdge(edges, target, "runtime-identity");
		}
	}
	return edges;
}

function combinedEdges(
	targets: CoreCallGraphIndex,
	functionId: CoreFunctionId,
	structural: CoreReachabilityEdges,
): { readonly edges: CoreReachabilityEdges; readonly open: boolean } {
	const edges = new Map<CoreFunctionId, Set<CoreFunctionReachabilityReason>>();
	let open = false;
	for (const site of targets.outgoing(functionId)) {
		if (site.targets.anyScript) {
			open = true;
		} else {
			for (const target of site.targets.functions) addEdge(edges, target, "finite-call");
		}
	}
	for (const [target, reasons] of structural) {
		for (const reason of reasons) addEdge(edges, target, reason);
	}
	return { edges, open };
}

const ANY_SCRIPT_REASONS: ReadonlySet<CoreFunctionReachabilityReason> = new Set([
	"any-script",
]);

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
		for (const functionId of all) enter(functionId, "any-script");
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
		for (const target of targets.globalStoreTargets(slot).functions) {
			enter(target, "host-install");
		}
	}
	return { roots, hostInstallSlotsRead: hostInstallSlots.size };
}

export function analyzeCoreFunctionReachability(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	context: CoreCompilationContext,
	previous?: CoreFunctionReachabilityState,
): CoreFunctionReachabilityState {
	const all = [...program.functionIds()];
	const allSet = new Set(all);
	const functionVersions = new Map(previous?.functionVersions ?? []);
	const structural = new Map(previous?.structural ?? []);
	const changedSources = new Set(targets.changedCallers);
	let functionsIndexed = 0;
	let structuralIndexEdges = 0;
	const dataChanged = previous?.programDataVersion !== program.versions.data;
	for (const functionId of all) {
		const fn = program.function(functionId);
		const version = functionVersionKey(fn);
		if (!dataChanged && functionVersions.get(functionId) === version) continue;
		const edges = structuralEdges(program, fn);
		structural.set(functionId, edges);
		functionVersions.set(functionId, version);
		changedSources.add(functionId);
		functionsIndexed++;
		for (const reasons of edges.values()) structuralIndexEdges += reasons.size;
	}
	for (const functionId of previous?.functionVersions.keys() ?? []) {
		if (allSet.has(functionId)) continue;
		functionVersions.delete(functionId);
		structural.delete(functionId);
		changedSources.add(functionId);
	}

	const specificOutgoingEdges = new Map(previous?.specificOutgoingEdges ?? []);
	const specificReverseEdges = new Map(previous?.specificReverseEdges ?? []);
	const openSources = new Set(previous?.openSources ?? []);
	const updatedReverseEdges = new Map<CoreFunctionId, Set<CoreFunctionId>>();
	const affected = new Set<CoreFunctionId>();
	let reachabilityEdgesUpdated = 0;
	let logicalReachabilityEdgesUpdated = 0;
	for (const functionId of changedSources) {
		const prior =
			specificOutgoingEdges.get(functionId) ??
			new Map<CoreFunctionId, ReadonlySet<CoreFunctionReachabilityReason>>();
		const combined = allSet.has(functionId)
			? combinedEdges(
					targets,
					functionId,
					structural.get(functionId) ??
						new Map<CoreFunctionId, ReadonlySet<CoreFunctionReachabilityReason>>(),
				)
			: {
					edges: new Map<CoreFunctionId, Set<CoreFunctionReachabilityReason>>(),
					open: false,
				};
		const next = combined.edges;
		const priorOpen = previous?.openSources.has(functionId) ?? false;
		if (priorOpen !== combined.open) {
			reachabilityEdgesUpdated++;
			logicalReachabilityEdgesUpdated += all.length;
			for (const target of all) affected.add(target);
		}
		if (combined.open) openSources.add(functionId);
		else openSources.delete(functionId);
		for (const target of new Set([...prior.keys(), ...next.keys()])) {
			const oldReasons = prior.get(target);
			const newReasons = next.get(target);
			if (sameReasons(oldReasons, newReasons)) continue;
			affected.add(target);
			const updateCount = Math.max(oldReasons?.size ?? 0, newReasons?.size ?? 0);
			reachabilityEdgesUpdated += updateCount;
			logicalReachabilityEdgesUpdated += updateCount;
			if ((oldReasons?.size ?? 0) === 0 || (newReasons?.size ?? 0) === 0) {
				let reverse = updatedReverseEdges.get(target);
				if (reverse === undefined) {
					reverse = new Set(specificReverseEdges.get(target) ?? []);
					updatedReverseEdges.set(target, reverse);
				}
				if ((newReasons?.size ?? 0) === 0) reverse.delete(functionId);
				else reverse.add(functionId);
			}
		}
		if (allSet.has(functionId)) specificOutgoingEdges.set(functionId, next);
		else specificOutgoingEdges.delete(functionId);
	}
	for (const [target, reverse] of updatedReverseEdges) {
		if (reverse.size === 0) specificReverseEdges.delete(target);
		else specificReverseEdges.set(target, reverse);
	}

	const { roots, hostInstallSlotsRead } = reachabilityRoots(program, targets, context);
	for (const functionId of new Set([
		...(previous?.roots.keys() ?? []),
		...roots.keys(),
	])) {
		if (!sameReasons(previous?.roots.get(functionId), roots.get(functionId))) {
			affected.add(functionId);
		}
	}
	for (const functionId of all) {
		if (!previous?.functionVersions.has(functionId)) affected.add(functionId);
	}

	if (previous === undefined) {
		for (const functionId of all) affected.add(functionId);
	} else {
		const queue = [...affected];
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const functionId = queue[cursor]!;
			if (
				openSources.has(functionId) ||
				(previous?.openSources.has(functionId) ?? false)
			) {
				for (const target of all) {
					if (affected.has(target)) continue;
					affected.add(target);
					queue.push(target);
				}
			}
			const edgeTargets = new Set([
				...(previous.specificOutgoingEdges.get(functionId)?.keys() ?? []),
				...(specificOutgoingEdges.get(functionId)?.keys() ?? []),
			]);
			for (const target of edgeTargets) {
				if (affected.has(target)) continue;
				affected.add(target);
				queue.push(target);
			}
		}
	}

	const executable = new Set(previous?.executable ?? []);
	const reasons = new Map(previous?.reasons ?? []);
	for (const functionId of affected) {
		executable.delete(functionId);
		reasons.delete(functionId);
	}
	const pending: Array<CoreFunctionId> = [];
	const enter = (
		functionId: CoreFunctionId,
		incoming: ReadonlySet<CoreFunctionReachabilityReason>,
	): void => {
		if (!affected.has(functionId)) return;
		const current = new Set(reasons.get(functionId) ?? []);
		for (const reason of incoming) current.add(reason);
		reasons.set(functionId, current);
		if (executable.has(functionId)) return;
		executable.add(functionId);
		pending.push(functionId);
	};
	let anyScriptExpanded = false;
	const stableExecutableOpenSources = [...openSources].filter(
		(source) => !affected.has(source) && executable.has(source),
	).length;
	let callEdgesFollowed = 0;
	let logicalCallEdgesFollowed = 0;
	let openSourceExpansions = 0;
	if (stableExecutableOpenSources > 0) {
		anyScriptExpanded = true;
		callEdgesFollowed += affected.size;
		logicalCallEdgesFollowed += affected.size * stableExecutableOpenSources;
		openSourceExpansions++;
		for (const functionId of affected) enter(functionId, ANY_SCRIPT_REASONS);
	}
	for (const functionId of affected) {
		const rootReasons = roots.get(functionId);
		if (rootReasons !== undefined) enter(functionId, rootReasons);
		for (const source of specificReverseEdges.get(functionId) ?? []) {
			if (affected.has(source) || !executable.has(source)) continue;
			const edgeReasons = specificOutgoingEdges.get(source)?.get(functionId);
			if (edgeReasons !== undefined) enter(functionId, edgeReasons);
		}
	}
	let functionsScanned = 0;
	let structuralEdgesFollowed = 0;
	while (pending.length > 0) {
		const functionId = pending.pop()!;
		functionsScanned++;
		if (openSources.has(functionId)) {
			logicalCallEdgesFollowed += affected.size;
			if (!anyScriptExpanded) {
				anyScriptExpanded = true;
				callEdgesFollowed += affected.size;
				openSourceExpansions++;
				for (const target of affected) enter(target, ANY_SCRIPT_REASONS);
			}
		}
		for (const [target, edgeReasons] of specificOutgoingEdges.get(functionId) ?? []) {
			if (!affected.has(target)) continue;
			for (const reason of edgeReasons) {
				if (reason === "finite-call") {
					callEdgesFollowed++;
					logicalCallEdgesFollowed++;
				} else structuralEdgesFollowed++;
			}
			enter(target, edgeReasons);
		}
	}
	for (const functionId of affected) {
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
	const stableUniverse =
		previous !== undefined &&
		previous.functionVersions.size === all.length &&
		all.every((functionId) => previous.functionVersions.has(functionId));
	const finalExecutable = stableExecutable ? previous.executable : executable;
	const dead =
		stableExecutable && stableUniverse
			? previous.dead
			: new Set(all.filter((functionId) => !executable.has(functionId)));
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
		functionVersions,
		programDataVersion: program.versions.data,
		structural,
		specificOutgoingEdges,
		specificReverseEdges,
		openSources,
		roots,
		targets,
		statistics: Object.freeze({
			functions: all.length,
			functionsIndexed,
			structuralIndexEdges,
			reachabilityEdgesUpdated,
			logicalReachabilityEdgesUpdated,
			hostInstallSlotsRead,
			functionsScanned,
			callEdgesFollowed,
			logicalCallEdgesFollowed,
			openSourceExpansions,
			structuralEdgesFollowed,
			resultSetUpdates,
			deadFunctions: dead.size,
		}),
	});
}

export const CORE_FUNCTION_REACHABILITY_ANALYSIS: CoreAnalysisDefinition<CoreFunctionReachabilityState> =
	{
		key: "function-reachability",
		scope: "program",
		functionDependencies: ["body", "cfg", "calls"],
		programDependencies: ["functions", "data", "calls"],
		contextIdentity(context) {
			return context.facts.closure.sourceClosure.kind;
		},
		compute({ program, context, request, previous, get }) {
			if (request.scope !== "program")
				throw new Error("Expected program analysis request");
			const targets = get(CORE_CALL_GRAPH_ANALYSIS, request);
			return analyzeCoreFunctionReachability(
				program,
				targets,
				context,
				previous as CoreFunctionReachabilityState | undefined,
			);
		},
	};
