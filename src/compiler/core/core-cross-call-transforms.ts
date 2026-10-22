import { COMPILER_VALUE_KIND_TOP } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import {
	coreArrayIterationCall,
	expandCoreArrayIterationCall,
} from "./core-array-iteration.ts";
import { coreConstructorSlotReserve } from "./core-constructor-layout.ts";
import { CoreEditor } from "./core-editor.ts";
import {
	coreCaptureOwners,
	coreCreatesFunctions,
	coreSingleActivationFunctions,
} from "./core-function-activations.ts";
import { cloneCoreFunction, coreFunctionIsCloneable } from "./core-function-clone.ts";
import type { CoreCrossCallFunctionOptimizationResult } from "./core-function-optimization-session.ts";
import {
	coreFunctionPrototypeCall,
	coreGuardableCall,
	expandCoreFunctionIndexCall,
	expandCoreFunctionPrototypeCall,
} from "./core-function-prototype-call.ts";
import {
	coreInstanceMethodHint,
	coreInstanceMethodHints,
	coreInstanceMethodTargets,
} from "./core-instance-method-hints.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import {
	coreDirectCreatedFunction,
	coreCalleeTargetsAreOpen,
	coreCalleeTargetsSingleFunction,
	coreValueIsLoadedGlobalProperty,
} from "./core-ir-call-targets.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	buildCoreControlFlow,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import {
	CORE_GENERATED_CODE_COST_WEIGHTS,
	coreBlockLoopFrequency,
} from "./core-ir-generated-cost.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "./core-ir-provenance.ts";
import type { CoreLocalOptimizationPlanInput } from "./core-ir-region-selection.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import {
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	coreValueKindDemand,
	coreValueKindObservation,
} from "./core-ir-value-kinds.ts";
import type {
	CoreProgramValueKinds,
	CoreProgramValueKindState,
} from "./core-ir-value-kinds.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { coreArgumentObservation } from "./core-native-entry-analysis.ts";
import {
	coreFieldArgument,
	coreReadOnlyParameterFields,
} from "./core-native-field-analysis.ts";
import { coreModulePrivateNames } from "./core-private-names.ts";
import type { CoreModulePrivateNameIndex } from "./core-private-names.ts";
import {
	CORE_PROGRAM_FLOW_ANALYSIS,
	CORE_PROGRAM_VALUE_KIND_ANALYSIS,
} from "./core-program-flow-analysis.ts";
import type { CoreProgramFlowState } from "./core-program-flow-analysis.ts";
import {
	expandCoreReadAccessorRegion,
	coreReadAccessorRegionCost,
	EMPTY_CORE_READ_ACCESSOR_WORK,
} from "./core-read-accessor-expansion.ts";
import type { CoreReadAccessorWork } from "./core-read-accessor-expansion.ts";
import { specializeCoreStaticArguments } from "./core-static-value-calls.ts";
import type { CoreChangeSet, CoreFunctionStore, CoreProgram } from "./core-store.ts";
import { coreSynchronousCallbackConsumer } from "./core-synchronous-callbacks.ts";
import type { CoreSynchronousCallbackConsumer } from "./core-synchronous-callbacks.ts";
import {
	CoreTransformCandidateService,
	DEFAULT_CORE_TRANSFORM_BUDGETS,
} from "./core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformBudgetStatistics,
	CoreTransformCandidate,
} from "./core-transform-candidates.ts";
import { virtualizeGuardedCallbackEnvironment } from "./core-virtual-captures.ts";

export interface CoreCrossCallTransformStatistics
	extends CoreTransformBudgetStatistics, Readonly<CoreReadAccessorWork> {
	readonly waves: number;
	readonly callerEditSessions: number;
	readonly callerLocalOptimizations: number;
	readonly programFlowResolves: number;
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
	readonly callGraphFunctionsAnalyzed: number;
	readonly summaryFunctionsAnalyzed: number;
	readonly sccNodesAnalyzed: number;
	readonly sccEdgeVisits: number;
	readonly sccTransfers: number;
	readonly callerWakeups: number;
	readonly valueKindFunctionEvaluations: number;
	readonly valueKindFolds: number;
	readonly wildcardAggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
}

interface AppliedTransform {
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
}

const readAccessorInputs = new WeakMap<
	CoreProgram,
	{
		names: CoreModulePrivateNameIndex;
		hints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>;
		work?: CoreReadAccessorWork;
	}
>();

interface InlineTarget {
	readonly captureValues: ReadonlyMap<CoreInstructionId, CoreValueId>;
	readonly argumentSnapshots: boolean;
	readonly construction: boolean;
	readonly linear: boolean;
	readonly returnValues: ReadonlyArray<CoreValueId>;
	readonly function: CoreFunctionStore;
	readonly returnValue: CoreValueId;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly blocks: ReadonlyArray<{
		readonly id: CoreBlockId;
		readonly instructions: ReadonlyArray<CoreInstructionId>;
		readonly parameters: ReadonlyArray<readonly [CoreValueId, CoreValueId]>;
	}>;
}

// Constants become operands or immediates of the instructions that read them.
const INLINE_CODELESS_OPCODES: ReadonlySet<string> = new Set([
	"createUndefined",
	"createNull",
	"createBoolean",
	"createI32",
	"createF64",
	"createNumber",
	"createString",
]);

function inlineCodeSize(inline: InlineTarget): number {
	let size = 0;
	for (const instruction of inline.instructions)
		if (!INLINE_CODELESS_OPCODES.has(inline.function.instructionOpcodeName(instruction)))
			size++;
	return size;
}

function materializeInstructionOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	const values: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++)
		values.push(fn.kernel.operandAt(start + index));
	return values;
}

function materializeInstructionResults(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionResultStart(instruction);
	const count = fn.kernel.instructionResultCount(instruction);
	const values: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++)
		values.push(fn.kernel.resultAt(start + index));
	return values;
}

function inlineSourcePositions(
	program: CoreProgram,
	editor: CoreEditor,
	callee: CoreFunctionId,
	callerPosition: number | undefined,
	instructions: ReadonlyArray<CoreInstructionId>,
	fn: CoreFunctionStore,
): ReadonlyMap<CoreInstructionId, number | undefined> {
	const appended: Array<(typeof program.sourcePositions)[number]> = [];
	const base = program.sourcePositions.length;
	const relocated = new Map<number, number>();
	const relocate = (positionId: number): number => {
		const known = relocated.get(positionId);
		if (known !== undefined) return known;
		const position = program.sourcePositions[positionId];
		if (position === undefined) {
			throw new Error(`Inline source position ${positionId} does not exist`);
		}
		const relocatedCaller =
			position.inlinedFunctionIndex !== undefined && position.callerPosId !== undefined
				? relocate(position.callerPosId)
				: callerPosition;
		const result = base + appended.length;
		appended.push(
			Object.freeze({
				line: position.line,
				column: position.column,
				inlinedFunctionIndex: position.inlinedFunctionIndex ?? callee,
				...(relocatedCaller === undefined ? {} : { callerPosId: relocatedCaller }),
			}),
		);
		relocated.set(positionId, result);
		return result;
	};
	const result = new Map<CoreInstructionId, number | undefined>();
	for (const instruction of instructions) {
		const position = fn.instructionSourcePosition(instruction);
		result.set(instruction, position === undefined ? callerPosition : relocate(position));
	}
	editor.appendSourcePositions(appended);
	return result;
}

// The callback runs once per element, so its call site is weighted like a loop body.
const ARRAY_ITERATION_CALLBACK_EXPOSURE = 8;

const INLINE_ENVIRONMENT_OPCODES: ReadonlySet<string> = new Set([
	"loadCaptured",
	"createFunction",
	"withEnter",
	"withExit",
	"withGet",
	"withResolveBase",
	"withSet",
]);

const INLINE_UNSUPPORTED_OPCODES = new Set([
	"createArgumentsObject",
	"createRestArguments",
	"createRestArgumentsState",
	"callRestArguments",
	"loadArgumentCount",
	"loadCallee",
	"loadStaticArgument",
	"storeCaptured",
]);

interface InlineCaptureContext {
	readonly caller: CoreFunctionStore;
	readonly callee: CoreValueId;
	readonly site: CoreInstructionId;
	// The callee was created in the caller's current scope chain, so its captured
	// stores reach the same environments from an inlined copy.
	readonly sameScopeChain?: true;
}

function immutableCaptureValue(
	program: CoreProgram,
	context: InlineCaptureContext,
	owner: unknown,
	index: unknown,
): CoreValueId | undefined {
	const caller = context.caller;
	const cells = discoveredCapturedCellWrites.get(program);
	if (
		owner !== caller.id ||
		typeof index !== "number" ||
		cells === undefined ||
		!cells.sourceClosed ||
		cells.rebinding.has(caller.id) ||
		caller.metadata.mappedArgumentSlots.includes(index)
	)
		return undefined;
	const writes = cells.writes.get(`${caller.id}:${index}`);
	if (writes?.length !== 1 || writes[0]!.function !== caller.id) return undefined;
	const store = writes[0]!.instruction;
	if (caller.instructionOpcodeName(store) !== "storeCaptured") return undefined;
	const from = caller.instructionBlock(store),
		to = caller.instructionBlock(context.site);
	if (
		caller.handlerBlockCount !== 0 &&
		(from !== caller.entry || caller.kernel.blockHandlerBlock(from) !== undefined)
	)
		return undefined;
	const flow = buildCoreControlFlow(program, caller.id, { exceptions: true });
	if (
		flow.loops.some((loop) => loop.blocks.has(from)) ||
		flow.irreducibleCycles.some((cycle) => cycle.blocks.has(from))
	)
		return undefined;
	if (from === to) {
		let precedes = false;
		for (const instruction of caller.instructionIds(from)) {
			if (instruction === context.site) break;
			if (instruction === store) precedes = true;
		}
		if (!precedes) return undefined;
	} else if (!flow.instructionDominatesBlock(from, to)) return undefined;
	return caller.kernel.operandAt(caller.kernel.instructionOperandStart(store));
}

const CAPTURE_ENVIRONMENT_REBINDS = new Set(["envPush", "envCopy", "envPop"]);

interface CapturedCellWrites {
	readonly sourceClosed: boolean;
	readonly writes: ReadonlyMap<
		string,
		ReadonlyArray<{
			readonly function: CoreFunctionId;
			readonly instruction: CoreInstructionId;
		}>
	>;
	readonly rebinding: ReadonlySet<CoreFunctionId>;
}

// Each discovery resets this; a wave's inlines never add captured-cell writers.
const discoveredCapturedCellWrites = new WeakMap<CoreProgram, CapturedCellWrites>();

function capturedCellWrites(
	program: CoreProgram,
	sourceClosed: boolean,
): CapturedCellWrites {
	const writes = new Map<
		string,
		Array<{ function: CoreFunctionId; instruction: CoreInstructionId }>
	>();
	const rebinding = new Set<CoreFunctionId>();
	const record = (
		owner: unknown,
		index: unknown,
		write: { function: CoreFunctionId; instruction: CoreInstructionId },
	) => {
		const key = `${String(owner)}:${String(index)}`;
		const known = writes.get(key);
		if (known === undefined) writes.set(key, [write]);
		else known.push(write);
	};
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const attributes = fn.instructionAttributes(instruction);
			const write = { function: functionId, instruction };
			if (opcode === "storeCaptured")
				record(attributes.functionIndex, attributes.index, write);
			else if (
				opcode === "createPrivateNames" &&
				Array.isArray(attributes.capturedIndices)
			)
				for (const index of attributes.capturedIndices)
					record(attributes.functionIndex, index, write);
			else if (CAPTURE_ENVIRONMENT_REBINDS.has(opcode)) rebinding.add(functionId);
		}
	}
	return { writes, rebinding, sourceClosed };
}

/**
 * A callee read from a cell that only its owner fills with this target's fresh
 * closures shares the caller's environment for that owner and its ancestors, so
 * the callee's captured reads resolve identically when copied into the caller.
 */
function ancestorCaptureContext(
	program: CoreProgram,
	cells: CapturedCellWrites,
	caller: CoreFunctionStore,
	callee: CoreValueId,
	site: CoreInstructionId,
	target: CoreFunctionId,
): InlineCaptureContext | undefined {
	if (caller.kernel.valueDefinitionKind(callee) !== 1) return undefined;
	const load = coreInstructionId(caller.kernel.valueDefinitionOwner(callee));
	if (
		caller.instructionKind(load) !== "operation" ||
		caller.instructionOpcodeName(load) !== "loadCaptured"
	)
		return undefined;
	const { functionIndex: owner, index } = caller.instructionAttributes(load);
	if (
		typeof owner !== "number" ||
		typeof index !== "number" ||
		cells.rebinding.has(owner as CoreFunctionId)
	)
		return undefined;
	const writes = cells.writes.get(`${owner}:${index}`) ?? [];
	if (writes.length === 0) return undefined;
	for (const write of writes) {
		if (write.function !== owner) return undefined;
		const fn = program.function(write.function);
		if (fn.instructionOpcodeName(write.instruction) !== "storeCaptured") return undefined;
		const value = fn.kernel.operandAt(
			fn.kernel.instructionOperandStart(write.instruction),
		);
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const creation = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (
			fn.instructionOpcodeName(creation) !== "createFunction" ||
			fn.instructionAttributes(creation).functionIndex !== target
		)
			return undefined;
	}
	return { caller, callee, site };
}

// Each discovery resets this alongside the captured-cell writes.
const discoveredSingleActivations = new WeakMap<
	CoreProgram,
	ReadonlySet<CoreFunctionId>
>();

/**
 * A callee whose captured scopes all run once reads the same environments as a
 * caller that already captures them, wherever its closure came from, such as a
 * parameter that only ever receives a module-level helper.
 */
function singleActivationCaptureContext(
	program: CoreProgram,
	once: ReadonlySet<CoreFunctionId>,
	caller: CoreFunctionStore,
	callee: CoreValueId,
	site: CoreInstructionId,
	target: CoreFunctionId,
): InlineCaptureContext | undefined {
	const fn = program.function(target);
	const owners = coreCaptureOwners(fn);
	if (owners.size === 0) return undefined;
	const callerOwners = coreCaptureOwners(caller);
	for (const owner of owners)
		if (
			!once.has(owner as CoreFunctionId) ||
			(owner !== caller.id && !callerOwners.has(owner))
		)
			return undefined;
	// A closure created in the copy would bind the caller's scope, not the callee's.
	if (coreCreatesFunctions(fn)) return undefined;
	return { caller, callee, site };
}

function applicationCaptureContext(
	program: CoreProgram,
	caller: CoreFunctionStore,
	callee: CoreValueId,
	site: CoreInstructionId,
	target: CoreFunctionId,
): InlineCaptureContext | undefined {
	const cells = discoveredCapturedCellWrites.get(program);
	const once = discoveredSingleActivations.get(program);
	return (
		directCaptureContext(caller, callee, site, target) ??
		(cells === undefined
			? undefined
			: ancestorCaptureContext(program, cells, caller, callee, site, target)) ??
		(once === undefined
			? undefined
			: singleActivationCaptureContext(program, once, caller, callee, site, target))
	);
}

// Every candidate call site of a large caller asks for the same predecessor edges.
const blockPredecessors = new WeakMap<
	CoreFunctionStore,
	{
		readonly cfgVersion: number;
		readonly predecessors: ReadonlyMap<CoreBlockId, ReadonlyArray<CoreBlockId>>;
	}
>();

function blockPredecessorsOf(
	fn: CoreFunctionStore,
): ReadonlyMap<CoreBlockId, ReadonlyArray<CoreBlockId>> {
	// An open editor's edits move no version until it commits.
	const cfgVersion = fn.hasActiveEditor ? undefined : fn.version("cfg");
	const cached = blockPredecessors.get(fn);
	if (cfgVersion !== undefined && cached?.cfgVersion === cfgVersion)
		return cached.predecessors;
	const predecessors = new Map<CoreBlockId, Array<CoreBlockId>>();
	for (const block of fn.blockIds()) {
		const last = fn.kernel.blockLastInstruction(block);
		if (last < 0 || fn.instructionKind(coreInstructionId(last)) === "operation") continue;
		const terminator = coreInstructionId(last);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		for (let edge = 0; edge < fn.kernel.terminatorEdgeCount(terminator); edge++) {
			const target = fn.kernel.terminatorEdgeBlock(edgeStart + edge);
			const incoming = predecessors.get(target) ?? [];
			incoming.push(block);
			predecessors.set(target, incoming);
		}
	}
	if (cfgVersion !== undefined) blockPredecessors.set(fn, { cfgVersion, predecessors });
	return predecessors;
}

