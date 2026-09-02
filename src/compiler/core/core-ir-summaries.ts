import {
	EVERY_EFFECT_SUMMARY,
	NO_EFFECT_SUMMARY,
	RETURN_PROVENANCE_NONE,
	effectSummariesEqual,
	functionSummaryId,
	joinEffectSummaries,
	joinReturnProvenance,
	joinReturnRepresentation,
	joinValueContainment,
	joinValueEscape,
	moduleSummaryId,
	normalizeRootReasons,
} from "../shared/effect-summary.ts";
import type {
	EffectSummary,
	FunctionEffectSummary,
	ModuleEffectSummary,
	RelativeOwnSlotEffect,
	ReturnProvenance,
	ReturnRepresentation,
	SummaryRootReason,
	ValueContainmentFact,
	ValueEscapeFact,
} from "../shared/effect-summary.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CORE_ANY_SCRIPT_AGGREGATE } from "./core-call-graph.ts";
import type { CoreCallGraphNode } from "./core-call-graph.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CALL_GRAPH_ANALYSIS,
	analyzeCoreCallGraph,
	coreCalleeTargetsAreOpen,
} from "./core-ir-call-targets.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import {
	CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreFunctionId, CoreRepresentation, CoreValueId } from "./core-ir.ts";
import {
	CORE_PROGRAM_FLOW_SUMMARIES,
	CORE_PROGRAM_FLOW_SUMMARY_CONSUMER,
} from "./core-program-flow.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_CALL_EFFECT_SUMMARY_FACT = "call-effect-summary";
export const CORE_CALL_SUMMARY_ATTRIBUTE = "callSummary";

type ValueOrigin =
	| { readonly kind: "none" }
	| { readonly kind: "fresh" }
	| { readonly kind: "primitive" }
	| { readonly kind: "parameter"; readonly index: number }
	| { readonly kind: "receiver" }
	| { readonly kind: "unknown" };

const ORIGIN_NONE: ValueOrigin = Object.freeze({ kind: "none" });
const ORIGIN_UNKNOWN: ValueOrigin = Object.freeze({ kind: "unknown" });

interface CoreLocalFunctionSummary {
	readonly function: CoreFunctionId;
	readonly bodyVersion: number;
	readonly cfgVersion: number;
	readonly callsVersion: number;
	readonly memoryEffectsVersion: number;
	readonly representationsVersion: number;
	readonly sourcePath: string;
	readonly summaryId: string;
	readonly moduleId: string;
	readonly effects: EffectSummary;
	readonly parameterEscape: ReadonlyArray<ValueEscapeFact>;
	readonly receiverEscape: ValueEscapeFact;
	readonly parameterContainment: ReadonlyArray<ValueContainmentFact>;
	readonly receiverContainment: ValueContainmentFact;
	readonly returnProvenance: ReturnProvenance;
	readonly returnRepresentation: ReturnRepresentation;
	readonly origins: ReadonlyArray<ValueOrigin>;
}

export interface CorePublishedFunctionSummary {
	readonly version: number;
	readonly summary: FunctionEffectSummary;
}

export interface CoreCallGraphScc {
	readonly id: string;
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly hasAnyScriptAggregate: boolean;
}

