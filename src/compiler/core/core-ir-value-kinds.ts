import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
	compilerValueKindMaskIsValid,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CORE_ANY_SCRIPT_AGGREGATE } from "./core-call-graph.ts";
import type { CoreCallGraphNode } from "./core-call-graph.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import { CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "./core-ir-summaries.ts";
import type {
	CoreFunctionId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE =
	"exactCallArgumentRepresentations";
export const CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE = "exactBinaryInputKindMasks";
export const CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE = "exactScalarAfterTdz";
export const CORE_PRIMITIVE_OPERATOR_EFFECT_FACT = "primitive-operator-effects";

export type CoreExactScalarKind = "int32" | "number" | "boolean" | "string";
export type CoreExactCallArgumentRepresentation = "boxed" | CoreExactScalarKind;

export interface CoreValueKindAnalysis {
	kindMask(value: CoreValueId): CompilerValueKindMask;
	latticeMask(value: CoreValueId): CompilerValueKindMask;
	exactScalar(value: CoreValueId): CoreExactScalarKind | undefined;
}

export interface CoreValueKindInputs {
	readonly parameterMasks?: ReadonlyArray<CompilerValueKindMask>;
	readonly receiverMask?: CompilerValueKindMask;
	readonly operationResultMask?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => CompilerValueKindMask | undefined;
}

const NUMERIC_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"-",
	"+",
	"~",
	"increment",
	"decrement",
	"tonumeric",
]);
const NON_COERCING_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"!",
	"typeof",
	"void",
]);
const NUMERIC_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

function numberIsExactInt32(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= -0x8000_0000 &&
		value <= 0x7fff_ffff &&
		!Object.is(value, -0)
	);
}

function representationKind(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CompilerValueKindMask | undefined {
	switch (fn.valueRepresentation(value)) {
		case "f64":
		case "i32":
			return COMPILER_VALUE_KIND_NUMBER;
		case "boolean":
			return COMPILER_VALUE_KIND_BOOLEAN;
		case "string":
		case "string-span":
			return COMPILER_VALUE_KIND_STRING;
		case "projected-elements":
		case "dense-elements":
		case "scalarized-object":
			return COMPILER_VALUE_KIND_OBJECT;
		case "boxed":
			return undefined;
	}
}

function staticOpcodeKind(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerValueKindMask | undefined {
	switch (fn.instructionOpcodeName(instruction)) {
		case "createUndefined":
			return COMPILER_VALUE_KIND_UNDEFINED;
		case "createNull":
			return COMPILER_VALUE_KIND_NULL;
		case "createBoolean":
			return COMPILER_VALUE_KIND_BOOLEAN;
		case "createF64":
		case "createNumber":
			return COMPILER_VALUE_KIND_NUMBER;
		case "createString":
			return COMPILER_VALUE_KIND_STRING;
		case "createBigint":
			return COMPILER_VALUE_KIND_BIGINT;
		case "createPrivateName":
		case "createPrivateNames":
			return COMPILER_VALUE_KIND_SYMBOL;
		case "createFunction":
		case "createArray":
		case "createObject":
		case "createObjectShaped":
		case "createModuleNamespace":
		case "createTemplateObject":
		case "instantiateLiteralTemplate":
			return COMPILER_VALUE_KIND_OBJECT;
		case "isEmpty":
		case "typeofCompare":
			return COMPILER_VALUE_KIND_BOOLEAN;
		default:
			return undefined;
	}
}

interface KindTransfer {
	readonly output: CoreValueId;
	readonly inputs: ReadonlyArray<CoreValueId>;
	readonly evaluate: (masks: Uint16Array) => CompilerValueKindMask;
}

function operationTransfer(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	output: CoreValueId,
	inputs?: CoreValueKindInputs,
): KindTransfer {
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	const operands = Array.from({ length: operandCount }, (_, index) =>
		fn.kernel.operandAt(operandStart + index),
	);
	const staticKind = representationKind(fn, output) ?? staticOpcodeKind(fn, instruction);
	if (staticKind !== undefined) return { output, inputs: [], evaluate: () => staticKind };
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "loadThis" && inputs?.receiverMask !== undefined) {
		return { output, inputs: [], evaluate: () => inputs.receiverMask! };
	}
	const supplied = inputs?.operationResultMask?.(instruction, output);
	if (supplied !== undefined) return { output, inputs: [], evaluate: () => supplied };
	const operator = fn.instructionAttributes(instruction).operator;
	if (opcode === "move" && operands.length === 1) {
		return {
			output,
			inputs: operands,
			evaluate: (masks) => masks[operands[0]!]!,
		};
	}
	if (opcode === "unary" && operands.length === 1 && typeof operator === "string") {
		return {
			output,
			inputs: operands,
			evaluate(masks) {
				if (operator === "!") return COMPILER_VALUE_KIND_BOOLEAN;
				if (operator === "typeof") return COMPILER_VALUE_KIND_STRING;
				if (operator === "void") return COMPILER_VALUE_KIND_UNDEFINED;
				return NUMERIC_UNARY_OPERATORS.has(operator) &&
					compilerValueKindMaskIsSubset(masks[operands[0]!]!, COMPILER_VALUE_KIND_NUMBER)
					? COMPILER_VALUE_KIND_NUMBER
					: COMPILER_VALUE_KIND_TOP;
			},
		};
	}
	if (opcode === "binary" && operands.length === 2 && typeof operator === "string") {
		return {
			output,
			inputs: operands,
			evaluate(masks) {
				if (COMPARISON_OPERATORS.has(operator)) return COMPILER_VALUE_KIND_BOOLEAN;
				const left = masks[operands[0]!]!;
				const right = masks[operands[1]!]!;
				if (left === 0 || right === 0) return 0;
				if (
					operator === "+" &&
					compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_STRING) &&
					compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_STRING)
				) {
					return COMPILER_VALUE_KIND_STRING;
				}
				return NUMERIC_BINARY_OPERATORS.has(operator) &&
					compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_NUMBER) &&
					compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_NUMBER)
					? COMPILER_VALUE_KIND_NUMBER
					: COMPILER_VALUE_KIND_TOP;
			},
		};
	}
	return { output, inputs: [], evaluate: () => COMPILER_VALUE_KIND_TOP };
}