function captureEnvironmentIsStable(
	fn: CoreFunctionStore,
	creation: CoreInstructionId,
	site: CoreInstructionId,
): boolean {
	const creationBlock = fn.instructionBlock(creation);
	const siteBlock = fn.instructionBlock(site);
	const predecessors = blockPredecessorsOf(fn);
	const canReachSite = new Set<CoreBlockId>([siteBlock]);
	const reverse = [siteBlock];
	while (reverse.length > 0 && canReachSite.size <= 64) {
		const block = reverse.pop()!;
		if (block === creationBlock) continue;
		for (const predecessor of predecessors.get(block) ?? []) {
			if (canReachSite.has(predecessor)) continue;
			canReachSite.add(predecessor);
			reverse.push(predecessor);
		}
	}
	if (!canReachSite.has(creationBlock) || canReachSite.size > 64) return false;

	let reachedSite = false;
	const pending = [creationBlock];
	const visited = new Set<CoreBlockId>();
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (visited.has(block)) continue;
		visited.add(block);
		let afterCreation = block !== creationBlock;
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (!afterCreation) {
				afterCreation = instruction === creation;
				continue;
			}
			if (instruction === site) {
				reachedSite = true;
				break;
			}
			if (CAPTURE_ENVIRONMENT_REBINDS.has(fn.instructionOpcodeName(instruction)))
				return false;
		}
		if (block === siteBlock) continue;
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		for (let edge = 0; edge < fn.kernel.terminatorEdgeCount(terminator); edge++) {
			const target = fn.kernel.terminatorEdgeBlock(edgeStart + edge);
			if (canReachSite.has(target)) pending.push(target);
		}
	}
	return reachedSite;
}

function directCaptureContext(
	caller: CoreFunctionStore,
	callee: CoreValueId,
	site: CoreInstructionId,
	target: CoreFunctionId,
): InlineCaptureContext | undefined {
	if (
		caller.kernel.valueDefinitionKind(callee) !== 1 ||
		caller.kernel.valueHandlerUseCount(callee) !== 0
	)
		return undefined;
	const creation = coreInstructionId(caller.kernel.valueDefinitionOwner(callee));
	if (
		caller.instructionOpcodeName(creation) !== "createFunction" ||
		caller.instructionAttributes(creation).functionIndex !== target ||
		!captureEnvironmentIsStable(caller, creation, site)
	)
		return undefined;
	let uses = 0;
	for (
		let use = caller.kernel.valueFirstUse(callee);
		use >= 0;
		use = caller.kernel.useNext(use)
	) {
		if (caller.kernel.useLive(use) === 0) continue;
		const instruction = coreInstructionId(caller.kernel.useInstruction(use));
		if (instruction === site) {
			if (++uses > 1) return undefined;
			continue;
		}
		if (
			caller.instructionKind(instruction) !== "operation" ||
			caller.instructionOpcodeName(instruction) !== "call" ||
			caller.instructionAttributes(instruction)[
				CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
			] !== true
		) {
			if (
				caller.instructionKind(instruction) === "operation" &&
				caller.instructionOpcodeName(instruction) === "call" &&
				caller.kernel.useOperand(use) === 0 &&
				captureEnvironmentIsStable(caller, creation, instruction)
			)
				continue;
			return undefined;
		}
		const descriptor = caller.registry.byId(caller.instructionOpcode(instruction));
		if (descriptor.callTransfer?.arguments.kind !== "positional") return undefined;
		const position = caller.kernel.useOperand(use);
		if (position < descriptor.callTransfer.arguments.firstOperand) return undefined;
	}
	if (uses !== 1) return undefined;
	return { caller, callee, site, sameScopeChain: true };
}

function inlineTarget(
	program: CoreProgram,
	caller: CoreFunctionStore,
	target: CoreFunctionId,
	invocation: "call" | "construct",
	captureContext?: InlineCaptureContext,
	synchronousCallback?: CoreSynchronousCallbackConsumer,
): InlineTarget | undefined {
	const fn = program.function(target);
	const callbackConsumer =
		synchronousCallback?.function === fn &&
		synchronousCallback.bodyVersion === fn.version("body");
	if (
		fn.isGenerator ||
		fn.isAsync ||
		// Strictness belongs to the running function, as an assignment through `with` shows.
		fn.metadata.strict !== caller.metadata.strict ||
		(invocation === "call" && fn.metadata.isClassConstructor) ||
		(invocation === "construct" &&
			(!fn.metadata.hasPrototype || fn.metadata.isDerivedConstructor)) ||
		fn.metadata.capturedCount !== 0
	)
		return undefined;
	const hasArgumentSnapshots = [...fn.instructionIds()].some(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "loadArgument",
	);
	if (hasArgumentSnapshots && coreArgumentObservation(fn).kind === "general")
		return undefined;
	const functionParameters = new Set<CoreValueId>();
	for (let index = 0; index < fn.parameterCount; index++)
		functionParameters.add(fn.kernel.functionParameter(index));
	const entryParameterStart = fn.kernel.blockParameterStart(fn.entry);
	for (let index = 0; index < fn.kernel.blockParameterCount(fn.entry); index++)
		if (
			!functionParameters.has(fn.kernel.blockParameterValue(entryParameterStart + index))
		)
			return undefined;
	const visited = new Set<CoreBlockId>();
	const active = new Set<CoreBlockId>();
	const ordered: Array<CoreBlockId> = [];
	const returns: Array<CoreValueId> = [];
	let linear = true;
	let instructionCount = 0;
	const visit = (block: CoreBlockId): boolean => {
		if (active.has(block)) {
			linear = false;
			return callbackConsumer;
		}
		if (visited.has(block)) return true;
		if (
			visited.size >= (callbackConsumer ? 64 : 16) ||
			(!callbackConsumer && fn.kernel.blockHandlerBlock(block) !== undefined)
		)
			return false;
		visited.add(block);
		active.add(block);
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				++instructionCount > (callbackConsumer ? 128 : 48) ||
				(INLINE_UNSUPPORTED_OPCODES.has(opcode) &&
					!(opcode === "storeCaptured" && captureContext?.sameScopeChain === true)) ||
				(invocation !== "construct" && opcode === "loadNewTarget") ||
				(invocation === "construct" &&
					["createFunction", "envCopy", "envPop", "envPush"].includes(opcode)) ||
				// Creating a descendant closure also binds the callee's lexical environment,
				// and `with` references resolve through it too.
				(INLINE_ENVIRONMENT_OPCODES.has(opcode) && captureContext === undefined) ||
				(opcode === "loadThis" && !fn.metadata.strict)
			)
				return false;
			const refinement = fn.instructionEffectRefinement(instruction);
			if (refinement !== undefined) {
				const fact = fn.fact(refinement.proof);
				// Generic operators remain valid while the caller reproves their effects.
				if (
					(opcode !== "unary" && opcode !== "binary") ||
					fact.kind !== CORE_PRIMITIVE_OPERATOR_EFFECT_FACT ||
					fact.obligations.length !== 0
				)
					return false;
			}
		}
		const terminator = fn.blockTerminator(block);
		const handler = fn.kernel.blockHandlerBlock(block);
		if (handler !== undefined) {
			linear = false;
			if (!visit(handler)) return false;
		}
		const kind = fn.instructionKind(terminator);
		if (kind === "return")
			returns.push(fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)));
		// The cloned throw inherits the call site's handler, as the call's exception would.
		else if (kind === "throw") linear = false;
		else if (kind === "jump" || kind === "branch" || kind === "switch") {
			if (kind !== "jump") linear = false;
			const start = fn.kernel.terminatorEdgeStart(terminator);
			for (let index = 0; index < fn.kernel.terminatorEdgeCount(terminator); index++) {
				const edge = start + index;
				const next = fn.kernel.terminatorEdgeBlock(edge);
				if (
					fn.kernel.blockParameterCount(next) !==
						fn.kernel.terminatorEdgeArgumentCount(edge) ||
					!visit(next)
				)
					return false;
			}
		} else return false;
		active.delete(block);
		ordered.push(block);
		return true;
	};
	if (!visit(fn.entry) || returns.length === 0) return undefined;
	if (
		invocation === "construct" &&
		returns.some((value) => constructorReturnMode(fn, value) === undefined)
	)
		return undefined;
	ordered.reverse();
	const blocks: Array<InlineTarget["blocks"][number]> = [];
	for (const [index, id] of ordered.entries()) {
		const parameters: Array<readonly [CoreValueId, CoreValueId]> = [];
		if (linear && index > 0) {
			const edge = fn.kernel.terminatorEdgeStart(fn.blockTerminator(ordered[index - 1]!));
			const start = fn.kernel.blockParameterStart(id);
			const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
			for (let offset = 0; offset < fn.kernel.blockParameterCount(id); offset++)
				parameters.push([
					fn.kernel.blockParameterValue(start + offset),
					fn.kernel.operandAt(argumentStart + offset),
				]);
		}
		blocks.push({
			id,
			instructions: [...fn.bodyInstructionIds(id)],
			parameters,
		});
	}
	const captureValues = new Map<CoreInstructionId, CoreValueId>();
	if (captureContext !== undefined) {
		for (const block of blocks)
			for (const instruction of block.instructions) {
				if (fn.instructionOpcodeName(instruction) !== "loadCaptured") continue;
				const attributes = fn.instructionAttributes(instruction);
				const value = immutableCaptureValue(
					program,
					captureContext,
					attributes.functionIndex,
					attributes.index,
				);
				if (value !== undefined) captureValues.set(instruction, value);
			}
	}
	return {
		captureValues,
		argumentSnapshots: hasArgumentSnapshots,
		construction: invocation === "construct",
		function: fn,
		linear,
		returnValue: returns[0]!,
		returnValues: returns,
		blocks,
		instructions: blocks.flatMap((block) => block.instructions),
	};
}

type ConstructorReturnMode = "receiver" | "returned" | "dynamic";

function constructorReturnMode(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): ConstructorReturnMode | undefined {
	if (seen.has(value)) return undefined;
	seen.add(value);
	switch (fn.valueRepresentation(value)) {
		case "f64":
		case "i32":
		case "boolean":
		case "string":
		case "string-span":
			return "receiver";
		case "projected-elements":
		case "dense-elements":
		case "scalarized-object":
			return "returned";
		case "boxed":
			break;
	}
	if (fn.kernel.valueDefinitionKind(value) !== 1) return "dynamic";
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (fn.instructionKind(definition) !== "operation") return "dynamic";
	const opcode = fn.instructionOpcodeName(definition);
	if (opcode === "move") {
		const input = materializeInstructionOperands(fn, definition)[0];
		return input === undefined ? undefined : constructorReturnMode(fn, input, seen);
	}
	if (opcode === "loadThis") return "receiver";
	if (opcode === "loadNewTarget") return "returned";
	if (
		[
			"createUndefined",
			"createNull",
			"createBoolean",
			"createF64",
			"createNumber",
			"createString",
			"createBigint",
			"createPrivateName",
			"createPrivateNames",
			"binary",
			"unary",
			"typeofCompare",
			"isEmpty",
		].includes(opcode)
	)
		return "receiver";
	if (
		[
			"createFunction",
			"createArray",
			"createObject",
			"createObjectShaped",
			"createModuleNamespace",
			"createTemplateObject",
			"instantiateLiteralTemplate",
		].includes(opcode)
	)
		return "returned";
	return "dynamic";
}

interface ScalarConstructorLayout {
	readonly keyStringIndices: ReadonlyArray<number>;
	readonly initialValues: ReadonlyArray<CoreValueId>;
	readonly primitiveParameterIndices: ReadonlyArray<number>;
	readonly returnsReceiver: boolean;
	readonly stores: ReadonlySet<CoreInstructionId>;
}

const SCALAR_CONSTRUCTOR_VALUE_OPCODES = new Set([
	"move",
	"createUndefined",
	"createNull",
	"createBoolean",
	"createF64",
	"createNumber",
	"createString",
	"createBigint",
	"binary",
	"unary",
	"typeofCompare",
	"isEmpty",
]);

function scalarConstructorValueProducer(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	available: ReadonlySet<CoreValueId>,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
	if (!SCALAR_CONSTRUCTOR_VALUE_OPCODES.has(opcode)) return false;
	if (
		materializeInstructionOperands(fn, instruction).some((value) => !available.has(value))
	)
		return false;
	return true;
}

function locallyPrimitiveValue(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): boolean {
	if (
		["f64", "i32", "boolean", "string", "string-span"].includes(
			fn.valueRepresentation(value),
		)
	)
		return true;
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return false;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition);
	if (
		[
			"createUndefined",
			"createNull",
			"createBoolean",
			"createF64",
			"createNumber",
			"createString",
			"createBigint",
			"binary",
			"unary",
			"typeofCompare",
			"isEmpty",
		].includes(opcode)
	)
		return true;
	if (opcode !== "move" || fn.kernel.instructionOperandCount(definition) !== 1)
		return false;
	return locallyPrimitiveValue(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition)),
		seen,
	);
}

function constructorKeyIsNamed(program: CoreProgram, stringIndex: number): boolean {
	const units = program.stringConstants[stringIndex];
	if (units === undefined || units.length === 0) return units !== undefined;
	const name = String.fromCodePoint(...units);
	if (name === "__proto__") return false;
	if (name === "0") return false;
	if (name.length > 1 && name.charCodeAt(0) === 0x30) return true;
	let index = 0;
	for (const unit of units) {
		if (unit < 0x30 || unit > 0x39) return true;
		index = index * 10 + unit - 0x30;
		if (index > 0xffff_ffff) return true;
	}
	return index === 0xffff_ffff;
}

function scalarConstructorLayout(
	program: CoreProgram,
	inline: InlineTarget,
): ScalarConstructorLayout | undefined {
	const returnMode = constructorReturnMode(inline.function, inline.returnValue);
	if (
		!inline.construction ||
		!inline.linear ||
		(returnMode !== "receiver" && returnMode !== "returned")
	)
		return undefined;
	const parameters = new Set<CoreValueId>();
	const valueParameters = new Map<CoreValueId, ReadonlySet<number>>();
	for (let index = 0; index < inline.function.parameterCount; index++) {
		const parameter = inline.function.kernel.functionParameter(index);
		parameters.add(parameter);
		valueParameters.set(parameter, new Set([index]));
	}
	const availableValues = new Set(parameters);
	const primitiveParameterIndices = new Set<number>();
	const receivers = new Set<CoreValueId>();
	const keys: Array<number> = [];
	const values: Array<CoreValueId> = [];
	const stores = new Set<CoreInstructionId>();
	let receiverStoresComplete = false;
	for (const instruction of inline.instructions) {
		const opcode = inline.function.instructionOpcodeName(instruction);
		const outputs = materializeInstructionResults(inline.function, instruction);
		if (opcode === "loadThis") {
			if (outputs.length !== 1 || receiverStoresComplete) return undefined;
			receivers.add(outputs[0]!);
			continue;
		}
		const operands = materializeInstructionOperands(inline.function, instruction);
		if (scalarConstructorValueProducer(inline.function, instruction, availableValues)) {
			const dependencies = new Set<number>();
			for (const operand of operands)
				for (const parameter of valueParameters.get(operand) ?? [])
					dependencies.add(parameter);
			if (
				(opcode === "binary" || opcode === "unary") &&
				inline.function.instructionEffectRefinement(instruction) === undefined
			)
				for (const parameter of dependencies) primitiveParameterIndices.add(parameter);
			for (const output of outputs) {
				availableValues.add(output);
				valueParameters.set(output, dependencies);
			}
			continue;
		}
		if (opcode !== "storePropertyStatic") {
			if (returnMode !== "returned" || operands.some((value) => receivers.has(value)))
				return undefined;
			receiverStoresComplete = true;
			continue;
		}
		const stringIndex = inline.function.instructionAttributes(instruction).stringIndex;
		if (
			receiverStoresComplete ||
			operands.length !== 2 ||
			!receivers.has(operands[0]!) ||
			!availableValues.has(operands[1]!) ||
			typeof stringIndex !== "number" ||
			!constructorKeyIsNamed(program, stringIndex) ||
			keys.includes(stringIndex)
		)
			return undefined;
		keys.push(stringIndex);
		values.push(operands[1]!);
		stores.add(instruction);
	}
	if (keys.length === 0 || keys.length > 8) return undefined;
	return {
		keyStringIndices: Object.freeze(keys),
		initialValues: Object.freeze(values),
		primitiveParameterIndices: Object.freeze([...primitiveParameterIndices]),
		returnsReceiver: returnMode === "receiver",
		stores,
	};
}

interface ConstructorMethodConsumer {
	readonly lookup: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly keyStringIndex: number;
	readonly target: CoreFunctionId;
	readonly inline: InlineTarget;
}

interface ConstructorConsumerPlan {
	readonly prefix: ReadonlyArray<CoreInstructionId>;
	readonly suffix: ReadonlyArray<CoreInstructionId>;
	readonly liveOut: ReadonlyArray<CoreValueId>;
	readonly method?: ConstructorMethodConsumer;
}

function valueUsesAreExactly(
	fn: CoreFunctionStore,
	value: CoreValueId,
	expected: ReadonlyArray<readonly [CoreInstructionId, number]>,
): boolean {
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return false;
	const actual: Array<readonly [CoreInstructionId, number]> = [];
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		actual.push([
			coreInstructionId(fn.kernel.useInstruction(use)),
			fn.kernel.useOperand(use),
		]);
	}
	return (
		actual.length === expected.length &&
		expected.every(([instruction, operand]) =>
			actual.some(
				([actualInstruction, actualOperand]) =>
					actualInstruction === instruction && actualOperand === operand,
			),
		)
	);
}

