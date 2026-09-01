import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { ReturnProvenance } from "../shared/effect-summary.ts";
import { CoreEditor } from "./core-editor.ts";
import type {
	CoreCalleeTargets,
	CoreIndexedCallSite,
} from "./core-ir-call-targets.ts";
import { coreCalleeTargetsAreOpen } from "./core-ir-call-targets.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "./core-ir-summaries.ts";
import type {
	CoreAttributeValue,
	CoreFunctionId,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_LOCAL_CANONICALIZATION_PASSES } from "./core-local-passes.ts";
import type { CorePassManager } from "./core-pass-manager.ts";
import type { CoreChangeSet, CoreFunctionStore, CoreProgram } from "./core-store.ts";
import {
	CoreTransformCandidateService,
} from "./core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformBudgetStatistics,
	CoreTransformCandidate,
} from "./core-transform-candidates.ts";

export const CORE_CALLEE_TARGETS_ATTRIBUTE = "calleeTargets";
export const CORE_CALL_SUMMARY_VERSION_ATTRIBUTE = "callSummaryVersion";
export const CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE = "callParameterEscape";
export const CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE = "callParameterContainment";
export const CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE = "callReturnProvenance";
export const CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE = "callReturnRepresentation";

export interface CoreCrossCallTransformStatistics
	extends CoreTransformBudgetStatistics {
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
	readonly callGraphFunctionsAnalyzed: number;
	readonly sccTransfers: number;
	readonly callerWakeups: number;
}

interface AppliedTransform {
	readonly changes: CoreChangeSet;
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
}

interface LinearInlineTarget {
	readonly function: CoreFunctionStore;
	readonly block: number;
	readonly returnValue: CoreValueId;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
}

const INLINE_UNSUPPORTED_OPCODES = new Set([
	"createArgumentsObject",
	"createRestArguments",
	"loadArgument",
	"loadArgumentCount",
	"loadCallee",
	"loadNewTarget",
	"loadStaticArgument",
]);