export function analyzeCoreValueKinds(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	inputs?: CoreValueKindInputs,
): CoreValueKindAnalysis {
	const transfers: Array<KindTransfer> = [];
	const formalParameter = new Map<CoreValueId, number>();
	for (let index = 0; index < fn.parameterCount; index++) {
		formalParameter.set(fn.kernel.functionParameter(index), index);
	}
	for (const block of fn.blockIds()) {
		const incoming = cfg.predecessors[block] ?? [];
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const row = parameterStart + index;
			const parameter = fn.kernel.blockParameterValue(row);
			const representation = representationKind(fn, parameter);
			const formal = formalParameter.get(parameter);
			if (
				representation !== undefined ||
				formal !== undefined ||
				fn.kernel.blockParameterRole(row) === 1 ||
				incoming.length === 0
			) {
				const kind =
					representation ??
					(formal === undefined
						? COMPILER_VALUE_KIND_TOP
						: (inputs?.parameterMasks?.[formal] ?? COMPILER_VALUE_KIND_TOP));
				transfers.push({ output: parameter, inputs: [], evaluate: () => kind });
				continue;
			}
			const incomingValues = incoming.flatMap((edge) => {
				const value = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				return value === undefined ? [] : [value];
			});
			transfers.push({
				output: parameter,
				inputs: incomingValues,
				evaluate: (masks) =>
					incomingValues.reduce((mask, value) => mask | masks[value]!, 0),
			});
		}
		for (const instruction of fn.bodyInstructionIds(block)) {
			const resultStart = fn.kernel.instructionResultStart(instruction);
			const resultCount = fn.kernel.instructionResultCount(instruction);
			for (let index = 0; index < resultCount; index++) {
				const output = fn.kernel.resultAt(resultStart + index);
				transfers.push(operationTransfer(fn, instruction, output, inputs));
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
	const masks = new Uint16Array(fn.valueCapacity);
	const queue = transfers.map((_, index) => index);
	const queued = new Uint8Array(transfers.length);
	queued.fill(1);
	let cursor = 0;
	while (cursor < queue.length) {
		const index = queue[cursor++]!;
		queued[index] = 0;
		const transfer = transfers[index]!;
		const next = masks[transfer.output]! | transfer.evaluate(masks);
		if (next === masks[transfer.output]) continue;
		masks[transfer.output] = next;
		for (const dependent of dependents[transfer.output] ?? []) {
			if (queued[dependent] !== 0) continue;
			queued[dependent] = 1;
			queue.push(dependent);
		}
	}
	const exactInt32 = new Uint8Array(fn.valueCapacity);
	for (const value of fn.valueIds()) {
		if (fn.valueRepresentation(value) === "i32") exactInt32[value] = 1;
		if (fn.kernel.valueDefinitionKind(value) !== 1) continue;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionKind(definition) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(definition);
		if (
			(opcode === "createNumber" || opcode === "createF64") &&
			numberIsExactInt32(fn.instructionAttributes(definition).value)
		)
			exactInt32[value] = 1;
	}
	const exactQueue = transfers.map((_, index) => index);
	const exactQueued = new Uint8Array(transfers.length);
	exactQueued.fill(1);
	let exactCursor = 0;
	while (exactCursor < exactQueue.length) {
		const index = exactQueue[exactCursor++]!;
		exactQueued[index] = 0;
		const transfer = transfers[index]!;
		if (
			exactInt32[transfer.output] !== 0 ||
			masks[transfer.output] !== COMPILER_VALUE_KIND_NUMBER ||
			transfer.inputs.length === 0 ||
			transfer.inputs.some((input) => exactInt32[input] === 0)
		)
			continue;
		const definitionKind = fn.kernel.valueDefinitionKind(transfer.output);
		const forwardsInteger =
			definitionKind === 0 ||
			(definitionKind === 1 &&
				fn.instructionOpcodeName(
					coreInstructionId(fn.kernel.valueDefinitionOwner(transfer.output)),
				) === "move");
		if (!forwardsInteger) continue;
		exactInt32[transfer.output] = 1;
		for (const dependent of dependents[transfer.output] ?? []) {
			if (exactQueued[dependent] !== 0) continue;
			exactQueued[dependent] = 1;
			exactQueue.push(dependent);
		}
	}
	const result: CoreValueKindAnalysis = {
		kindMask(value) {
			return masks[value] === 0 ? COMPILER_VALUE_KIND_TOP : masks[value]!;
		},
		latticeMask(value) {
			return masks[value]!;
		},
		exactScalar(value) {
			const mask = masks[value] === 0 ? COMPILER_VALUE_KIND_TOP : masks[value]!;
			if (mask === COMPILER_VALUE_KIND_NUMBER)
				return exactInt32[value] === 1 ? "int32" : "number";
			if (mask === COMPILER_VALUE_KIND_BOOLEAN) return "boolean";
			if (mask === COMPILER_VALUE_KIND_STRING) return "string";
			return undefined;
		},
	};
	return Object.freeze(result);
}

export const CORE_LOCAL_VALUE_KIND_ANALYSIS: CoreAnalysisDefinition<CoreValueKindAnalysis> =
	{
		key: "local-value-kinds",
		scope: "function",
		functionDependencies: ["body", "cfg", "representations"],
		contextIdentity: (context) => context.data.singleAssignmentGlobalSlots.join(","),
		compute({ program, context, request, get }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			const fn = program.function(request.function);
			const cfg = get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request);
			const closedGlobals = new Set(context.data.singleAssignmentGlobalSlots);
			const stores = new Map<
				number,
				{
					readonly instruction: CoreInstructionId;
					readonly value: CoreValueId;
				} | null
			>();
			const emptyInitialization = (value: CoreValueId): boolean => {
				if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
				const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
				const opcode = fn.instructionOpcodeName(definition);
				if (opcode === "createEmpty") return true;
				const source =
					fn.kernel.instructionOperandCount(definition) === 0
						? undefined
						: fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition));
				return opcode === "move" && source !== undefined && emptyInitialization(source);
			};
			for (const instruction of fn.instructionIds()) {
				if (
					fn.instructionKind(instruction) !== "operation" ||
					fn.instructionOpcodeName(instruction) !== "storeGlobal"
				)
					continue;
				const index = fn.instructionAttributes(instruction).index;
				const value =
					fn.kernel.instructionOperandCount(instruction) === 0
						? undefined
						: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
				if (
					typeof index !== "number" ||
					value === undefined ||
					!closedGlobals.has(index) ||
					emptyInitialization(value)
				)
					continue;
				stores.set(index, stores.has(index) ? null : { instruction, value });
			}
			const instructionOrder = new Int32Array(fn.instructionCapacity);
			instructionOrder.fill(-1);
			for (const block of fn.blockIds()) {
				for (const [index, instruction] of [...fn.instructionIds(block)].entries()) {
					instructionOrder[instruction] = index;
				}
			}
			const storedKind = (value: CoreValueId): CompilerValueKindMask | undefined => {
				const representation = representationKind(fn, value);
				if (representation !== undefined) return representation;
				if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
				const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
				const kind = staticOpcodeKind(fn, definition);
				if (kind !== undefined) return kind;
				const source =
					fn.kernel.instructionOperandCount(definition) === 0
						? undefined
						: fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition));
				return fn.instructionOpcodeName(definition) === "move" && source !== undefined
					? storedKind(source)
					: undefined;
			};
			const operationResultMask = (
				instruction: CoreInstructionId,
			): CompilerValueKindMask | undefined => {
				if (fn.instructionOpcodeName(instruction) !== "loadGlobal") return undefined;
				const index = fn.instructionAttributes(instruction).index;
				if (typeof index !== "number") return undefined;
				const store = stores.get(index);
				if (store === undefined || store === null) return undefined;
				const storeBlock = fn.instructionBlock(store.instruction);
				const loadBlock = fn.instructionBlock(instruction);
				const dominates =
					storeBlock === loadBlock
						? instructionOrder[store.instruction]! < instructionOrder[instruction]!
						: cfg.instructionDominatesBlock(storeBlock, loadBlock);
				return dominates ? storedKind(store.value) : undefined;
			};
			return analyzeCoreValueKinds(
				fn,
				cfg,
				closedGlobals.size === 0 ? undefined : { operationResultMask },
			);
		},
	};

