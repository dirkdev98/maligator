import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { coreCapturedSlotKey, coreClosedCapturedValueSlots } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreLocalCallSite } from "./core-ir-interprocedural-flow.ts";
import { analyzeCoreInterproceduralValueFlow } from "./core-ir-interprocedural-flow.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
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
	return Object.freeze({
		functions: Object.freeze(functions.length > CORE_CALLEE_TARGET_CAP ? [] : functions),
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
	readonly cellInputs: ReadonlyMap<string, CoreCalleeTargets>;
	readonly cellWrites: ReadonlyMap<string, CoreCalleeTargets>;
	readonly propertyInputs: ReadonlyMap<string, CoreCalleeTargets>;
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

function globalCellKey(index: number): string {
	return `global:${index}`;
}

function capturedCellKey(owner: number, index: number): string {
	return `captured:${coreCapturedSlotKey(owner, index)}`;
}

function functionPropertyKey(functionId: CoreFunctionId, stringIndex: number): string {
	return `function-property:${functionId}:${stringIndex}`;
}

function directCreatedFunction(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): CoreFunctionId | undefined {
	if (seen.has(value)) return undefined;
	seen.add(value);
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction") return undefined;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	if (opcode === "move") {
		const input = fn.instructionOperands(definition.instruction)[0];
		return input === undefined ? undefined : directCreatedFunction(fn, input, seen);
	}
	if (opcode !== "createFunction") return undefined;
	const target = fn.instructionAttributes(definition.instruction).functionIndex;
	return typeof target === "number" && Number.isSafeInteger(target) && target >= 0
		? (target as CoreFunctionId)
		: undefined;
}

function directStringIndex(
	fn: CoreFunctionStore,
	value: CoreValueId,
): number | undefined {
	const definition = fn.valueDefinition(value);
	if (
		definition.kind !== "instruction" ||
		fn.instructionOpcodeName(definition.instruction) !== "createString"
	)
		return undefined;
	const index = fn.instructionAttributes(definition.instruction).stringIndex;
	return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
		? index
		: undefined;
}

function collectKnownFunctionProperties(
	program: CoreProgram,
): ReadonlyMap<string, CoreCalleeTargets> {
	const properties = new Map<string, CoreCalleeTargets>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			if (fn.instructionOpcodeName(instruction) !== "defineProperty") continue;
			const [receiver, key, value] = fn.instructionOperands(instruction);
			if (receiver === undefined || key === undefined || value === undefined) continue;
			const receiverFunction = directCreatedFunction(fn, receiver);
			const stringIndex = directStringIndex(fn, key);
			const valueFunction = directCreatedFunction(fn, value);
			if (
				receiverFunction === undefined ||
				stringIndex === undefined ||
				valueFunction === undefined ||
				receiverFunction >= program.functionCapacity ||
				valueFunction >= program.functionCapacity
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

function instructionCellKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	trackedCells: ReadonlySet<string>,
): string | undefined {
	const key = rawInstructionCellKey(fn, instruction);
	return key !== undefined && trackedCells.has(key) ? key : undefined;
}

function targetsKey(targets: CoreCalleeTargets): string {
	return `${targets.functions.join(",")}:${targets.anyScript ? "a" : "-"}:${targets.opaque ? "o" : "-"}`;
}

function analyzeFunctionTargets(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	cells: ReadonlyMap<string, CoreCalleeTargets>,
	trackedCells: ReadonlySet<string>,
	knownFunctionProperties: ReadonlyMap<string, CoreCalleeTargets>,
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
	for (const parameter of fn.parameters) raise(parameter, CORE_CALLEE_TARGETS_OPAQUE);

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
						operand === undefined ? CORE_CALLEE_TARGETS_OPEN : values[operand]!;
				} else if (opcode === "loadGlobal" || opcode === "loadCaptured") {
					const key = instructionCellKey(fn, instruction, trackedCells);
					resultTargets =
						key === undefined
							? CORE_CALLEE_TARGETS_OPEN
							: (cells.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM);
				} else if (opcode === "loadPropertyStatic") {
					const receiver = fn.instructionOperands(instruction)[0];
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
				for (const result of results) changed = raise(result, resultTargets) || changed;
			}
		}
	}

	let returnTargets = CORE_CALLEE_TARGETS_BOTTOM;
	for (const block of cfg.reachable) {
		const terminator = fn.terminatorPayload(fn.blockTerminator(block));
		if (terminator.kind === "return") {
			returnTargets = joinCoreCalleeTargets(returnTargets, values[terminator.value]!);
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
	const cellInputs = new Map<string, CoreCalleeTargets>();
	const cellWrites = new Map<string, CoreCalleeTargets>();
	const propertyInputs = new Map<string, CoreCalleeTargets>();
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "loadPropertyStatic") {
			const receiver = fn.instructionOperands(instruction)[0];
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
		const value = fn.instructionOperands(instruction)[0];
		if (value === undefined) continue;
		cellWrites.set(
			key,
			joinCoreCalleeTargets(
				cellWrites.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM,
				values[value] ?? CORE_CALLEE_TARGETS_OPEN,
			),
		);
	}
	return Object.freeze({
		function: fn.id,
		versionKey: functionVersionKey(fn),
		values: Object.freeze(values),
		returnTargets,
		sites: Object.freeze(sites),
		cellInputs,
		cellWrites,
		propertyInputs,
	});
}