function stableAttribute(value: CoreAttributeValue): string {
	if (Array.isArray(value)) return `[${value.map(stableAttribute).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${key}:${stableAttribute(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function targetKey(targets: CoreCalleeTargets): string {
	return `${targets.functions.join(",")}:${targets.anyScript ? "a" : "-"}:${targets.opaque ? "o" : "-"}`;
}

function returnProvenanceAttribute(
	value: ReturnProvenance,
): CoreAttributeValue {
	return value.kind === "parameter"
		? Object.freeze({ kind: value.kind, index: value.index })
		: value.kind;
}

function refreshedAttributes(
	fn: CoreFunctionStore,
	site: CoreIndexedCallSite,
	summaries: CoreProgramSummaries,
): CoreInstructionAttributes {
	const attributes: Record<string, CoreAttributeValue> = {
		...fn.instructionAttributes(site.instruction),
	};
	delete attributes[CORE_CALLEE_TARGETS_ATTRIBUTE];
	delete attributes[CORE_CALL_SUMMARY_VERSION_ATTRIBUTE];
	delete attributes[CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE];
	delete attributes[CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE];
	delete attributes[CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE];
	delete attributes[CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE];
	if (!(
		site.targets.functions.length === 0 &&
		!site.targets.anyScript &&
		!site.targets.opaque
	)) {
		attributes[CORE_CALLEE_TARGETS_ATTRIBUTE] = Object.freeze({
			functions: site.targets.functions,
			anyScript: site.targets.anyScript,
			opaque: site.targets.opaque,
		});
	}
	if (site.targets.functions.length === 1) {
		const target = site.targets.functions[0]!;
		const summary = summaries.summary(target);
		if (summary !== undefined) {
			attributes[CORE_CALL_SUMMARY_VERSION_ATTRIBUTE] = summaries.version(target);
			attributes[CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE] = summary.parameterEscape;
			attributes[CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE] =
				summary.parameterContainment;
			attributes[CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE] =
				returnProvenanceAttribute(summary.returnProvenance);
			attributes[CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE] =
				summary.returnRepresentation;
		}
	}
	return Object.freeze(attributes);
}

function linearInlineTarget(
	program: CoreProgram,
	target: CoreFunctionId,
): LinearInlineTarget | undefined {
	const fn = program.function(target);
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.metadata.isClassConstructor ||
		fn.factCapacity !== 0
	) return undefined;
	const blocks = [...fn.blockIds()];
	if (blocks.length !== 1 || blocks[0] !== fn.entry || fn.blockHandler(fn.entry) !== undefined) {
		return undefined;
	}
	const instructions = [...fn.bodyInstructionIds(fn.entry)];
	const available = new Set(fn.parameters);
	if (
		fn.blockParameters(fn.entry).some(({ value }) => !available.has(value))
	) return undefined;
	for (const instruction of instructions) {
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			INLINE_UNSUPPORTED_OPCODES.has(opcode) ||
			(opcode === "loadThis" && !fn.metadata.strict) ||
			fn.instructionEffectRefinement(instruction) !== undefined
		) return undefined;
		if (
			opcode !== "loadThis" &&
			fn.instructionOperands(instruction).some((value) => !available.has(value))
		) return undefined;
		for (const output of fn.instructionResults(instruction)) available.add(output);
	}
	const terminator = fn.terminatorPayload(fn.blockTerminator(fn.entry));
	if (terminator.kind !== "return" || !available.has(terminator.value)) return undefined;
	return {
		function: fn,
		block: fn.entry,
		returnValue: terminator.value,
		instructions,
	};
}

function offerFunctionCandidates(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	functionId: CoreFunctionId,
): void {
	const fn = program.function(functionId);
	for (const site of summaries.targets.outgoing(functionId)) {
		if (!fn.isInstructionLive(site.instruction)) continue;
		const refreshed = refreshedAttributes(fn, site, summaries);
		const current = fn.instructionAttributes(site.instruction);
		const versions = site.targets.functions.map((target) => summaries.version(target));
		if (stableAttribute(current) !== stableAttribute(refreshed)) {
			service.offer(Object.freeze({
				key: `0-refresh:${site.id}:${targetKey(site.targets)}:${versions.join(",")}`,
				kind: "call-refresh",
				caller: functionId,
				site: site.instruction,
				targets: site.targets.functions,
				generatedCodeCost: 0,
				compilerWorkCost: 1,
				expansive: false,
			}));
		}
		if (site.targets.functions.length > 0) {
			const guarded =
				coreCalleeTargetsAreOpen(site.targets) || site.targets.functions.length > 1;
			service.offer(Object.freeze({
				key: `1-dispatch:${site.id}:${targetKey(site.targets)}`,
				kind: "finite-dispatch",
				caller: functionId,
				site: site.instruction,
				targets: site.targets.functions,
				generatedCodeCost: guarded ? site.targets.functions.length * 2 + 1 : 0,
				compilerWorkCost: site.targets.functions.length + 1,
				expansive: guarded,
			}));
		}
		if (site.targets.functions.length !== 1 || coreCalleeTargetsAreOpen(site.targets)) {
			continue;
		}
		const target = site.targets.functions[0]!;
		const linear = linearInlineTarget(program, target);
		service.offer(Object.freeze({
			key: `2-inline:${site.id}:${target}:${summaries.version(target)}`,
			kind: "inline",
			caller: functionId,
			site: site.instruction,
			targets: Object.freeze([target]),
			generatedCodeCost: linear?.instructions.length ?? 0,
			compilerWorkCost:
				(linear?.instructions.length ?? 0) +
				(linear?.function.valueCapacity ?? 0) +
				1,
			expansive: true,
			...(target === functionId
				? { unsupportedReason: "recursive" as const }
				: linear === undefined
					? { unsupportedReason: "unsupported-graph" as const }
					: {}),
		}));
	}
}

export function discoverCoreCrossCallCandidates(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	functions: Iterable<CoreFunctionId> = program.functionIds(),
): void {
	for (const functionId of functions) {
		offerFunctionCandidates(program, summaries, service, functionId);
	}
}

function applyCallRefresh(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	candidate: CoreTransformCandidate,
): AppliedTransform | undefined {
	const fn = program.function(candidate.caller);
	if (
		!fn.isInstructionLive(candidate.site) ||
		fn.instructionKind(candidate.site) !== "operation"
	) return undefined;
	const site = summaries.targets.outgoing(candidate.caller).find(
		({ instruction }) => instruction === candidate.site,
	);
	if (site === undefined) return undefined;
	const attributes = refreshedAttributes(fn, site, summaries);
	if (stableAttribute(attributes) === stableAttribute(fn.instructionAttributes(candidate.site))) {
		return undefined;
	}
	const editor = CoreEditor.open(program, candidate.caller);
	editor.replaceInstruction(
		candidate.site,
		fn.instructionOpcodeName(candidate.site),
		fn.instructionOperands(candidate.site),
		{
			attributes,
			sourcePosition: fn.instructionSourcePosition(candidate.site),
			...(fn.instructionEffectRefinement(candidate.site) === undefined
				? {}
				: { effectRefinement: fn.instructionEffectRefinement(candidate.site) }),
		},
	);
	return { changes: editor.commit(), instructionsIntroduced: 0, blocksIntroduced: 0 };
}

function applyFiniteDispatch(
	program: CoreProgram,
	candidate: CoreTransformCandidate,
): AppliedTransform | undefined {
	const fn = program.function(candidate.caller);
	if (
		!fn.isInstructionLive(candidate.site) ||
		fn.instructionKind(candidate.site) !== "operation"
	) return undefined;
	const attributes: Record<string, CoreAttributeValue> = {
		...fn.instructionAttributes(candidate.site),
	};
	delete attributes.directFunctionIndex;
	delete attributes.guardedFunctionIndices;
	if (!candidate.expansive && candidate.targets.length === 1) {
		attributes.directFunctionIndex = candidate.targets[0];
	} else {
		attributes.guardedFunctionIndices = candidate.targets;
	}
	if (stableAttribute(attributes) === stableAttribute(fn.instructionAttributes(candidate.site))) {
		return undefined;
	}
	const editor = CoreEditor.open(program, candidate.caller);
	editor.replaceInstruction(
		candidate.site,
		fn.instructionOpcodeName(candidate.site),
		fn.instructionOperands(candidate.site),
		{
			attributes,
			sourcePosition: fn.instructionSourcePosition(candidate.site),
			...(fn.instructionEffectRefinement(candidate.site) === undefined
				? {}
				: { effectRefinement: fn.instructionEffectRefinement(candidate.site) }),
		},
	);
	return { changes: editor.commit(), instructionsIntroduced: 0, blocksIntroduced: 0 };
}

function applyLinearInline(
	program: CoreProgram,
	candidate: CoreTransformCandidate,
): AppliedTransform | undefined {
	const target = candidate.targets[0];
	if (target === undefined) return undefined;
	const linear = linearInlineTarget(program, target);
	const caller = program.function(candidate.caller);
	if (
		linear === undefined ||
		!caller.isInstructionLive(candidate.site) ||
		caller.instructionKind(candidate.site) !== "operation"
	) return undefined;
	const descriptor = caller.registry.byId(caller.instructionOpcode(candidate.site));
	if (
		descriptor.callTransfer?.invocation !== "call" ||
		descriptor.callTransfer.result !== "call-completion"
	) return undefined;
	const operands = caller.instructionOperands(candidate.site);
	const callResults = caller.instructionResults(candidate.site);
	if (callResults.length !== 1) return undefined;
	const receiverIndex = descriptor.callTransfer.receiverOperand;
	const receiver = receiverIndex === undefined ? undefined : operands[receiverIndex];
	const firstArgument =
		descriptor.callTransfer.arguments.kind === "positional"
			? descriptor.callTransfer.arguments.firstOperand
			: undefined;
	if (firstArgument === undefined) return undefined;
	const arguments_ = operands.slice(firstArgument);
	const block = caller.instructionBlock(candidate.site);
	const editor = CoreEditor.open(program, candidate.caller);
	const values = new Map<CoreValueId, CoreValueId>();
	let introduced = 0;
	for (const [index, parameter] of linear.function.parameters.entries()) {
		const argument = arguments_[index];
		if (argument !== undefined) {
			values.set(parameter, argument);
			continue;
		}
		const created = editor.insertInstruction(
			block,
			candidate.site,
			"createUndefined",
			[],
			{ sourcePosition: caller.instructionSourcePosition(candidate.site) },
		);
		values.set(parameter, created.outputs[0]!);
		introduced++;
	}
	for (const instruction of linear.instructions) {
		const opcode = linear.function.instructionOpcodeName(instruction);
		if (opcode === "loadThis") {
			const output = linear.function.instructionResults(instruction)[0];
			if (output === undefined || receiver === undefined) return undefined;
			values.set(output, receiver);
			continue;
		}
		const inputs = linear.function.instructionOperands(instruction).map((value) =>
			values.get(value),
		);
		if (inputs.some((value) => value === undefined)) {
			throw new Error("Validated inline input has no caller value");
		}
		const outputs = linear.function.instructionResults(instruction);
		const inserted = editor.insertInstruction(
			block,
			candidate.site,
			opcode,
			inputs as ReadonlyArray<CoreValueId>,
			{
				outputCount: outputs.length,
				outputRepresentations: outputs.map((value) =>
					linear.function.valueRepresentation(value),
				),
				attributes: linear.function.instructionAttributes(instruction),
				sourcePosition: linear.function.instructionSourcePosition(instruction),
			},
		);
		introduced++;
		for (const [index, output] of outputs.entries()) {
			values.set(output, inserted.outputs[index]!);
		}
	}
	const replacement = values.get(linear.returnValue);
	if (replacement === undefined) {
		throw new Error("Validated inline return has no caller value");
	}
	editor.replaceValueUses(callResults[0]!, replacement);
	editor.removeInstruction(candidate.site);
	return {
		changes: editor.commit(),
		instructionsIntroduced: introduced,
		blocksIntroduced: 0,
	};
}

function applyCandidate(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	candidate: CoreTransformCandidate,
): AppliedTransform | undefined {
	switch (candidate.kind) {
		case "call-refresh": return applyCallRefresh(program, summaries, candidate);
		case "finite-dispatch": return applyFiniteDispatch(program, candidate);
		case "inline": return applyLinearInline(program, candidate);
	}
}

export function runCoreCrossCallTransforms(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	passes: CorePassManager,
	limits?: CoreTransformBudgetLimits,
): {
	readonly summaries: CoreProgramSummaries;
	readonly statistics: CoreCrossCallTransformStatistics;
} {
	const service = new CoreTransformCandidateService(limits);
	let summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	let callGraphFunctionsAnalyzed = summaries.targets.statistics.functionsAnalyzed;
	let sccTransfers = summaries.statistics.sccTransfers;
	let callerWakeups = summaries.statistics.callerWakeups;
	discoverCoreCrossCallCandidates(program, summaries, service);
	let instructionsIntroduced = 0;
	let blocksIntroduced = 0;
	for (let candidate = service.next(); candidate !== undefined; candidate = service.next()) {
		const decline = service.admit(candidate);
		if (decline !== undefined) {
			service.recordDeclined(decline);
			continue;
		}
		const applied = applyCandidate(program, summaries, candidate);
		if (applied === undefined) {
			service.recordDeclined("unsupported-graph");
			continue;
		}
		service.recordApplied(candidate);
		instructionsIntroduced += applied.instructionsIntroduced;
		blocksIntroduced += applied.blocksIntroduced;
		if (candidate.kind !== "inline") continue;
		passes.runStage(
			"canonicalize",
			CORE_LOCAL_CANONICALIZATION_PASSES,
			[applied.changes],
		);
		summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
		callGraphFunctionsAnalyzed += summaries.targets.statistics.functionsAnalyzed;
		sccTransfers += summaries.statistics.sccTransfers;
		callerWakeups += summaries.statistics.callerWakeups;
		discoverCoreCrossCallCandidates(
			program,
			summaries,
			service,
			new Set([candidate.caller, ...summaries.changedFunctions]),
		);
	}
	summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	const budget = service.statistics();
	return Object.freeze({
		summaries,
		statistics: Object.freeze({
			...budget,
			instructionsIntroduced,
			blocksIntroduced,
			callGraphFunctionsAnalyzed,
			sccTransfers,
			callerWakeups,
		}),
	});
}