export interface CoreProgramValueKindSummary {
	readonly parameterKinds: ReadonlyArray<CompilerValueKindMask>;
	readonly receiverKind: CompilerValueKindMask;
	readonly returnKind: CompilerValueKindMask;
}

export interface CoreProgramValueKindStatistics {
	readonly functions: number;
	readonly functionsEvaluated: number;
	readonly functionsReused: number;
	readonly affectedFunctions: number;
	readonly callerWakeups: number;
	readonly calleeWakeups: number;
	readonly aggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
	readonly aggregateFunctionVisits: number;
}

export interface CoreProgramValueKinds {
	readonly changedFunctions: ReadonlySet<CoreFunctionId>;
	readonly statistics: CoreProgramValueKindStatistics;
	values(functionId: CoreFunctionId): CoreValueKindAnalysis;
	summary(functionId: CoreFunctionId): CoreProgramValueKindSummary;
}

interface CoreProgramValueKindState extends CoreProgramValueKinds {
	readonly sourceClosed: boolean;
	readonly targets: CoreCallGraphIndex;
	readonly versionKeys: ReadonlyMap<CoreFunctionId, string>;
	readonly external: ReadonlyMap<CoreFunctionId, boolean>;
	readonly valueAnalyses: ReadonlyMap<CoreFunctionId, CoreValueKindAnalysis>;
	readonly summaries: ReadonlyMap<CoreFunctionId, CoreProgramValueKindSummary>;
	readonly wildcardContributions: ReadonlyMap<
		CoreFunctionId,
		CoreProgramValueKindWildcardContribution
	>;
	readonly anyScriptAggregate: CoreProgramValueKindAggregate | undefined;
}

