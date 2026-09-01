import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreLocalCallSite } from "./core-ir-interprocedural-flow.ts";
import { analyzeCoreInterproceduralValueFlow } from "./core-ir-interprocedural-flow.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

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

export function coreCalleeTargetsFunction(
	functionId: number,
): CoreCalleeTargets {
	return Object.freeze({
		functions: Object.freeze([functionId as CoreFunctionId]),
		anyScript: false,
		opaque: false,
	});
}

export function coreCalleeTargetsIsBottom(targets: CoreCalleeTargets): boolean {
	return (
		targets.functions.length === 0 && !targets.anyScript && !targets.opaque
	);
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
	return Object.freeze({
		functions: Object.freeze(
			functions.length > CORE_CALLEE_TARGET_CAP ? [] : functions,
		),
		anyScript:
			left.anyScript || right.anyScript || functions.length > CORE_CALLEE_TARGET_CAP,
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
	readonly versionKey: string;
	readonly values: ReadonlyArray<CoreCalleeTargets>;
	readonly returnTargets: CoreCalleeTargets;
	readonly sites: ReadonlyArray<CoreIndexedCallSite>;
}

export interface CoreCallGraphStatistics {
	readonly functions: number;
	readonly functionsAnalyzed: number;
	readonly functionsReused: number;
	readonly callSites: number;
	readonly callEdges: number;
	readonly openCallSites: number;
	readonly updatedCallSites: number;
}

export interface CoreCallGraphIndex {
	readonly sourceClosed: boolean;
	readonly statistics: CoreCallGraphStatistics;
	targets(functionId: CoreFunctionId, value: CoreValueId): CoreCalleeTargets;
	returnTargets(functionId: CoreFunctionId): CoreCalleeTargets;
	site(id: CoreCallSiteId): CoreIndexedCallSite | undefined;
	outgoing(functionId: CoreFunctionId): ReadonlyArray<CoreIndexedCallSite>;
	callers(functionId: CoreFunctionId): ReadonlySet<CoreFunctionId>;
}

function functionVersionKey(fn: CoreFunctionStore): string {
	const { body, cfg, calls } = fn.versions;
	return `${body}:${cfg}:${calls}`;
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

function analyzeFunctionTargets(
	program: CoreProgram,
	fn: CoreFunctionStore,
): CoreLocalCallTargets {
	const values = Array<CoreCalleeTargets>(fn.valueCapacity).fill(
		CORE_CALLEE_TARGETS_BOTTOM,
	);
	const raise = (value: CoreValueId, incoming: CoreCalleeTargets): boolean => {
		const current = values[value] ?? CORE_CALLEE_TARGETS_BOTTOM;
		const joined = joinCoreCalleeTargets(current, incoming);
		if (coreCalleeTargetsEqual(current, joined)) return false;
		values[value] = joined;
		return true;
	};
	for (const parameter of fn.parameters) raise(parameter, CORE_CALLEE_TARGETS_OPEN);

	const cfg = buildCoreControlFlow(program, fn.id);
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of cfg.reversePostorder) {
			const parameters = fn.blockParameters(block);
			for (const edge of cfg.predecessors[block] ?? []) {
				if (edge.kind !== "ordinary") continue;
				for (const [index, parameter] of parameters.entries()) {
					const argument = edge.arguments[index];
					if (argument !== undefined) {
						changed = raise(parameter.value, values[argument]!) || changed;
					}
				}
			}
			for (const instruction of fn.bodyInstructionIds(block)) {
				const opcode = fn.instructionOpcodeName(instruction);
				const results = fn.instructionResults(instruction);
				if (results.length === 0) continue;
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
					const operand = fn.instructionOperands(instruction)[0];
					resultTargets =
						operand === undefined
							? CORE_CALLEE_TARGETS_OPEN
							: values[operand]!;
				} else if (DEFINITELY_NON_CALLABLE_RESULTS.has(opcode)) {
					resultTargets = CORE_CALLEE_TARGETS_BOTTOM;
				}
				for (const result of results) changed = raise(result, resultTargets) || changed;
			}
		}
	}

	let returnTargets = CORE_CALLEE_TARGETS_BOTTOM;
	for (const block of cfg.reachable) {
		const terminator = fn.terminatorPayload(fn.blockTerminator(block));
		if (terminator.kind === "return") {
			returnTargets = joinCoreCalleeTargets(
				returnTargets,
				values[terminator.value]!,
			);
		}
	}
	const flow = analyzeCoreInterproceduralValueFlow(fn);
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
	return Object.freeze({
		function: fn.id,
		versionKey: functionVersionKey(fn),
		values: Object.freeze(values),
		returnTargets,
		sites: Object.freeze(sites),
	});
}