function scalarConstructorMethod(
	program: CoreProgram,
	fn: CoreFunctionStore,
	tail: ReadonlyArray<CoreInstructionId>,
	callResult: CoreValueId,
	originalTerminator: CoreInstructionId,
	layout: ScalarConstructorLayout,
	instanceMethodHints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
): ConstructorConsumerPlan | undefined {
	if (!layout.returnsReceiver || tail.length < 2) return undefined;
	const [lookup, call] = tail;
	if (
		lookup === undefined ||
		call === undefined ||
		fn.instructionOpcodeName(lookup) !== "loadPropertyStatic" ||
		fn.instructionOpcodeName(call) !== "call"
	)
		return undefined;
	const lookupInputs = materializeInstructionOperands(fn, lookup);
	const lookupOutputs = materializeInstructionResults(fn, lookup);
	const keyStringIndex = fn.instructionAttributes(lookup).stringIndex;
	if (
		lookupInputs.length !== 1 ||
		lookupInputs[0] !== callResult ||
		lookupOutputs.length !== 1 ||
		typeof keyStringIndex !== "number" ||
		layout.keyStringIndices.includes(keyStringIndex)
	)
		return undefined;
	const methodValue = lookupOutputs[0]!;
	const descriptor = fn.registry.byId(fn.instructionOpcode(call));
	const callInputs = materializeInstructionOperands(fn, call);
	if (
		descriptor.callTransfer?.invocation !== "call" ||
		descriptor.callTransfer.result !== "call-completion" ||
		descriptor.callTransfer.arguments.kind !== "positional" ||
		callInputs[descriptor.callTransfer.calleeOperand] !== methodValue ||
		descriptor.callTransfer.receiverOperand === undefined ||
		callInputs[descriptor.callTransfer.receiverOperand] !== callResult ||
		descriptor.callTransfer.arguments.firstOperand !== callInputs.length
	)
		return undefined;
	const callOutputs = materializeInstructionResults(fn, call);
	if (callOutputs.length !== 1) return undefined;
	const targets = coreInstanceMethodTargets(
		fn,
		methodValue,
		callResult,
		instanceMethodHints,
	);
	if (targets?.length !== 1) return undefined;
	const target = targets[0]!;
	const inline = inlineTarget(program, fn, target, "call");
	if (
		inline === undefined ||
		!inline.linear ||
		inline.function.parameterCount !== 0 ||
		!canBridgeInlineResult(
			inline.function.valueRepresentation(inline.returnValue),
			fn.valueRepresentation(callOutputs[0]!),
		)
	)
		return undefined;
	const receiverValues = new Set<CoreValueId>();
	const availableValues = new Set<CoreValueId>();
	for (const instruction of inline.instructions) {
		const opcode = inline.function.instructionOpcodeName(instruction);
		const inputs = materializeInstructionOperands(inline.function, instruction);
		const outputs = materializeInstructionResults(inline.function, instruction);
		if (opcode === "loadThis") {
			if (inputs.length !== 0 || outputs.length !== 1) return undefined;
			receiverValues.add(outputs[0]!);
			continue;
		}
		if (opcode === "loadPropertyStatic") {
			const fieldStringIndex =
				inline.function.instructionAttributes(instruction).stringIndex;
			if (
				inputs.length !== 1 ||
				!receiverValues.has(inputs[0]!) ||
				outputs.length !== 1 ||
				typeof fieldStringIndex !== "number" ||
				!layout.keyStringIndices.includes(fieldStringIndex)
			)
				return undefined;
			availableValues.add(outputs[0]!);
			continue;
		}
		if (!scalarConstructorValueProducer(inline.function, instruction, availableValues))
			return undefined;
		for (const output of outputs) availableValues.add(output);
	}
	if (!availableValues.has(inline.returnValue)) return undefined;
	if (
		!valueUsesAreExactly(fn, callResult, [
			[lookup, 0],
			[call, descriptor.callTransfer.receiverOperand],
		]) ||
		!valueUsesAreExactly(fn, methodValue, [
			[call, descriptor.callTransfer.calleeOperand],
		]) ||
		materializeInstructionOperands(fn, originalTerminator).includes(callOutputs[0]!)
	)
		return undefined;
	return {
		prefix: Object.freeze([lookup, call]),
		suffix: Object.freeze(tail.slice(2)),
		liveOut: Object.freeze([callOutputs[0]!]),
		method: { lookup, call, keyStringIndex, target, inline },
	};
}

function constructorFieldConsumerPlan(
	fn: CoreFunctionStore,
	tail: ReadonlyArray<CoreInstructionId>,
	callResult: CoreValueId,
	originalTerminator: CoreInstructionId,
	layout: ScalarConstructorLayout,
): ConstructorConsumerPlan | undefined {
	const aliases = new Set<CoreValueId>([callResult]);
	let lastUse = -1;
	for (const [index, instruction] of tail.entries()) {
		const opcode = fn.instructionOpcodeName(instruction);
		const operands = materializeInstructionOperands(fn, instruction);
		for (const [position, operand] of operands.entries()) {
			if (!aliases.has(operand)) continue;
			const stringIndex = fn.instructionAttributes(instruction).stringIndex;
			if (
				!((opcode === "move" || opcode === "throwIfTdz") && position === 0) &&
				!(
					opcode === "loadPropertyStatic" &&
					position === 0 &&
					typeof stringIndex === "number" &&
					layout.keyStringIndices.includes(stringIndex)
				)
			)
				return undefined;
			lastUse = index;
		}
		if (
			(opcode === "move" || opcode === "throwIfTdz") &&
			operands.length > 0 &&
			aliases.has(operands[0]!)
		) {
			for (const output of materializeInstructionResults(fn, instruction))
				aliases.add(output);
		}
	}
	if (lastUse < 0 || lastUse >= 12) return undefined;
	const prefix = tail.slice(0, lastUse + 1);
	const prefixSet = new Set(prefix);
	const terminatorOperands = materializeInstructionOperands(fn, originalTerminator);
	if (terminatorOperands.some((value) => aliases.has(value))) return undefined;
	for (const alias of aliases) {
		if (fn.kernel.valueHandlerUseCount(alias) !== 0) return undefined;
		for (
			let use = fn.kernel.valueFirstUse(alias);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = coreInstructionId(fn.kernel.useInstruction(use));
			if (!prefixSet.has(instruction)) return undefined;
		}
	}
	const liveOut: Array<CoreValueId> = [];
	for (const instruction of prefix) {
		for (const output of materializeInstructionResults(fn, instruction)) {
			let internal = false;
			let external = fn.kernel.valueHandlerUseCount(output) !== 0;
			for (
				let use = fn.kernel.valueFirstUse(output);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const user = coreInstructionId(fn.kernel.useInstruction(use));
				if (prefixSet.has(user)) internal = true;
				else external = true;
			}
			if (external && internal) return undefined;
			if (external) liveOut.push(output);
		}
	}
	if (liveOut.length === 0 || liveOut.length > 4) return undefined;
	return {
		prefix: Object.freeze(prefix),
		suffix: Object.freeze(tail.slice(lastUse + 1)),
		liveOut: Object.freeze(liveOut),
	};
}

function constructorConsumerPlan(
	program: CoreProgram,
	fn: CoreFunctionStore,
	tail: ReadonlyArray<CoreInstructionId>,
	callResult: CoreValueId,
	originalTerminator: CoreInstructionId,
	layout: ScalarConstructorLayout,
	instanceMethodHints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
): ConstructorConsumerPlan | undefined {
	return (
		scalarConstructorMethod(
			program,
			fn,
			tail,
			callResult,
			originalTerminator,
			layout,
			instanceMethodHints,
		) ?? constructorFieldConsumerPlan(fn, tail, callResult, originalTerminator, layout)
	);
}

function appendConstructReceiver(
	editor: CoreEditor,
	block: CoreBlockId,
	callee: CoreValueId,
	slotReserve: number,
	position: number | undefined,
): CoreValueId {
	return editor.appendInstruction(block, "createBaseConstructReceiver", [callee], {
		attributes: { constructorSlotReserve: slotReserve },
		sourcePosition: position,
	}).outputs[0]!;
}

function cloneConstructorConsumerPrefix(
	editor: CoreEditor,
	fn: CoreFunctionStore,
	destination: CoreBlockId,
	plan: ConstructorConsumerPlan,
	callResult: CoreValueId,
	receiver: CoreValueId,
	methodValue?: CoreValueId,
): {
	readonly liveOut: ReadonlyArray<CoreValueId>;
	readonly methodCall?: CoreInstructionId;
	readonly instructionsIntroduced: number;
} {
	const values = new Map<CoreValueId, CoreValueId>([[callResult, receiver]]);
	let methodCall: CoreInstructionId | undefined;
	let instructionsIntroduced = 0;
	for (const instruction of plan.prefix) {
		if (instruction === plan.method?.lookup) {
			const output = materializeInstructionResults(fn, instruction)[0];
			if (output === undefined || methodValue === undefined)
				throw new Error("Validated constructor method lookup has no guarded value");
			values.set(output, methodValue);
			continue;
		}
		const inputs = materializeInstructionOperands(fn, instruction).map(
			(value) => values.get(value) ?? value,
		);
		const outputs = materializeInstructionResults(fn, instruction);
		const inserted = editor.appendInstruction(
			destination,
			fn.instructionOpcodeName(instruction),
			inputs,
			{
				outputCount: outputs.length,
				outputRepresentations: outputs.map((value) => fn.valueRepresentation(value)),
				attributes: fn.instructionAttributes(instruction),
				sourcePosition: fn.instructionSourcePosition(instruction),
			},
		);
		instructionsIntroduced++;
		if (instruction === plan.method?.call) methodCall = inserted.instruction;
		for (const [index, output] of outputs.entries())
			values.set(output, inserted.outputs[index]!);
	}
	return {
		liveOut: plan.liveOut.map((value) => values.get(value)!),
		...(methodCall === undefined ? {} : { methodCall }),
		instructionsIntroduced,
	};
}

function callCarriesDirectCreatedFunction(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
	if (descriptor.callTransfer?.arguments.kind !== "positional") return false;
	const operands = materializeInstructionOperands(fn, instruction);
	return operands
		.slice(descriptor.callTransfer.arguments.firstOperand)
		.some((value) => coreDirectCreatedFunction(fn, value) !== undefined);
}

function guardedConstructorConsumerDuplication(
	program: CoreProgram,
	fn: CoreFunctionStore,
	inline: InlineTarget | undefined,
	site: CoreInstructionId,
	result: CoreValueId | undefined,
	instanceMethodHints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
): number {
	if (inline === undefined || result === undefined) return 0;
	const layout = scalarConstructorLayout(program, inline);
	if (layout === undefined) return 0;
	const block = fn.instructionBlock(site);
	const terminator = fn.blockTerminator(block);
	if (fn.instructionKind(terminator) === "guard") return 0;
	const tail: Array<CoreInstructionId> = [];
	for (
		let instruction = fn.instructionNext(site);
		instruction !== undefined && instruction !== terminator;
		instruction = fn.instructionNext(instruction)
	)
		tail.push(instruction);
	const plan = constructorConsumerPlan(
		program,
		fn,
		tail,
		result,
		terminator,
		layout,
		instanceMethodHints,
	);
	return plan === undefined
		? 0
		: plan.prefix.length +
				(plan.method?.inline.instructions.length ?? 0) +
				(plan.method === undefined ? 0 : 3);
}

function nativeFieldEntryMethodEligible(fn: CoreFunctionStore, name: number): boolean {
	return nativeFieldEntryMethodName(fn) === name;
}

function nativeFieldEntryMethodName(fn: CoreFunctionStore): number | undefined {
	return fn.parameterCount === 1 &&
		!fn.metadata.hasPrototype &&
		!fn.metadata.isClassConstructor &&
		!fn.metadata.isDerivedConstructor &&
		!fn.isGenerator &&
		!fn.isAsync
		? fn.metadata.nameStringIndex
		: undefined;
}

function nativeFieldEntryNominees(
	program: CoreProgram,
	liveFunctions: ReadonlySet<CoreFunctionId>,
): ReadonlyMap<number, number> {
	const nominees = new Map<number, number>();
	for (const functionId of liveFunctions) {
		const name = nativeFieldEntryMethodName(program.function(functionId));
		if (name !== undefined) nominees.set(name, (nominees.get(name) ?? 0) + 1);
	}
	return nominees;
}

function prefersFieldEntryDispatch(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	callerId: CoreFunctionId,
	call: CoreInstructionId,
	callee: CoreValueId,
	arguments_: ReadonlyArray<CoreValueId> | undefined,
	targets: ReadonlyArray<CoreFunctionId>,
	fieldEntryNominees: ReadonlyMap<number, number>,
	heapFieldsOnly = false,
): boolean {
	if (
		arguments_?.length !== 1 ||
		program.function(callerId).kernel.valueDefinitionKind(callee) !== 1
	)
		return false;
	const caller = program.function(callerId);
	const load = coreInstructionId(caller.kernel.valueDefinitionOwner(callee));
	if (caller.instructionOpcodeName(load) !== "loadPropertyStatic") return false;
	const name = caller.instructionAttributes(load).stringIndex;
	if (typeof name !== "number") return false;
	const nominees = fieldEntryNominees.get(name) ?? 0;
	if (nominees === 0 || nominees > 4) return false;
	const facts = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, {
		scope: "function",
		function: callerId,
	});
	return targets.some((target) => {
		const targetFn = program.function(target);
		if (!nativeFieldEntryMethodEligible(targetFn, name)) return false;
		const observation = coreArgumentObservation(targetFn);
		if (
			observation.kind === "general" ||
			observation.readsCount ||
			observation.indices.length > 0 ||
			observation.restStarts.length > 0
		)
			return false;
		const cfg = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: target,
			})
			.exceptional();
		const fields = coreReadOnlyParameterFields(targetFn, cfg);
		if (fields === undefined) return false;
		const fieldObject = coreFieldArgument(caller, facts, call, arguments_[0]!, fields);
		return (
			fieldObject !== undefined &&
			(!heapFieldsOnly || fieldObject.valueRepresentations.includes("boxed"))
		);
	});
}

function inlinePriorityScore(
	loopFrequency: number,
	generatedCodeCost: number,
	addedRuntimeCost: number,
	loopPrefixCount = 0,
): number {
	const weights = CORE_GENERATED_CODE_COST_WEIGHTS.runtime;
	// Inlining removes one dispatch; the callee body still executes, even with many targets.
	const savedWork = Math.max(0, weights.helperCall - addedRuntimeCost);
	const prefixWork = Math.max(
		0,
		loopPrefixCount * (weights.helperCall - weights.rootSlot) - weights.guard,
	);
	// Retained prefixes remove probes after admission; their boxed roots still cross each edge.
	const reuseWork = Math.max(0, loopFrequency - 1) * prefixWork;
	return -(loopFrequency * savedWork + reuseWork) / Math.max(1, generatedCodeCost);
}

function coreInstanceMethodHintsForAccessor(
	fn: CoreFunctionStore,
	callee: CoreValueId,
	receiver: CoreValueId | undefined,
	hints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
	summaries: CoreProgramSummaries,
	privateNames: CoreModulePrivateNameIndex,
): boolean {
	const target = coreInstanceMethodHint(fn, callee, receiver, hints);
	const accessor =
		target === undefined ? undefined : summaries.summary(target)?.readAccessor;
	return (
		accessor !== undefined &&
		accessor.reads.every(
			(read) => read.kind !== "private" || privateNames.validSlot(read.slot),
		)
	);
}