interface CoreProgramValueKindWildcardContribution {
	readonly parameterKinds: ReadonlyArray<CompilerValueKindMask>;
	readonly strictReceiverKind: CompilerValueKindMask;
}

interface CoreProgramValueKindAggregate extends CoreProgramValueKindWildcardContribution {
	readonly returnKind: CompilerValueKindMask;
}

function programValueKindVersionKey(fn: CoreFunctionStore): string {
	const { body, cfg, calls, representations } = fn.versions;
	return `${body}:${cfg}:${calls}:${representations}`;
}

function programValueKindTargetsKey(
	targets: CoreCallGraphIndex,
	functionId: CoreFunctionId,
): string {
	return targets
		.outgoing(functionId)
		.map(
			(site) =>
				`${site.id}:${site.targets.functions.join(",")}:${site.targets.anyScript ? "a" : "-"}:${site.targets.opaque ? "o" : "-"}`,
		)
		.join("|");
}

function freezeProgramValueKindSummary(
	summary: CoreProgramValueKindSummary,
): CoreProgramValueKindSummary {
	return Object.freeze({
		parameterKinds: Object.freeze([...summary.parameterKinds]),
		receiverKind: summary.receiverKind,
		returnKind: summary.returnKind,
	});
}

function sameMasks(
	left: ReadonlyArray<CompilerValueKindMask>,
	right: ReadonlyArray<CompilerValueKindMask>,
): boolean {
	return (
		left.length === right.length && left.every((value, index) => value === right[index])
	);
}

function sameWildcardContribution(
	left: CoreProgramValueKindWildcardContribution | undefined,
	right: CoreProgramValueKindWildcardContribution | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.strictReceiverKind === right.strictReceiverKind &&
		sameMasks(left.parameterKinds, right.parameterKinds)
	);
}

