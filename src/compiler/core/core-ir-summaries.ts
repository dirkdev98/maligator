import {
	EVERY_EFFECT_SUMMARY,
	NO_EFFECT_SUMMARY,
	RETURN_PROVENANCE_NONE,
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
	ReturnProvenance,
	ReturnRepresentation,
	SummaryRootReason,
	ValueContainmentFact,
	ValueEscapeFact,
} from "../shared/effect-summary.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CALL_GRAPH_ANALYSIS,
	analyzeCoreCallGraph,
	coreCalleeTargetsAreOpen,
} from "./core-ir-call-targets.ts";
import type { CoreCallGraphIndex, CoreIndexedCallSite } from "./core-ir-call-targets.ts";
import {
	CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreFunctionId, CoreRepresentation, CoreValueId } from "./core-ir.ts";
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
	readonly versionKey: string;
	readonly sourcePath: string;
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
}

export interface CoreProgramSummaryStatistics {
	readonly functions: number;
	readonly functionsAnalyzed: number;
	readonly functionsReused: number;
	readonly sccs: number;
	readonly sccTransfers: number;
	readonly summaryChanges: number;
	readonly callerWakeups: number;
	readonly affectedCallers: number;
	readonly sccNodesAnalyzed: number;
	readonly sccsReused: number;
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
	readonly owner: ReadonlyMap<CoreFunctionId, number>;
	readonly rootReasons: ReadonlyMap<CoreFunctionId, ReadonlyArray<SummaryRootReason>>;
}

