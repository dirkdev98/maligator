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
	coreCalleeTargetsAreOpen,
} from "./core-ir-call-targets.ts";
import type {
	CoreCallGraphIndex,
	CoreIndexedCallSite,
} from "./core-ir-call-targets.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type {
	CoreFunctionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
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
}

export interface CoreProgramSummaries {
	readonly targets: CoreCallGraphIndex;
	readonly sccs: ReadonlyArray<CoreCallGraphScc>;
	readonly functionEffects: ReadonlyMap<string, FunctionEffectSummary>;
	readonly moduleEffects: ReadonlyMap<string, ModuleEffectSummary>;
	readonly statistics: CoreProgramSummaryStatistics;
	summary(functionId: CoreFunctionId): FunctionEffectSummary | undefined;
	version(functionId: CoreFunctionId): number;
}

interface CoreProgramSummaryState extends CoreProgramSummaries {
	readonly sourceClosed: boolean;
	readonly local: ReadonlyMap<CoreFunctionId, CoreLocalFunctionSummary>;
	readonly published: ReadonlyMap<CoreFunctionId, CorePublishedFunctionSummary>;
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

function returnRepresentation(
	representation: CoreRepresentation,
): ReturnRepresentation {
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
		case "none": return RETURN_PROVENANCE_NONE;
		case "fresh": return { kind: "fresh" };
		case "primitive": return { kind: "primitive" };
		case "parameter": return { kind: "parameter", index: origin.index };
		case "receiver": return { kind: "receiver" };
		case "unknown": return { kind: "unknown" };
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
	program: CoreProgram,
	fn: CoreFunctionStore,
): CoreLocalFunctionSummary {
	const cfg = buildCoreControlFlow(program, fn.id, { exceptions: true });
	const origins = Array<ValueOrigin>(fn.valueCapacity).fill(ORIGIN_NONE);
	for (const [index, parameter] of fn.parameters.entries()) {
		origins[parameter] = Object.freeze({ kind: "parameter", index });
	}
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
						changed =
							raiseOrigin(origins, parameter.value, origins[argument]!) || changed;
					}
				}
			}
			for (const instruction of fn.bodyInstructionIds(block)) {
				const results = fn.instructionResults(instruction);
				if (results.length === 0) continue;
				const opcode = fn.instructionOpcodeName(instruction);
				let origin: ValueOrigin = ORIGIN_UNKNOWN;
				if (opcode === "move") {
					const operand = fn.instructionOperands(instruction)[0];
					origin = operand === undefined ? ORIGIN_UNKNOWN : origins[operand]!;
				} else if (opcode === "loadThis") {
					origin = { kind: "receiver" };
				} else if (FRESH_RESULTS.has(opcode)) {
					origin = { kind: "fresh" };
				} else if (PRIMITIVE_RESULTS.has(opcode)) {
					origin = { kind: "primitive" };
				}
				for (const result of results) {
					changed = raiseOrigin(origins, result, origin) || changed;
				}
			}
		}
	}

	let effects = NO_EFFECT_SUMMARY;
	const parameterEscape = Array<ValueEscapeFact>(fn.parameters.length).fill("none");
	const parameterContainment = Array<ValueContainmentFact>(fn.parameters.length).fill(
		"preserved",
	);
	const receiver = { escape: "none" as ValueEscapeFact, containment: "preserved" as ValueContainmentFact };
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
): {
	readonly sccs: ReadonlyArray<CoreCallGraphScc>;
	readonly owner: ReadonlyMap<CoreFunctionId, number>;
} {
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
	for (const functionId of program.functionIds()) {
		if (!indices.has(functionId)) visit(functionId);
	}
	const owner = new Map<CoreFunctionId, number>();
	const sccs = components.map((functions, index) => {
		for (const functionId of functions) owner.set(functionId, index);
		return Object.freeze({
			id: `scc:${functions.join(",")}`,
			functions: Object.freeze(functions),
		});
	});
	return { sccs: Object.freeze(sccs), owner };
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
			for (const functionId of program.functionIds()) {
				const fn = program.function(functionId);
				for (const block of fn.blockIds()) {
					for (const instruction of fn.bodyInstructionIds(block)) {
						if (
							fn.instructionOpcodeName(instruction) !== "storeGlobal" ||
							fn.instructionAttributes(instruction).index !== slot
						) continue;
						const value = fn.instructionOperands(instruction)[0];
						if (value === undefined) continue;
						const installed = targets.targets(functionId, value);
						for (const target of installed.functions) add(target, "host-install");
					}
				}
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
			[...new Set(targets.outgoing(functionId).flatMap((site) =>
				callTargets(program, site).map((callee) =>
					functionSummaryId(program.function(callee).metadata.sourcePath, callee),
				),
			))].sort(),
		),
		openCallEdge: targets.outgoing(functionId).some((site) =>
			coreCalleeTargetsAreOpen(site.targets),
		),
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
		for (const summary of summaries) effects = joinEffectSummaries(effects, summary.effects);
		const sourcePath = program.function(summaries[0]!.functionIndex as CoreFunctionId).metadata.sourcePath;
		result.set(id, Object.freeze({
			id,
			sourcePath,
			effects,
			functions: Object.freeze(summaries.map(({ id: functionId }) => functionId).sort()),
			externallyReachable: summaries.some(({ externallyReachable }) => externallyReachable),
			evaluated: evaluated.has(sourcePath),
		}));
	}
	return result;
}