function solveCoreProgramValueKinds(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	externallyReachable: (functionId: CoreFunctionId) => boolean,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
	previous?: CoreProgramValueKindState,
): CoreProgramValueKindState {
	const functionIds = [...program.functionIds()];
	const maximumParameterCount = functionIds.reduce(
		(largest, functionId) =>
			Math.max(largest, program.function(functionId).parameterCount),
		0,
	);
	const live = new Set(functionIds);
	const versionKeys = new Map(
		functionIds.map((functionId) => [
			functionId,
			programValueKindVersionKey(program.function(functionId)),
		]),
	);
	const external = new Map(
		functionIds.map((functionId) => [functionId, externallyReachable(functionId)]),
	);
	const affected = new Set<CoreFunctionId>();
	let aggregateInitiallyAffected = false;
	if (previous === undefined || previous.sourceClosed !== targets.sourceClosed) {
		for (const functionId of functionIds) affected.add(functionId);
		aggregateInitiallyAffected = targets.graph.hasAggregate();
	} else {
		for (const functionId of functionIds) {
			if (
				previous.versionKeys.get(functionId) !== versionKeys.get(functionId) ||
				previous.external.get(functionId) !== external.get(functionId) ||
				programValueKindTargetsKey(previous.targets, functionId) !==
					programValueKindTargetsKey(targets, functionId)
			)
				affected.add(functionId);
		}
		aggregateInitiallyAffected = targets.graph.changedNodes.has(
			CORE_ANY_SCRIPT_AGGREGATE,
		);
		if (previous.targets.graph.hasAggregate() && !targets.graph.hasAggregate()) {
			for (const functionId of functionIds) affected.add(functionId);
		}
	}
	const affectedQueue = [...affected];
	let affectedCursor = 0;
	while (affectedCursor < affectedQueue.length) {
		const functionId = affectedQueue[affectedCursor++]!;
		for (const index of [targets, previous?.targets]) {
			if (index === undefined) continue;
			for (const neighbor of [
				...index.graph.exactOutgoing(functionId),
				...index.graph.exactCallers(functionId),
			]) {
				if (!live.has(neighbor) || affected.has(neighbor)) continue;
				affected.add(neighbor);
				affectedQueue.push(neighbor);
			}
		}
	}
	let anyScriptAggregate = targets.graph.hasAggregate()
		? previous?.anyScriptAggregate
		: undefined;
	const seededSummary = (
		functionId: CoreFunctionId,
		aggregate: CoreProgramValueKindAggregate | undefined,
	): CoreProgramValueKindSummary => {
		const fn = program.function(functionId);
		const seed = external.get(functionId) === true ? COMPILER_VALUE_KIND_TOP : 0;
		return {
			parameterKinds: Array.from(
				{ length: fn.parameterCount },
				(_, index) => seed | (aggregate?.parameterKinds[index] ?? 0),
			),
			receiverKind:
				seed |
				(aggregate === undefined
					? 0
					: fn.metadata.strict
						? aggregate.strictReceiverKind
						: COMPILER_VALUE_KIND_OBJECT),
			returnKind: 0,
		};
	};
	const summaries = new Map<CoreFunctionId, CoreProgramValueKindSummary>();
	const valueAnalyses = new Map<CoreFunctionId, CoreValueKindAnalysis>();
	for (const functionId of functionIds) {
		if (!affected.has(functionId)) {
			const summary = previous?.summaries.get(functionId);
			const analysis = previous?.valueAnalyses.get(functionId);
			if (summary !== undefined && analysis !== undefined) {
				summaries.set(functionId, summary);
				valueAnalyses.set(functionId, analysis);
				continue;
			}
			affected.add(functionId);
		}
		summaries.set(functionId, seededSummary(functionId, anyScriptAggregate));
	}
	const wildcardContributions = new Map<
		CoreFunctionId,
		CoreProgramValueKindWildcardContribution
	>();
	for (const [functionId, contribution] of previous?.wildcardContributions ?? []) {
		if (live.has(functionId)) {
			wildcardContributions.set(functionId, contribution);
		}
	}
	const queue: Array<CoreCallGraphNode> = [
		...affected,
		...(aggregateInitiallyAffected && targets.graph.hasAggregate()
			? [CORE_ANY_SCRIPT_AGGREGATE]
			: []),
	];
	const queued = new Set<CoreCallGraphNode>(queue);
	let callerWakeups = 0;
	let calleeWakeups = 0;
	const enqueue = (node: CoreCallGraphNode, caller: boolean): void => {
		if ((node !== CORE_ANY_SCRIPT_AGGREGATE && !affected.has(node)) || queued.has(node))
			return;
		queued.add(node);
		queue.push(node);
		if (caller) callerWakeups++;
		else calleeWakeups++;
	};
	const activate = (functionId: CoreFunctionId, caller: boolean): void => {
		if (affected.has(functionId)) {
			enqueue(functionId, caller);
			return;
		}
		affected.add(functionId);
		valueAnalyses.delete(functionId);
		summaries.set(functionId, seededSummary(functionId, anyScriptAggregate));
		enqueue(functionId, caller);
	};
	const activateExactComponent = (initial: CoreFunctionId, caller: boolean): void => {
		if (affected.has(initial)) {
			enqueue(initial, caller);
			return;
		}
		const pending = [initial];
		const seen = new Set<CoreFunctionId>();
		for (let index = 0; index < pending.length; index++) {
			const functionId = pending[index]!;
			if (!live.has(functionId) || seen.has(functionId)) continue;
			seen.add(functionId);
			activate(functionId, caller);
			for (const graphIndex of [targets, previous?.targets]) {
				if (graphIndex === undefined) continue;
				pending.push(...graphIndex.graph.exactOutgoing(functionId));
				pending.push(...graphIndex.graph.exactCallers(functionId));
			}
		}
	};
	let cursor = 0;
	let functionsEvaluated = 0;
	let aggregateRecomputations = 0;
	let exactReverseCallerVisits = 0;
	let wildcardReverseCallerVisits = 0;
	let aggregateFunctionVisits = 0;
	const applyIncoming = (
		callee: CoreFunctionId,
		incomingParameterKinds: ReadonlyArray<CompilerValueKindMask>,
		strictReceiverKind: CompilerValueKindMask,
	): void => {
		if (!live.has(callee)) return;
		const calleeFn = program.function(callee);
		const prior = summaries.get(callee)!;
		const parameterKinds = [...prior.parameterKinds];
		for (let index = 0; index < calleeFn.parameterCount; index++) {
			parameterKinds[index] =
				parameterKinds[index]! | (incomingParameterKinds[index] ?? 0);
		}
		const incomingReceiver = calleeFn.metadata.strict
			? strictReceiverKind
			: COMPILER_VALUE_KIND_OBJECT;
		const receiverKind = prior.receiverKind | incomingReceiver;
		if (
			receiverKind === prior.receiverKind &&
			parameterKinds.every((kind, index) => kind === prior.parameterKinds[index])
		)
			return;
		summaries.set(callee, { ...prior, parameterKinds, receiverKind });
		enqueue(callee, false);
	};
	while (cursor < queue.length) {
		const node = queue[cursor++]!;
		queued.delete(node);
		if (node === CORE_ANY_SCRIPT_AGGREGATE) {
			const parameterKinds = Array<CompilerValueKindMask>(maximumParameterCount).fill(0);
			let strictReceiverKind = 0;
			for (const caller of targets.graph.wildcardCallers) {
				const contribution = wildcardContributions.get(caller);
				if (contribution === undefined) continue;
				for (let index = 0; index < maximumParameterCount; index++) {
					parameterKinds[index] =
						parameterKinds[index]! | (contribution.parameterKinds[index] ?? 0);
				}
				strictReceiverKind |= contribution.strictReceiverKind;
			}
			let returnKind = 0;
			for (const summary of summaries.values()) {
				aggregateFunctionVisits++;
				returnKind |= summary.returnKind;
			}
			const prior = anyScriptAggregate;
			const next: CoreProgramValueKindAggregate = {
				parameterKinds,
				strictReceiverKind,
				returnKind,
			};
			aggregateRecomputations++;
			anyScriptAggregate = next;
			if (prior?.returnKind !== returnKind) {
				for (const caller of targets.graph.wildcardCallers) {
					wildcardReverseCallerVisits++;
					activateExactComponent(caller, true);
				}
			}
			if (!sameWildcardContribution(prior, next)) {
				for (const functionId of functionIds) activate(functionId, false);
				for (const callee of functionIds) {
					aggregateFunctionVisits++;
					applyIncoming(callee, parameterKinds, strictReceiverKind);
				}
				enqueue(CORE_ANY_SCRIPT_AGGREGATE, false);
			}
			continue;
		}
		const functionId = node;
		const fn = program.function(functionId);
		const summary = summaries.get(functionId)!;
		const sites = targets.outgoing(functionId);
		const byInstruction = new Map(sites.map((site) => [site.instruction, site]));
		const values = analyzeCoreValueKinds(fn, controlFlow(functionId), {
			parameterMasks: summary.parameterKinds,
			receiverMask: summary.receiverKind,
			operationResultMask(instruction) {
				const site = byInstruction.get(instruction);
				if (site === undefined) return undefined;
				if (site.targets.opaque || (!targets.sourceClosed && site.targets.anyScript)) {
					return COMPILER_VALUE_KIND_TOP;
				}
				if (site.targets.anyScript) {
					return anyScriptAggregate?.returnKind ?? 0;
				}
				const callees = site.targets.functions;
				if (callees.length === 0) return COMPILER_VALUE_KIND_TOP;
				return callees.reduce(
					(mask, callee) => mask | summaries.get(callee)!.returnKind,
					0,
				);
			},
		});
		valueAnalyses.set(functionId, values);
		functionsEvaluated++;
		let returnKind = 0;
		const cfg = controlFlow(functionId);
		for (const block of cfg.reachable) {
			const terminator = fn.blockTerminator(block);
			if (fn.instructionKind(terminator) === "return") {
				returnKind |= values.latticeMask(
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
				);
			}
		}
		if (returnKind !== summary.returnKind) {
			summaries.set(functionId, { ...summary, returnKind });
			for (const caller of targets.graph.exactCallers(functionId)) {
				exactReverseCallerVisits++;
				activateExactComponent(caller, true);
			}
			if (targets.graph.hasAggregate()) {
				enqueue(CORE_ANY_SCRIPT_AGGREGATE, true);
			}
		}
		const anyScriptParameterKinds =
			Array<CompilerValueKindMask>(maximumParameterCount).fill(0);
		let anyScriptStrictReceiverKind = 0;
		let hasAnyScriptSite = false;
		for (const site of sites) {
			if (site.targets.anyScript) {
				hasAnyScriptSite = true;
				for (let index = 0; index < maximumParameterCount; index++) {
					const argument = site.arguments?.[index];
					anyScriptParameterKinds[index] =
						anyScriptParameterKinds[index]! |
						(site.arguments === undefined
							? COMPILER_VALUE_KIND_TOP
							: argument === undefined
								? COMPILER_VALUE_KIND_UNDEFINED
								: values.latticeMask(argument));
				}
				anyScriptStrictReceiverKind |=
					site.receiver === undefined
						? COMPILER_VALUE_KIND_TOP
						: values.latticeMask(site.receiver);
				continue;
			}
			const incomingParameterKinds = Array<CompilerValueKindMask>(maximumParameterCount);
			for (let index = 0; index < maximumParameterCount; index++) {
				const argument = site.arguments?.[index];
				incomingParameterKinds[index] =
					site.arguments === undefined
						? COMPILER_VALUE_KIND_TOP
						: argument === undefined
							? COMPILER_VALUE_KIND_UNDEFINED
							: values.latticeMask(argument);
			}
			for (const callee of site.targets.functions) {
				applyIncoming(
					callee,
					incomingParameterKinds,
					site.receiver === undefined
						? COMPILER_VALUE_KIND_TOP
						: values.latticeMask(site.receiver),
				);
			}
		}
		if (hasAnyScriptSite) {
			const contribution: CoreProgramValueKindWildcardContribution = {
				parameterKinds: anyScriptParameterKinds,
				strictReceiverKind: anyScriptStrictReceiverKind,
			};
			if (
				!sameWildcardContribution(wildcardContributions.get(functionId), contribution)
			) {
				wildcardContributions.set(functionId, contribution);
				enqueue(CORE_ANY_SCRIPT_AGGREGATE, false);
			}
		} else if (wildcardContributions.delete(functionId) && targets.graph.hasAggregate()) {
			enqueue(CORE_ANY_SCRIPT_AGGREGATE, false);
		}
	}
	const changedFunctions = new Set(affected);
	for (const functionId of functionIds) {
		const frozen = freezeProgramValueKindSummary(summaries.get(functionId)!);
		summaries.set(functionId, frozen);
	}
	const statistics = Object.freeze({
		functions: functionIds.length,
		functionsEvaluated,
		functionsReused: functionIds.length - affected.size,
		affectedFunctions: affected.size,
		callerWakeups,
		calleeWakeups,
		aggregateRecomputations,
		exactReverseCallerVisits,
		wildcardReverseCallerVisits,
		aggregateFunctionVisits,
	});
	return Object.freeze({
		sourceClosed: targets.sourceClosed,
		targets,
		versionKeys,
		external,
		valueAnalyses,
		summaries,
		wildcardContributions,
		anyScriptAggregate,
		changedFunctions,
		statistics,
		values(functionId: CoreFunctionId) {
			const result = valueAnalyses.get(functionId);
			if (result === undefined)
				throw new Error(`No value-kind analysis for ${functionId}`);
			return result;
		},
		summary(functionId: CoreFunctionId) {
			const result = summaries.get(functionId);
			if (result === undefined)
				throw new Error(`No value-kind summary for ${functionId}`);
			return result;
		},
	});
}