export interface CoreProgramSummaryStatistics {
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

export interface CoreProgramSummaries {
	readonly targets: CoreCallGraphIndex;
	readonly sccs: ReadonlyArray<CoreCallGraphScc>;
	readonly functionEffects: ReadonlyMap<string, FunctionEffectSummary>;
	readonly moduleEffects: ReadonlyMap<string, ModuleEffectSummary>;
	readonly changedFunctions: ReadonlySet<CoreFunctionId>;
	readonly statistics: CoreProgramSummaryStatistics;
	summary(functionId: CoreFunctionId): FunctionEffectSummary | undefined;
	version(functionId: CoreFunctionId): number;
}

interface CoreProgramSummaryState extends CoreProgramSummaries {
	readonly sourceClosed: boolean;
	readonly local: ReadonlyMap<CoreFunctionId, CoreLocalFunctionSummary>;
	readonly published: ReadonlyMap<CoreFunctionId, CorePublishedFunctionSummary>;
	readonly owner: ReadonlyMap<CoreCallGraphNode, number>;
	readonly rootReasons: ReadonlyMap<CoreFunctionId, ReadonlyArray<SummaryRootReason>>;
	readonly anyScriptSummary: CoreAnyScriptCallSummary | undefined;
}

function localSummaryIsCurrent(
	local: CoreLocalFunctionSummary | undefined,
	fn: CoreFunctionStore,
): boolean {
	return (
		local !== undefined &&
		local.bodyVersion === fn.version("body") &&
		local.cfgVersion === fn.version("cfg") &&
		local.callsVersion === fn.version("calls") &&
		local.memoryEffectsVersion === fn.version("memoryEffects") &&
		local.representationsVersion === fn.version("representations")
	);
}

const FRESH_RESULTS = new Set([
	"createArgumentsObject",
	"createArray",
	"createFunction",
	"createModuleNamespace",
	"createObject",
	"createObjectShaped",
	"createPrivateName",
	"createPrivateNames",
	"createRestArguments",
	"createTemplateObject",
]);

const PRIMITIVE_RESULTS = new Set([
	"binary",
	"createBigint",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createString",
	"createUndefined",
	"isEmpty",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"typeofCompare",
	"unary",
]);

function originsEqual(left: ValueOrigin, right: ValueOrigin): boolean {
	return (
		left.kind === right.kind &&
		(left.kind !== "parameter" ||
			(right.kind === "parameter" && left.index === right.index))
	);
}

function joinOrigins(left: ValueOrigin, right: ValueOrigin): ValueOrigin {
	if (left.kind === "none") return right;
	if (right.kind === "none") return left;
	return originsEqual(left, right) ? left : ORIGIN_UNKNOWN;
}

function returnRepresentation(representation: CoreRepresentation): ReturnRepresentation {
	switch (representation) {
		case "i32":
		case "f64":
		case "boolean":
		case "string":
			return representation;
		default:
			return "boxed";
	}
}

function returnProvenance(origin: ValueOrigin): ReturnProvenance {
	switch (origin.kind) {
		case "none":
			return RETURN_PROVENANCE_NONE;
		case "fresh":
			return { kind: "fresh" };
		case "primitive":
			return { kind: "primitive" };
		case "parameter":
			return { kind: "parameter", index: origin.index };
		case "receiver":
			return { kind: "receiver" };
		case "unknown":
			return { kind: "unknown" };
	}
}

function raiseOrigin(
	origins: Array<ValueOrigin>,
	value: CoreValueId,
	incoming: ValueOrigin,
): boolean {
	const current = origins[value] ?? ORIGIN_NONE;
	const next = joinOrigins(current, incoming);
	if (originsEqual(current, next)) return false;
	origins[value] = next;
	return true;
}

function noteEscape(
	origin: ValueOrigin,
	escape: ValueEscapeFact,
	containment: ValueContainmentFact,
	parameterEscape: Array<ValueEscapeFact>,
	parameterContainment: Array<ValueContainmentFact>,
	receiver: { escape: ValueEscapeFact; containment: ValueContainmentFact },
): void {
	if (origin.kind === "parameter") {
		parameterEscape[origin.index] = joinValueEscape(
			parameterEscape[origin.index] ?? "none",
			escape,
		);
		parameterContainment[origin.index] = joinValueContainment(
			parameterContainment[origin.index] ?? "preserved",
			containment,
		);
	} else if (origin.kind === "receiver") {
		receiver.escape = joinValueEscape(receiver.escape, escape);
		receiver.containment = joinValueContainment(receiver.containment, containment);
	}
}

function analyzeLocalSummary(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): CoreLocalFunctionSummary {
	const origins = Array<ValueOrigin>(fn.valueCapacity).fill(ORIGIN_NONE);
	for (let index = 0; index < fn.parameterCount; index++) {
		origins[fn.kernel.functionParameter(index)] = Object.freeze({
			kind: "parameter",
			index,
		});
	}
	type OriginTransfer = {
		readonly output: CoreValueId;
		readonly inputs: ReadonlyArray<CoreValueId>;
		readonly evaluate: () => ValueOrigin;
	};
	const transfers: Array<OriginTransfer> = [];
	for (const block of cfg.reversePostorder) {
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const parameter = fn.kernel.blockParameterValue(parameterStart + index);
			const incoming = (cfg.predecessors[block] ?? []).flatMap((edge) => {
				if (edge.kind !== "ordinary") return [];
				const argument = edge.arguments[index];
				return argument === undefined ? [] : [argument];
			});
			if (incoming.length === 0) continue;
			transfers.push({
				output: parameter,
				inputs: incoming,
				evaluate: () =>
					incoming.reduce(
						(origin, value) => joinOrigins(origin, origins[value]!),
						ORIGIN_NONE,
					),
			});
		}
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			const operand =
				opcode === "move" && fn.kernel.instructionOperandCount(instruction) > 0
					? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction))
					: undefined;
			const inputs = operand === undefined ? [] : [operand];
			const resultStart = fn.kernel.instructionResultStart(instruction);
			const resultCount = fn.kernel.instructionResultCount(instruction);
			for (let index = 0; index < resultCount; index++) {
				const output = fn.kernel.resultAt(resultStart + index);
				transfers.push({
					output,
					inputs,
					evaluate: () => {
						if (operand !== undefined) return origins[operand]!;
						if (opcode === "loadThis") return { kind: "receiver" };
						if (FRESH_RESULTS.has(opcode)) return { kind: "fresh" };
						if (PRIMITIVE_RESULTS.has(opcode)) return { kind: "primitive" };
						return ORIGIN_UNKNOWN;
					},
				});
			}
		}
	}
	const dependents = new Array<Array<number> | undefined>(fn.valueCapacity);
	for (const [index, transfer] of transfers.entries()) {
		for (const input of transfer.inputs) {
			const users = dependents[input] ?? [];
			users.push(index);
			dependents[input] = users;
		}
	}
	const queue = transfers.map((_, index) => index);
	const queued = new Uint8Array(transfers.length);
	queued.fill(1);
	let cursor = 0;
	while (cursor < queue.length) {
		const index = queue[cursor++]!;
		queued[index] = 0;
		const transfer = transfers[index]!;
		if (!raiseOrigin(origins, transfer.output, transfer.evaluate())) continue;
		for (const dependent of dependents[transfer.output] ?? []) {
			if (queued[dependent] !== 0) continue;
			queued[dependent] = 1;
			queue.push(dependent);
		}
	}

	let effects = NO_EFFECT_SUMMARY;
	const parameterEscape = Array<ValueEscapeFact>(fn.parameterCount).fill("none");
	const parameterContainment = Array<ValueContainmentFact>(fn.parameterCount).fill(
		"preserved",
	);
	const receiver = {
		escape: "none" as ValueEscapeFact,
		containment: "preserved" as ValueContainmentFact,
	};
	for (const block of cfg.reachable) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
			const instructionEffects = coreInstructionEffects(fn, instruction);
			effects = joinEffectSummaries(
				effects,
				descriptor.callTransfer === undefined
					? instructionEffects
					: {
							...instructionEffects,
							reads: instructionEffects.reads.filter((domain) => domain !== "host"),
							writes: instructionEffects.writes.filter((domain) => domain !== "host"),
							callsUserCode: false,
						},
			);
			const operandStart = fn.kernel.instructionOperandStart(instruction);
			const operandCount = fn.kernel.instructionOperandCount(instruction);
			for (let operandIndex = 0; operandIndex < operandCount; operandIndex++) {
				const value = fn.kernel.operandAt(operandStart + operandIndex);
				const origin = origins[value]!;
				if (descriptor.observesOperands || descriptor.opcode === "move") continue;
				if (descriptor.callTransfer?.calleeOperand === operandIndex) {
					noteEscape(
						origin,
						"invoked",
						"unknown",
						parameterEscape,
						parameterContainment,
						receiver,
					);
					continue;
				}
				if (descriptor.callTransfer !== undefined) continue;
				noteEscape(
					origin,
					"retained",
					"unknown",
					parameterEscape,
					parameterContainment,
					receiver,
				);
			}
		}
	}

	let provenance: ReturnProvenance = RETURN_PROVENANCE_NONE;
	let representation: ReturnRepresentation = "none";
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind === "throw") {
			effects = joinEffectSummaries(effects, {
				...NO_EFFECT_SUMMARY,
				mayThrow: true,
			});
		}
		if (kind !== "return") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
		const origin = origins[value]!;
		provenance = joinReturnProvenance(provenance, returnProvenance(origin));
		representation = joinReturnRepresentation(
			representation,
			returnRepresentation(fn.valueRepresentation(value)),
		);
		noteEscape(
			origin,
			"returned",
			"preserved",
			parameterEscape,
			parameterContainment,
			receiver,
		);
	}
	return Object.freeze({
		function: fn.id,
		bodyVersion: fn.version("body"),
		cfgVersion: fn.version("cfg"),
		callsVersion: fn.version("calls"),
		memoryEffectsVersion: fn.version("memoryEffects"),
		representationsVersion: fn.version("representations"),
		sourcePath: fn.metadata.sourcePath,
		summaryId: functionSummaryId(fn.metadata.sourcePath, fn.id),
		moduleId: moduleSummaryId(fn.metadata.sourcePath),
		effects,
		parameterEscape: Object.freeze(parameterEscape),
		receiverEscape: receiver.escape,
		parameterContainment: Object.freeze(parameterContainment),
		receiverContainment: receiver.containment,
		returnProvenance: provenance,
		returnRepresentation: representation,
		origins: Object.freeze(origins),
	});
}