function localVersionKey(fn: CoreFunctionStore): string {
	const { body, cfg, calls, memoryEffects, representations } = fn.versions;
	return `${body}:${cfg}:${calls}:${memoryEffects}:${representations}`;
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
	for (const [index, parameter] of fn.parameters.entries()) {
		origins[parameter] = Object.freeze({ kind: "parameter", index });
	}
	type OriginTransfer = {
		readonly output: CoreValueId;
		readonly inputs: ReadonlyArray<CoreValueId>;
		readonly evaluate: () => ValueOrigin;
	};
	const transfers: Array<OriginTransfer> = [];
	for (const block of cfg.reversePostorder) {
		const parameters = fn.blockParameters(block);
		for (const [index, parameter] of parameters.entries()) {
			const incoming = (cfg.predecessors[block] ?? []).flatMap((edge) => {
				if (edge.kind !== "ordinary") return [];
				const argument = edge.arguments[index];
				return argument === undefined ? [] : [argument];
			});
			if (incoming.length === 0) continue;
			transfers.push({
				output: parameter.value,
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
				opcode === "move" ? fn.instructionOperands(instruction)[0] : undefined;
			const inputs = operand === undefined ? [] : [operand];
			for (const output of fn.instructionResults(instruction)) {
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
	const dependents = Array.from({ length: fn.valueCapacity }, () => new Array<number>());
	for (const [index, transfer] of transfers.entries()) {
		for (const input of transfer.inputs) dependents[input]!.push(index);
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
		for (const dependent of dependents[transfer.output]!) {
			if (queued[dependent] !== 0) continue;
			queued[dependent] = 1;
			queue.push(dependent);
		}
	}

	let effects = NO_EFFECT_SUMMARY;
	const parameterEscape = Array<ValueEscapeFact>(fn.parameters.length).fill("none");
	const parameterContainment = Array<ValueContainmentFact>(fn.parameters.length).fill(
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
			for (const [operandIndex, value] of fn.instructionOperands(instruction).entries()) {
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
		const terminator = fn.terminatorPayload(fn.blockTerminator(block));
		if (terminator.kind === "throw") {
			effects = joinEffectSummaries(effects, {
				...NO_EFFECT_SUMMARY,
				mayThrow: true,
			});
		}
		if (terminator.kind !== "return") continue;
		const origin = origins[terminator.value]!;
		provenance = joinReturnProvenance(provenance, returnProvenance(origin));
		representation = joinReturnRepresentation(
			representation,
			returnRepresentation(fn.valueRepresentation(terminator.value)),
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
		versionKey: localVersionKey(fn),
		sourcePath: fn.metadata.sourcePath,
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

function callTargets(
	program: CoreProgram,
	site: CoreIndexedCallSite,
): ReadonlyArray<CoreFunctionId> {
	return site.targets.anyScript ? [...program.functionIds()] : site.targets.functions;
}

function callGraphSccs(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	previous?: CoreProgramSummaryState,
): {
	readonly sccs: ReadonlyArray<CoreCallGraphScc>;
	readonly owner: ReadonlyMap<CoreFunctionId, number>;
	readonly nodesAnalyzed: number;
	readonly sccsReused: number;
} {
	const all = [...program.functionIds()];
	const affected = new Set<CoreFunctionId>();
	for (const caller of targets.changedEdgeCallers) {
		affected.add(caller);
		for (const site of targets.outgoing(caller)) {
			for (const callee of callTargets(program, site)) affected.add(callee);
		}
		for (const site of previous?.targets.outgoing(caller) ?? []) {
			for (const callee of callTargets(program, site)) affected.add(callee);
		}
	}
	for (const functionId of all) {
		if (!previous?.owner.has(functionId)) affected.add(functionId);
	}
	if (previous !== undefined && affected.size === 0) {
		return {
			sccs: previous.sccs,
			owner: previous.owner,
			nodesAnalyzed: 0,
			sccsReused: previous.sccs.length,
		};
	}
	if (previous !== undefined) {
		const queue = [...affected];
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const functionId = queue[cursor]!;
			const neighbors = new Set<CoreFunctionId>([
				...targets.callers(functionId),
				...previous.targets.callers(functionId),
			]);
			for (const site of targets.outgoing(functionId)) {
				for (const callee of callTargets(program, site)) neighbors.add(callee);
			}
			for (const site of previous.targets.outgoing(functionId)) {
				for (const callee of callTargets(program, site)) neighbors.add(callee);
			}
			for (const neighbor of neighbors) {
				if (affected.has(neighbor)) continue;
				affected.add(neighbor);
				queue.push(neighbor);
			}
		}
	} else {
		for (const functionId of all) affected.add(functionId);
	}

	let nextIndex = 0;
	const indices = new Map<CoreFunctionId, number>();
	const lowlinks = new Map<CoreFunctionId, number>();
	const stack: Array<CoreFunctionId> = [];
	const onStack = new Set<CoreFunctionId>();
	const components: Array<Array<CoreFunctionId>> = [];
	const visit = (functionId: CoreFunctionId): void => {
		indices.set(functionId, nextIndex);
		lowlinks.set(functionId, nextIndex++);
		stack.push(functionId);
		onStack.add(functionId);
		for (const site of targets.outgoing(functionId)) {
			for (const callee of callTargets(program, site)) {
				if (!affected.has(callee)) continue;
				if (!indices.has(callee)) {
					visit(callee);
					lowlinks.set(
						functionId,
						Math.min(lowlinks.get(functionId)!, lowlinks.get(callee)!),
					);
				} else if (onStack.has(callee)) {
					lowlinks.set(
						functionId,
						Math.min(lowlinks.get(functionId)!, indices.get(callee)!),
					);
				}
			}
		}
		if (lowlinks.get(functionId) !== indices.get(functionId)) return;
		const component: Array<CoreFunctionId> = [];
		while (stack.length > 0) {
			const member = stack.pop()!;
			onStack.delete(member);
			component.push(member);
			if (member === functionId) break;
		}
		components.push(component.sort((left, right) => left - right));
	};
	for (const functionId of affected) {
		if (!indices.has(functionId)) visit(functionId);
	}
	const preserved =
		previous?.sccs.filter((scc) =>
			scc.functions.every((functionId) => !affected.has(functionId)),
		) ?? [];
	const owner = new Map<CoreFunctionId, number>();
	const sccs = [
		...preserved,
		...components.map((functions) =>
			Object.freeze({
				id: `scc:${functions.join(",")}`,
				functions: Object.freeze(functions),
			}),
		),
	];
	for (const [index, scc] of sccs.entries()) {
		const functions = scc.functions;
		for (const functionId of functions) owner.set(functionId, index);
	}
	return {
		sccs: Object.freeze(sccs),
		owner,
		nodesAnalyzed: affected.size,
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
			for (const target of targets.globalStoreTargets(slot).functions) {
				add(target, "host-install");
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

function summaryKey(summary: FunctionEffectSummary): string {
	return JSON.stringify(summary);
}

function deriveSummary(
	program: CoreProgram,
	functionId: CoreFunctionId,
	local: CoreLocalFunctionSummary,
	targets: CoreCallGraphIndex,
	current: ReadonlyMap<CoreFunctionId, FunctionEffectSummary>,
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
		const callees = callTargets(program, site);
		if (site.targets.opaque || (!targets.sourceClosed && site.targets.anyScript)) {
			effects = joinEffectSummaries(effects, EVERY_EFFECT_SUMMARY);
			for (const argument of site.arguments ?? []) {
				noteCallFact(argument, "retained", "unknown");
			}
			noteCallFact(site.receiver, "retained", "unknown");
			continue;
		}
		for (const callee of callees) {
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
		id: functionSummaryId(local.sourcePath, functionId),
		functionIndex: functionId,
		module: moduleSummaryId(local.sourcePath),
		effects,
		relativeOwnSlotEffects: Object.freeze([]),
		callees: Object.freeze(
			[
				...new Set(
					targets
						.outgoing(functionId)
						.flatMap((site) =>
							callTargets(program, site).map((callee) =>
								functionSummaryId(program.function(callee).metadata.sourcePath, callee),
							),
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
): CoreProgramSummaryState {
	const local = new Map<CoreFunctionId, CoreLocalFunctionSummary>();
	const changedFunctions = new Set<CoreFunctionId>();
	let functionsAnalyzed = 0;
	let functionsReused = 0;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		const prior = previous?.local.get(functionId);
		if (prior?.versionKey === localVersionKey(fn)) {
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
		sccsReused,
	} = callGraphSccs(program, targets, previous);
	const reasons = rootReasons(program, targets, context);
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
				reasons,
				false,
			),
		);
	}
	const queue: Array<number> = [];
	const queued = new Set<number>();
	const enqueue = (scc: number | undefined): void => {
		if (scc === undefined || queued.has(scc)) return;
		queued.add(scc);
		queue.push(scc);
	};
	if (previous === undefined || previous.sourceClosed !== targets.sourceClosed) {
		for (const index of sccs.keys()) enqueue(index);
	} else {
		for (const functionId of changedFunctions) enqueue(owner.get(functionId));
		for (const functionId of targets.changedCallers) {
			enqueue(owner.get(functionId));
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
	const affectedCallers = new Set<CoreFunctionId>();
	const changedPublished = new Set<CoreFunctionId>();
	let queueCursor = 0;
	while (queueCursor < queue.length) {
		const sccIndex = queue[queueCursor++]!;
		queued.delete(sccIndex);
		const scc = sccs[sccIndex]!;
		for (const functionId of scc.functions) {
			current.set(
				functionId,
				deriveSummary(
					program,
					functionId,
					local.get(functionId)!,
					targets,
					current,
					reasons,
					false,
				),
			);
		}
		const members = new Set(scc.functions);
		const memberQueue = [...scc.functions];
		const memberQueued = new Set(scc.functions);
		let memberCursor = 0;
		while (memberCursor < memberQueue.length) {
			const functionId = memberQueue[memberCursor++]!;
			memberQueued.delete(functionId);
			const next = deriveSummary(
				program,
				functionId,
				local.get(functionId)!,
				targets,
				current,
				reasons,
			);
			const prior = current.get(functionId);
			current.set(functionId, next);
			sccTransfers++;
			if (prior !== undefined && summaryKey(prior) === summaryKey(next)) continue;
			for (const caller of targets.callers(functionId)) {
				if (!members.has(caller) || memberQueued.has(caller)) continue;
				memberQueued.add(caller);
				memberQueue.push(caller);
			}
		}
		for (const functionId of scc.functions) {
			const next = current.get(functionId)!;
			const prior = previous?.published.get(functionId)?.summary;
			if (prior !== undefined && summaryKey(prior) === summaryKey(next)) continue;
			changedPublished.add(functionId);
			for (const caller of targets.callers(functionId)) {
				const callerScc = owner.get(caller);
				if (callerScc === sccIndex) continue;
				enqueue(callerScc);
				callerWakeups++;
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
				reasons,
			),
		);
	}
	const published = new Map<CoreFunctionId, CorePublishedFunctionSummary>();
	for (const [functionId, summary] of current) {
		const prior = previous?.published.get(functionId);
		if (prior !== undefined && summaryKey(prior.summary) === summaryKey(summary)) {
			published.set(functionId, prior);
		} else {
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
		summaryChanges: changedPublished.size,
		callerWakeups,
		affectedCallers: affectedCallers.size,
		sccNodesAnalyzed,
		sccsReused,
	});
	return Object.freeze({
		sourceClosed: targets.sourceClosed,
		targets,
		sccs,
		local,
		published,
		owner,
		rootReasons: reasons,
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
		programDependencies: ["functions", "calls", "facts", "representations"],
		contextIdentity(context) {
			return context.facts.closure.sourceClosure.kind;
		},
		compute({ program, context, request, previous, get }) {
			if (request.scope !== "program")
				throw new Error("Expected program analysis request");
			const targets = get(CORE_CALL_GRAPH_ANALYSIS, request);
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