export const CORE_PROGRAM_VALUE_KIND_ANALYSIS: CoreAnalysisDefinition<CoreProgramValueKindState> =
	{
		key: "program-value-kinds",
		scope: "program",
		functionDependencies: ["body", "cfg", "calls", "representations"],
		programDependencies: ["functions", "calls", "facts", "representations"],
		contextIdentity(context) {
			return context.facts.closure.sourceClosure.kind;
		},
		compute({ program, request, previous, get }) {
			if (request.scope !== "program") throw new Error("Expected program analysis");
			const summaries = get(CORE_PROGRAM_SUMMARIES_ANALYSIS, request);
			return solveCoreProgramValueKinds(
				program,
				summaries.targets,
				(functionId) => summaries.summary(functionId)?.externallyReachable === true,
				(functionId) =>
					get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, {
						scope: "function",
						function: functionId,
					}),
				previous as CoreProgramValueKindState | undefined,
			);
		},
	};

function exactPrimitiveTypeof(mask: number): string | undefined {
	if (mask === COMPILER_VALUE_KIND_UNDEFINED) return "undefined";
	if (mask === COMPILER_VALUE_KIND_NULL) return "object";
	if (mask === COMPILER_VALUE_KIND_BOOLEAN) return "boolean";
	if (mask === COMPILER_VALUE_KIND_NUMBER) return "number";
	if (mask === COMPILER_VALUE_KIND_STRING) return "string";
	if (mask === COMPILER_VALUE_KIND_BIGINT) return "bigint";
	if (mask === COMPILER_VALUE_KIND_SYMBOL) return "symbol";
	return undefined;
}