function offerFunctionCandidates(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	functionId: CoreFunctionId,
	instanceMethodHints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
	fieldEntryNominees: ReadonlyMap<number, number>,
	capturedCells: () => CapturedCellWrites,
	singleActivations: () => ReadonlySet<CoreFunctionId>,
	privateNames: CoreModulePrivateNameIndex,
	readAccessors: boolean,
	accessorWork?: CoreReadAccessorWork,
	clones: ReadonlySet<CoreFunctionId> = new Set(),
): void {
	const fn = program.function(functionId);
	const outgoing = summaries.targets.outgoing(functionId);
	const globalTargetUses = new Map<CoreFunctionId, number>();
	const blockFrequencies = new Map<CoreBlockId, number>();
	const offeredReadAccessorSites = new Set<CoreInstructionId>();
	for (const site of outgoing) {
		const target =
			site.targets.functions.length === 1 ? site.targets.functions[0] : undefined;
		if (target === undefined || !coreValueIsLoadedGlobalProperty(fn, site.callee)) {
			continue;
		}
		globalTargetUses.set(target, (globalTargetUses.get(target) ?? 0) + 1);
	}
	for (const site of outgoing) {
		if (!fn.isInstructionLive(site.instruction)) continue;
		const invocation = fn.registry.byId(fn.instructionOpcode(site.instruction))
			.callTransfer?.invocation;
		if (invocation === undefined) continue;
		const current = fn.instructionAttributes(site.instruction);
		if (current[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true) continue;
		const block = fn.instructionBlock(site.instruction);
		let loopFrequency = blockFrequencies.get(block);
		if (loopFrequency === undefined) {
			loopFrequency = coreBlockLoopFrequency(
				analyses
					.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
						scope: "function",
						function: functionId,
					})
					.ordinary(),
				block,
			);
			blockFrequencies.set(block, loopFrequency);
		}
		const inLoop = loopFrequency > 1;
		const exposure = loopFrequency;
		const iteration = coreArrayIterationCall(program, fn, site.instruction);
		const callback =
			iteration === undefined
				? undefined
				: coreDirectCreatedFunction(fn, iteration.callback);
		if (iteration !== undefined && callback !== undefined && callback !== functionId) {
			const inline = inlineTarget(
				program,
				fn,
				callback,
				"call",
				directCaptureContext(fn, iteration.callback, site.instruction, callback),
			);
			if (inline !== undefined) {
				const generatedCodeCost = 32 + inline.instructions.length;
				service.offer({
					kind: "array-iteration-inline",
					caller: functionId,
					site: site.instruction,
					revision: summaries.version(callback),
					priorityClass: 2,
					// The eligibility helper replaces builtin dispatch; credit one callback only.
					// The method is itself a loop over the callback, wherever it is called from.
					priorityScore: inlinePriorityScore(
						exposure * ARRAY_ITERATION_CALLBACK_EXPOSURE,
						generatedCodeCost,
						CORE_GENERATED_CODE_COST_WEIGHTS.runtime.admissionCheck,
					),
					targets: [callback],
					generatedCodeCost,
					compilerWorkCost:
						32 + inline.instructions.length + inline.function.valueCapacity,
					expansive: true,
				});
				continue;
			}
		}
		const resultCount = fn.kernel.instructionResultCount(site.instruction);
		const result =
			resultCount === 1
				? fn.kernel.resultAt(fn.kernel.instructionResultStart(site.instruction))
				: undefined;
		const closedFiniteTargets =
			invocation === "call" &&
			inLoop &&
			!coreCalleeTargetsAreOpen(site.targets) &&
			site.targets.functions.length > 1
				? site.targets.functions
				: undefined;
		const hintedTargets =
			invocation === "call" &&
			inLoop &&
			site.targets.functions.length === 0 &&
			coreCalleeTargetsAreOpen(site.targets)
				? coreInstanceMethodTargets(fn, site.callee, site.receiver, instanceMethodHints)
				: undefined;
		const openHintTargets =
			hintedTargets !== undefined &&
			hintedTargets.length > 1 &&
			!prefersFieldEntryDispatch(
				program,
				analyses,
				functionId,
				site.instruction,
				site.callee,
				site.arguments,
				hintedTargets,
				fieldEntryNominees,
			)
				? hintedTargets
				: undefined;
		const finiteTargets = closedFiniteTargets ?? openHintTargets;
		if (finiteTargets !== undefined) {
			const targetSetKind = closedFiniteTargets === undefined ? "open-hints" : "closed";
			const inlines = finiteTargets.map((target) =>
				inlineTarget(program, fn, target, invocation),
			);
			const generatedCodeCost = inlines.reduce(
				(cost, inline) =>
					cost +
					(inline?.instructions.length ?? 0) +
					(inline?.linear === false ? inline.blocks.length : 0) +
					1,
				0,
			);
			const bridgesResult =
				result !== undefined &&
				inlines.every(
					(inline) =>
						inline !== undefined &&
						inline.returnValues.every((value) =>
							canBridgeInlineResult(
								inline.function.valueRepresentation(value),
								fn.valueRepresentation(result),
							),
						),
				);
			service.offer(
				Object.freeze({
					kind: "finite-dispatch",
					caller: functionId,
					site: site.instruction,
					revision: finiteTargets.reduce(
						(revision, target) => revision * 31 + summaries.version(target),
						0,
					),
					priorityClass: targetSetKind === "closed" ? 2 : 3,
					priorityScore: inlinePriorityScore(
						loopFrequency,
						generatedCodeCost,
						(finiteTargets.length - (targetSetKind === "closed" ? 1 : 0)) *
							CORE_GENERATED_CODE_COST_WEIGHTS.runtime.guard,
					),
					targets: Object.freeze([...finiteTargets]),
					targetSetKind,
					generatedCodeCost,
					compilerWorkCost: inlines.reduce(
						(cost, inline) =>
							cost +
							(inline?.instructions.length ?? 0) +
							(inline?.function.valueCapacity ?? 0) +
							4,
						0,
					),
					expansive: true,
					...(finiteTargets.includes(functionId)
						? { unsupportedReason: "recursive" as const }
						: inlines.some((inline) => inline === undefined)
							? { unsupportedReason: "unsupported-graph" as const }
							: !bridgesResult
								? { unsupportedReason: "representation" as const }
								: {}),
				}),
			);
			continue;
		}
		const exactTarget =
			site.targets.functions.length === 1 ? site.targets.functions[0] : undefined;
		const hintedTarget =
			exactTarget === undefined &&
			site.targets.functions.length === 0 &&
			coreCalleeTargetsAreOpen(site.targets) &&
			(inLoop ||
				(readAccessors &&
					coreInstanceMethodHintsForAccessor(
						fn,
						site.callee,
						site.receiver,
						instanceMethodHints,
						summaries,
						privateNames,
					)))
				? coreInstanceMethodHint(fn, site.callee, site.receiver, instanceMethodHints)
				: undefined;
		const target = exactTarget ?? hintedTarget;
		if (target === undefined) continue;
		const accessor = summaries.summary(target)?.readAccessor;
		let readAccessor =
			readAccessors &&
			invocation === "call" &&
			accessor !== undefined &&
			accessor.reads.every(
				(read) => read.kind !== "private" || privateNames.validSlot(read.slot),
			);
		const open = hintedTarget !== undefined || coreCalleeTargetsAreOpen(site.targets);
		// Primitive literals can sink into guarded misses; heap fields must retain their lifetime.
		if (
			open &&
			inLoop &&
			prefersFieldEntryDispatch(
				program,
				analyses,
				functionId,
				site.instruction,
				site.callee,
				site.arguments,
				[target],
				fieldEntryNominees,
				true,
			)
		)
			continue;
		const localCaptureContext =
			exactTarget === undefined
				? undefined
				: directCaptureContext(fn, site.callee, site.instruction, exactTarget);
		const captureContext =
			localCaptureContext ??
			(exactTarget === undefined
				? undefined
				: (ancestorCaptureContext(
						program,
						capturedCells(),
						fn,
						site.callee,
						site.instruction,
						exactTarget,
					) ??
					singleActivationCaptureContext(
						program,
						singleActivations(),
						fn,
						site.callee,
						site.instruction,
						exactTarget,
					)));
		if (localCaptureContext !== undefined) capturedCells();
		const consumerProof =
			exactTarget === undefined || open || invocation !== "call"
				? undefined
				: coreSynchronousCallbackConsumer(
						program,
						summaries,
						fn,
						site.instruction,
						target,
					);
		const callbackContext =
			consumerProof?.created !== true
				? undefined
				: directCaptureContext(
						fn,
						consumerProof.argument,
						site.instruction,
						consumerProof.callback,
					);
		const callbackInline =
			callbackContext === undefined
				? undefined
				: inlineTarget(program, fn, consumerProof!.callback, "call", callbackContext);
		// A held callback stays a call, now with an exact callee inside the inlined consumer.
		const synchronousCallback =
			callbackInline?.linear || consumerProof?.created === false
				? consumerProof
				: undefined;
		const inline = inlineTarget(
			program,
			fn,
			target,
			invocation,
			captureContext,
			synchronousCallback,
		);
		const singleUseGlobal =
			coreValueIsLoadedGlobalProperty(fn, site.callee) &&
			(globalTargetUses.get(target) ?? 0) < 2;
		if (
			singleUseGlobal &&
			synchronousCallback === undefined &&
			(!inLoop ||
				(!inline?.argumentSnapshots &&
					!callCarriesDirectCreatedFunction(fn, site.instruction)))
		) {
			continue;
		}
		const consumerDuplication = open
			? guardedConstructorConsumerDuplication(
					program,
					fn,
					inline,
					site.instruction,
					result,
					instanceMethodHints,
				)
			: 0;
		const bridgesResult =
			inline !== undefined &&
			result !== undefined &&
			inline.returnValues.every((value) =>
				canBridgeInlineResult(
					inline.function.valueRepresentation(value),
					fn.valueRepresentation(result),
				),
			);
		// An exact inline replaces its call, so a body of one instruction and its constant
		// operands adds no code; a guarded one keeps the call and pays for every instruction.
		const generatedCodeCost = Math.max(
			0,
			(inline === undefined
				? 0
				: open
					? inline.instructions.length
					: inlineCodeSize(inline)) +
				(inline?.linear === false ? inline.blocks.length : 0) +
				(synchronousCallback?.created !== true
					? 0
					: synchronousCallback.invocations * callbackInline!.instructions.length) +
				consumerDuplication +
				(open ? 1 : inline === undefined ? 0 : -1),
		);
		const regionCost = readAccessor
			? coreReadAccessorRegionCost(
					program,
					summaries,
					{
						caller: functionId,
						site: site.instruction,
						targets: [target],
						...(inLoop ? { readAccessorLoopEligible: true as const } : {}),
					},
					instanceMethodHints,
					accessorWork,
				)
			: undefined;
		if (readAccessor && regionCost === undefined) {
			if (hintedTarget !== undefined && !inLoop) continue;
			readAccessor = false;
		}
		if (
			regionCost?.sites.some((instruction) => offeredReadAccessorSites.has(instruction))
		)
			continue;
		// A forwarding clone is the other half of its caller's specialization.
		const cloneSpecialization =
			(clones.has(functionId) || clones.has(target)) &&
			!open &&
			!readAccessor &&
			synchronousCallback === undefined;
		const offered = service.offer(
			Object.freeze({
				kind:
					synchronousCallback !== undefined && inline !== undefined
						? "synchronous-callback-inline"
						: readAccessor
							? open
								? "guarded-read-accessor"
								: "read-accessor"
							: open
								? "guarded-inline"
								: "inline",
				caller: functionId,
				site: site.instruction,
				revision: summaries.version(target),
				priorityClass:
					synchronousCallback?.created === true || cloneSpecialization
						? 1
						: hintedTarget !== undefined
							? 3
							: 2,
				// A held callback's invocations stop dispatching, once per consumer loop iteration.
				priorityScore: inlinePriorityScore(
					loopFrequency *
						(regionCost?.sites.length ?? 1) *
						(synchronousCallback?.created === false
							? 1 +
								synchronousCallback.invocations *
									CORE_GENERATED_CODE_COST_WEIGHTS.loopFrequency.base
							: 1),
					regionCost?.generatedCode ?? generatedCodeCost,
					open ? CORE_GENERATED_CODE_COST_WEIGHTS.runtime.guard : 0,
					regionCost?.loopPrefixCount,
				),
				targets: Object.freeze([target]),
				...(regionCost === undefined ? {} : { readAccessorRegion: regionCost.plan }),
				...(inLoop && readAccessor ? { readAccessorLoopEligible: true as const } : {}),
				...(cloneSpecialization ? { cloneSpecialization: true as const } : {}),
				generatedCodeCost: regionCost?.generatedCode ?? generatedCodeCost,
				compilerWorkCost:
					regionCost?.compilerWork ??
					(inline?.instructions.length ?? 0) +
						(inline?.function.valueCapacity ?? 0) +
						(synchronousCallback?.created !== true
							? 0
							: synchronousCallback.invocations *
								(callbackInline!.instructions.length +
									callbackInline!.function.valueCapacity)) +
						consumerDuplication +
						(open ? 4 : 1),
				expansive: localCaptureContext === undefined,
				...(target === functionId
					? { unsupportedReason: "recursive" as const }
					: inline === undefined
						? { unsupportedReason: "unsupported-graph" as const }
						: !bridgesResult
							? { unsupportedReason: "representation" as const }
							: {}),
			}),
		);
		if (offered && regionCost !== undefined) {
			if (accessorWork !== undefined) accessorWork.accessorRegionsOffered++;
			for (const instruction of regionCost.sites)
				offeredReadAccessorSites.add(instruction);
		}
	}
}

function canBridgeInlineResult(
	source: CoreRepresentation,
	destination: CoreRepresentation,
): boolean {
	return (
		source === destination ||
		destination === "boxed" ||
		(source === "i32" && destination === "f64")
	);
}

const CALLBACK_SPECIALIZATION_EXCLUDED_OPCODES: ReadonlySet<string> = new Set([
	"loadCallee",
	"loadArgument",
	"loadArgumentCount",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
]);

// A clone created at the call site binds the caller's scope chain instead of the original's.
const CALLBACK_SPECIALIZATION_SCOPED_OPCODES: ReadonlySet<string> = new Set([
	"loadCaptured",
	"storeCaptured",
	"createFunction",
]);

const CALLBACK_SPECIALIZATION_VARIANTS = 16;
const CALLBACK_SPECIALIZATION_ROUNDS = 3;
const CALLBACK_SPECIALIZATION_MAX_INSTRUCTIONS = 256;

function callbackSpecializationScope(
	fn: CoreFunctionStore,
): "unsupported" | "scoped" | "independent" {
	if (
		fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor ||
		fn.metadata.capturedCount !== 0 ||
		fn.metadata.mappedArguments ||
		fn.liveStorageCounts().instructions > CALLBACK_SPECIALIZATION_MAX_INSTRUCTIONS ||
		!coreFunctionIsCloneable(fn)
	)
		return "unsupported";
	let scope: "scoped" | "independent" = "independent";
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (CALLBACK_SPECIALIZATION_EXCLUDED_OPCODES.has(opcode)) return "unsupported";
		if (CALLBACK_SPECIALIZATION_SCOPED_OPCODES.has(opcode)) scope = "scoped";
	}
	return scope;
}

const OMITTED_PARAMETER_COMPARISONS: ReadonlySet<string> = new Set([
	"===",
	"!==",
	"==",
	"!=",
]);
const OMITTED_PARAMETER_CLONE_INSTRUCTIONS = 48;

/** The parameter decides a branch or comparison that an undefined value would fold. */
function omittedParameterTested(fn: CoreFunctionStore, parameter: number): boolean {
	const value = fn.kernel.functionParameter(parameter);
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const instruction = coreInstructionId(fn.kernel.useInstruction(use));
		const kind = fn.instructionKind(instruction);
		if (kind === "branch") return true;
		if (kind !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const operator = fn.instructionAttributes(instruction).operator;
		if (
			opcode === "typeofCompare" ||
			(opcode === "binary" && OMITTED_PARAMETER_COMPARISONS.has(operator as string)) ||
			(opcode === "unary" && (operator === "!" || operator === "typeof"))
		)
			return true;
	}
	return false;
}

/** The consumer calls the parameter inside a loop, or forwards it to an exact callee that does. */
function callbackUseRepeats(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	fn: CoreFunctionStore,
	parameter: number,
	depth = 0,
): boolean {
	const value = fn.kernel.functionParameter(parameter);
	let cfg: ReturnType<typeof buildCoreControlFlow> | undefined;
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const instruction = coreInstructionId(fn.kernel.useInstruction(use));
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "call"
		)
			continue;
		const operand = fn.kernel.useOperand(use);
		if (operand === 0) {
			cfg ??= buildCoreControlFlow(program, fn.id);
			if (coreBlockLoopFrequency(cfg, fn.instructionBlock(instruction)) > 1) return true;
			continue;
		}
		const site = summaries.targets.site(fn.id, instruction);
		const callee =
			site === undefined ? undefined : coreCalleeTargetsSingleFunction(site.targets);
		const forwarded = site?.arguments?.indexOf(value) ?? -1;
		if (
			depth < 3 &&
			callee !== undefined &&
			callee !== fn.id &&
			forwarded >= 0 &&
			forwarded < program.function(callee).parameterCount &&
			callbackUseRepeats(
				program,
				summaries,
				program.function(callee),
				forwarded,
				depth + 1,
			)
		)
			return true;
	}
	return false;
}

/**
 * Clone a function at exact call sites that pass it closures it only invokes. Each
 * clone is created by its call sites alone, so the program flow gives its
 * parameters exactly those closures' targets, and later waves call or inline them
 * directly instead of dispatching. Sites sharing the same closures share a clone.
 */