interface CoreCallGraphIndexState extends CoreCallGraphIndex {
	readonly local: ReadonlyMap<CoreFunctionId, CoreLocalCallTargets>;
	readonly cells: ReadonlyMap<string, CoreCalleeTargets>;
}

export function analyzeCoreCallGraph(
	program: CoreProgram,
	sourceClosed: boolean,
	previous?: CoreCallGraphIndexState,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow = (functionId) =>
		buildCoreControlFlow(program, functionId),
	context?: CoreCompilationContext,
): CoreCallGraphIndexState {
	const knownFunctionProperties = collectKnownFunctionProperties(program);
	const local = new Map<CoreFunctionId, CoreLocalCallTargets>();
	const closedCells = new Set<string>();
	for (const index of context?.data.singleAssignmentGlobalSlots ?? []) {
		closedCells.add(globalCellKey(index));
	}
	for (const key of coreClosedCapturedValueSlots(program, context)) {
		closedCells.add(`captured:${key}`);
	}
	const trackedCells = new Set(closedCells);
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const key = rawInstructionCellKey(fn, instruction);
			if (key !== undefined) trackedCells.add(key);
		}
	}
	const readers = new Map<string, Set<CoreFunctionId>>();
	const currentWriteKeys = new Map<CoreFunctionId, ReadonlySet<string>>();
	const changedFunctions = new Set<CoreFunctionId>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		const writes = new Set<string>();
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const key = instructionCellKey(fn, instruction, trackedCells);
			if (key === undefined) continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "loadGlobal" || opcode === "loadCaptured") {
				const functions = readers.get(key) ?? new Set<CoreFunctionId>();
				functions.add(functionId);
				readers.set(key, functions);
			} else {
				writes.add(key);
			}
		}
		currentWriteKeys.set(functionId, writes);
		const prior = previous?.local.get(functionId);
		if (prior?.versionKey === functionVersionKey(fn)) {
			local.set(functionId, prior);
		} else {
			changedFunctions.add(functionId);
		}
	}
	const affectedFunctions = new Set(changedFunctions);
	for (const [functionId, entry] of local) {
		if (
			[...entry.propertyInputs].some(
				([key, targets]) =>
					targetsKey(targets) !==
					targetsKey(knownFunctionProperties.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM),
			)
		)
			affectedFunctions.add(functionId);
	}
	const affectedCells: Array<string> = [];
	const knownAffectedCells = new Set<string>();
	const markCell = (key: string): void => {
		if (knownAffectedCells.has(key)) return;
		knownAffectedCells.add(key);
		affectedCells.push(key);
	};
	for (const functionId of affectedFunctions) {
		for (const key of previous?.local.get(functionId)?.cellWrites.keys() ?? [])
			markCell(key);
		for (const key of currentWriteKeys.get(functionId) ?? []) markCell(key);
	}
	for (let cursor = 0; cursor < affectedCells.length; cursor++) {
		for (const functionId of readers.get(affectedCells[cursor]!) ?? []) {
			if (affectedFunctions.has(functionId)) continue;
			affectedFunctions.add(functionId);
			for (const key of previous?.local.get(functionId)?.cellWrites.keys() ?? []) {
				markCell(key);
			}
			for (const key of currentWriteKeys.get(functionId) ?? []) markCell(key);
		}
	}
	for (const functionId of affectedFunctions) local.delete(functionId);
	const cells = new Map<string, CoreCalleeTargets>();
	const recomputeCell = (key: string): CoreCalleeTargets => {
		let result = closedCells.has(key)
			? CORE_CALLEE_TARGETS_BOTTOM
			: CORE_CALLEE_TARGETS_OPAQUE;
		for (const entry of local.values()) {
			result = joinCoreCalleeTargets(
				result,
				entry.cellWrites.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM,
			);
		}
		return result;
	};
	for (const key of trackedCells) cells.set(key, recomputeCell(key));
	for (const [functionId, entry] of local) {
		if (
			[...entry.cellInputs].some(
				([key, targets]) =>
					targetsKey(targets) !==
					targetsKey(cells.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM),
			)
		) {
			affectedFunctions.add(functionId);
		}
	}
	for (const functionId of affectedFunctions) local.delete(functionId);
	for (const key of [...cells.keys()]) {
		const targets = recomputeCell(key);
		if (coreCalleeTargetsIsBottom(targets)) cells.delete(key);
		else cells.set(key, targets);
	}
	const queue = [...affectedFunctions].sort((left, right) => left - right);
	const queued = new Set(queue);
	const analyzed = new Set<CoreFunctionId>();
	const enqueue = (functionId: CoreFunctionId): void => {
		if (queued.has(functionId)) return;
		queued.add(functionId);
		queue.push(functionId);
	};
	while (queue.length > 0) {
		const functionId = queue.shift()!;
		queued.delete(functionId);
		const previousLocal = local.get(functionId);
		const next = analyzeFunctionTargets(
			program,
			program.function(functionId),
			controlFlow(functionId),
			cells,
			trackedCells,
			knownFunctionProperties,
		);
		local.set(functionId, next);
		analyzed.add(functionId);
		const writeKeys = new Set([
			...(previousLocal?.cellWrites.keys() ?? []),
			...next.cellWrites.keys(),
		]);
		for (const key of writeKeys) {
			const prior = cells.get(key) ?? CORE_CALLEE_TARGETS_BOTTOM;
			const current = recomputeCell(key);
			if (coreCalleeTargetsEqual(prior, current)) continue;
			if (coreCalleeTargetsIsBottom(current)) cells.delete(key);
			else cells.set(key, current);
			for (const reader of readers.get(key) ?? []) enqueue(reader);
		}
	}
	const functionsAnalyzed = analyzed.size;
	const functionsReused = local.size - functionsAnalyzed;
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
		cells,
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
	compute({ program, context, request, previous, get }) {
		if (request.scope !== "program") throw new Error("Expected program analysis request");
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
		);
	},
};

export function analyzeCoreCalleeTargets(program: CoreProgram): CoreCallGraphIndex {
	return analyzeCoreCallGraph(program, false);
}

export type CoreCalleeTargetAnalysis = CoreCallGraphIndex;