function coreStringConstant(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
): string | undefined {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (
		fn.instructionKind(definition) !== "operation" ||
		fn.instructionOpcodeName(definition) !== "createString"
	)
		return undefined;
	const stringIndex = fn.instructionAttributes(definition).stringIndex;
	if (typeof stringIndex !== "number") return undefined;
	const units = program.stringConstants[stringIndex];
	return units === undefined ? undefined : String.fromCodePoint(...units);
}

export function coreValueKindObservation(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kindMask: (value: CoreValueId) => CompilerValueKindMask,
): boolean | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.kernel.instructionResultCount(instruction) !== 1
	)
		return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	const operand = (index: number): CoreValueId | undefined =>
		index < operandCount ? fn.kernel.operandAt(operandStart + index) : undefined;
	if (opcode === "typeofCompare") {
		const input = operand(0);
		const expected = fn.instructionAttributes(instruction).expected;
		if (input === undefined || typeof expected !== "string") return undefined;
		const actual = exactPrimitiveTypeof(kindMask(input));
		if (actual === undefined) return undefined;
		const equal = actual === expected;
		return fn.instructionAttributes(instruction).negated === true ? !equal : equal;
	}
	if (opcode === "unary" && fn.instructionAttributes(instruction).operator === "!") {
		const input = operand(0);
		return input !== undefined &&
			compilerValueKindMaskIsSubset(
				kindMask(input),
				COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_NULL,
			)
			? true
			: undefined;
	}
	if (opcode !== "binary" || operandCount !== 2) return undefined;
	const operator = fn.instructionAttributes(instruction).operator;
	if (operator !== "===" && operator !== "!==") return undefined;
	const typeofResult = (value: CoreValueId, other: CoreValueId): boolean | undefined => {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (
			fn.instructionKind(definition) !== "operation" ||
			fn.instructionOpcodeName(definition) !== "unary" ||
			fn.instructionAttributes(definition).operator !== "typeof"
		)
			return undefined;
		const input =
			fn.kernel.instructionOperandCount(definition) === 0
				? undefined
				: fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition));
		const expected = coreStringConstant(program, fn, other);
		if (input === undefined || expected === undefined) return undefined;
		const actual = exactPrimitiveTypeof(kindMask(input));
		return actual === undefined ? undefined : actual === expected;
	};
	const left = operand(0)!;
	const right = operand(1)!;
	const equal =
		typeofResult(left, right) ??
		typeofResult(right, left) ??
		((kindMask(left) & kindMask(right)) === 0 ? false : undefined);
	return equal === undefined ? undefined : operator === "===" ? equal : !equal;
}

