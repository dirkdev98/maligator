import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import {
	EVERY_EFFECT_SUMMARY,
	NO_EFFECT_SUMMARY,
	RETURN_PROVENANCE_NONE,
	effectSummariesEqual,
	functionSummaryId,
	joinEffectSummaries,
	joinReturnProvenance,
	returnProvenancesEqual,
	joinReturnRepresentation,
	joinValueContainment,
	joinValueEscape,
	moduleSummaryId,
	normalizeRootReasons,
	normalizeRelativeOwnSlotEffects,
	relativeOwnSlotEffectKey,
} from "../shared/effect-summary.ts";
import type {
	EffectSummary,
	FunctionEffectSummary,
	ModuleEffectSummary,
	RelativeOwnSlotEffect,
	RelativeOwnSlotEffectSummary,
	ReturnProvenance,
	ReturnRepresentation,
	ReadAccessorSummary,
	SummaryRootReason,
	ValueContainmentFact,
	ValueEscapeFact,
} from "../shared/effect-summary.ts";
import {
	coreBuiltinCallbackEffects,
	coreBuiltinCallbackInvocation,
	coreKnownBuiltinOnlyObservesOperands,
} from "./core-builtin-effects.ts";
import type { CoreBuiltinCallbackInvocation } from "./core-builtin-effects.ts";
import { coreBuiltinResultProjection } from "./core-builtin-result-projections.ts";
import { coreCalleeTargetsAreOpen } from "./core-callee-targets.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { analyzeCoreCallGraph } from "./core-ir-call-targets.ts";
import type { CoreCallGraphIndex, CoreIndexedCallSite } from "./core-ir-call-targets.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreAttributeValuesEqual } from "./core-ir-equality.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreAttributeValue } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CoreProgramFlowEngine } from "./core-program-flow.ts";
import type {
	CoreProgramFlowLocalTransfers,
	CoreProgramFlowPublishedFunctionSummary,
	CoreProgramFlowSummaries,
	CoreProgramFlowSummarySemantics,
	CoreProgramFlowSummaryState,
	CoreProgramFlowSummaryStatistics,
} from "./core-program-flow.ts";
import { coreReadAccessorSummary } from "./core-read-accessors.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_CALL_EFFECT_SUMMARY_FACT = "call-effect-summary";
type ValueOrigin = ReturnProvenance;

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

interface ReturnOriginNode {
	readonly value: CoreValueId;
	readonly inputs: ReadonlyArray<CoreValueId>;
	readonly call?: CoreInstructionId;
	readonly identityKinds?: number;
}

interface ReturnOriginPlan {
	readonly returns: ReadonlyArray<CoreValueId>;
	readonly nodes: ReadonlyArray<ReturnOriginNode>;
	readonly dependents: ReadonlyMap<CoreValueId, ReadonlyArray<number>>;
}

export interface CoreLocalFunctionSummary {
	readonly readAccessor?: ReadAccessorSummary;
	readonly function: CoreFunctionId;
	readonly bodyVersion: number;
	readonly cfgVersion: number;
	readonly exceptionFlowVersion: number;
	readonly callsVersion: number;
	readonly memoryEffectsVersion: number;
	readonly representationsVersion: number;
	readonly sourcePath: string;
	readonly summaryId: string;
	readonly moduleId: string;
	readonly effects: EffectSummary;
	readonly builtinCallbacks: ReadonlyArray<CoreBuiltinCallbackInvocation>;
	readonly conditionalOwnSlotEffects?: RelativeOwnSlotEffectSummary;
	readonly parameterEscape: ReadonlyArray<ValueEscapeFact>;
	readonly receiverEscape: ValueEscapeFact;
	readonly parameterContainment: ReadonlyArray<ValueContainmentFact>;
	readonly receiverContainment: ValueContainmentFact;
	readonly returnProvenance: ReturnProvenance;
	readonly returnRepresentation: ReturnRepresentation;
	readonly origins: ReadonlyArray<ValueOrigin>;
	readonly returnOrigins?: ReturnOriginPlan;
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
		local.exceptionFlowVersion === fn.version("exceptionFlow") &&
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
	"stringConcatLength",
	"concatStrings",
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
	"preparedStringCompare",
	"preciseNumberSum",
	"typeofCompare",
	"unary",
]);

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

