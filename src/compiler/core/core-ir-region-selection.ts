import type { ReturnRepresentation } from "../shared/effect-summary.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import { coreGeneratedCodeCostModel } from "./core-ir-generated-cost.ts";
import { CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS } from "./core-ir-provenance.ts";
import type { CoreLocalSpecializationCandidate } from "./core-ir-provenance.ts";
import { corePlanVersionStamp } from "./core-ir-region-validity.ts";
import type {
	CoreDirectEntryCallSite,
	CoreDirectEntryPlan,
	CoreOptimizationPlan,
	CoreOptimizationPlanStatistics,
	CorePlanRepresentation,
	CorePlanSpecialization,
	CorePlanSpecializationKind,
} from "./core-ir-regions.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreProgram } from "./core-store.ts";
import {
	CoreTransformCandidateService,
} from "./core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
	CoreTransformDeclineReason,
} from "./core-transform-candidates.ts";

export const DEFAULT_CORE_SPECIALIZATION_BUDGETS: CoreTransformBudgetLimits =
	Object.freeze({
		perSiteExpansions: 1,
		perCallerExpansions: 4,
		perCallerGeneratedCode: 512,
		perCallerCompilerWork: 2_048,
		programGeneratedCode: 4_096,
		programCompilerWork: 32_768,
	});

interface PendingSpecialization {
	readonly budget: CoreTransformCandidate;
	readonly selection: CorePlanSpecialization;
}

interface PendingDirectEntry {
	readonly budget: CoreTransformCandidate;
	readonly function: CoreFunctionId;
	readonly callSites: ReadonlyArray<CoreDirectEntryCallSite>;
	readonly parameterRepresentations: ReadonlyArray<CorePlanRepresentation>;
	readonly resultRepresentation: CorePlanRepresentation;
}

type PendingCandidate = PendingSpecialization | PendingDirectEntry;

function isPendingDirectEntry(candidate: PendingCandidate): candidate is PendingDirectEntry {
	return "callSites" in candidate;
}

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function planRepresentation(
	representation: ReturnRepresentation,
): CorePlanRepresentation | undefined {
	switch (representation) {
		case "boxed": return "boxed";
		case "f64": return "f64";
		case "i32": return "i32";
		case "boolean": return "boolean";
		case "string": return "string";
		case "none": return undefined;
	}
}

function localKind(
	kind: CoreLocalSpecializationCandidate["kind"],
): CorePlanSpecializationKind {
	if (kind === "stack-object") return "stack-object-plan";
	if (kind === "dense-array") return "dense-array-plan";
	return "numeric-fusion";
}

function localRepresentation(
	kind: CoreLocalSpecializationCandidate["kind"],
): string {
	if (kind === "stack-object") return "activation-local-fixed-shape-objects";
	if (kind === "dense-array") return "contained-dense-elements";
	return "binary-pairs-f64";
}

function localRequirements(
	program: CoreProgram,
	candidate: CoreLocalSpecializationCandidate,
): ReadonlyArray<{ readonly value: CoreValueId; readonly representation: CoreRepresentation }> {
	const fn = program.function(candidate.function);
	const requirements = new Map<CoreValueId, CoreRepresentation>();
	for (const instruction of candidate.instructions) {
		if (!fn.isInstructionLive(instruction)) continue;
		for (const value of [
			...fn.instructionOperands(instruction),
			...fn.instructionResults(instruction),
		]) {
			requirements.set(value, fn.valueRepresentation(value));
		}
	}
	return Object.freeze([...requirements].sort(([left], [right]) => left - right)
		.map(([value, representation]) => Object.freeze({ value, representation })));
}

function pendingLocalCandidate(
	program: CoreProgram,
	candidate: CoreLocalSpecializationCandidate,
): PendingSpecialization {
	const fn = program.function(candidate.function);
	const cfg = buildCoreControlFlow(program, candidate.function, { exceptions: true });
	const cost = coreGeneratedCodeCostModel(fn, cfg).forRegion(candidate.instructions, {
		genericTwins: 1,
		...(candidate.kind === "stack-object" ? { materializationPaths: 1 } : {}),
	});
	const instructions = Object.freeze([...candidate.instructions]);
	const blocks = Object.freeze([...new Set(instructions
		.filter((instruction) => fn.isInstructionLive(instruction))
		.map((instruction) => fn.instructionBlock(instruction)))].sort((left, right) => left - right));
	const kind = localKind(candidate.kind);
	const selection: CorePlanSpecialization = Object.freeze({
		id: candidate.key,
		kind,
		function: candidate.function,
		anchors: Object.freeze([candidate.root]),
		claimedInstructions: instructions,
		ordinaryBlocks: blocks,
		exceptionalBlocks: Object.freeze([]),
		representation: localRepresentation(candidate.kind),
		requiredRepresentations: localRequirements(program, candidate),
		target: "native",
		fallback: "canonical-core",
		semanticProtectors: Object.freeze([]),
		targetFunctions: Object.freeze([]),
		composition: candidate.kind === "numeric-fusion" ? "overlay" : "exclusive",
		cost: Object.freeze({
			generatedCode: cost.estimatedCStatements,
			compilerWork: cost.compileScore,
			runtimeBenefit: cost.runtimeScore + candidate.fanOut,
		}),
	});
	return {
		selection,
		budget: {
			key: `1:${String(1_000_000 - selection.cost.runtimeBenefit).padStart(7, "0")}:${candidate.key}`,
			kind,
			caller: candidate.function,
			site: candidate.root,
			targets: Object.freeze([]),
			generatedCodeCost: selection.cost.generatedCode,
			compilerWorkCost: selection.cost.compilerWork,
			expansive: true,
			...(!fn.isInstructionLive(candidate.root) ||
				instructions.some((instruction) => !fn.isInstructionLive(instruction))
				? { unsupportedReason: "stale-anchor" as const }
				: {}),
		},
	};
}