function specializeCoreCallbackArguments(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	limits: CoreTransformBudgetLimits,
	liveFunctions: ReadonlySet<CoreFunctionId>,
	variantsPerTarget: Map<CoreFunctionId, number>,
	clones: Set<CoreFunctionId>,
): ReadonlyArray<CoreFunctionId> {
	if (!summaries.targets.sourceClosed) return [];
	const cells = capturedCellWrites(program, true);
	const scopes = new Map<
		CoreFunctionId,
		ReturnType<typeof callbackSpecializationScope>
	>();
	const groups = new Map<
		string,
		{
			readonly target: CoreFunctionId;
			readonly closures: ReadonlyArray<CoreFunctionId>;
			readonly sites: Array<{
				readonly caller: CoreFunctionId;
				readonly instruction: CoreInstructionId;
			}>;
		}
	>();
	for (const caller of liveFunctions) {
		const fn = program.function(caller);
		for (const site of summaries.targets.outgoing(caller)) {
			const target =
				site.targets.functions.length === 1 ? site.targets.functions[0]! : undefined;
			if (
				target === undefined ||
				target === caller ||
				site.open ||
				!fn.isInstructionLive(site.instruction) ||
				fn.instructionOpcodeName(site.instruction) !== "call" ||
				fn.instructionAttributes(site.instruction)[
					CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
				] === true ||
				site.arguments === undefined
			)
				continue;
			const targetFn = program.function(target);
			let scope = scopes.get(target);
			if (scope === undefined) {
				scope = callbackSpecializationScope(targetFn);
				scopes.set(target, scope);
			}
			if (scope === "unsupported") continue;
			const escapes = summaries.summary(target)?.parameterEscape;
			const held: Array<string> = [];
			const closures: Array<CoreFunctionId> = [];
			for (let parameter = 0; parameter < targetFn.parameterCount; parameter++) {
				const argument = site.arguments[parameter];
				// Inside a clone, a helper that only omitting sites call sees the omitted
				// parameter as undefined, so the loop it guards folds and the helper inlines.
				if (
					parameter >= site.arguments.length &&
					clones.has(caller) &&
					!clones.has(target) &&
					targetFn.liveStorageCounts().instructions <=
						OMITTED_PARAMETER_CLONE_INSTRUCTIONS &&
					omittedParameterTested(targetFn, parameter)
				)
					held.push(`${parameter}:omitted`);
				if (
					argument === undefined ||
					escapes?.[parameter] !== "invoked" ||
					!callbackUseRepeats(program, summaries, targetFn, parameter)
				)
					continue;
				const closure = coreCalleeTargetsSingleFunction(
					summaries.targets.targets(caller, argument),
				);
				// A clone's parameters are already exact; cloning it again would only duplicate it.
				if (
					closure === undefined ||
					coreCalleeTargetsSingleFunction(
						summaries.targets.targets(
							target,
							targetFn.kernel.functionParameter(parameter),
						),
					) !== undefined
				)
					continue;
				held.push(`${parameter}:${closure}`);
				closures.push(closure);
			}
			if (held.length === 0) continue;
			if (
				scope === "scoped" &&
				ancestorCaptureContext(
					program,
					cells,
					fn,
					site.callee,
					site.instruction,
					target,
				) === undefined
			)
				continue;
			const signature = `${target}|${held.join(",")}`;
			const group = groups.get(signature) ?? { target, closures, sites: [] };
			group.sites.push({ caller, instruction: site.instruction });
			groups.set(signature, group);
		}
	}
	// A clone grows the program by one copy of its target, whichever sites share it.
	const candidateKey = (candidate: {
		readonly site: CoreInstructionId;
		readonly targets: ReadonlyArray<CoreFunctionId>;
	}) => `${candidate.site}|${candidate.targets.join(",")}`;
	const bySite = new Map<string, string>();
	for (const [signature, group] of groups) {
		const targetFn = program.function(group.target);
		const cost = targetFn.liveStorageCounts().instructions;
		const representative = group.sites[0]!.instruction;
		const offered = service.offer({
			kind: "callback-specialization",
			caller: group.target,
			site: representative,
			revision: summaries.version(group.target),
			// A clone pays off once the callees it forwards its closures to are specialized too.
			priorityClass: group.sites.some((site) => clones.has(site.caller)) ? 1 : 2,
			// Each shared site stops dispatching to every held closure once per consumer loop iteration.
			priorityScore: inlinePriorityScore(
				group.sites.length *
					(1 +
						group.closures.length * CORE_GENERATED_CODE_COST_WEIGHTS.loopFrequency.base),
				cost,
				0,
			),
			targets: [group.target, ...group.closures],
			generatedCodeCost: cost,
			compilerWorkCost: cost + targetFn.valueCapacity,
			// Sites are another function's instructions; the variant cap bounds expansion instead.
			expansive: false,
		});
		if (offered)
			bySite.set(
				candidateKey({
					site: representative,
					targets: [group.target, ...group.closures],
				}),
				signature,
			);
	}
	const changed = new Set<CoreFunctionId>();
	for (
		let candidate = service.next();
		candidate !== undefined;
		candidate = service.next()
	) {
		const signature = bySite.get(candidateKey(candidate));
		const group = signature === undefined ? undefined : groups.get(signature);
		if (group === undefined) throw new Error("Unexpected callback specialization");
		const decline = service.admit(candidate, limits);
		if (decline !== undefined) {
			service.recordDeclined(decline);
			continue;
		}
		if ((variantsPerTarget.get(group.target) ?? 0) >= CALLBACK_SPECIALIZATION_VARIANTS) {
			service.recordDeclined("expansion-limit");
			continue;
		}
		const variant = cloneCoreFunction(program, program.function(group.target));
		clones.add(variant);
		variantsPerTarget.set(group.target, (variantsPerTarget.get(group.target) ?? 0) + 1);
		changed.add(variant);
		const editors = new Map<CoreFunctionId, CoreEditor>();
		for (const { caller, instruction } of group.sites) {
			const fn = program.function(caller);
			const editor = editors.get(caller) ?? CoreEditor.open(program, caller);
			editors.set(caller, editor);
			const operands = materializeInstructionOperands(fn, instruction);
			operands[0] = editor.insertInstruction(
				fn.instructionBlock(instruction),
				instruction,
				"createFunction",
				[],
				{
					attributes: { functionIndex: variant },
					sourcePosition: fn.instructionSourcePosition(instruction),
				},
			).outputs[0]!;
			editor.replaceOperands(instruction, operands);
			changed.add(caller);
		}
		for (const editor of editors.values()) editor.commit();
		service.recordApplied(candidate);
	}
	return [...changed];
}

const CLOSURE_FACTORY_OPCODES: ReadonlySet<string> = new Set([
	"loadCaptured",
	"storeCaptured",
	"createFunction",
]);

interface CaptureReferenceIndex {
	/** Functions with an instruction naming each function index, other than creating it. */
	readonly referrers: ReadonlyMap<number, ReadonlySet<CoreFunctionId>>;
	readonly creators: ReadonlyMap<number, ReadonlySet<CoreFunctionId>>;
}

function captureReferenceIndex(program: CoreProgram): CaptureReferenceIndex {
	const referrers = new Map<number, Set<CoreFunctionId>>();
	const creators = new Map<number, Set<CoreFunctionId>>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const target = fn.instructionAttributes(instruction).functionIndex;
			if (typeof target !== "number") continue;
			const index =
				fn.instructionOpcodeName(instruction) === "createFunction" ? creators : referrers;
			const functions = index.get(target) ?? new Set<CoreFunctionId>();
			functions.add(functionId);
			index.set(target, functions);
		}
	}
	return { referrers, creators };
}

/**
 * A small function that only creates closures over its own scope, which nothing
 * else reads. Cloning it with those closures gives each clone cells of its own.
 */
function closureFactoryMembers(
	program: CoreProgram,
	factory: CoreFunctionStore,
	references: () => CaptureReferenceIndex,
): ReadonlyArray<CoreFunctionId> | undefined {
	if (
		factory.metadata.capturedCount === 0 ||
		factory.metadata.isClassConstructor ||
		factory.metadata.isDerivedConstructor ||
		factory.metadata.mappedArguments ||
		factory.liveStorageCounts().instructions > CALLBACK_SPECIALIZATION_MAX_INSTRUCTIONS ||
		!coreFunctionIsCloneable(factory)
	)
		return undefined;
	const members = new Set<CoreFunctionId>();
	const ownsEveryAccess = (fn: CoreFunctionStore, creates: boolean): boolean => {
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (CALLBACK_SPECIALIZATION_EXCLUDED_OPCODES.has(opcode)) return false;
			if (CAPTURE_ENVIRONMENT_REBINDS.has(opcode) || opcode === "createPrivateNames")
				return false;
			if (!CLOSURE_FACTORY_OPCODES.has(opcode)) continue;
			const target = fn.instructionAttributes(instruction).functionIndex;
			if (opcode !== "createFunction") {
				if (target !== factory.id) return false;
			} else if (!creates || typeof target !== "number") {
				return false;
			} else {
				members.add(target as CoreFunctionId);
			}
		}
		return true;
	};
	if (!ownsEveryAccess(factory, true) || members.size === 0) return undefined;
	for (const member of members) {
		const fn = program.function(member);
		if (
			member === factory.id ||
			fn.metadata.capturedCount !== 0 ||
			fn.liveStorageCounts().instructions > CALLBACK_SPECIALIZATION_MAX_INSTRUCTIONS ||
			!coreFunctionIsCloneable(fn) ||
			!ownsEveryAccess(fn, false)
		)
			return undefined;
	}
	const { referrers, creators } = references();
	for (const referrer of referrers.get(factory.id) ?? [])
		if (referrer !== factory.id && !members.has(referrer)) return undefined;
	for (const member of members)
		for (const creator of creators.get(member) ?? [])
			if (creator !== factory.id) return undefined;
	return [...members].sort((left, right) => left - right);
}

/** Captured slots of `factory` that a member calls, or reads `call` or `apply` from. */
function closureFactoryInvokedSlots(
	program: CoreProgram,
	factory: CoreFunctionId,
	members: ReadonlyArray<CoreFunctionId>,
): ReadonlySet<number> {
	const slots = new Set<number>();
	for (const member of members) {
		const fn = program.function(member);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "loadCaptured"
			)
				continue;
			const attributes = fn.instructionAttributes(instruction);
			if (attributes.functionIndex !== factory || typeof attributes.index !== "number")
				continue;
			const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const consumer = coreInstructionId(fn.kernel.useInstruction(use));
				if (fn.instructionKind(consumer) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(consumer);
				const first =
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(consumer)) === value;
				const name =
					opcode === "loadPropertyStatic"
						? String.fromCharCode(
								...(program.stringConstants[
									fn.instructionAttributes(consumer).stringIndex as number
								] ?? []),
							)
						: undefined;
				if (first && (opcode === "call" || name === "call" || name === "apply"))
					slots.add(attributes.index);
			}
		}
	}
	return slots;
}

/** Parameters `factory` stores into the captured slots in `slots`. */
function closureFactoryParameterSlots(
	factory: CoreFunctionStore,
	slots: ReadonlySet<number>,
): ReadonlySet<number> {
	const parameters = new Set<number>();
	for (const instruction of factory.instructionIds()) {
		if (
			factory.instructionKind(instruction) !== "operation" ||
			factory.instructionOpcodeName(instruction) !== "storeCaptured" ||
			!slots.has(factory.instructionAttributes(instruction).index as number)
		)
			continue;
		const value = factory.kernel.operandAt(
			factory.kernel.instructionOperandStart(instruction),
		);
		for (let parameter = 0; parameter < factory.parameterCount; parameter++)
			if (factory.kernel.functionParameter(parameter) === value)
				parameters.add(parameter);
	}
	return parameters;
}

function retargetCapturedOwner(
	program: CoreProgram,
	functionId: CoreFunctionId,
	owner: CoreFunctionId,
	clone: CoreFunctionId,
	members: ReadonlyMap<CoreFunctionId, CoreFunctionId>,
): void {
	const fn = program.function(functionId);
	const editor = CoreEditor.open(program, functionId);
	for (const instruction of [...fn.instructionIds()]) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (!CLOSURE_FACTORY_OPCODES.has(opcode)) continue;
		const attributes = fn.instructionAttributes(instruction);
		const target = attributes.functionIndex as CoreFunctionId;
		const next =
			opcode === "createFunction"
				? members.get(target)
				: target === owner
					? clone
					: undefined;
		if (next === undefined) continue;
		editor.replaceInstruction(
			instruction,
			opcode,
			materializeInstructionOperands(fn, instruction),
			{
				attributes: { ...attributes, functionIndex: next },
				sourcePosition: fn.instructionSourcePosition(instruction),
				effectRefinement: fn.instructionEffectRefinement(instruction),
			},
		);
	}
	editor.commit();
}

/**
 * Clones a closure factory, with the closures it creates, for callers that pass it
 * exact callbacks its closures invoke. Each clone's captured cells then hold only
 * its callers' callbacks, which its closures can call directly or inline.
 */
function specializeCoreClosureFactories(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	limits: CoreTransformBudgetLimits,
	liveFunctions: ReadonlySet<CoreFunctionId>,
	variantsPerTarget: Map<CoreFunctionId, number>,
	clones: Set<CoreFunctionId>,
): ReadonlyArray<CoreFunctionId> {
	if (!summaries.targets.sourceClosed) return [];
	let index: CaptureReferenceIndex | undefined;
	const references = () => (index ??= captureReferenceIndex(program));
	const factories = new Map<
		CoreFunctionId,
		| {
				readonly members: ReadonlyArray<CoreFunctionId>;
				readonly parameters: ReadonlySet<number>;
		  }
		| undefined
	>();
	const groups = new Map<
		string,
		{
			readonly target: CoreFunctionId;
			readonly members: ReadonlyArray<CoreFunctionId>;
			readonly closures: ReadonlyArray<CoreFunctionId>;
			readonly sites: Array<{
				readonly caller: CoreFunctionId;
				readonly instruction: CoreInstructionId;
				readonly callee: CoreValueId;
				readonly guarded: boolean;
			}>;
		}
	>();
	for (const caller of liveFunctions) {
		const fn = program.function(caller);
		for (const site of summaries.targets.outgoing(caller)) {
			// A callee that may also be a non-function is guarded by its function index.
			const target =
				site.targets.functions.length === 1 &&
				!site.targets.opaque &&
				!site.targets.anyScript
					? site.targets.functions[0]!
					: undefined;
			// A clone's cells already hold only its callers' callbacks.
			if (
				target === undefined ||
				target === caller ||
				clones.has(target) ||
				site.arguments === undefined ||
				!fn.isInstructionLive(site.instruction) ||
				!coreGuardableCall(fn, site.instruction)
			)
				continue;
			if (!factories.has(target)) {
				const members = closureFactoryMembers(
					program,
					program.function(target),
					references,
				);
				factories.set(
					target,
					members === undefined
						? undefined
						: {
								members,
								parameters: closureFactoryParameterSlots(
									program.function(target),
									closureFactoryInvokedSlots(program, target, members),
								),
							},
				);
			}
			const factory = factories.get(target);
			if (factory === undefined) continue;
			const held: Array<string> = [];
			const closures: Array<CoreFunctionId> = [];
			for (const parameter of [...factory.parameters].sort(
				(left, right) => left - right,
			)) {
				const argument = site.arguments[parameter];
				const closure =
					argument === undefined
						? undefined
						: coreCalleeTargetsSingleFunction(
								summaries.targets.targets(caller, argument),
							);
				if (closure === undefined) continue;
				held.push(`${parameter}:${closure}`);
				closures.push(closure);
			}
			if (held.length === 0) continue;
			const signature = `${target}|${held.join(",")}`;
			const group = groups.get(signature) ?? {
				target,
				members: factory.members,
				closures,
				sites: [],
			};
			group.sites.push({
				caller,
				instruction: site.instruction,
				callee: site.callee,
				guarded: site.open,
			});
			groups.set(signature, group);
		}
	}
	const candidateKey = (candidate: {
		readonly site: CoreInstructionId;
		readonly targets: ReadonlyArray<CoreFunctionId>;
	}) => `${candidate.site}|${candidate.targets.join(",")}`;
	const bySite = new Map<string, string>();
	for (const [signature, group] of groups) {
		const cost = [group.target, ...group.members].reduce(
			(total, functionId) =>
				total + program.function(functionId).liveStorageCounts().instructions,
			0,
		);
		const representative = group.sites[0]!.instruction;
		const offered = service.offer({
			kind: "callback-specialization",
			caller: group.target,
			site: representative,
			revision: summaries.version(group.target),
			priorityClass: 2,
			priorityScore: inlinePriorityScore(
				group.sites.length * (1 + group.closures.length),
				cost,
				0,
			),
			targets: [group.target, ...group.closures],
			generatedCodeCost: cost,
			compilerWorkCost: cost + program.function(group.target).valueCapacity,
			expansive: false,
		});
		if (offered)
			bySite.set(
				candidateKey({
					site: representative,
					targets: [group.target, ...group.closures],
				}),
				signature,
			);
	}
	const changed = new Set<CoreFunctionId>();
	for (
		let candidate = service.next();
		candidate !== undefined;
		candidate = service.next()
	) {
		const signature = bySite.get(candidateKey(candidate));
		const group = signature === undefined ? undefined : groups.get(signature);
		if (group === undefined) throw new Error("Unexpected closure factory specialization");
		const decline = service.admit(candidate, limits);
		if (decline !== undefined) {
			service.recordDeclined(decline);
			continue;
		}
		if ((variantsPerTarget.get(group.target) ?? 0) >= CALLBACK_SPECIALIZATION_VARIANTS) {
			service.recordDeclined("expansion-limit");
			continue;
		}
		const sites = group.sites.filter(
			({ caller, instruction, callee }) =>
				program.function(caller).isInstructionLive(instruction) &&
				program
					.function(caller)
					.kernel.operandAt(
						program.function(caller).kernel.instructionOperandStart(instruction),
					) === callee,
		);
		if (sites.length === 0) {
			service.recordDeclined("unsupported-graph");
			continue;
		}
		const variant = cloneCoreFunction(program, program.function(group.target));
		const members = new Map(
			group.members.map(
				(member) =>
					[member, cloneCoreFunction(program, program.function(member))] as const,
			),
		);
		for (const functionId of [variant, ...members.values()]) {
			retargetCapturedOwner(program, functionId, group.target, variant, members);
			clones.add(functionId);
			changed.add(functionId);
		}
		variantsPerTarget.set(group.target, (variantsPerTarget.get(group.target) ?? 0) + 1);
		const editors = new Map<CoreFunctionId, CoreEditor>();
		for (const { caller, instruction, guarded } of sites) {
			const fn = program.function(caller);
			const editor = editors.get(caller) ?? CoreEditor.open(program, caller);
			editors.set(caller, editor);
			changed.add(caller);
			if (guarded) {
				expandCoreFunctionIndexCall(fn, editor, instruction, group.target, variant);
				continue;
			}
			const operands = materializeInstructionOperands(fn, instruction);
			operands[0] = editor.insertInstruction(
				fn.instructionBlock(instruction),
				instruction,
				"createFunction",
				[],
				{
					attributes: { functionIndex: variant },
					sourcePosition: fn.instructionSourcePosition(instruction),
				},
			).outputs[0]!;
			editor.replaceOperands(instruction, operands);
			changed.add(caller);
		}
		for (const editor of editors.values()) editor.commit();
		service.recordApplied(candidate);
	}
	return [...changed];
}

