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
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	analyzeCoreCallGraph,
	coreCalleeTargetsAreOpen,
} from "./core-ir-call-targets.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreFunctionId, CoreRepresentation, CoreValueId } from "./core-ir.ts";
import { CoreProgramFlowEngine } from "./core-program-flow.ts";
import type {
	CoreProgramFlowLocalTransfers,
	CoreProgramFlowPublishedFunctionSummary,
	CoreProgramFlowSummaries,
	CoreProgramFlowSummarySemantics,
	CoreProgramFlowSummaryState,
	CoreProgramFlowSummaryStatistics,
} from "./core-program-flow.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_CALL_EFFECT_SUMMARY_FACT = "call-effect-summary";
type ValueOrigin =
	| { readonly kind: "none" }
	| { readonly kind: "fresh" }
	| { readonly kind: "primitive" }
	| { readonly kind: "parameter"; readonly index: number }
	| { readonly kind: "receiver" }
	| { readonly kind: "unknown" };

const ORIGIN_NONE: ValueOrigin = Object.freeze({ kind: "none" });
const ORIGIN_FRESH: ValueOrigin = Object.freeze({ kind: "fresh" });
const ORIGIN_PRIMITIVE: ValueOrigin = Object.freeze({ kind: "primitive" });
const ORIGIN_RECEIVER: ValueOrigin = Object.freeze({ kind: "receiver" });
const ORIGIN_UNKNOWN: ValueOrigin = Object.freeze({ kind: "unknown" });

const ORIGIN_TRANSFER_JOIN = 0;
const ORIGIN_TRANSFER_COPY = 1;
const ORIGIN_TRANSFER_RECEIVER = 2;
const ORIGIN_TRANSFER_FRESH = 3;
const ORIGIN_TRANSFER_PRIMITIVE = 4;
const ORIGIN_TRANSFER_UNKNOWN = 5;