function projectOrigin(origin: ValueOrigin, identityKinds: number): ValueOrigin {
	if (identityKinds === COMPILER_VALUE_KIND_TOP || origin.kind === "none") return origin;
	if (origin.kind !== "parameter" && origin.kind !== "receiver") return ORIGIN_UNKNOWN;
	const required = (origin.identityKinds ?? COMPILER_VALUE_KIND_TOP) & identityKinds;
	return required === 0 ? ORIGIN_UNKNOWN : { ...origin, identityKinds: required };
}

function returnOriginPlan(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	origins: ReadonlyArray<ValueOrigin>,
	returns: ReadonlyArray<CoreValueId>,
): ReturnOriginPlan | undefined {
	if (fn.isAsync || fn.isGenerator) return undefined;
	const nodes: Array<ReturnOriginNode> = [];
	const visited = new Set<CoreValueId>();
	const pending = [...returns];
	let calls = 0;
	for (let cursor = 0; cursor < pending.length; cursor++) {
		const value = pending[cursor]!;
		if (visited.has(value) || origins[value]?.kind !== "unknown") continue;
		visited.add(value);
		let node: ReturnOriginNode | undefined;
		const owner = fn.kernel.valueDefinitionOwner(value);
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			const block = owner as CoreBlockId;
			const index = fn.kernel.valueDefinitionIndex(value);
			if (
				fn.kernel.blockParameterRole(fn.kernel.blockParameterStart(block) + index) === 1
			)
				continue;
			const inputs: Array<CoreValueId> = [];
			for (const edge of cfg.predecessors[block] ?? []) {
				if (!cfg.reachable.has(edge.from)) continue;
				const input = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (input !== undefined) inputs.push(input);
			}
			if (inputs.length > 0) node = { value, inputs };
		} else if (fn.kernel.valueDefinitionKind(value) === 1) {
			const instruction = coreInstructionId(owner);
			const opcode = fn.instructionOpcodeName(instruction);
			const projection = coreBuiltinResultProjection(fn, instruction);
			const input =
				opcode === "move"
					? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction))
					: projection?.input;
			if (input !== undefined) {
				node = { value, inputs: [input], identityKinds: projection?.identityKinds };
			} else {
				const transfer = fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer;
				if (
					transfer?.result !== "call-completion" ||
					fn.kernel.instructionResultCount(instruction) !== 1
				)
					continue;
				const start = fn.kernel.instructionOperandStart(instruction);
				const count = fn.kernel.instructionOperandCount(instruction);
				const inputs: Array<CoreValueId> = [];
				if (transfer.receiverOperand !== undefined && transfer.receiverOperand < count)
					inputs.push(fn.kernel.operandAt(start + transfer.receiverOperand));
				const first =
					transfer.arguments.kind === "positional"
						? transfer.arguments.firstOperand
						: transfer.arguments.kind === "aggregate"
							? transfer.arguments.prefixFirstOperand
							: undefined;
				if (first !== undefined) {
					for (let index = first; index < count; index++)
						inputs.push(fn.kernel.operandAt(start + index));
				}
				node = { value, call: instruction, inputs };
				calls++;
			}
		}
		if (node === undefined) continue;
		nodes.push(node);
		for (const input of node.inputs) pending.push(input);
	}
	if (calls === 0) return undefined;
	const dependents = new Map<CoreValueId, Array<number>>();
	for (let index = 0; index < nodes.length; index++) {
		for (const value of nodes[index]!.inputs) {
			const users = dependents.get(value) ?? [];
			users.push(index);
			dependents.set(value, users);
		}
	}
	return { returns, nodes, dependents };
}