interface CoreCallGraphIndexState extends CoreCallGraphIndex {
	readonly local: ReadonlyMap<CoreFunctionId, CoreLocalCallTargets>;
}

function analyzeCallGraph(
	program: CoreProgram,
	sourceClosed: boolean,
	previous?: CoreCallGraphIndexState,
): CoreCallGraphIndexState {
	const local = new Map<CoreFunctionId, CoreLocalCallTargets>();
	let functionsAnalyzed = 0;
	let functionsReused = 0;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		const prior = previous?.local.get(functionId);
		if (prior?.versionKey === functionVersionKey(fn)) {
			local.set(functionId, prior);
			functionsReused++;
		} else {
			local.set(functionId, analyzeFunctionTargets(program, fn));
			functionsAnalyzed++;
		}
	}
	const sites = new Map<CoreCallSiteId, CoreIndexedCallSite>();
	const outgoing = new Map<CoreFunctionId, ReadonlyArray<CoreIndexedCallSite>>();
	const callers = new Map<CoreFunctionId, Set<CoreFunctionId>>();
	let callEdges = 0;
	let openCallSites = 0;
	for (const [functionId, result] of local) {
		outgoing.set(functionId, result.sites);
		for (const site of result.sites) {
			sites.set(site.id, site);
			if (site.open) openCallSites++;
			const targets = site.targets.anyScript
				? [...program.functionIds()]
				: site.targets.functions;
			for (const target of targets) {
				const reverse = callers.get(target) ?? new Set<CoreFunctionId>();
				reverse.add(functionId);
				callers.set(target, reverse);
				callEdges++;
			}
		}
	}
	let updatedCallSites = sites.size;
	if (previous !== undefined) {
		updatedCallSites = 0;
		const keys = new Set<CoreCallSiteId>(sites.keys());
		for (const result of previous.local.values()) {
			for (const site of result.sites) keys.add(site.id);
		}
		for (const key of keys) {
			const current = sites.get(key);
			const prior = previous.site(key);
			if (
				current === undefined ||
				prior === undefined ||
				!coreCalleeTargetsEqual(current.targets, prior.targets)
			) {
				updatedCallSites++;
			}
		}
	}
	const statistics = Object.freeze({
		functions: local.size,
		functionsAnalyzed,
		functionsReused,
		callSites: sites.size,
		callEdges,
		openCallSites,
		updatedCallSites,
	});
	return Object.freeze({
		sourceClosed,
		statistics,
		local,
		targets(functionId: CoreFunctionId, value: CoreValueId) {
			return local.get(functionId)?.values[value] ?? CORE_CALLEE_TARGETS_OPEN;
		},
		returnTargets(functionId: CoreFunctionId) {
			return local.get(functionId)?.returnTargets ?? CORE_CALLEE_TARGETS_OPEN;
		},
		site(id: CoreCallSiteId) {
			return sites.get(id);
		},
		outgoing(functionId: CoreFunctionId) {
			return outgoing.get(functionId) ?? [];
		},
		callers(functionId: CoreFunctionId) {
			return callers.get(functionId) ?? new Set();
		},
	});
}

export const CORE_CALL_GRAPH_ANALYSIS: CoreAnalysisDefinition<CoreCallGraphIndexState> = {
	key: "call-graph",
	scope: "program",
	functionDependencies: ["body", "cfg", "calls"],
	programDependencies: ["functions", "calls", "specializationInputs"],
	contextIdentity(context) {
		return context.facts.closure.sourceClosure.kind;
	},
	compute({ program, context, request, previous }) {
		if (request.scope !== "program") throw new Error("Expected program analysis request");
		return analyzeCallGraph(
			program,
			context.facts.closure.sourceClosure.kind === "known",
			previous as CoreCallGraphIndexState | undefined,
		);
	},
};

export function analyzeCoreCalleeTargets(program: CoreProgram): CoreCallGraphIndex {
	return analyzeCallGraph(program, false);
}

export type CoreCalleeTargetAnalysis = CoreCallGraphIndex;