function callGraphSccs(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	_previous?: CoreProgramSummaryState,
): {
	readonly sccs: ReadonlyArray<CoreCallGraphScc>;
	readonly owner: ReadonlyMap<CoreCallGraphNode, number>;
	readonly nodesAnalyzed: number;
	readonly edgeVisits: number;
	readonly sccsReused: number;
} {
	const previous = _previous;
	const all: Array<CoreCallGraphNode> = [
		...program.functionIds(),
		...(targets.graph.hasAggregate() ? [CORE_ANY_SCRIPT_AGGREGATE] : []),
	];
	if (previous !== undefined && targets.graph.changedNodes.size === 0) {
		return {
			sccs: previous.sccs,
			owner: previous.owner,
			nodesAnalyzed: 0,
			edgeVisits: 0,
			sccsReused: previous.sccs.length,
		};
	}
	let edgeVisits = 0;
	const affected = new Set<CoreCallGraphNode>();
	if (
		previous !== undefined &&
		!targets.graph.hasAggregate() &&
		!previous.targets.graph.hasAggregate() &&
		targets.graph.functions.length === previous.targets.graph.functions.length &&
		targets.graph.functions.every(
			(functionId, index) => functionId === previous.targets.graph.functions[index],
		)
	) {
		for (const caller of targets.changedEdgeCallers) {
			affected.add(caller);
			for (const callee of targets.graph.exactOutgoing(caller)) affected.add(callee);
			for (const callee of previous.targets.graph.exactOutgoing(caller)) {
				affected.add(callee);
			}
		}
		for (const functionId of program.functionIds()) {
			if (!previous.owner.has(functionId)) affected.add(functionId);
		}
		const queue = [...affected];
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const functionId = queue[cursor]! as CoreFunctionId;
			const neighbors = [
				...targets.graph.exactCallers(functionId),
				...previous.targets.graph.exactCallers(functionId),
				...targets.graph.exactOutgoing(functionId),
				...previous.targets.graph.exactOutgoing(functionId),
			];
			edgeVisits += neighbors.length;
			for (const neighbor of neighbors) {
				if (affected.has(neighbor)) continue;
				affected.add(neighbor);
				queue.push(neighbor);
			}
		}
	} else {
		for (const node of all) affected.add(node);
	}
	if (previous !== undefined && affected.size === 0) {
		return {
			sccs: previous.sccs,
			owner: previous.owner,
			nodesAnalyzed: 0,
			edgeVisits: 0,
			sccsReused: previous.sccs.length,
		};
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
		targets.graph.visitSuccessors(node, (successor) => {
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
	const preserved =
		previous?.sccs.filter(
			(scc) =>
				scc.functions.every((functionId) => !affected.has(functionId)) &&
				!scc.hasAnyScriptAggregate,
		) ?? [];
	const owner = new Map<CoreCallGraphNode, number>();
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
	const sccs = [...preserved, ...rebuilt];
	for (const [index, scc] of sccs.entries()) {
		for (const functionId of scc.functions) owner.set(functionId, index);
		if (scc.hasAnyScriptAggregate) owner.set(CORE_ANY_SCRIPT_AGGREGATE, index);
	}
	return {
		sccs: Object.freeze(sccs),
		owner,
		nodesAnalyzed: affected.size,
		edgeVisits,
		sccsReused: preserved.length,
	};
}

function rootReasons(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	context: CoreCompilationContext,
): ReadonlyMap<CoreFunctionId, ReadonlyArray<SummaryRootReason>> {
	const reasons = new Map<CoreFunctionId, Set<SummaryRootReason>>();
	const add = (functionId: number, reason: SummaryRootReason): void => {
		if (functionId < 0 || functionId >= program.functionCapacity) return;
		const id = functionId as CoreFunctionId;
		const current = reasons.get(id) ?? new Set<SummaryRootReason>();
		current.add(reason);
		reasons.set(id, current);
	};
	if (!targets.sourceClosed) {
		for (const functionId of program.functionIds()) add(functionId, "open-world");
	}
	const [entry] = program.functionIds();
	if (entry !== undefined) add(entry, "program-entry");
	for (const functionId of context.data.cjsModuleFunctionIndices) {
		add(functionId, "commonjs-module");
	}
	for (const candidate of context.data.hostInstallCandidates) {
		for (const { slot } of candidate.exports) {
			const installed = targets.globalStoreTargets(slot);
			for (const target of installed.functions) {
				add(target, "host-install");
			}
			if (installed.anyScript) {
				for (const functionId of program.functionIds()) add(functionId, "host-install");
			}
		}
	}
	return new Map(
		[...reasons].map(([functionId, values]) => [
			functionId,
			normalizeRootReasons(values),
		]),
	);
}

function stringSlicesEqual(
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function relativeOwnSlotEffectsEqual(
	left: ReadonlyArray<RelativeOwnSlotEffect>,
	right: ReadonlyArray<RelativeOwnSlotEffect>,
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const leftEffect = left[index]!;
		const rightEffect = right[index]!;
		if (
			leftEffect.key !== rightEffect.key ||
			leftEffect.mode !== rightEffect.mode ||
			leftEffect.base.kind !== rightEffect.base.kind ||
			(leftEffect.base.kind === "parameter" &&
				(rightEffect.base.kind !== "parameter" ||
					leftEffect.base.index !== rightEffect.base.index))
		) {
			return false;
		}
	}
	return true;
}

function returnProvenancesEqual(
	left: ReturnProvenance,
	right: ReturnProvenance,
): boolean {
	return (
		left.kind === right.kind &&
		(left.kind !== "parameter" ||
			(right.kind === "parameter" && left.index === right.index))
	);
}

function summariesEqual(
	left: FunctionEffectSummary,
	right: FunctionEffectSummary,
): boolean {
	return (
		left === right ||
		(left.id === right.id &&
			left.functionIndex === right.functionIndex &&
			left.module === right.module &&
			effectSummariesEqual(left.effects, right.effects) &&
			relativeOwnSlotEffectsEqual(
				left.relativeOwnSlotEffects,
				right.relativeOwnSlotEffects,
			) &&
			stringSlicesEqual(left.callees, right.callees) &&
			left.openCallEdge === right.openCallEdge &&
			left.externallyReachable === right.externallyReachable &&
			stringSlicesEqual(left.rootReasons, right.rootReasons) &&
			stringSlicesEqual(left.parameterEscape, right.parameterEscape) &&
			left.restParameterEscape === right.restParameterEscape &&
			left.receiverEscape === right.receiverEscape &&
			stringSlicesEqual(left.parameterContainment, right.parameterContainment) &&
			left.restParameterContainment === right.restParameterContainment &&
			left.receiverContainment === right.receiverContainment &&
			returnProvenancesEqual(left.returnProvenance, right.returnProvenance) &&
			left.returnRepresentation === right.returnRepresentation)
	);
}

interface CoreAnyScriptCallSummary {
	readonly effects: EffectSummary;
	readonly parameterEscape: ReadonlyArray<ValueEscapeFact>;
	readonly parameterContainment: ReadonlyArray<ValueContainmentFact>;
	readonly receiverEscape: ValueEscapeFact;
	readonly receiverContainment: ValueContainmentFact;
}

function summarizeAnyScriptCallees(
	current: ReadonlyMap<CoreFunctionId, FunctionEffectSummary>,
	parameterCount: number,
): CoreAnyScriptCallSummary {
	let effects = NO_EFFECT_SUMMARY;
	const parameterEscape = Array<ValueEscapeFact>(parameterCount).fill("none");
	const parameterContainment =
		Array<ValueContainmentFact>(parameterCount).fill("preserved");
	let receiverEscape: ValueEscapeFact = "none";
	let receiverContainment: ValueContainmentFact = "preserved";
	for (const summary of current.values()) {
		effects = joinEffectSummaries(effects, summary.effects);
		for (let index = 0; index < parameterCount; index++) {
			parameterEscape[index] = joinValueEscape(
				parameterEscape[index]!,
				summary.parameterEscape[index] ?? summary.restParameterEscape,
			);
			parameterContainment[index] = joinValueContainment(
				parameterContainment[index]!,
				summary.parameterContainment[index] ?? summary.restParameterContainment,
			);
		}
		receiverEscape = joinValueEscape(receiverEscape, summary.receiverEscape);
		receiverContainment = joinValueContainment(
			receiverContainment,
			summary.receiverContainment,
		);
	}
	return {
		effects,
		parameterEscape,
		parameterContainment,
		receiverEscape,
		receiverContainment,
	};
}

function sameAnyScriptSummary(
	left: CoreAnyScriptCallSummary | undefined,
	right: CoreAnyScriptCallSummary | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		effectSummariesEqual(left.effects, right.effects) &&
		left.receiverEscape === right.receiverEscape &&
		left.receiverContainment === right.receiverContainment &&
		left.parameterEscape.length === right.parameterEscape.length &&
		left.parameterEscape.every(
			(value, index) => value === right.parameterEscape[index],
		) &&
		left.parameterContainment.length === right.parameterContainment.length &&
		left.parameterContainment.every(
			(value, index) => value === right.parameterContainment[index],
		)
	);
}

function deriveSummary(
	program: CoreProgram,
	functionId: CoreFunctionId,
	local: CoreLocalFunctionSummary,
	targets: CoreCallGraphIndex,
	current: ReadonlyMap<CoreFunctionId, FunctionEffectSummary>,
	anyScriptSummary: CoreAnyScriptCallSummary | undefined,
	summaryIds: ReadonlyMap<CoreFunctionId, string>,
	reasons: ReadonlyMap<CoreFunctionId, ReadonlyArray<SummaryRootReason>>,
	includeCalls = true,
): FunctionEffectSummary {
	let effects = local.effects;
	const parameterEscape = [...local.parameterEscape];
	const parameterContainment = [...local.parameterContainment];
	const receiver = {
		escape: local.receiverEscape,
		containment: local.receiverContainment,
	};
	const noteCallFact = (
		value: CoreValueId | undefined,
		escape: ValueEscapeFact,
		containment: ValueContainmentFact,
	): void => {
		if (value === undefined) return;
		noteEscape(
			local.origins[value] ?? ORIGIN_UNKNOWN,
			escape,
			containment,
			parameterEscape,
			parameterContainment,
			receiver,
		);
	};
	const callSites = includeCalls ? targets.outgoing(functionId) : [];
	for (const site of callSites) {
		if (site.targets.opaque || (!targets.sourceClosed && site.targets.anyScript)) {
			effects = joinEffectSummaries(effects, EVERY_EFFECT_SUMMARY);
			for (const argument of site.arguments ?? []) {
				noteCallFact(argument, "retained", "unknown");
			}
			noteCallFact(site.receiver, "retained", "unknown");
			continue;
		}
		if (site.targets.anyScript) {
			if (anyScriptSummary === undefined) {
				throw new Error("Missing AnyScriptAggregate summary");
			}
			effects = joinEffectSummaries(effects, anyScriptSummary.effects);
			for (const [index, argument] of (site.arguments ?? []).entries()) {
				noteCallFact(
					argument,
					anyScriptSummary.parameterEscape[index] ?? "retained",
					anyScriptSummary.parameterContainment[index] ?? "unknown",
				);
			}
			noteCallFact(
				site.receiver,
				anyScriptSummary.receiverEscape,
				anyScriptSummary.receiverContainment,
			);
			continue;
		}
		for (const callee of site.targets.functions) {
			const calleeSummary = current.get(callee);
			if (calleeSummary === undefined) {
				effects = joinEffectSummaries(effects, EVERY_EFFECT_SUMMARY);
				continue;
			}
			effects = joinEffectSummaries(effects, calleeSummary.effects);
			for (const [index, argument] of (site.arguments ?? []).entries()) {
				noteCallFact(
					argument,
					calleeSummary.parameterEscape[index] ?? calleeSummary.restParameterEscape,
					calleeSummary.parameterContainment[index] ??
						calleeSummary.restParameterContainment,
				);
			}
			noteCallFact(
				site.receiver,
				calleeSummary.receiverEscape,
				calleeSummary.receiverContainment,
			);
		}
	}
	const roots = reasons.get(functionId) ?? [];
	return Object.freeze({
		id: local.summaryId,
		functionIndex: functionId,
		module: local.moduleId,
		effects,
		relativeOwnSlotEffects: Object.freeze([]),
		callees: Object.freeze(
			[
				...new Set(
					targets.outgoing(functionId).flatMap((site) =>
						site.targets.functions.flatMap((callee) => {
							const id = summaryIds.get(callee);
							return id === undefined ? [] : [id];
						}),
					),
				),
			].sort(),
		),
		openCallEdge: targets
			.outgoing(functionId)
			.some((site) => coreCalleeTargetsAreOpen(site.targets)),
		externallyReachable: roots.length > 0,
		rootReasons: roots,
		parameterEscape: Object.freeze(parameterEscape),
		restParameterEscape: "retained",
		receiverEscape: receiver.escape,
		parameterContainment: Object.freeze(parameterContainment),
		restParameterContainment: "unknown",
		receiverContainment: receiver.containment,
		returnProvenance: local.returnProvenance,
		returnRepresentation: local.returnRepresentation,
	});
}

function moduleSummaries(
	program: CoreProgram,
	functions: ReadonlyMap<CoreFunctionId, CorePublishedFunctionSummary>,
	context: CoreCompilationContext,
): ReadonlyMap<string, ModuleEffectSummary> {
	const grouped = new Map<string, Array<FunctionEffectSummary>>();
	for (const { summary } of functions.values()) {
		const current = grouped.get(summary.module) ?? [];
		current.push(summary);
		grouped.set(summary.module, current);
	}
	const evaluated = new Set(context.data.moduleEvaluationOrder);
	const result = new Map<string, ModuleEffectSummary>();
	for (const [id, summaries] of grouped) {
		let effects = NO_EFFECT_SUMMARY;
		for (const summary of summaries)
			effects = joinEffectSummaries(effects, summary.effects);
		const sourcePath = program.function(summaries[0]!.functionIndex as CoreFunctionId)
			.metadata.sourcePath;
		result.set(
			id,
			Object.freeze({
				id,
				sourcePath,
				effects,
				functions: Object.freeze(
					summaries.map(({ id: functionId }) => functionId).sort(),
				),
				externallyReachable: summaries.some(
					({ externallyReachable }) => externallyReachable,
				),
				evaluated: evaluated.has(sourcePath),
			}),
		);
	}
	return result;
}

function analyzeProgramSummaries(
	program: CoreProgram,
	context: CoreCompilationContext,
	targets: CoreCallGraphIndex,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
	previous?: CoreProgramSummaryState,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
): CoreProgramSummaryState {
	const local = new Map<CoreFunctionId, CoreLocalFunctionSummary>();
	const changedFunctions = new Set<CoreFunctionId>();
	const dirty = new Set(
		previous === undefined ? program.functionIds() : (dirtyFunctions ?? program.functionIds()),
	);
	let functionsAnalyzed = 0;
	let functionsReused = 0;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		const prior = previous?.local.get(functionId);
		if (!dirty.has(functionId) || localSummaryIsCurrent(prior, fn)) {
			if (prior === undefined) throw new Error(`Missing local summary for ${functionId}`);
			local.set(functionId, prior);
			functionsReused++;
		} else {
			local.set(functionId, analyzeLocalSummary(fn, controlFlow(functionId)));
			changedFunctions.add(functionId);
			functionsAnalyzed++;
		}
	}
	const {
		sccs,
		owner,
		nodesAnalyzed: sccNodesAnalyzed,
		edgeVisits: sccEdgeVisits,
		sccsReused,
	} = callGraphSccs(program, targets, previous);
	const reasons = rootReasons(program, targets, context);
	const summaryIds = new Map(
		[...local].map(([functionId, summary]) => [functionId, summary.summaryId]),
	);
	const current = new Map<CoreFunctionId, FunctionEffectSummary>();
	for (const functionId of program.functionIds()) {
		const prior = previous?.published.get(functionId)?.summary;
		if (prior !== undefined) current.set(functionId, prior);
	}
	for (const functionId of program.functionIds()) {
		if (current.has(functionId)) continue;
		current.set(
			functionId,
			deriveSummary(
				program,
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
	const maximumWildcardArgumentCount = [...program.functionIds()].reduce(
		(largest, functionId) =>
			Math.max(
				largest,
				...targets
					.outgoing(functionId)
					.filter((site) => site.targets.anyScript)
					.map((site) => site.arguments?.length ?? 0),
			),
		0,
	);
	let anyScriptSummary = targets.graph.hasAggregate()
		? previous?.anyScriptSummary
		: undefined;
	if (
		targets.graph.hasAggregate() &&
		(anyScriptSummary === undefined ||
			anyScriptSummary.parameterEscape.length !== maximumWildcardArgumentCount)
	) {
		anyScriptSummary = summarizeAnyScriptCallees(current, maximumWildcardArgumentCount);
	}
	const queue: Array<number> = [];
	const queued = new Set<number>();
	const enqueue = (scc: number | undefined): boolean => {
		if (scc === undefined || queued.has(scc)) return false;
		queued.add(scc);
		queue.push(scc);
		return true;
	};
	if (previous === undefined || previous.sourceClosed !== targets.sourceClosed) {
		for (const index of sccs.keys()) enqueue(index);
	} else {
		for (const functionId of changedFunctions) enqueue(owner.get(functionId));
		for (const functionId of targets.changedCallers) {
			enqueue(owner.get(functionId));
		}
		if (targets.graph.changedNodes.has(CORE_ANY_SCRIPT_AGGREGATE)) {
			enqueue(owner.get(CORE_ANY_SCRIPT_AGGREGATE));
		}
		for (const functionId of new Set([
			...previous.rootReasons.keys(),
			...reasons.keys(),
		])) {
			const prior = previous.rootReasons.get(functionId) ?? [];
			const next = reasons.get(functionId) ?? [];
			if (
				prior.length !== next.length ||
				prior.some((reason, index) => reason !== next[index])
			) {
				enqueue(owner.get(functionId));
			}
		}
	}
	let sccTransfers = 0;
	let callerWakeups = 0;
	let aggregateRecomputations = 0;
	let exactReverseCallerVisits = 0;
	let wildcardReverseCallerVisits = 0;
	const affectedCallers = new Set<CoreFunctionId>();
	let queueCursor = 0;
	while (queueCursor < queue.length) {
		const sccIndex = queue[queueCursor++]!;
		queued.delete(sccIndex);
		const scc = sccs[sccIndex]!;
		const aggregateBefore = anyScriptSummary;
		for (const functionId of scc.functions) {
			current.set(
				functionId,
				deriveSummary(
					program,
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
		const members = new Set(scc.functions);
		const memberQueue: Array<CoreCallGraphNode> = [
			...(scc.hasAnyScriptAggregate ? [CORE_ANY_SCRIPT_AGGREGATE] : []),
			...scc.functions,
		];
		const memberQueued = new Set(memberQueue);
		let memberCursor = 0;
		while (memberCursor < memberQueue.length) {
			const node = memberQueue[memberCursor++]!;
			memberQueued.delete(node);
			if (node === CORE_ANY_SCRIPT_AGGREGATE) {
				const nextAggregate = summarizeAnyScriptCallees(
					current,
					maximumWildcardArgumentCount,
				);
				aggregateRecomputations++;
				if (sameAnyScriptSummary(anyScriptSummary, nextAggregate)) continue;
				anyScriptSummary = nextAggregate;
				for (const caller of targets.graph.wildcardCallers) {
					wildcardReverseCallerVisits++;
					if (!members.has(caller) || memberQueued.has(caller)) continue;
					memberQueued.add(caller);
					memberQueue.push(caller);
				}
				continue;
			}
			const functionId = node;
			const next = deriveSummary(
				program,
				functionId,
				local.get(functionId)!,
				targets,
				current,
				anyScriptSummary,
				summaryIds,
				reasons,
			);
			const prior = current.get(functionId);
			current.set(functionId, next);
			sccTransfers++;
			if (prior !== undefined && summariesEqual(prior, next)) continue;
			for (const caller of targets.graph.exactCallers(functionId)) {
				exactReverseCallerVisits++;
				if (!members.has(caller) || memberQueued.has(caller)) continue;
				memberQueued.add(caller);
				memberQueue.push(caller);
			}
			if (scc.hasAnyScriptAggregate && !memberQueued.has(CORE_ANY_SCRIPT_AGGREGATE)) {
				memberQueued.add(CORE_ANY_SCRIPT_AGGREGATE);
				memberQueue.push(CORE_ANY_SCRIPT_AGGREGATE);
			}
		}
		for (const functionId of scc.functions) {
			const next = current.get(functionId)!;
			const prior = previous?.published.get(functionId)?.summary;
			if (prior !== undefined && summariesEqual(prior, next)) continue;
			for (const caller of targets.graph.exactCallers(functionId)) {
				exactReverseCallerVisits++;
				const callerScc = owner.get(caller);
				if (callerScc === sccIndex) continue;
				if (enqueue(callerScc)) callerWakeups++;
				affectedCallers.add(caller);
			}
			if (targets.graph.hasAggregate()) {
				const aggregateScc = owner.get(CORE_ANY_SCRIPT_AGGREGATE);
				if (aggregateScc !== sccIndex && enqueue(aggregateScc)) callerWakeups++;
			}
		}
		if (
			scc.hasAnyScriptAggregate &&
			!sameAnyScriptSummary(aggregateBefore, anyScriptSummary)
		) {
			for (const caller of targets.graph.wildcardCallers) {
				wildcardReverseCallerVisits++;
				const callerScc = owner.get(caller);
				if (callerScc === sccIndex) continue;
				if (enqueue(callerScc)) callerWakeups++;
				affectedCallers.add(caller);
			}
		}
	}
	for (const functionId of program.functionIds()) {
		if (current.has(functionId)) continue;
		current.set(
			functionId,
			deriveSummary(
				program,
				functionId,
				local.get(functionId)!,
				targets,
				current,
				anyScriptSummary,
				summaryIds,
				reasons,
			),
		);
	}
	const published = new Map<CoreFunctionId, CorePublishedFunctionSummary>();
	const changedPublished = new Set<CoreFunctionId>();
	for (const [functionId, summary] of current) {
		const prior = previous?.published.get(functionId);
		if (prior !== undefined && summariesEqual(prior.summary, summary)) {
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
	const modules = moduleSummaries(program, published, context);
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
		owner,
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

export const CORE_PROGRAM_SUMMARIES_ANALYSIS: CoreAnalysisDefinition<CoreProgramSummaryState> =
	{
		key: "program-summaries",
		scope: "program",
		functionDependencies: ["body", "cfg", "calls", "memoryEffects", "representations"],
		programDependencies: ["functions", "calls"],
		contextIdentity(context) {
			return context.facts.closure.sourceClosure.kind;
		},
		compute({ program, context, request, previous, get, programFlow }) {
			if (request.scope !== "program")
				throw new Error("Expected program analysis request");
			const targets = get(CORE_CALL_GRAPH_ANALYSIS, request);
			const flow = programFlow.refresh(
				CORE_PROGRAM_FLOW_SUMMARY_CONSUMER,
				CORE_PROGRAM_FLOW_SUMMARIES,
			);
			const dirtyFunctions = new Array<CoreFunctionId>();
			if (previous !== undefined) {
				for (let index = 0; index < flow.dirtyFunctionCount; index++) {
					dirtyFunctions.push(flow.dirtyFunctionAt(index));
				}
			}
			return analyzeProgramSummaries(
				program,
				context,
				targets,
				(functionId) =>
					get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, {
						scope: "function",
						function: functionId,
					}),
				previous as CoreProgramSummaryState | undefined,
				dirtyFunctions,
			);
		},
	};

export function analyzeCoreProgramSummaries(
	program: CoreProgram,
	context: CoreCompilationContext,
): CoreProgramSummaries {
	const targets = analyzeCoreCallGraph(
		program,
		context.facts.closure.sourceClosure.kind === "known",
		undefined,
		undefined,
		context,
	);
	return analyzeProgramSummaries(program, context, targets, (functionId) =>
		buildCoreControlFlow(program, functionId, { exceptions: true }),
	);
}