function analyzeProgramSummaries(
	program: CoreProgram,
	context: CoreCompilationContext,
	targets: CoreCallGraphIndex,
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
			local.set(functionId, analyzeLocalSummary(program, fn));
			changedFunctions.add(functionId);
			functionsAnalyzed++;
		}
	}
	const { sccs, owner } = callGraphSccs(program, targets);
	const reasons = rootReasons(program, targets, context);
	const current = new Map<CoreFunctionId, FunctionEffectSummary>();
	for (const functionId of program.functionIds()) {
		const prior = previous?.published.get(functionId)?.summary;
		if (prior !== undefined) current.set(functionId, prior);
	}
	for (const functionId of program.functionIds()) {
		if (current.has(functionId)) continue;
		current.set(functionId, deriveSummary(
			program,
			functionId,
			local.get(functionId)!,
			targets,
			current,
			reasons,
			false,
		));
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
		if (targets.statistics.updatedCallSites > 0) {
			for (const functionId of program.functionIds()) {
				if (targets.outgoing(functionId).some(({ id }) => previous.targets.site(id)?.targets !== targets.site(id)?.targets)) {
					enqueue(owner.get(functionId));
				}
			}
		}
	}
	let sccTransfers = 0;
	let callerWakeups = 0;
	const affectedCallers = new Set<CoreFunctionId>();
	const changedPublished = new Set<CoreFunctionId>();
	while (queue.length > 0) {
		const sccIndex = queue.shift()!;
		queued.delete(sccIndex);
		const scc = sccs[sccIndex]!;
		for (const functionId of scc.functions) {
			current.set(functionId, deriveSummary(
				program,
				functionId,
				local.get(functionId)!,
				targets,
				current,
				reasons,
				false,
			));
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const functionId of scc.functions) {
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
				if (prior === undefined || summaryKey(prior) !== summaryKey(next)) changed = true;
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
		current.set(functionId, deriveSummary(
			program,
			functionId,
			local.get(functionId)!,
			targets,
			current,
			reasons,
		));
	}
	const published = new Map<CoreFunctionId, CorePublishedFunctionSummary>();
	for (const [functionId, summary] of current) {
		const prior = previous?.published.get(functionId);
		if (prior !== undefined && summaryKey(prior.summary) === summaryKey(summary)) {
			published.set(functionId, prior);
		} else {
			published.set(functionId, Object.freeze({
				version: (prior?.version ?? 0) + 1,
				summary,
			}));
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
	});
	return Object.freeze({
		sourceClosed: targets.sourceClosed,
		targets,
		sccs,
		local,
		published,
		functionEffects,
		moduleEffects: modules,
		statistics,
		summary(functionId: CoreFunctionId) {
			return published.get(functionId)?.summary;
		},
		version(functionId: CoreFunctionId) {
			return published.get(functionId)?.version ?? 0;
		},
	});
}

export const CORE_PROGRAM_SUMMARIES_ANALYSIS: CoreAnalysisDefinition<CoreProgramSummaryState> = {
	key: "program-summaries",
	scope: "program",
	functionDependencies: ["body", "cfg", "calls", "memoryEffects", "representations"],
	programDependencies: [
		"functions",
		"calls",
		"facts",
		"representations",
		"specializationInputs",
	],
	contextIdentity(context) {
		return context.facts.closure.sourceClosure.kind;
	},
	compute({ program, context, request, previous }) {
		if (request.scope !== "program") throw new Error("Expected program analysis request");
		const targets = CORE_CALL_GRAPH_ANALYSIS.compute({
			program,
			context,
			request,
			previous: (previous as CoreProgramSummaryState | undefined)?.targets,
		});
		return analyzeProgramSummaries(
			program,
			context,
			targets,
			previous as CoreProgramSummaryState | undefined,
		);
	},
};

export function analyzeCoreProgramSummaries(
	program: CoreProgram,
	_contextOrRegistry?: unknown,
	legacyContext?: CoreCompilationContext,
): CoreProgramSummaries {
	const context =
		legacyContext ??
		(_contextOrRegistry !== null &&
		typeof _contextOrRegistry === "object" &&
		"facts" in _contextOrRegistry
			? (_contextOrRegistry as CoreCompilationContext)
			: undefined);
	if (context === undefined) {
		throw new Error("Core program summaries require a compilation context");
	}
	const targets = CORE_CALL_GRAPH_ANALYSIS.compute({
		program,
		context,
		request: { scope: "program" },
	});
	return analyzeProgramSummaries(program, context, targets);
}