function projectedReturnOrigin(
	program: CoreProgram,
	local: CoreLocalFunctionSummary,
	targets: CoreCallGraphIndex,
	current: ReadonlyMap<CoreFunctionId, FunctionEffectSummary>,
	includeCalls: boolean,
): ValueOrigin {
	const plan = local.returnOrigins;
	if (plan === undefined) return local.returnProvenance;
	const values = new Map(plan.nodes.map(({ value }) => [value, ORIGIN_NONE]));
	const origin = (value: CoreValueId) =>
		values.get(value) ?? local.origins[value] ?? ORIGIN_UNKNOWN;
	const callOrigin = (instruction: CoreInstructionId): ValueOrigin => {
		const site = targets.site(local.function, instruction);
		if (site === undefined || site.targets.opaque || site.targets.anyScript)
			return ORIGIN_UNKNOWN;
		// SCCs start at bottom so a recursive call cannot certify itself from an old summary.
		if (!includeCalls) return ORIGIN_NONE;
		let result = ORIGIN_NONE;
		for (const target of site.targets.functions) {
			const callee = program.function(target);
			const provenance = current.get(target)?.returnProvenance ?? ORIGIN_UNKNOWN;
			let projected = provenance;
			if (callee.isAsync || callee.isGenerator) projected = ORIGIN_UNKNOWN;
			else if (provenance.kind === "parameter" || provenance.kind === "receiver") {
				const input =
					provenance.kind === "parameter"
						? (site.arguments ?? site.argumentPrefix)?.[provenance.index]
						: site.receiver;
				let required = provenance.identityKinds ?? COMPILER_VALUE_KIND_TOP;
				if (provenance.kind === "receiver" && !callee.metadata.strict)
					required &= COMPILER_VALUE_KIND_OBJECT;
				projected =
					input !== undefined
						? projectOrigin(origin(input), required)
						: provenance.kind === "parameter" &&
							  site.arguments !== undefined &&
							  provenance.index >= site.arguments.length &&
							  (required & COMPILER_VALUE_KIND_UNDEFINED) !== 0
							? ORIGIN_PRIMITIVE
							: ORIGIN_UNKNOWN;
			}
			result = joinReturnProvenance(result, projected);
		}
		return result;
	};
	const queue = plan.nodes.map((_, index) => index);
	const queued = new Uint8Array(queue.length).fill(1);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const index = queue[cursor]!;
		queued[index] = 0;
		const node = plan.nodes[index]!;
		let next = ORIGIN_NONE;
		if (node.call !== undefined) next = callOrigin(node.call);
		else {
			for (const input of node.inputs) next = joinReturnProvenance(next, origin(input));
			if (node.identityKinds !== undefined)
				next = projectOrigin(next, node.identityKinds);
		}
		const previous = values.get(node.value)!;
		next = joinReturnProvenance(previous, next);
		if (returnProvenancesEqual(previous, next)) continue;
		values.set(node.value, next);
		for (const user of plan.dependents.get(node.value) ?? []) {
			if (queued[user] !== 0) continue;
			queued[user] = 1;
			queue.push(user);
		}
	}
	let result = ORIGIN_NONE;
	for (const value of plan.returns) result = joinReturnProvenance(result, origin(value));
	return result;
}