/** Calls `f` directly from `f.call(...)` sites whose `f` holds known script functions. */
function devirtualizeCoreFunctionPrototypeCalls(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	liveFunctions: ReadonlySet<CoreFunctionId>,
): { readonly changed: ReadonlyArray<CoreFunctionId>; readonly instructions: number } {
	const changed: Array<CoreFunctionId> = [];
	let instructions = 0;
	for (const caller of liveFunctions) {
		const fn = program.function(caller);
		if (fn.isAsync || fn.isGenerator) continue;
		let editor: CoreEditor | undefined;
		for (const site of [...fn.instructionIds()]) {
			if (!fn.isInstructionLive(site)) continue;
			const call = coreFunctionPrototypeCall(program, fn, site);
			if (
				call === undefined ||
				summaries.targets.targets(caller, call.target).functions.length === 0
			)
				continue;
			editor ??= CoreEditor.open(program, caller);
			instructions += expandCoreFunctionPrototypeCall(
				fn,
				editor,
				site,
				call,
			).instructionsIntroduced;
		}
		if (editor === undefined) continue;
		editor.commit();
		changed.push(caller);
	}
	return { changed, instructions };
}

export function discoverCoreCrossCallCandidates(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	liveFunctions: ReadonlySet<CoreFunctionId>,
	functions: Iterable<CoreFunctionId> = program.functionIds(),
	readAccessors = true,
	accessorWork?: CoreReadAccessorWork,
	clones: ReadonlySet<CoreFunctionId> = new Set(),
): void {
	const instanceMethodHints = coreInstanceMethodHints(program);
	const fieldEntryNominees = nativeFieldEntryNominees(program, liveFunctions);
	discoveredCapturedCellWrites.delete(program);
	discoveredSingleActivations.delete(program);
	const singleActivations = () => {
		let once = discoveredSingleActivations.get(program);
		if (once === undefined) {
			once = coreSingleActivationFunctions(program, analyses.compilationContext);
			discoveredSingleActivations.set(program, once);
		}
		return once;
	};
	const capturedCells = () => {
		let cells = discoveredCapturedCellWrites.get(program);
		if (cells === undefined) {
			cells = capturedCellWrites(program, summaries.targets.sourceClosed);
			discoveredCapturedCellWrites.set(program, cells);
		}
		return cells;
	};
	const privateNames = coreModulePrivateNames(program, analyses.compilationContext);
	readAccessorInputs.set(program, {
		names: privateNames,
		hints: instanceMethodHints,
		work: accessorWork,
	});
	for (const functionId of functions) {
		offerFunctionCandidates(
			program,
			analyses,
			summaries,
			service,
			functionId,
			instanceMethodHints,
			fieldEntryNominees,
			capturedCells,
			singleActivations,
			privateNames,
			readAccessors,
			accessorWork,
			clones,
		);
	}
}