export interface CoreLocalFunctionSummary {
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

export type CorePublishedFunctionSummary = CoreProgramFlowPublishedFunctionSummary;
export type CoreProgramSummaryStatistics = CoreProgramFlowSummaryStatistics;
export type CoreProgramSummaries = CoreProgramFlowSummaries<CoreCallGraphIndex>;
export type CoreProgramSummaryState = CoreProgramFlowSummaryState<
	CoreLocalFunctionSummary,
	CoreAnyScriptCallSummary,
	CoreCallGraphIndex
>;

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
	localTransfers: CoreProgramFlowLocalTransfers,
): CoreLocalFunctionSummary {
	const origins = Array<ValueOrigin>(fn.valueCapacity).fill(ORIGIN_NONE);
	for (let index = 0; index < fn.parameterCount; index++) {
		origins[fn.kernel.functionParameter(index)] = Object.freeze({
			kind: "parameter",
			index,
		});
	}
	const transferKinds: Array<number> = [];
	const transferOutputs: Array<CoreValueId> = [];
	const transferInputStarts: Array<number> = [];
	const transferInputCounts: Array<number> = [];
	const transferInputs: Array<CoreValueId> = [];
	const addTransfer = (
		kind: number,
		output: CoreValueId,
		inputs: ReadonlyArray<CoreValueId> = [],
	): void => {
		transferKinds.push(kind);
		transferOutputs.push(output);
		transferInputStarts.push(transferInputs.length);
		transferInputCounts.push(inputs.length);
		for (const input of inputs) transferInputs.push(input);
	};
	const reachableBlocks = new Uint8Array(fn.blockCapacity);
	for (const block of cfg.reachable) reachableBlocks[block] = 1;
	for (const block of cfg.reversePostorder) {
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const parameter = fn.kernel.blockParameterValue(parameterStart + index);
			const incoming: Array<CoreValueId> = [];
			for (const edge of cfg.predecessors[block] ?? []) {
				if (edge.kind !== "ordinary") continue;
				const argument = edge.arguments[index];
				if (argument !== undefined) incoming.push(argument);
			}
			if (incoming.length === 0) continue;
			addTransfer(ORIGIN_TRANSFER_JOIN, parameter, incoming);
		}
	}
	for (let transfer = 0; transfer < localTransfers.operationCount; transfer++) {
		const instruction = localTransfers.operationAt(transfer);
		if (reachableBlocks[fn.instructionBlock(instruction)] === 0) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const operand =
			opcode === "move" && fn.kernel.instructionOperandCount(instruction) > 0
				? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction))
				: undefined;
		const kind =
			operand !== undefined
				? ORIGIN_TRANSFER_COPY
				: opcode === "loadThis"
					? ORIGIN_TRANSFER_RECEIVER
					: FRESH_RESULTS.has(opcode)
						? ORIGIN_TRANSFER_FRESH
						: PRIMITIVE_RESULTS.has(opcode)
							? ORIGIN_TRANSFER_PRIMITIVE
							: ORIGIN_TRANSFER_UNKNOWN;
		const resultStart = fn.kernel.instructionResultStart(instruction);
		const resultCount = fn.kernel.instructionResultCount(instruction);
		for (let index = 0; index < resultCount; index++) {
			const output = fn.kernel.resultAt(resultStart + index);
			addTransfer(kind, output, operand === undefined ? [] : [operand]);
		}
	}
	const dependents = new Array<Array<number> | undefined>(fn.valueCapacity);
	for (let index = 0; index < transferOutputs.length; index++) {
		const inputStart = transferInputStarts[index]!;
		const inputCount = transferInputCounts[index]!;
		for (let offset = 0; offset < inputCount; offset++) {
			const input = transferInputs[inputStart + offset]!;
			const users = dependents[input] ?? [];
			users.push(index);
			dependents[input] = users;
		}
	}
	const kinds = Uint8Array.from(transferKinds);
	const outputs = Uint32Array.from(transferOutputs);
	const inputStarts = Uint32Array.from(transferInputStarts);
	const inputCounts = Uint32Array.from(transferInputCounts);
	const inputs = Uint32Array.from(transferInputs);
	const queue = Array.from({ length: outputs.length }, (_, index) => index);
	const queued = new Uint8Array(outputs.length);
	queued.fill(1);
	let cursor = 0;
	while (cursor < queue.length) {
		const index = queue[cursor++]!;
		queued[index] = 0;
		const kind = kinds[index]!;
		const inputStart = inputStarts[index]!;
		const inputCount = inputCounts[index]!;
		let incoming = ORIGIN_NONE;
		if (kind === ORIGIN_TRANSFER_JOIN || kind === ORIGIN_TRANSFER_COPY) {
			for (let offset = 0; offset < inputCount; offset++) {
				incoming = joinOrigins(incoming, origins[inputs[inputStart + offset]!]!);
			}
		} else if (kind === ORIGIN_TRANSFER_RECEIVER) incoming = ORIGIN_RECEIVER;
		else if (kind === ORIGIN_TRANSFER_FRESH) incoming = ORIGIN_FRESH;
		else if (kind === ORIGIN_TRANSFER_PRIMITIVE) incoming = ORIGIN_PRIMITIVE;
		else incoming = ORIGIN_UNKNOWN;
		const output = outputs[index]! as CoreValueId;
		if (!raiseOrigin(origins, output, incoming)) continue;
		for (const dependent of dependents[output] ?? []) {
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
	for (let transfer = 0; transfer < localTransfers.operationCount; transfer++) {
		const instruction = localTransfers.operationAt(transfer);
		if (reachableBlocks[fn.instructionBlock(instruction)] === 0) continue;
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

export interface CoreAnyScriptCallSummary {
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

export const CORE_PROGRAM_FLOW_SUMMARY_SEMANTICS: CoreProgramFlowSummarySemantics<
	CoreLocalFunctionSummary,
	CoreAnyScriptCallSummary,
	CoreCallGraphIndex
> = Object.freeze({
	localIsCurrent: localSummaryIsCurrent,
	analyzeLocal: analyzeLocalSummary,
	summaryId(local: CoreLocalFunctionSummary) {
		return local.summaryId;
	},
	rootReasons,
	derive: deriveSummary,
	summarizeAggregate: summarizeAnyScriptCallees,
	aggregateParameterCount(aggregate: CoreAnyScriptCallSummary) {
		return aggregate.parameterEscape.length;
	},
	sameAggregate: sameAnyScriptSummary,
	summariesEqual,
	moduleSummaries,
});

export function analyzeProgramSummaries(
	program: CoreProgram,
	context: CoreCompilationContext,
	targets: CoreCallGraphIndex,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
	previous?: CoreProgramSummaryState,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
): CoreProgramSummaryState {
	return new CoreProgramFlowEngine(program).solveSummaries(
		context,
		targets,
		controlFlow,
		CORE_PROGRAM_FLOW_SUMMARY_SEMANTICS,
		previous,
		dirtyFunctions,
	);
}

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