export function coreExactBinaryInputKindMasks(
	value: unknown,
): readonly [CompilerValueKindMask, CompilerValueKindMask] | undefined {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!compilerValueKindMaskIsValid(value[0]) ||
		!compilerValueKindMaskIsValid(value[1])
	)
		return undefined;
	return value as unknown as readonly [CompilerValueKindMask, CompilerValueKindMask];
}

export function coreBinaryInputKindMasksHaveExactNativeSemantics(
	operator: unknown,
	masks: readonly [CompilerValueKindMask, CompilerValueKindMask],
): boolean {
	return (
		typeof operator === "string" &&
		COMPARISON_OPERATORS.has(operator) &&
		compilerValueKindMaskIsSubset(masks[0], COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED) &&
		compilerValueKindMaskIsSubset(masks[1], COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED)
	);
}

export function corePrimitiveOperatorEffectRefinement(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	masks: ReadonlyArray<CompilerValueKindMask>,
): CoreInstructionEffects | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const operator = fn.instructionAttributes(instruction).operator;
	let primitive = false;
	let gcFree = false;
	if (opcode === "unary" && masks.length === 1 && typeof operator === "string") {
		const numberOnly = compilerValueKindMaskIsSubset(
			masks[0]!,
			COMPILER_VALUE_KIND_NUMBER,
		);
		primitive =
			NON_COERCING_UNARY_OPERATORS.has(operator) ||
			(NUMERIC_UNARY_OPERATORS.has(operator) && numberOnly);
		gcFree = NON_COERCING_UNARY_OPERATORS.has(operator) || numberOnly;
	} else if (opcode === "binary" && masks.length === 2 && typeof operator === "string") {
		const numbersOnly = masks.every((mask) =>
			compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NUMBER),
		);
		primitive =
			["===", "!=="].includes(operator) ||
			(NUMERIC_BINARY_OPERATORS.has(operator) && numbersOnly) ||
			(operator === "+" &&
				masks.every((mask) =>
					compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_STRING),
				)) ||
			coreBinaryInputKindMasksHaveExactNativeSemantics(operator, [masks[0]!, masks[1]!]);
		gcFree =
			["===", "!=="].includes(operator) ||
			(numbersOnly &&
				(NUMERIC_BINARY_OPERATORS.has(operator) || COMPARISON_OPERATORS.has(operator)));
	}
	if (!primitive) return undefined;
	const baseline = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
	return {
		reads: baseline.reads.filter((domain) => domain !== "host"),
		writes: baseline.writes.filter((domain) => domain !== "host"),
		mayThrow: false,
		maySuspend: baseline.maySuspend,
		mayGc: gcFree ? false : baseline.mayGc,
		callsUserCode: false,
	};
}

export function coreExactCallArgumentRepresentations(
	value: unknown,
	parameterCount?: number,
): ReadonlyArray<CoreExactCallArgumentRepresentation> | undefined {
	if (
		!Array.isArray(value) ||
		(parameterCount !== undefined && value.length !== parameterCount) ||
		value.some(
			(entry) =>
				entry !== "boxed" &&
				entry !== "int32" &&
				entry !== "number" &&
				entry !== "boolean" &&
				entry !== "string",
		)
	)
		return undefined;
	return value as ReadonlyArray<CoreExactCallArgumentRepresentation>;
}

export interface CoreExactValueFactSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

export function materializeCoreExactScalarRepresentations(
	program: CoreProgram,
): CoreExactValueFactSelection {
	return { program, changed: false };
}

export function selectCoreExactValueFacts(
	program: CoreProgram,
): CoreExactValueFactSelection {
	return { program, changed: false };
}