function applyLinearInline(
	program: CoreProgram,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
	selectedInline?: InlineTarget,
): AppliedTransform | undefined {
	const target = candidate.targets[0];
	if (target === undefined) return undefined;
	const caller = program.function(candidate.caller);
	if (
		!caller.isInstructionLive(candidate.site) ||
		caller.instructionKind(candidate.site) !== "operation"
	)
		return undefined;
	const descriptor = caller.registry.byId(caller.instructionOpcode(candidate.site));
	if (
		descriptor.callTransfer === undefined ||
		!["call-completion", "construct-completion"].includes(descriptor.callTransfer.result)
	)
		return undefined;
	const operands = materializeInstructionOperands(caller, candidate.site);
	const callee = operands[descriptor.callTransfer.calleeOperand];
	if (callee === undefined) return undefined;
	const inline =
		selectedInline ??
		inlineTarget(
			program,
			caller,
			target,
			descriptor.callTransfer.invocation,
			applicationCaptureContext(program, caller, callee, candidate.site, target),
		);
	if (inline === undefined) return undefined;
	if (inline.construction) return applyGuardedInline(program, candidate, editor, false);
	if (!inline.linear) return applyGuardedInline(program, candidate, editor, false);
	const callResults = materializeInstructionResults(caller, candidate.site);
	if (callResults.length !== 1) return undefined;
	const callResult = callResults[0]!;
	const callRepresentation = caller.valueRepresentation(callResult);
	if (
		!canBridgeInlineResult(
			inline.function.valueRepresentation(inline.returnValue),
			callRepresentation,
		)
	)
		return undefined;
	const receiverIndex = descriptor.callTransfer.receiverOperand;
	const receiver = receiverIndex === undefined ? undefined : operands[receiverIndex];
	const firstArgument =
		descriptor.callTransfer.arguments.kind === "positional"
			? descriptor.callTransfer.arguments.firstOperand
			: undefined;
	if (firstArgument === undefined) return undefined;
	const arguments_ = operands.slice(firstArgument);
	if (
		receiver === undefined &&
		inline.instructions.some(
			(instruction) => inline.function.instructionOpcodeName(instruction) === "loadThis",
		)
	)
		return undefined;
	const block = caller.instructionBlock(candidate.site);
	const callerPosition = caller.instructionSourcePosition(candidate.site);
	const sourcePositions = inlineSourcePositions(
		program,
		editor,
		target,
		callerPosition,
		inline.instructions,
		inline.function,
	);
	const values = new Map<CoreValueId, CoreValueId>();
	let introduced = 0;
	const bridgeValue = (
		value: CoreValueId,
		representation: CoreRepresentation,
		position: number | undefined,
	): CoreValueId => {
		const sourceRepresentation = caller.valueRepresentation(value);
		if (sourceRepresentation === representation) return value;
		if (!canBridgeInlineResult(sourceRepresentation, representation)) {
			throw new Error("Validated inline input became representation-incompatible");
		}
		introduced++;
		return editor.insertInstruction(block, candidate.site, "move", [value], {
			outputRepresentations: [representation],
			sourcePosition: position,
		}).outputs[0]!;
	};
	for (let index = 0; index < inline.function.parameterCount; index++) {
		const parameter = inline.function.kernel.functionParameter(index);
		const argument = arguments_[index];
		if (argument !== undefined) {
			values.set(
				parameter,
				bridgeValue(
					argument,
					inline.function.valueRepresentation(parameter),
					callerPosition,
				),
			);
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
	for (const inlineBlock of inline.blocks) {
		for (const [parameter, incoming] of inlineBlock.parameters) {
			const value = values.get(incoming);
			if (value === undefined)
				throw new Error("Validated inline edge has no caller value");
			values.set(parameter, value);
		}
		for (const instruction of inlineBlock.instructions) {
			const opcode = inline.function.instructionOpcodeName(instruction);
			const captured = inline.captureValues.get(instruction);
			if (captured !== undefined) {
				const output = materializeInstructionResults(inline.function, instruction)[0]!;
				values.set(
					output,
					bridgeValue(
						captured,
						inline.function.valueRepresentation(output),
						sourcePositions.get(instruction),
					),
				);
				continue;
			}
			if (opcode === "loadArgument") {
				const output = materializeInstructionResults(inline.function, instruction)[0];
				const index = inline.function.instructionAttributes(instruction).index;
				if (
					output === undefined ||
					typeof index !== "number" ||
					!Number.isSafeInteger(index) ||
					index < 0
				)
					return undefined;
				const argument = arguments_[index];
				if (argument !== undefined) {
					values.set(
						output,
						bridgeValue(
							argument,
							inline.function.valueRepresentation(output),
							sourcePositions.get(instruction),
						),
					);
					continue;
				}
				const created = editor.insertInstruction(
					block,
					candidate.site,
					"createUndefined",
					[],
					{ sourcePosition: sourcePositions.get(instruction) },
				);
				values.set(output, created.outputs[0]!);
				introduced++;
				continue;
			}
			if (opcode === "loadThis") {
				const output =
					inline.function.kernel.instructionResultCount(instruction) === 0
						? undefined
						: inline.function.kernel.resultAt(
								inline.function.kernel.instructionResultStart(instruction),
							);
				if (output === undefined || receiver === undefined) return undefined;
				values.set(
					output,
					bridgeValue(
						receiver,
						inline.function.valueRepresentation(output),
						sourcePositions.get(instruction),
					),
				);
				continue;
			}
			const inputStart = inline.function.kernel.instructionOperandStart(instruction);
			const inputCount = inline.function.kernel.instructionOperandCount(instruction);
			const inputs: Array<CoreValueId | undefined> = [];
			for (let index = 0; index < inputCount; index++)
				inputs.push(values.get(inline.function.kernel.operandAt(inputStart + index)));
			if (inputs.some((value) => value === undefined)) {
				throw new Error("Validated inline input has no caller value");
			}
			const outputs = materializeInstructionResults(inline.function, instruction);
			const inserted = editor.insertInstruction(
				block,
				candidate.site,
				opcode,
				inputs as ReadonlyArray<CoreValueId>,
				{
					outputCount: outputs.length,
					outputRepresentations: outputs.map((value) =>
						inline.function.valueRepresentation(value),
					),
					attributes: inline.function.instructionAttributes(instruction),
					sourcePosition: sourcePositions.get(instruction),
				},
			);
			introduced++;
			for (const [index, output] of outputs.entries()) {
				values.set(output, inserted.outputs[index]!);
			}
		}
	}
	let replacement = values.get(inline.returnValue);
	if (replacement === undefined) {
		throw new Error("Validated inline return has no caller value");
	}
	const replacementRepresentation = caller.valueRepresentation(replacement);
	if (!canBridgeInlineResult(replacementRepresentation, callRepresentation)) {
		throw new Error("Validated inline result became representation-incompatible");
	}
	if (replacementRepresentation !== callRepresentation) {
		const bridge = editor.insertInstruction(
			block,
			candidate.site,
			"move",
			[replacement],
			{
				outputRepresentations: [callRepresentation],
				sourcePosition: callerPosition,
			},
		);
		replacement = bridge.outputs[0]!;
		introduced++;
	}
	editor.replaceValueUses(callResult, replacement);
	editor.removeInstruction(candidate.site);
	return {
		instructionsIntroduced: introduced,
		blocksIntroduced: 0,
	};
}

function applyGuardedInline(
	program: CoreProgram,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
	guarded = true,
	synchronousCallback?: CoreSynchronousCallbackConsumer,
): AppliedTransform | undefined {
	const target = candidate.targets[0];
	if (target === undefined) return undefined;
	const caller = program.function(candidate.caller);
	if (
		!caller.isInstructionLive(candidate.site) ||
		caller.instructionKind(candidate.site) !== "operation"
	)
		return undefined;
	const descriptor = caller.registry.byId(caller.instructionOpcode(candidate.site));
	if (
		descriptor.callTransfer === undefined ||
		!["call-completion", "construct-completion"].includes(descriptor.callTransfer.result)
	)
		return undefined;
	const operands = materializeInstructionOperands(caller, candidate.site);
	const callee = operands[descriptor.callTransfer.calleeOperand];
	if (callee === undefined) return undefined;
	const inline = inlineTarget(
		program,
		caller,
		target,
		descriptor.callTransfer.invocation,
		applicationCaptureContext(program, caller, callee, candidate.site, target),
		synchronousCallback,
	);
	if (inline === undefined) return undefined;
	if (
		inline.construction &&
		inline.function.metadata.strict !== caller.metadata.strict &&
		inline.instructions.some((instruction) =>
			[
				"deleteProperty",
				"storeProperty",
				"storePropertyStatic",
				"storeSuperProperty",
			].includes(inline.function.instructionOpcodeName(instruction)),
		)
	)
		return undefined;
	const callResults = materializeInstructionResults(caller, candidate.site);
	if (callResults.length !== 1) return undefined;
	const callResult = callResults[0]!;
	const callRepresentation = caller.valueRepresentation(callResult);
	if (
		!inline.returnValues.every((value) =>
			canBridgeInlineResult(
				inline.function.valueRepresentation(value),
				callRepresentation,
			),
		)
	)
		return undefined;
	const receiverIndex = descriptor.callTransfer.receiverOperand;
	let receiver = receiverIndex === undefined ? undefined : operands[receiverIndex];
	const firstArgument =
		descriptor.callTransfer.arguments.kind === "positional"
			? descriptor.callTransfer.arguments.firstOperand
			: undefined;
	if (firstArgument === undefined) return undefined;
	const arguments_ = operands.slice(firstArgument);
	const block = caller.instructionBlock(candidate.site);
	const originalTerminator = caller.blockTerminator(block);
	if (caller.instructionKind(originalTerminator) === "guard") return undefined;
	const terminatorPosition = caller.instructionSourcePosition(originalTerminator);
	const callerPosition = caller.instructionSourcePosition(candidate.site);
	const sourcePositions = inlineSourcePositions(
		program,
		editor,
		target,
		callerPosition,
		inline.instructions,
		inline.function,
	);
	const tail: Array<CoreInstructionId> = [];
	for (
		let instruction = caller.instructionNext(candidate.site);
		instruction !== undefined && instruction !== originalTerminator;
		instruction = caller.instructionNext(instruction)
	)
		tail.push(instruction);
	const candidateScalarLayout = guarded
		? scalarConstructorLayout(program, inline)
		: undefined;
	const scalarLayout =
		candidateScalarLayout !== undefined &&
		candidateScalarLayout.primitiveParameterIndices.every((index) => {
			const argument = arguments_[index];
			return argument === undefined || locallyPrimitiveValue(caller, argument);
		})
			? candidateScalarLayout
			: undefined;
	const receiverStoresElided =
		scalarLayout !== undefined &&
		constructorReturnMode(inline.function, inline.returnValue) === "returned";
	const consumerPlan =
		scalarLayout === undefined
			? undefined
			: constructorConsumerPlan(
					program,
					caller,
					tail,
					callResult,
					originalTerminator,
					scalarLayout,
					coreInstanceMethodHints(program),
				);
	const scalarizedReceiver = scalarLayout !== undefined && consumerPlan !== undefined;
	const handlerBlock = caller.kernel.blockHandlerBlock(block);
	const handlerArguments: Array<CoreValueId> = [];
	const handlerArgumentStart = caller.kernel.blockHandlerArgumentStart(block);
	const handlerArgumentCount = caller.kernel.blockHandlerArgumentCount(block);
	for (let index = 0; index < handlerArgumentCount; index++)
		handlerArguments.push(caller.kernel.handlerArgumentAt(handlerArgumentStart + index));
	const callAttributes = caller.instructionAttributes(candidate.site);
	const callRefinement = caller.instructionEffectRefinement(candidate.site);
	const fast = editor.createBlock();
	const fallback = guarded ? editor.createBlock() : undefined;
	const joinValues = consumerPlan?.liveOut ?? [callResult];
	const join = editor.createBlock(
		joinValues.map((value) => ({
			representation: caller.valueRepresentation(value),
		})),
	);
	const joinParameterStart = caller.kernel.blockParameterStart(join);
	for (const instruction of consumerPlan?.suffix ?? tail)
		editor.moveInstruction(instruction, join);
	for (const [index, value] of joinValues.entries())
		editor.replaceValueUses(
			value,
			caller.kernel.blockParameterValue(joinParameterStart + index),
		);
	const joinedTerminator = {
		...coreTerminatorInput(caller, originalTerminator),
		...(terminatorPosition === undefined ? {} : { sourcePosition: terminatorPosition }),
	};
	editor.setTerminator(join, joinedTerminator);

	let sunkFunctionCount = 0;
	if (fallback !== undefined) {
		const fallbackOperands = [...operands];
		const sinkableArguments: Array<number> = [];
		for (let index = firstArgument; index < fallbackOperands.length; index++) {
			const argument = fallbackOperands[index]!;
			const functionIndex = coreDirectCreatedFunction(caller, argument);
			if (
				functionIndex !== undefined &&
				directCaptureContext(caller, argument, candidate.site, functionIndex) !==
					undefined
			)
				sinkableArguments.push(index);
		}
		editor.moveInstruction(candidate.site, fallback);
		for (const index of sinkableArguments) {
			const argument = fallbackOperands[index]!;
			const creation = coreInstructionId(caller.kernel.valueDefinitionOwner(argument));
			const sunk = editor.insertInstruction(
				fallback,
				candidate.site,
				"createFunction",
				[],
				{
					attributes: caller.instructionAttributes(creation),
					sourcePosition: caller.instructionSourcePosition(creation),
				},
			);
			fallbackOperands[index] = sunk.outputs[0]!;
			sunkFunctionCount++;
		}
		editor.replaceInstruction(
			candidate.site,
			caller.instructionOpcodeName(candidate.site),
			fallbackOperands,
			{
				attributes: {
					...callAttributes,
					[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true,
				},
				sourcePosition: callerPosition,
				...(callRefinement === undefined ? {} : { effectRefinement: callRefinement }),
			},
		);
		if (consumerPlan !== undefined)
			for (const instruction of consumerPlan.prefix)
				editor.moveInstruction(instruction, fallback);
		editor.setTerminator(fallback, {
			kind: "jump",
			edge: { block: join, arguments: [...joinValues] },
			sourcePosition: callerPosition,
		});
	} else editor.removeInstruction(candidate.site);

	const values = new Map<CoreValueId, CoreValueId>();
	let introduced = (guarded ? 1 : 0) + sunkFunctionCount;
	let guardedMethodValue: CoreValueId | undefined;
	if (consumerPlan?.method !== undefined) {
		guardedMethodValue = editor.appendInstruction(fast, "createFunction", [], {
			attributes: { functionIndex: consumerPlan.method.target },
			sourcePosition: caller.instructionSourcePosition(consumerPlan.method.lookup),
		}).outputs[0]!;
		introduced++;
	}
	const bridgeValue = (
		destination: CoreBlockId,
		value: CoreValueId,
		representation: CoreRepresentation,
		position: number | undefined,
	): CoreValueId => {
		const sourceRepresentation = caller.valueRepresentation(value);
		if (sourceRepresentation === representation) return value;
		if (!canBridgeInlineResult(sourceRepresentation, representation)) {
			throw new Error(
				"Validated guarded inline input became representation-incompatible",
			);
		}
		introduced++;
		return editor.appendInstruction(destination, "move", [value], {
			outputRepresentations: [representation],
			sourcePosition: position,
		}).outputs[0]!;
	};
	const clonedBlocks = new Map<CoreBlockId, CoreBlockId>([[inline.function.entry, fast]]);
	if (!inline.linear) {
		for (const inlineBlock of inline.blocks) {
			if (inlineBlock.id === inline.function.entry) continue;
			const start = inline.function.kernel.blockParameterStart(inlineBlock.id);
			const parameters = Array.from(
				{ length: inline.function.kernel.blockParameterCount(inlineBlock.id) },
				(_, index) => inline.function.kernel.blockParameterValue(start + index),
			);
			const created = editor.createBlock(
				parameters.map((value, index) => ({
					representation: inline.function.valueRepresentation(value),
					role: inline.function.blockParameterRole(
						inline.function.kernel.blockParameterStart(inlineBlock.id) + index,
					),
				})),
			);
			clonedBlocks.set(inlineBlock.id, created);
			for (const [index, value] of parameters.entries())
				values.set(
					value,
					caller.kernel.blockParameterValue(
						caller.kernel.blockParameterStart(created) + index,
					),
				);
		}
	}
	for (let index = 0; index < inline.function.parameterCount; index++) {
		const parameter = inline.function.kernel.functionParameter(index);
		const argument = arguments_[index];
		if (argument !== undefined) {
			values.set(
				parameter,
				bridgeValue(
					fast,
					argument,
					inline.function.valueRepresentation(parameter),
					callerPosition,
				),
			);
			continue;
		}
		const created = editor.appendInstruction(fast, "createUndefined", [], {
			sourcePosition: callerPosition,
		});
		values.set(parameter, created.outputs[0]!);
		introduced++;
	}
	if (inline.construction && !receiverStoresElided && !scalarizedReceiver) {
		receiver = appendConstructReceiver(
			editor,
			fast,
			callee,
			coreConstructorSlotReserve(inline.function),
			callerPosition,
		);
		introduced++;
	}
	const emitReturn = (destination: CoreBlockId, value: CoreValueId): void => {
		const returnMode = inline.construction
			? constructorReturnMode(inline.function, value)
			: undefined;
		let result = returnMode === "receiver" ? receiver : values.get(value);
		if (result === undefined)
			throw new Error("Validated inline return has no caller value");
		if (returnMode === "dynamic") {
			if (receiver === undefined)
				throw new Error("Validated dynamic constructor return has no receiver");
			result = editor.appendInstruction(
				destination,
				"baseConstructResult",
				[receiver, result],
				{
					outputRepresentations: ["boxed"],
					sourcePosition: callerPosition,
				},
			).outputs[0]!;
			introduced++;
		}
		const resultRepresentation = caller.valueRepresentation(result);
		if (!canBridgeInlineResult(resultRepresentation, callRepresentation)) {
			throw new Error(
				"Validated guarded inline result became representation-incompatible",
			);
		}
		if (resultRepresentation !== callRepresentation) {
			result = editor.appendInstruction(destination, "move", [result], {
				outputRepresentations: [callRepresentation],
				sourcePosition: callerPosition,
			}).outputs[0]!;
			introduced++;
		}
		const clonedConsumer =
			consumerPlan === undefined
				? undefined
				: cloneConstructorConsumerPrefix(
						editor,
						caller,
						destination,
						consumerPlan,
						callResult,
						result,
						guardedMethodValue,
					);
		const arguments_ = clonedConsumer?.liveOut ?? [result];
		introduced += clonedConsumer?.instructionsIntroduced ?? 0;
		editor.setTerminator(destination, {
			kind: "jump",
			edge: { block: join, arguments: arguments_ },
			sourcePosition: callerPosition,
		});
		if (clonedConsumer?.methodCall !== undefined && consumerPlan?.method !== undefined) {
			const applied = applyLinearInline(
				program,
				{
					kind: "inline",
					caller: candidate.caller,
					site: clonedConsumer.methodCall,
					revision: 0,
					priorityClass: 0,
					priorityScore: 0,
					targets: [consumerPlan.method.target],
					generatedCodeCost: consumerPlan.method.inline.instructions.length,
					compilerWorkCost: consumerPlan.method.inline.instructions.length,
					expansive: false,
				},
				editor,
				inline,
			);
			if (applied === undefined)
				throw new Error("Validated constructor method inline became inapplicable");
			introduced += applied.instructionsIntroduced;
		}
	};
	for (const inlineBlock of inline.blocks) {
		const destination = inline.linear ? fast : clonedBlocks.get(inlineBlock.id)!;
		for (const [parameter, incoming] of inlineBlock.parameters) {
			const value = values.get(incoming);
			if (value === undefined)
				throw new Error("Validated guarded inline edge has no caller value");
			values.set(parameter, value);
		}
		for (const instruction of inlineBlock.instructions) {
			const opcode = inline.function.instructionOpcodeName(instruction);
			const captured = inline.captureValues.get(instruction);
			if (captured !== undefined) {
				const output = materializeInstructionResults(inline.function, instruction)[0]!;
				values.set(
					output,
					bridgeValue(
						destination,
						captured,
						inline.function.valueRepresentation(output),
						sourcePositions.get(instruction),
					),
				);
				continue;
			}
			if (
				scalarLayout !== undefined &&
				(scalarizedReceiver || receiverStoresElided) &&
				scalarLayout.stores.has(instruction)
			)
				continue;
			if (opcode === "loadThis" && (scalarizedReceiver || receiverStoresElided)) continue;
			if (opcode === "loadArgument") {
				const output = materializeInstructionResults(inline.function, instruction)[0];
				const index = inline.function.instructionAttributes(instruction).index;
				if (
					output === undefined ||
					typeof index !== "number" ||
					!Number.isSafeInteger(index) ||
					index < 0
				)
					throw new Error("Validated guarded inline argument snapshot is invalid");
				const argument = arguments_[index];
				if (argument !== undefined) {
					values.set(
						output,
						bridgeValue(
							destination,
							argument,
							inline.function.valueRepresentation(output),
							sourcePositions.get(instruction),
						),
					);
					continue;
				}
				const created = editor.appendInstruction(destination, "createUndefined", [], {
					sourcePosition: sourcePositions.get(instruction),
				});
				values.set(output, created.outputs[0]!);
				introduced++;
				continue;
			}
			if (opcode === "loadNewTarget") {
				const output = materializeInstructionResults(inline.function, instruction)[0];
				if (output === undefined)
					throw new Error("Validated guarded inline new.target is unavailable");
				values.set(
					output,
					bridgeValue(
						destination,
						callee,
						inline.function.valueRepresentation(output),
						sourcePositions.get(instruction),
					),
				);
				continue;
			}
			if (opcode === "loadThis") {
				const output =
					inline.function.kernel.instructionResultCount(instruction) === 0
						? undefined
						: inline.function.kernel.resultAt(
								inline.function.kernel.instructionResultStart(instruction),
							);
				if (output === undefined || receiver === undefined)
					throw new Error("Validated guarded inline receiver is unavailable");
				values.set(
					output,
					bridgeValue(
						destination,
						receiver,
						inline.function.valueRepresentation(output),
						sourcePositions.get(instruction),
					),
				);
				continue;
			}
			const inputStart = inline.function.kernel.instructionOperandStart(instruction);
			const inputCount = inline.function.kernel.instructionOperandCount(instruction);
			const inputs: Array<CoreValueId | undefined> = [];
			for (let index = 0; index < inputCount; index++)
				inputs.push(values.get(inline.function.kernel.operandAt(inputStart + index)));
			if (inputs.some((value) => value === undefined))
				throw new Error("Validated guarded inline input has no caller value");
			const outputs = materializeInstructionResults(inline.function, instruction);
			const inserted = editor.appendInstruction(
				destination,
				opcode,
				inputs as ReadonlyArray<CoreValueId>,
				{
					outputCount: outputs.length,
					outputRepresentations: outputs.map((value) =>
						inline.function.valueRepresentation(value),
					),
					attributes: inline.function.instructionAttributes(instruction),
					sourcePosition: sourcePositions.get(instruction),
				},
			);
			introduced++;
			for (const [index, output] of outputs.entries())
				values.set(output, inserted.outputs[index]!);
		}
		if (!inline.linear) {
			const terminator = coreTerminatorInput(
				inline.function,
				inline.function.blockTerminator(inlineBlock.id),
			);
			const edge = (source: CoreEdge): CoreEdge => ({
				block: clonedBlocks.get(source.block)!,
				arguments: source.arguments.map((value) => values.get(value)!),
			});
			if (terminator.kind === "return") emitReturn(destination, terminator.value);
			else if (terminator.kind === "jump")
				editor.setTerminator(destination, {
					kind: "jump",
					edge: edge(terminator.edge),
				});
			else if (terminator.kind === "branch")
				editor.setTerminator(destination, {
					kind: "branch",
					condition: values.get(terminator.condition)!,
					consequent: edge(terminator.consequent),
					alternate: edge(terminator.alternate),
				});
			else if (terminator.kind === "switch")
				editor.setTerminator(destination, {
					kind: "switch",
					discriminant: values.get(terminator.discriminant)!,
					cases: terminator.cases.map((entry) => ({
						value: entry.value,
						edge: edge(entry.edge),
					})),
					default: edge(terminator.default),
				});
			else if (terminator.kind === "throw")
				editor.setTerminator(destination, {
					kind: "throw",
					value: values.get(terminator.value)!,
					sourcePosition: callerPosition,
				});
			else throw new Error("Validated inline graph has an unsupported terminator");
		}
	}
	if (inline.linear) {
		if (scalarizedReceiver) {
			const initialValues = scalarLayout.initialValues.map((value) => values.get(value)!);
			receiver = editor.appendInstruction(fast, "createObjectShaped", initialValues, {
				attributes: { keyStringIndices: scalarLayout.keyStringIndices },
				sourcePosition: callerPosition,
			}).outputs[0]!;
			introduced++;
		}
		emitReturn(fast, inline.returnValue);
	}

	if (fallback !== undefined) {
		const keyStringIndices = scalarLayout?.keyStringIndices;
		const guard = editor.appendInstruction(
			block,
			scalarLayout !== undefined && (scalarizedReceiver || receiverStoresElided)
				? "guardBaseConstructorLayout"
				: "guardFunctionIndex",
			[callee],
			{
				outputRepresentations: ["boolean"],
				attributes: {
					functionIndex: target,
					...(consumerPlan?.method === undefined
						? {}
						: {
								methodStringIndex: consumerPlan.method.keyStringIndex,
								methodFunctionIndex: consumerPlan.method.target,
							}),
					...(scalarLayout === undefined || (!scalarizedReceiver && !receiverStoresElided)
						? {}
						: { keyStringIndices }),
				},
				sourcePosition: callerPosition,
			},
		);
		editor.replaceTerminator(block, {
			kind: "branch",
			condition: guard.outputs[0]!,
			consequent: { block: fast, arguments: [] },
			alternate: { block: fallback, arguments: [] },
			sourcePosition: callerPosition,
		});
	} else
		editor.replaceTerminator(block, {
			kind: "jump",
			edge: { block: fast, arguments: [] },
			sourcePosition: callerPosition,
		});

	if (handlerBlock !== undefined) {
		for (const guardedBlock of [
			...clonedBlocks.values(),
			join,
			...(fallback === undefined ? [] : [fallback]),
		])
			editor.setHandler(guardedBlock, handlerBlock, handlerArguments);
	}
	for (const inlineBlock of inline.blocks) {
		const handler = inline.function.kernel.blockHandlerBlock(inlineBlock.id);
		if (handler === undefined) continue;
		const start = inline.function.kernel.blockHandlerArgumentStart(inlineBlock.id);
		const args = Array.from(
			{ length: inline.function.kernel.blockHandlerArgumentCount(inlineBlock.id) },
			(_, index) => {
				const value = values.get(inline.function.kernel.handlerArgumentAt(start + index));
				if (value === undefined)
					throw new Error("Validated inline handler has no caller value");
				return value;
			},
		);
		editor.setHandler(
			clonedBlocks.get(inlineBlock.id)!,
			clonedBlocks.get(handler)!,
			args,
		);
	}
	return {
		instructionsIntroduced: introduced,
		blocksIntroduced: clonedBlocks.size + 1 + (guarded ? 1 : 0),
	};
}

function applyFiniteDispatch(
	program: CoreProgram,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
): AppliedTransform | undefined {
	if (candidate.targets.length < 2) return undefined;
	const caller = program.function(candidate.caller);
	if (
		!caller.isInstructionLive(candidate.site) ||
		caller.instructionKind(candidate.site) !== "operation" ||
		caller.instructionKind(
			caller.blockTerminator(caller.instructionBlock(candidate.site)),
		) === "guard"
	)
		return undefined;
	const descriptor = caller.registry.byId(caller.instructionOpcode(candidate.site));
	if (
		descriptor.callTransfer?.invocation !== "call" ||
		descriptor.callTransfer.result !== "call-completion" ||
		descriptor.callTransfer.arguments.kind !== "positional" ||
		caller.kernel.instructionResultCount(candidate.site) !== 1
	)
		return undefined;
	const result = caller.kernel.resultAt(
		caller.kernel.instructionResultStart(candidate.site),
	);
	const representation = caller.valueRepresentation(result);
	if (
		candidate.targets.some((target) => {
			const inline = inlineTarget(program, caller, target, "call");
			return (
				inline === undefined ||
				inline.returnValues.some(
					(value) =>
						!canBridgeInlineResult(
							inline.function.valueRepresentation(value),
							representation,
						),
				)
			);
		})
	)
		return undefined;
	let instructionsIntroduced = 0;
	let blocksIntroduced = 0;
	for (const [index, target] of candidate.targets.entries()) {
		const applied = applyGuardedInline(
			program,
			{ ...candidate, targets: [target] },
			editor,
			candidate.targetSetKind === "open-hints" || index + 1 < candidate.targets.length,
		);
		if (applied === undefined) {
			throw new Error("Validated finite dispatch became inapplicable during expansion");
		}
		instructionsIntroduced += applied.instructionsIntroduced;
		blocksIntroduced += applied.blocksIntroduced;
	}
	return { instructionsIntroduced, blocksIntroduced };
}

function applyCandidate(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
): AppliedTransform | undefined {
	switch (candidate.kind) {
		case "array-iteration-inline": {
			const fn = program.function(candidate.caller);
			if (!fn.isInstructionLive(candidate.site)) return undefined;
			const iteration = coreArrayIterationCall(program, fn, candidate.site);
			const target = candidate.targets[0];
			if (
				iteration === undefined ||
				target === undefined ||
				coreDirectCreatedFunction(fn, iteration.callback) !== target
			)
				return undefined;
			const inline = inlineTarget(
				program,
				fn,
				target,
				"call",
				directCaptureContext(fn, iteration.callback, candidate.site, target),
			);
			if (inline === undefined) return undefined;
			const expanded = expandCoreArrayIterationCall(
				fn,
				editor,
				candidate.site,
				iteration,
			);
			const applied = applyLinearInline(
				program,
				{ ...candidate, kind: "inline", site: expanded.callback },
				editor,
			);
			if (applied === undefined)
				throw new Error("Admitted array iteration callback lost its inline proof");
			return {
				instructionsIntroduced:
					expanded.instructionsIntroduced + applied.instructionsIntroduced,
				blocksIntroduced: expanded.blocksIntroduced + applied.blocksIntroduced,
			};
		}
		case "finite-dispatch":
			return applyFiniteDispatch(program, candidate, editor);
		case "inline":
			return applyLinearInline(program, candidate, editor);
		case "synchronous-callback-inline": {
			const target = candidate.targets[0];
			if (target === undefined) return undefined;
			const proof = coreSynchronousCallbackConsumer(
				program,
				summaries,
				editor.function,
				candidate.site,
				target,
			);
			if (proof === undefined) return undefined;
			if (!proof.created)
				return applyGuardedInline(program, candidate, editor, false, proof);
			const context = directCaptureContext(
				editor.function,
				proof.argument,
				candidate.site,
				proof.callback,
			);
			if (context === undefined) return undefined;
			const callback = inlineTarget(
				program,
				editor.function,
				proof.callback,
				"call",
				context,
			);
			if (!callback?.linear) return undefined;
			const firstNewInstruction = editor.function.instructionCapacity;
			const applied = applyGuardedInline(program, candidate, editor, false, proof);
			if (applied === undefined) return undefined;
			const calls = new Set<CoreInstructionId>();
			for (
				let use = editor.function.kernel.valueFirstUse(proof.argument);
				use >= 0;
				use = editor.function.kernel.useNext(use)
			) {
				if (
					editor.function.kernel.useLive(use) === 0 ||
					editor.function.kernel.useOperand(use) !== 0
				)
					continue;
				const instruction = coreInstructionId(editor.function.kernel.useInstruction(use));
				if (instruction < firstNewInstruction) continue;
				if (
					editor.function.instructionKind(instruction) === "operation" &&
					editor.function.instructionOpcodeName(instruction) === "call"
				)
					calls.add(instruction);
			}
			if (calls.size !== proof.invocations)
				throw new Error("Validated callback consumer lost an invocation");
			let introduced = applied.instructionsIntroduced;
			for (const site of calls) {
				const inlined = applyLinearInline(
					program,
					{ ...candidate, kind: "inline", site, targets: [proof.callback] },
					editor,
					callback,
				);
				if (inlined === undefined)
					throw new Error("Validated synchronous callback became inapplicable");
				introduced += inlined.instructionsIntroduced;
			}
			return { ...applied, instructionsIntroduced: introduced };
		}
		case "guarded-inline":
			return applyGuardedInline(program, candidate, editor);
		case "read-accessor":
		case "guarded-read-accessor": {
			const input = readAccessorInputs.get(program);
			return input === undefined
				? undefined
				: expandCoreReadAccessorRegion(
						program,
						summaries,
						input.names,
						candidate,
						editor,
						input.hints,
						input.work,
					);
		}
	}
}

interface CoreValueKindFold {
	readonly instruction: CoreInstructionId;
	readonly result: boolean;
}

export type CoreCrossCallCallerPreparation = (
	wave: number,
	functionId: CoreFunctionId,
	editor: CoreEditor,
) => () => CoreCrossCallFunctionOptimizationResult;

export interface CoreCrossCallTransformResult {
	readonly summaries: CoreProgramSummaries;
	readonly statistics: CoreCrossCallTransformStatistics;
	readonly localPlanInputs: ReadonlyArray<CoreLocalOptimizationPlanInput>;
}

export function emptyCoreCrossCallTransformResult(
	flow: CoreProgramFlowState,
): CoreCrossCallTransformResult {
	const budget = new CoreTransformCandidateService().statistics();
	return Object.freeze({
		summaries: flow.summaries,
		localPlanInputs: Object.freeze([]),
		statistics: Object.freeze({
			...budget,
			...EMPTY_CORE_READ_ACCESSOR_WORK,
			waves: 0,
			callerEditSessions: 0,
			callerLocalOptimizations: 0,
			programFlowResolves: 0,
			instructionsIntroduced: 0,
			blocksIntroduced: 0,
			callGraphFunctionsAnalyzed: 0,
			summaryFunctionsAnalyzed: 0,
			sccNodesAnalyzed: 0,
			sccEdgeVisits: 0,
			sccTransfers: 0,
			callerWakeups: 0,
			valueKindFunctionEvaluations: 0,
			valueKindFolds: 0,
			wildcardAggregateRecomputations: 0,
			exactReverseCallerVisits: 0,
			wildcardReverseCallerVisits: 0,
		}),
	});
}

function discoverProgramValueKindObservations(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	flow: CoreProgramFlowState,
	readValueKinds: () => CoreProgramValueKinds,
): ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreValueKindFold>> {
	const foldsByCaller = new Map<CoreFunctionId, ReadonlyArray<CoreValueKindFold>>();
	const pending = new Map<CoreFunctionId, Array<CoreInstructionId>>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		let fixedKind: ReturnType<typeof coreValueKindDemand> | undefined;
		const folds: Array<CoreValueKindFold> = [];
		for (let index = 0; index < fn.instructionCapacity; index++) {
			const instruction = index as CoreInstructionId;
			if (fn.kernel.instructionLive(instruction) === 0) continue;
			let demand = false;
			const result = coreValueKindObservation(program, fn, instruction, (value) => {
				fixedKind ??= coreValueKindDemand(
					fn,
					() =>
						analyses
							.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
								scope: "function",
								function: functionId,
							})
							.exceptional(),
					flow.targets,
					flow.summaries.summary(functionId)?.externallyReachable === true,
				);
				const kind = fixedKind(value);
				if (kind === undefined) demand = true;
				return kind ?? COMPILER_VALUE_KIND_TOP;
			});
			if (result !== undefined) folds.push({ instruction, result });
			else if (demand) {
				let instructions = pending.get(functionId);
				if (instructions === undefined) pending.set(functionId, (instructions = []));
				instructions.push(instruction);
			}
		}
		if (folds.length > 0) foldsByCaller.set(functionId, folds);
	}
	if (pending.size > 0) {
		const kinds = readValueKinds();
		for (const [functionId, instructions] of pending) {
			const fn = program.function(functionId);
			const values = kinds.values(functionId);
			const folds = [...(foldsByCaller.get(functionId) ?? [])];
			for (const instruction of instructions) {
				const result = coreValueKindObservation(program, fn, instruction, (value) =>
					values.kindMask(value),
				);
				if (result !== undefined) folds.push({ instruction, result });
			}
			if (folds.length > 0) foldsByCaller.set(functionId, folds);
		}
	}
	return foldsByCaller;
}