function guardedCallCandidates(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	liveFunctions: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<PendingSpecialization> {
	const candidates: Array<PendingSpecialization> = [];
	for (const caller of liveFunctions) {
		const fn = program.function(caller);
		for (const site of summaries.targets.outgoing(caller)) {
			if (site.targets.functions.length === 0 || site.targets.opaque) continue;
			const targetFunctions = Object.freeze([...site.targets.functions]);
			const selection: CorePlanSpecialization = Object.freeze({
				id: `guarded-direct-call:${site.id}:${targetFunctions.join(",")}`,
				kind: "guarded-direct-call",
				function: caller,
				anchors: Object.freeze([site.instruction]),
				claimedInstructions: Object.freeze([site.instruction]),
				ordinaryBlocks: Object.freeze([fn.instructionBlock(site.instruction)]),
				exceptionalBlocks: Object.freeze([]),
				representation: targetFunctions.length === 1 ? "exact-function" : "finite-function-set",
				requiredRepresentations: Object.freeze([]),
				target: "native",
				fallback: "canonical-core",
				semanticProtectors: Object.freeze([]),
				targetFunctions,
				composition: "overlay",
				cost: Object.freeze({ generatedCode: targetFunctions.length, compilerWork: 1, runtimeBenefit: 8 }),
			});
			candidates.push({
				selection,
				budget: {
					key: `0:${selection.id}`,
					kind: "guarded-direct-call",
					caller,
					site: site.instruction,
					targets: targetFunctions,
					generatedCodeCost: selection.cost.generatedCode,
					compilerWorkCost: selection.cost.compilerWork,
					expansive: false,
				},
			});
		}
	}
	return candidates;
}

function directEntryCandidates(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	live: ReadonlySet<CoreFunctionId>,
): ReadonlyArray<PendingDirectEntry> {
	const callsByTarget = new Map<CoreFunctionId, Array<CoreDirectEntryCallSite>>();
	for (const caller of [...live].sort((left, right) => left - right)) {
		for (const site of summaries.targets.outgoing(caller)) {
			if (site.open || site.targets.functions.length !== 1) continue;
			const target = site.targets.functions[0]!;
			if (!live.has(target)) continue;
			const fn = program.function(caller);
			if (fn.instructionAttributes(site.instruction).directFunctionIndex !== target) continue;
			const calls = callsByTarget.get(target) ?? [];
			calls.push(Object.freeze({ caller, instruction: site.instruction }));
			callsByTarget.set(target, calls);
		}
	}
	const candidates: Array<PendingDirectEntry> = [];
	for (const [target, callSites] of [...callsByTarget].sort(([left], [right]) => left - right)) {
		const fn = program.function(target);
		const summary = summaries.summary(target);
		const resultRepresentation = planRepresentation(summary?.returnRepresentation ?? "none");
		if (resultRepresentation === undefined || resultRepresentation === "boxed" ||
			fn.isGenerator || fn.isAsync || fn.metadata.isClassConstructor) continue;
		const parameterRepresentations = Object.freeze(
			fn.parameters.map(() => "boxed" as const),
		);
		const generatedCode = Math.max(8, [...fn.instructionIds()].length);
		const compilerWork = generatedCode + fn.valueCapacity;
		candidates.push({
			function: target,
			callSites: Object.freeze(callSites.sort((left, right) =>
				left.caller - right.caller || left.instruction - right.instruction)),
			parameterRepresentations,
			resultRepresentation,
			budget: {
				key: `2:direct-entry:${target}:${resultRepresentation}`,
				kind: "direct-entry",
				caller: target,
				site: callSites[0]!.instruction,
				targets: Object.freeze([target]),
				generatedCodeCost: generatedCode,
				compilerWorkCost: compilerWork,
				expansive: true,
			},
		});
	}
	return candidates;
}

function conflicts(
	selection: CorePlanSpecialization,
	claimed: ReadonlyMap<CoreFunctionId, ReadonlyMap<CoreInstructionId, "exclusive" | "overlay">>,
): boolean {
	if (selection.composition === "overlay") return false;
	const owned = claimed.get(selection.function);
	return selection.claimedInstructions.some((instruction) => owned?.has(instruction));
}

function claim(
	selection: CorePlanSpecialization,
	claimed: Map<CoreFunctionId, Map<CoreInstructionId, "exclusive" | "overlay">>,
): void {
	const owned = claimed.get(selection.function) ??
		new Map<CoreInstructionId, "exclusive" | "overlay">();
	for (const instruction of selection.claimedInstructions) {
		if (!owned.has(instruction) || selection.composition === "exclusive") {
			owned.set(instruction, selection.composition);
		}
	}
	claimed.set(selection.function, owned);
}

export interface BuildCoreOptimizationPlanOptions {
	readonly budgets?: CoreTransformBudgetLimits;
}

export function buildCoreOptimizationPlan(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	liveFunctions: ReadonlyArray<CoreFunctionId>,
	options: BuildCoreOptimizationPlanOptions = {},
): CoreOptimizationPlan {
	const live = new Set(liveFunctions);
	const pending: Array<PendingCandidate> = [];
	for (const functionId of liveFunctions) {
		const discovered = analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, {
			scope: "function",
			function: functionId,
		});
		pending.push(...discovered.candidates.map((candidate) =>
			pendingLocalCandidate(program, candidate)),
		);
	}
	pending.push(...guardedCallCandidates(program, summaries, liveFunctions));
	pending.push(...directEntryCandidates(program, summaries, live));

	const service = new CoreTransformCandidateService(
		options.budgets ?? DEFAULT_CORE_SPECIALIZATION_BUDGETS,
	);
	const byBudgetKey = new Map<string, PendingCandidate>();
	const discoveredByKind: Record<string, number> = {};
	for (const candidate of pending) {
		increment(discoveredByKind, candidate.budget.kind);
		if (service.offer(candidate.budget)) byBudgetKey.set(candidate.budget.key, candidate);
	}
	const selectedByKind: Record<string, number> = {};
	const declinedByPlanReason: Record<string, number> = {};
	const claimed = new Map<CoreFunctionId, Map<CoreInstructionId, "exclusive" | "overlay">>();
	const specializations: Array<CorePlanSpecialization> = [];
	const directEntriesByFunction = new Map<CoreFunctionId, Array<CoreDirectEntryPlan>>();
	for (let budget = service.next(); budget !== undefined; budget = service.next()) {
		const candidate = byBudgetKey.get(budget.key)!;
		let reason: CoreTransformDeclineReason | undefined = service.admit(budget);
		if (reason === undefined && !isPendingDirectEntry(candidate) && conflicts(candidate.selection, claimed)) {
			reason = "overlap";
		}
		if (reason !== undefined) {
			service.recordDeclined(reason);
			increment(declinedByPlanReason, reason);
			continue;
		}
		service.recordApplied(budget);
		increment(selectedByKind, budget.kind);
		if (isPendingDirectEntry(candidate)) {
			const entries = directEntriesByFunction.get(candidate.function) ?? [];
			if (entries.length >= 4) {
				increment(declinedByPlanReason, "expansion-limit");
				continue;
			}
			entries.push(Object.freeze({
				id: entries.length,
				function: candidate.function,
				callSites: candidate.callSites,
				parameterRepresentations: candidate.parameterRepresentations,
				resultRepresentation: candidate.resultRepresentation,
				target: "native",
				fallback: "canonical-core",
				cost: Object.freeze({
					generatedCode: budget.generatedCodeCost,
					compilerWork: budget.compilerWorkCost,
					runtimeBenefit: candidate.callSites.length * 8,
				}),
			}));
			directEntriesByFunction.set(candidate.function, entries);
		} else {
			claim(candidate.selection, claimed);
			specializations.push(candidate.selection);
		}
	}
	const directEntries = [...directEntriesByFunction]
		.sort(([left], [right]) => left - right)
		.flatMap(([, entries]) => entries);
	const budgetStatistics = service.statistics();
	const statistics: CoreOptimizationPlanStatistics = Object.freeze({
		...budgetStatistics,
		discoveredByKind: Object.freeze({ ...discoveredByKind }),
		selectedByKind: Object.freeze({ ...selectedByKind }),
		declinedByPlanReason: Object.freeze({ ...declinedByPlanReason }),
		verificationMs: 0,
	});
	return Object.freeze({
		version: corePlanVersionStamp(program),
		liveFunctions: Object.freeze([...liveFunctions]),
		directEntries: Object.freeze(directEntries),
		specializations: Object.freeze(specializations),
		statistics,
	});
}

export function withCorePlanVerificationTime(
	plan: CoreOptimizationPlan,
	verificationMs: number,
): CoreOptimizationPlan {
	return Object.freeze({
		...plan,
		statistics: Object.freeze({ ...plan.statistics, verificationMs }),
	});
}