function raiseOrigin(
	origins: Array<ValueOrigin>,
	value: CoreValueId,
	incoming: ValueOrigin,
): boolean {
	const current = origins[value] ?? ORIGIN_NONE;
	const next = joinReturnProvenance(current, incoming);
	if (returnProvenancesEqual(current, next)) return false;
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

const OWN_SLOT_LOCAL_OPERATIONS = new Set([
	"move",
	"rootUse",
	"loadThis",
	"throwIfTdz",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createString",
	"createUndefined",
	"createFunction",
	"loadCaptured",
	"loadCallee",
	"loadGlobal",
	"loadGlobalIndex",
	"loadIntrinsic",
	"loadPrimordial",
	"mathUnaryNumber",
	"mathBinaryNumber",
]);

function conditionalOwnSlotEffects(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	localTransfers: CoreProgramFlowLocalTransfers,
	origins: ReadonlyArray<ValueOrigin>,
): RelativeOwnSlotEffectSummary | undefined {
	if (
		fn.isAsync ||
		fn.isGenerator ||
		fn.handlerBlockCount > 0 ||
		cfg.reachable.size > 256 ||
		localTransfers.operationCount > 256
	)
		return undefined;
	const accesses: Array<RelativeOwnSlotEffect> = [];
	const parameterEscape = Array<ValueEscapeFact>(fn.parameterCount).fill("none");
	const parameterContainment = Array<ValueContainmentFact>(fn.parameterCount).fill(
		"preserved",
	);
	const receiver = {
		escape: "none" as ValueEscapeFact,
		containment: "preserved" as ValueContainmentFact,
	};
	let remainingEscapeWork = 4_096;
	const retain = (value: CoreValueId, escape: ValueEscapeFact): void => {
		const pending = [value],
			visited = new Set<CoreValueId>();
		for (let next = 0; next < pending.length; next++) {
			if (remainingEscapeWork-- <= 0) return;
			const candidate = pending[next]!;
			if (visited.has(candidate)) continue;
			visited.add(candidate);
			const origin = origins[candidate] ?? ORIGIN_UNKNOWN;
			noteEscape(
				origin,
				escape,
				"preserved",
				parameterEscape,
				parameterContainment,
				receiver,
			);
			if (origin.kind !== "unknown") continue;
			const owner = fn.kernel.valueDefinitionOwner(candidate);
			if (fn.kernel.valueDefinitionKind(candidate) === 0) {
				const index = fn.kernel.valueDefinitionIndex(candidate);
				for (const edge of cfg.predecessors[owner as CoreBlockId] ?? []) {
					const incoming = edge.arguments[index];
					if (edge.kind === "ordinary" && incoming !== undefined) pending.push(incoming);
				}
			} else if (
				fn.kernel.valueDefinitionKind(candidate) === 1 &&
				fn.instructionOpcodeName(owner as CoreInstructionId) === "move"
			) {
				pending.push(
					fn.kernel.operandAt(
						fn.kernel.instructionOperandStart(owner as CoreInstructionId),
					),
				);
			}
		}
	};
	let residualEffects = NO_EFFECT_SUMMARY;
	let calls = 0;
	for (let transfer = 0; transfer < localTransfers.operationCount; transfer++) {
		const instruction = localTransfers.operationAt(transfer);
		if (!cfg.reachable.has(fn.instructionBlock(instruction))) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const attributes = fn.instructionAttributes(instruction);
		const effects = coreInstructionEffects(fn, instruction);
		const start = fn.kernel.instructionOperandStart(instruction);
		const count = fn.kernel.instructionOperandCount(instruction);
		const call = fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer;
		if (opcode === "callKnown" && coreKnownBuiltinOnlyObservesOperands(fn, instruction)) {
			residualEffects = joinEffectSummaries(residualEffects, effects);
			continue;
		}
		if (call !== undefined) {
			if (
				call.invocation !== "call" ||
				call.arguments.kind !== "positional" ||
				++calls > 32
			)
				return undefined;
			retain(fn.kernel.operandAt(start + call.calleeOperand), "invoked");
			residualEffects = joinEffectSummaries(residualEffects, {
				...NO_EFFECT_SUMMARY,
				mayThrow: effects.mayThrow,
				mayGc: effects.mayGc,
			});
			continue;
		}
		if (opcode === "loadPropertyStatic" || opcode === "storePropertyStatic") {
			const base = origins[fn.kernel.operandAt(start)] ?? ORIGIN_UNKNOWN;
			const key = attributes.stringIndex;
			if (
				(base.kind !== "parameter" && base.kind !== "receiver") ||
				base.identityKinds !== undefined ||
				typeof key !== "number" ||
				!Number.isSafeInteger(key) ||
				key < 0 ||
				accesses.length === 32
			)
				return undefined;
			accesses.push(
				Object.freeze({
					base,
					key,
					mode: opcode === "loadPropertyStatic" ? "read" : "write",
				}),
			);
			// Own data access removes getter/setter reentry, but collection and failure stay conservative.
			residualEffects = joinEffectSummaries(residualEffects, {
				...NO_EFFECT_SUMMARY,
				mayThrow: effects.mayThrow,
				mayGc: effects.mayGc,
			});
			for (let operand = 1; operand < count; operand++)
				retain(fn.kernel.operandAt(start + operand), "retained");
			continue;
		}
		const noncoerciveOperator =
			(opcode === "binary" &&
				(attributes.operator === "===" || attributes.operator === "!==")) ||
			(opcode === "unary" &&
				(attributes.operator === "typeof" ||
					attributes.operator === "!" ||
					attributes.operator === "void"));
		const provedPrimitiveOperator =
			(opcode === "unary" || opcode === "binary") &&
			!effects.callsUserCode &&
			!effects.maySuspend &&
			effects.writes.length === 0;
		if (
			!OWN_SLOT_LOCAL_OPERATIONS.has(opcode) &&
			!noncoerciveOperator &&
			!provedPrimitiveOperator
		)
			return undefined;
		if (noncoerciveOperator) {
			residualEffects = joinEffectSummaries(residualEffects, {
				...NO_EFFECT_SUMMARY,
				mayThrow: effects.mayThrow,
				mayGc: effects.mayGc,
			});
		} else {
			residualEffects = joinEffectSummaries(residualEffects, effects);
		}
	}
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind === "return" || kind === "throw") {
			retain(
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
				kind === "return" ? "returned" : "retained",
			);
			if (kind === "throw")
				residualEffects = joinEffectSummaries(residualEffects, {
					...NO_EFFECT_SUMMARY,
					mayThrow: true,
				});
		}
	}
	if (remainingEscapeWork < 0) return undefined;
	return Object.freeze({
		accesses: Object.freeze(normalizeRelativeOwnSlotEffects(accesses)),
		residualEffects,
		parameterEscape: Object.freeze(parameterEscape),
		receiverEscape: receiver.escape,
	});
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
	const transferIdentityKinds: Array<number | undefined> = [];
	const addTransfer = (
		kind: number,
		output: CoreValueId,
		inputs: ReadonlyArray<CoreValueId> = [],
		identityKinds = COMPILER_VALUE_KIND_TOP,
	): void => {
		transferKinds.push(kind);
		if (identityKinds !== COMPILER_VALUE_KIND_TOP)
			transferIdentityKinds[transferKinds.length - 1] = identityKinds;
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
			const row = parameterStart + index;
			const parameter = fn.kernel.blockParameterValue(row);
			if (fn.kernel.blockParameterRole(row) === 1) {
				// A caught completion is a value, not an unreachable return alternative.
				origins[parameter] = ORIGIN_UNKNOWN;
				continue;
			}
			const incoming: Array<CoreValueId> = [];
			for (const edge of cfg.predecessors[block] ?? []) {
				if (!cfg.reachable.has(edge.from)) continue;
				const argument = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
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
		const projection = coreBuiltinResultProjection(fn, instruction);
		const operand =
			opcode === "move" && fn.kernel.instructionOperandCount(instruction) > 0
				? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction))
				: projection?.input;
		const kind =
			operand !== undefined
				? ORIGIN_TRANSFER_COPY
				: opcode === "loadThis"
					? ORIGIN_TRANSFER_RECEIVER
					: FRESH_RESULTS.has(opcode)
						? ORIGIN_TRANSFER_FRESH
						: PRIMITIVE_RESULTS.has(opcode) ||
							  (projection !== undefined && projection.identityKinds === undefined)
							? ORIGIN_TRANSFER_PRIMITIVE
							: ORIGIN_TRANSFER_UNKNOWN;
		const resultStart = fn.kernel.instructionResultStart(instruction);
		const resultCount = fn.kernel.instructionResultCount(instruction);
		for (let index = 0; index < resultCount; index++) {
			const output = fn.kernel.resultAt(resultStart + index);
			addTransfer(
				kind,
				output,
				operand === undefined ? [] : [operand],
				projection?.identityKinds,
			);
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
				incoming = joinReturnProvenance(incoming, origins[inputs[inputStart + offset]!]!);
			}
		} else if (kind === ORIGIN_TRANSFER_RECEIVER) incoming = ORIGIN_RECEIVER;
		else if (kind === ORIGIN_TRANSFER_FRESH) incoming = ORIGIN_FRESH;
		else if (kind === ORIGIN_TRANSFER_PRIMITIVE) incoming = ORIGIN_PRIMITIVE;
		else incoming = ORIGIN_UNKNOWN;
		const output = outputs[index]! as CoreValueId;
		const identityKinds = transferIdentityKinds[index];
		if (
			!raiseOrigin(
				origins,
				output,
				identityKinds === undefined ? incoming : projectOrigin(incoming, identityKinds),
			)
		)
			continue;
		for (const dependent of dependents[output] ?? []) {
			if (queued[dependent] !== 0) continue;
			queued[dependent] = 1;
			queue.push(dependent);
		}
	}

	let effects = NO_EFFECT_SUMMARY;
	const builtinCallbacks: Array<CoreBuiltinCallbackInvocation> = [];
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
		const callback =
			descriptor.opcode === "callKnown"
				? coreBuiltinCallbackInvocation(fn, instruction)
				: undefined;
		if (callback !== undefined) builtinCallbacks.push(callback);
		effects = joinEffectSummaries(
			effects,
			callback !== undefined
				? callback.residualEffects
				: descriptor.callTransfer === undefined
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
		const observesOperands =
			descriptor.observesOperands ||
			descriptor.opcode === "move" ||
			(descriptor.opcode === "callKnown" &&
				coreKnownBuiltinOnlyObservesOperands(fn, instruction));
		for (let operandIndex = 0; operandIndex < operandCount; operandIndex++) {
			const value = fn.kernel.operandAt(operandStart + operandIndex);
			const origin = origins[value]!;
			if (observesOperands) continue;
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
	const returnedValues: Array<CoreValueId> = [];
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
		returnedValues.push(value);
		const origin = origins[value]!;
		provenance = joinReturnProvenance(provenance, origin);
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
		readAccessor: coreReadAccessorSummary(fn, cfg),
		bodyVersion: fn.version("body"),
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: fn.version("exceptionFlow"),
		callsVersion: fn.version("calls"),
		memoryEffectsVersion: fn.version("memoryEffects"),
		representationsVersion: fn.version("representations"),
		sourcePath: fn.metadata.sourcePath,
		summaryId: functionSummaryId(fn.metadata.sourcePath, fn.id),
		moduleId: moduleSummaryId(fn.metadata.sourcePath),
		effects,
		builtinCallbacks: Object.freeze(builtinCallbacks),
		conditionalOwnSlotEffects: conditionalOwnSlotEffects(
			fn,
			cfg,
			localTransfers,
			origins,
		),
		parameterEscape: Object.freeze(parameterEscape),
		receiverEscape: receiver.escape,
		parameterContainment: Object.freeze(parameterContainment),
		receiverContainment: receiver.containment,
		returnProvenance: provenance,
		returnRepresentation: representation,
		origins: Object.freeze(origins),
		returnOrigins:
			provenance.kind === "unknown"
				? returnOriginPlan(fn, cfg, origins, returnedValues)
				: undefined,
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
	for (const functionId of program.functionIds()) {
		for (const target of targets.publishedFunctions(functionId)) {
			add(target, "published-identity");
		}
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

function conditionalOwnSlotEffectsEqual(
	left: RelativeOwnSlotEffectSummary | undefined,
	right: RelativeOwnSlotEffectSummary | undefined,
): boolean {
	return left === undefined || right === undefined
		? left === right
		: relativeOwnSlotEffectsEqual(left.accesses, right.accesses) &&
				effectSummariesEqual(left.residualEffects, right.residualEffects) &&
				stringSlicesEqual(left.parameterEscape, right.parameterEscape) &&
				left.receiverEscape === right.receiverEscape;
}

function summariesEqual(
	left: FunctionEffectSummary,
	right: FunctionEffectSummary,
): boolean {
	return (
		left === right ||
		(left.id === right.id &&
			coreAttributeValuesEqual(
				left.readAccessor as unknown as CoreAttributeValue,
				right.readAccessor as unknown as CoreAttributeValue,
			) &&
			left.functionIndex === right.functionIndex &&
			left.module === right.module &&
			effectSummariesEqual(left.effects, right.effects) &&
			conditionalOwnSlotEffectsEqual(
				left.conditionalOwnSlotEffects,
				right.conditionalOwnSlotEffects,
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
		if (effects !== EVERY_EFFECT_SUMMARY)
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

function deriveConditionalOwnSlotEffects(
	local: CoreLocalFunctionSummary,
	calls: ReadonlyArray<CoreIndexedCallSite>,
	current: ReadonlyMap<CoreFunctionId, FunctionEffectSummary>,
	includeCalls: boolean,
): RelativeOwnSlotEffectSummary | undefined {
	const seed = local.conditionalOwnSlotEffects;
	// SCC seeds omit calls; consumers see the contract only after every edge converges.
	if (seed === undefined || calls.length === 0 || !includeCalls) return seed;
	const accesses = new Map(
		seed.accesses.map((access) => [relativeOwnSlotEffectKey(access), access]),
	);
	const parameterEscape = [...seed.parameterEscape];
	let receiverEscape = seed.receiverEscape;
	let residualEffects = seed.residualEffects;
	const retain = (value: CoreValueId | undefined, escape: ValueEscapeFact): boolean => {
		if (value === undefined || escape === "none") return true;
		const origin = local.origins[value] ?? ORIGIN_UNKNOWN;
		if (origin.kind === "unknown") return false;
		if (origin.kind === "parameter")
			parameterEscape[origin.index] = joinValueEscape(
				parameterEscape[origin.index] ?? "none",
				escape,
			);
		else if (origin.kind === "receiver")
			receiverEscape = joinValueEscape(receiverEscape, escape);
		return true;
	};
	for (const site of calls) {
		if (
			coreCalleeTargetsAreOpen(site.targets) ||
			site.targets.functions.length === 0 ||
			site.targets.functions.length > 4 ||
			site.transfer.invocation !== "call" ||
			site.arguments === undefined
		)
			return undefined;
		for (const target of site.targets.functions) {
			const callee = current.get(target);
			const conditional = callee?.conditionalOwnSlotEffects;
			if (conditional === undefined) return undefined;
			residualEffects = joinEffectSummaries(residualEffects, conditional.residualEffects);
			for (const [index, argument] of site.arguments.entries()) {
				const escape = conditional.parameterEscape[index] ?? "none";
				if (!retain(argument, escape)) return undefined;
			}
			if (!retain(site.receiver, conditional.receiverEscape)) return undefined;
			for (const access of conditional.accesses) {
				const value =
					access.base.kind === "receiver"
						? site.receiver
						: site.arguments[access.base.index];
				const base = value === undefined ? undefined : local.origins[value];
				if (
					(base?.kind !== "parameter" && base?.kind !== "receiver") ||
					base.identityKinds !== undefined
				)
					return undefined;
				const projected = Object.freeze({ base, key: access.key, mode: access.mode });
				accesses.set(relativeOwnSlotEffectKey(projected), projected);
				if (accesses.size > 32) return undefined;
			}
		}
	}
	return Object.freeze({
		accesses: Object.freeze(normalizeRelativeOwnSlotEffects([...accesses.values()])),
		residualEffects,
		parameterEscape: Object.freeze(parameterEscape),
		receiverEscape,
	});
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
	if (includeCalls) {
		const callbackEffects = (target: CoreFunctionId) => current.get(target)?.effects;
		for (const callback of local.builtinCallbacks)
			effects = joinEffectSummaries(
				effects,
				coreBuiltinCallbackEffects(
					program.function(functionId),
					callback,
					targets,
					callbackEffects,
				) ?? EVERY_EFFECT_SUMMARY,
			);
	}
	for (const site of callSites) {
		if (site.targets.opaque || (!targets.sourceClosed && site.targets.anyScript)) {
			effects = EVERY_EFFECT_SUMMARY;
			for (const argument of site.arguments ?? site.argumentPrefix ?? []) {
				noteCallFact(argument, "retained", "unknown");
			}
			noteCallFact(site.receiver, "retained", "unknown");
			continue;
		}
		if (site.targets.anyScript) {
			if (anyScriptSummary === undefined) {
				throw new Error("Missing AnyScriptAggregate summary");
			}
			if (effects !== EVERY_EFFECT_SUMMARY)
				effects = joinEffectSummaries(effects, anyScriptSummary.effects);
			for (const [index, argument] of (
				site.arguments ??
				site.argumentPrefix ??
				[]
			).entries()) {
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
				effects = EVERY_EFFECT_SUMMARY;
				continue;
			}
			if (effects !== EVERY_EFFECT_SUMMARY)
				effects = joinEffectSummaries(effects, calleeSummary.effects);
			for (const [index, argument] of (
				site.arguments ??
				site.argumentPrefix ??
				[]
			).entries()) {
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
	const conditional = deriveConditionalOwnSlotEffects(
		local,
		targets.outgoing(functionId),
		current,
		includeCalls,
	);
	return Object.freeze({
		id: local.summaryId,
		readAccessor: local.readAccessor,
		functionIndex: functionId,
		module: local.moduleId,
		effects,
		...(conditional !== undefined ? { conditionalOwnSlotEffects: conditional } : {}),
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
		returnProvenance: projectedReturnOrigin(
			program,
			local,
			targets,
			current,
			includeCalls,
		),
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
		for (const summary of summaries) {
			effects = joinEffectSummaries(effects, summary.effects);
			if (effects === EVERY_EFFECT_SUMMARY) break;
		}
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