export function runCoreCrossCallTransforms(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	prepareCaller: CoreCrossCallCallerPreparation,
	limits?: CoreTransformBudgetLimits,
	initialFlow?: CoreProgramFlowState,
	candidateService?: CoreTransformCandidateService,
	readAccessors = true,
	collectAccessorWork = false,
): CoreCrossCallTransformResult {
	const phaseLimits = limits ?? DEFAULT_CORE_TRANSFORM_BUDGETS;
	const service = candidateService ?? new CoreTransformCandidateService(phaseLimits);
	const budgetBaseline = service.statistics();
	const accessorWork: CoreReadAccessorWork | undefined = collectAccessorWork
		? {
				...EMPTY_CORE_READ_ACCESSOR_WORK,
				accessorApplications: [],
				accessorLoopApplications: [],
			}
		: undefined;
	let flow =
		initialFlow ?? analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
	let summaries = flow.summaries;
	let callGraphFunctionsAnalyzed = summaries.targets.statistics.functionsAnalyzed;
	let summaryFunctionsAnalyzed = summaries.statistics.functionsAnalyzed;
	let sccNodesAnalyzed = summaries.statistics.sccNodesAnalyzed;
	let sccEdgeVisits = summaries.statistics.sccEdgeVisits;
	let sccTransfers = summaries.statistics.sccTransfers;
	let callerWakeups = summaries.statistics.callerWakeups;
	let wildcardAggregateRecomputations = summaries.statistics.aggregateRecomputations;
	let exactReverseCallerVisits = summaries.statistics.exactReverseCallerVisits;
	let wildcardReverseCallerVisits = summaries.statistics.wildcardReverseCallerVisits;
	let valueKindFunctionEvaluations = 0;
	let valueKinds: CoreProgramValueKindState | undefined;
	const readValueKinds = () => {
		const next = analyses.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;
		if (next !== valueKinds) {
			valueKindFunctionEvaluations += next.statistics.functionsEvaluated;
			wildcardAggregateRecomputations += next.statistics.aggregateRecomputations;
			exactReverseCallerVisits += next.statistics.exactReverseCallerVisits;
			wildcardReverseCallerVisits += next.statistics.wildcardReverseCallerVisits;
		}
		valueKinds = next;
		return next;
	};
	let instructionsIntroduced = 0;
	let blocksIntroduced = 0;
	let waves = 0;
	let callerEditSessions = 0;
	let callerLocalOptimizations = 0;
	let programFlowResolves = 1;
	let valueKindFolds = 0;
	const localPlanInputs = new Map<CoreFunctionId, CoreLocalOptimizationPlanInput>();
	// Clones are new functions rather than growth of their callers, so they draw on a budget of their own.
	// Each clone is charged to the function it copies; the variant cap bounds that per function.
	const cloneLimits: CoreTransformBudgetLimits = Object.freeze({
		...phaseLimits,
		perCallerGeneratedCode:
			CALLBACK_SPECIALIZATION_VARIANTS * CALLBACK_SPECIALIZATION_MAX_INSTRUCTIONS,
		perCallerCompilerWork:
			2 * CALLBACK_SPECIALIZATION_VARIANTS * CALLBACK_SPECIALIZATION_MAX_INSTRUCTIONS,
		programGeneratedCode: phaseLimits.programGeneratedCode,
		programCompilerWork: phaseLimits.programCompilerWork,
	});
	const cloneVariants = new Map<CoreFunctionId, number>();
	const clones = new Set<CoreFunctionId>();
	let cloneGeneratedCode = 0;
	let cloneCompilerWork = 0;
	const specialized = specializeCoreStaticArguments(
		program,
		analyses,
		summaries,
		service,
		phaseLimits,
	);

	if (specialized.length !== 0) {
		flow = analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
		summaries = flow.summaries;
		programFlowResolves++;
	}

	for (let wave = 0; wave < 2; wave++) {
		// Inlines into clones may expose the callees of inlined forwarders to the next wave.
		const exhausted = service.programBudgetExhaustionReason(phaseLimits);
		if (
			exhausted !== undefined &&
			!(wave === 0 && specialized.length > 0) &&
			!(wave > 0 && exhausted === "generated-code-cost" && clones.size > 0)
		)
			break;
		const cloned = new Set<CoreFunctionId>();
		const devirtualized = devirtualizeCoreFunctionPrototypeCalls(
			program,
			summaries,
			new Set(flow.reachability.liveFunctions),
		);
		if (devirtualized.changed.length !== 0) {
			for (const functionId of devirtualized.changed) cloned.add(functionId);
			instructionsIntroduced += devirtualized.instructions;
			flow = analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
			summaries = flow.summaries;
			programFlowResolves++;
		}
		// Clones of forwarding helpers expose their callees' sites to the next round. Each
		// round reconsiders every candidate, since one declined earlier may now fit.
		for (let round = 0; round < CALLBACK_SPECIALIZATION_ROUNDS; round++) {
			const share = (round + 1) / CALLBACK_SPECIALIZATION_ROUNDS;
			const roundLimits: CoreTransformBudgetLimits = Object.freeze({
				...cloneLimits,
				programGeneratedCode: Math.max(
					0,
					Math.ceil(cloneLimits.programGeneratedCode * share) - cloneGeneratedCode,
				),
				programCompilerWork: Math.max(
					0,
					Math.ceil(cloneLimits.programCompilerWork * share) - cloneCompilerWork,
				),
			});
			const roundService = new CoreTransformCandidateService(roundLimits);
			const live = new Set(flow.reachability.liveFunctions);
			const changed = [
				...specializeCoreCallbackArguments(
					program,
					summaries,
					roundService,
					roundLimits,
					live,
					cloneVariants,
					clones,
				),
				...specializeCoreClosureFactories(
					program,
					summaries,
					roundService,
					roundLimits,
					live,
					cloneVariants,
					clones,
				),
			];
			const consumed = roundService.statistics();
			cloneGeneratedCode += consumed.generatedCodeConsumed;
			cloneCompilerWork += consumed.compilerWorkConsumed;
			if (changed.length === 0) break;
			for (const functionId of changed) cloned.add(functionId);
			flow = analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
			summaries = flow.summaries;
			programFlowResolves++;
		}
		discoverCoreCrossCallCandidates(
			program,
			analyses,
			summaries,
			service,
			new Set(flow.reachability.liveFunctions),
			undefined,
			readAccessors,
			accessorWork,
			clones,
		);
		const foldsByCaller = discoverProgramValueKindObservations(
			program,
			analyses,
			flow,
			readValueKinds,
		);
		const editors = new Map<CoreFunctionId, CoreEditor>();
		const appliedCallers = new Set<CoreFunctionId>([
			...(wave === 0 ? specialized : []),
			...cloned,
		]);
		for (const functionId of appliedCallers)
			editors.set(functionId, CoreEditor.open(program, functionId));
		let published = appliedCallers.size !== 0;
		for (
			let candidate = service.next();
			candidate !== undefined;
			candidate = service.next()
		) {
			const exhausted = service.programBudgetExhaustionReason(phaseLimits);
			// Candidates that add no code, or complete a clone, still fit.
			if (
				exhausted === "generated-code-cost" &&
				candidate.generatedCodeCost > 0 &&
				candidate.cloneSpecialization !== true
			) {
				service.recordDeclined(exhausted);
				continue;
			}
			if (exhausted !== undefined && exhausted !== "generated-code-cost") {
				service.recordDeclined(exhausted);
				service.discardPending(exhausted);
				break;
			}
			const decline = service.admit(candidate, phaseLimits);
			if (decline !== undefined) {
				service.recordDeclined(decline);
				continue;
			}
			const editor =
				editors.get(candidate.caller) ?? CoreEditor.open(program, candidate.caller);
			editors.set(candidate.caller, editor);
			const applied = applyCandidate(program, summaries, candidate, editor);
			if (applied === undefined) {
				service.recordDeclined("unsupported-graph");
				continue;
			}
			service.recordApplied(candidate);
			appliedCallers.add(candidate.caller);
			instructionsIntroduced += applied.instructionsIntroduced;
			blocksIntroduced += applied.blocksIntroduced;
			if (
				candidate.kind === "inline" ||
				candidate.kind === "synchronous-callback-inline" ||
				candidate.kind === "guarded-inline" ||
				candidate.kind === "read-accessor" ||
				candidate.kind === "guarded-read-accessor" ||
				candidate.kind === "array-iteration-inline"
			) {
				published = true;
			}
		}
		for (const [functionId, folds] of foldsByCaller) {
			const fn = program.function(functionId);
			const editor = editors.get(functionId) ?? CoreEditor.open(program, functionId);
			editors.set(functionId, editor);
			for (const { instruction, result } of folds) {
				if (!fn.isInstructionLive(instruction)) continue;
				editor.replaceInstruction(instruction, "createBoolean", [], {
					attributes: { value: result },
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				valueKindFolds++;
				published = true;
				appliedCallers.add(functionId);
			}
		}
		const waveChanges: Array<CoreChangeSet> = [];
		const finishCallers: Array<{
			function: CoreFunctionId;
			finish: () => CoreCrossCallFunctionOptimizationResult;
		}> = [];
		for (const [functionId, editor] of [...editors].sort(
			([left], [right]) => left - right,
		)) {
			callerEditSessions++;
			if (!appliedCallers.has(functionId)) {
				editor.commit();
				continue;
			}
			const virtualCapture = virtualizeGuardedCallbackEnvironment(
				program,
				functionId,
				editor,
			);
			if (virtualCapture !== undefined) {
				instructionsIntroduced += virtualCapture.instructionsIntroduced;
			}
			finishCallers.push({
				function: functionId,
				finish: prepareCaller(wave, functionId, editor),
			});
			callerLocalOptimizations++;
		}
		// Shared facts must not observe another caller's uncommitted rewrites.
		for (const { function: functionId, finish } of finishCallers) {
			const optimized = finish();
			if (optimized.localPlanInput.function !== functionId) {
				throw new Error(
					`Cross-call session for function ${functionId} returned function ${optimized.localPlanInput.function}`,
				);
			}
			localPlanInputs.set(functionId, optimized.localPlanInput);
			if (optimized.changes !== undefined && optimized.changes.edits > 0) {
				waveChanges.push(optimized.changes);
			}
		}
		if (waveChanges.length === 0 || !published) break;
		waves++;
		const priorFlow = flow;
		flow = analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
		programFlowResolves++;
		summaries = flow.summaries;
		if (flow.targets !== priorFlow.targets) {
			callGraphFunctionsAnalyzed += summaries.targets.statistics.functionsAnalyzed;
		}
		if (summaries !== priorFlow.summaries) {
			summaryFunctionsAnalyzed += summaries.statistics.functionsAnalyzed;
			sccNodesAnalyzed += summaries.statistics.sccNodesAnalyzed;
			sccEdgeVisits += summaries.statistics.sccEdgeVisits;
			sccTransfers += summaries.statistics.sccTransfers;
			callerWakeups += summaries.statistics.callerWakeups;
			wildcardAggregateRecomputations += summaries.statistics.aggregateRecomputations;
			exactReverseCallerVisits += summaries.statistics.exactReverseCallerVisits;
			wildcardReverseCallerVisits += summaries.statistics.wildcardReverseCallerVisits;
		}
		const spent = service.programBudgetExhaustionReason(phaseLimits);
		if (
			wave + 1 === 2 ||
			(spent !== undefined && (spent !== "generated-code-cost" || clones.size === 0))
		)
			break;
		// Committed edits can introduce consumers without changing published summaries.
	}
	const budget = service.statisticsSince(budgetBaseline);
	return Object.freeze({
		summaries,
		localPlanInputs: Object.freeze([...localPlanInputs.values()]),
		statistics: Object.freeze({
			...budget,
			...(accessorWork ?? EMPTY_CORE_READ_ACCESSOR_WORK),
			waves,
			callerEditSessions,
			callerLocalOptimizations,
			programFlowResolves,
			instructionsIntroduced,
			blocksIntroduced,
			callGraphFunctionsAnalyzed,
			summaryFunctionsAnalyzed,
			sccNodesAnalyzed,
			sccEdgeVisits,
			sccTransfers,
			callerWakeups,
			valueKindFunctionEvaluations,
			valueKindFolds,
			wildcardAggregateRecomputations,
			exactReverseCallerVisits,
			wildcardReverseCallerVisits,
		}),
	});
}
