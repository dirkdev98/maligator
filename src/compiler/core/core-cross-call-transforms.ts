import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import {
	coreArrayPredicateCall,
	expandCoreArrayPredicateCall,
} from "./core-array-predicates.ts";
import { coreConstructorSlotReserve } from "./core-constructor-layout.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreCrossCallFunctionOptimizationResult } from "./core-function-optimization-session.ts";
import {
	coreInstanceMethodHint,
	coreInstanceMethodHints,
	coreInstanceMethodTargets,
} from "./core-instance-method-hints.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import {
	coreDirectCreatedFunction,
	coreCalleeTargetsAreOpen,
	coreValueIsLoadedGlobalProperty,
} from "./core-ir-call-targets.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "./core-ir-provenance.ts";
import type { CoreLocalOptimizationPlanInput } from "./core-ir-region-selection.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import {
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	coreValueKindObservation,
} from "./core-ir-value-kinds.ts";
import type { CoreProgramValueKinds } from "./core-ir-value-kinds.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import {
	analyzeCoreNativeEntry,
	coreArgumentObservation,
} from "./core-native-entry-analysis.ts";
import {
	coreFieldEntryHasNumericComputations,
	coreNumericFieldArgument,
	coreReadOnlyNumericParameterFields,
} from "./core-native-field-analysis.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "./core-program-flow-analysis.ts";
import type { CoreProgramFlowState } from "./core-program-flow-analysis.ts";
import { specializeCoreStaticArguments } from "./core-static-value-calls.ts";
import type { CoreChangeSet, CoreFunctionStore, CoreProgram } from "./core-store.ts";
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

export interface CoreCrossCallTransformStatistics extends CoreTransformBudgetStatistics {
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

interface InlineTarget {
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

const INLINE_UNSUPPORTED_OPCODES = new Set([
	"createArgumentsObject",
	"createRestArguments",
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
}

const CAPTURE_ENVIRONMENT_REBINDS = new Set(["envPush", "envCopy", "envPop"]);

function captureEnvironmentIsStable(
	fn: CoreFunctionStore,
	creation: CoreInstructionId,
	site: CoreInstructionId,
): boolean {
	const creationBlock = fn.instructionBlock(creation);
	const siteBlock = fn.instructionBlock(site);
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
		)
			return undefined;
		const descriptor = caller.registry.byId(caller.instructionOpcode(instruction));
		if (descriptor.callTransfer?.arguments.kind !== "positional") return undefined;
		const position = caller.kernel.useOperand(use);
		if (position < descriptor.callTransfer.arguments.firstOperand) return undefined;
	}
	if (uses !== 1) return undefined;
	return { caller, callee, site };
}

function inlineTarget(
	program: CoreProgram,
	target: CoreFunctionId,
	invocation: "call" | "construct",
	captureContext?: InlineCaptureContext,
): InlineTarget | undefined {
	const fn = program.function(target);
	if (
		fn.isGenerator ||
		fn.isAsync ||
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
		if (active.has(block)) return false;
		if (visited.has(block)) return true;
		if (visited.size >= 8 || fn.kernel.blockHandlerBlock(block) !== undefined)
			return false;
		visited.add(block);
		active.add(block);
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				++instructionCount > 48 ||
				INLINE_UNSUPPORTED_OPCODES.has(opcode) ||
				(invocation !== "construct" && opcode === "loadNewTarget") ||
				(invocation === "construct" &&
					["createFunction", "envCopy", "envPop", "envPush"].includes(opcode)) ||
				(opcode === "loadCaptured" && captureContext === undefined) ||
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
		const kind = fn.instructionKind(terminator);
		if (kind === "return")
			returns.push(fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)));
		else if (kind === "jump" || kind === "branch") {
			if (kind === "branch") linear = false;
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
	return {
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
	const inline = inlineTarget(program, target, "call");
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
	return (
		fn.parameterCount === 1 &&
		!fn.metadata.hasPrototype &&
		!fn.metadata.isClassConstructor &&
		!fn.metadata.isDerivedConstructor &&
		!fn.isGenerator &&
		!fn.isAsync &&
		fn.metadata.nameStringIndex === name
	);
}

function prefersNumericFieldEntryDispatch(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	callerId: CoreFunctionId,
	call: CoreInstructionId,
	callee: CoreValueId,
	arguments_: ReadonlyArray<CoreValueId> | undefined,
	targets: ReadonlyArray<CoreFunctionId>,
	liveFunctions: ReadonlySet<CoreFunctionId>,
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
	let nominees = 0;
	for (const functionId of liveFunctions) {
		if (nativeFieldEntryMethodEligible(program.function(functionId), name)) nominees++;
	}
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
		const fields = coreReadOnlyNumericParameterFields(targetFn, cfg);
		if (fields === undefined) return false;
		const fieldObject = coreNumericFieldArgument(
			caller,
			facts,
			call,
			arguments_[0]!,
			fields,
		);
		if (fieldObject === undefined) return false;
		const variant = analyzeCoreNativeEntry(
			targetFn,
			cfg,
			["boxed"],
			undefined,
			[{ caller: callerId, instruction: call, guarded: true, fieldObject }],
			fields,
		);
		return coreFieldEntryHasNumericComputations(
			targetFn,
			variant.valueRepresentations,
			variant.operatorInputs,
		);
	});
}

function offerFunctionCandidates(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	functionId: CoreFunctionId,
	instanceMethodHints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
	liveFunctions: ReadonlySet<CoreFunctionId>,
): void {
	const fn = program.function(functionId);
	const outgoing = summaries.targets.outgoing(functionId);
	const globalTargetUses = new Map<CoreFunctionId, number>();
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
		const inLoop = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: functionId,
			})
			.ordinary()
			.loops.some((loop) => loop.blocks.has(fn.instructionBlock(site.instruction)));
		const predicate = inLoop
			? coreArrayPredicateCall(program, fn, site.instruction)
			: undefined;
		const callback =
			predicate === undefined
				? undefined
				: coreDirectCreatedFunction(fn, predicate.callback);
		if (predicate !== undefined && callback !== undefined && callback !== functionId) {
			const inline = inlineTarget(
				program,
				callback,
				"call",
				directCaptureContext(fn, predicate.callback, site.instruction, callback),
			);
			if (inline?.linear) {
				service.offer({
					kind: "array-predicate-inline",
					caller: functionId,
					site: site.instruction,
					revision: summaries.version(callback),
					priorityClass: 2,
					priorityScore: 0,
					targets: [callback],
					generatedCodeCost: 32 + inline.instructions.length,
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
			!prefersNumericFieldEntryDispatch(
				program,
				analyses,
				functionId,
				site.instruction,
				site.callee,
				site.arguments,
				hintedTargets,
				liveFunctions,
			)
				? hintedTargets
				: undefined;
		const finiteTargets = closedFiniteTargets ?? openHintTargets;
		if (finiteTargets !== undefined) {
			const targetSetKind = closedFiniteTargets === undefined ? "open-hints" : "closed";
			const inlines = finiteTargets.map((target) =>
				inlineTarget(program, target, invocation),
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
					priorityScore: 0,
					targets: Object.freeze([...finiteTargets]),
					targetSetKind,
					generatedCodeCost: inlines.reduce(
						(cost, inline) =>
							cost +
							(inline?.instructions.length ?? 0) +
							(inline?.linear === false ? inline.blocks.length : 0) +
							1,
						0,
					),
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
			inLoop
				? coreInstanceMethodHint(fn, site.callee, site.receiver, instanceMethodHints)
				: undefined;
		const target = exactTarget ?? hintedTarget;
		if (target === undefined) continue;
		const captureContext =
			exactTarget === undefined
				? undefined
				: directCaptureContext(fn, site.callee, site.instruction, exactTarget);
		const inline = inlineTarget(program, target, invocation, captureContext);
		const singleUseGlobal =
			coreValueIsLoadedGlobalProperty(fn, site.callee) &&
			(globalTargetUses.get(target) ?? 0) < 2;
		if (
			singleUseGlobal &&
			(!inLoop ||
				(!inline?.argumentSnapshots &&
					!callCarriesDirectCreatedFunction(fn, site.instruction)))
		) {
			continue;
		}
		const open = hintedTarget !== undefined || coreCalleeTargetsAreOpen(site.targets);
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
		service.offer(
			Object.freeze({
				kind: open ? "guarded-inline" : "inline",
				caller: functionId,
				site: site.instruction,
				revision: summaries.version(target),
				priorityClass: hintedTarget !== undefined ? 3 : open ? 1 : 2,
				priorityScore: 0,
				targets: Object.freeze([target]),
				generatedCodeCost:
					(inline?.instructions.length ?? 0) +
					(inline?.linear === false ? inline.blocks.length : 0) +
					consumerDuplication +
					(open ? 1 : 0),
				compilerWorkCost:
					(inline?.instructions.length ?? 0) +
					(inline?.function.valueCapacity ?? 0) +
					consumerDuplication +
					(open ? 4 : 1),
				expansive: captureContext === undefined,
				...(target === functionId
					? { unsupportedReason: "recursive" as const }
					: inline === undefined
						? { unsupportedReason: "unsupported-graph" as const }
						: !bridgesResult
							? { unsupportedReason: "representation" as const }
							: {}),
			}),
		);
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

export function discoverCoreCrossCallCandidates(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	liveFunctions: ReadonlySet<CoreFunctionId>,
	functions: Iterable<CoreFunctionId> = program.functionIds(),
): void {
	const instanceMethodHints = coreInstanceMethodHints(program);
	for (const functionId of functions) {
		offerFunctionCandidates(
			program,
			analyses,
			summaries,
			service,
			functionId,
			instanceMethodHints,
			liveFunctions,
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
			target,
			descriptor.callTransfer.invocation,
			directCaptureContext(caller, callee, candidate.site, target),
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
		target,
		descriptor.callTransfer.invocation,
		directCaptureContext(caller, callee, candidate.site, target),
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
				parameters.map((value) => ({
					representation: inline.function.valueRepresentation(value),
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
			const inline = inlineTarget(program, target, "call");
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
		case "array-predicate-inline": {
			const fn = program.function(candidate.caller);
			if (!fn.isInstructionLive(candidate.site)) return undefined;
			const predicate = coreArrayPredicateCall(program, fn, candidate.site);
			const target = candidate.targets[0];
			if (
				predicate === undefined ||
				target === undefined ||
				coreDirectCreatedFunction(fn, predicate.callback) !== target
			)
				return undefined;
			const inline = inlineTarget(
				program,
				target,
				"call",
				directCaptureContext(fn, predicate.callback, candidate.site, target),
			);
			if (!inline?.linear) return undefined;
			const expanded = expandCoreArrayPredicateCall(
				fn,
				editor,
				candidate.site,
				predicate,
			);
			const applied = applyLinearInline(
				program,
				{ ...candidate, kind: "inline", site: expanded.callback },
				editor,
			);
			if (applied === undefined)
				throw new Error("Admitted array predicate callback lost its inline proof");
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
		case "guarded-inline":
			return applyGuardedInline(program, candidate, editor);
	}
}

interface CoreValueKindFold {
	readonly instruction: CoreInstructionId;
	readonly result: boolean;
}

export type CoreCrossCallCallerOptimizer = (
	wave: number,
	functionId: CoreFunctionId,
	editor: CoreEditor,
) => CoreCrossCallFunctionOptimizationResult;

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
	kinds: CoreProgramValueKinds,
): ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreValueKindFold>> {
	const foldsByCaller = new Map<CoreFunctionId, ReadonlyArray<CoreValueKindFold>>();
	for (const functionId of kinds.changedFunctions) {
		const fn = program.function(functionId);
		const values = kinds.values(functionId);
		const folds: Array<CoreValueKindFold> = [];
		for (let index = 0; index < fn.instructionCapacity; index++) {
			const instruction = index as CoreInstructionId;
			if (fn.kernel.instructionLive(instruction) === 0) continue;
			const result = coreValueKindObservation(program, fn, instruction, (value) =>
				values.kindMask(value),
			);
			if (result !== undefined) folds.push({ instruction, result });
		}
		if (folds.length > 0) foldsByCaller.set(functionId, Object.freeze(folds));
	}
	return foldsByCaller;
}

export function runCoreCrossCallTransforms(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	optimizeCaller: CoreCrossCallCallerOptimizer,
	limits?: CoreTransformBudgetLimits,
	initialFlow?: CoreProgramFlowState,
	candidateService?: CoreTransformCandidateService,
): CoreCrossCallTransformResult {
	const phaseLimits = limits ?? DEFAULT_CORE_TRANSFORM_BUDGETS;
	const service = candidateService ?? new CoreTransformCandidateService(phaseLimits);
	const budgetBaseline = service.statistics();
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
	let valueKindFunctionEvaluations = flow.valueKinds.statistics.functionsEvaluated;
	let instructionsIntroduced = 0;
	let blocksIntroduced = 0;
	let waves = 0;
	let callerEditSessions = 0;
	let callerLocalOptimizations = 0;
	let programFlowResolves = 1;
	let valueKindFolds = 0;
	const localPlanInputs = new Map<CoreFunctionId, CoreLocalOptimizationPlanInput>();
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
		if (
			service.programBudgetExhaustionReason(phaseLimits) !== undefined &&
			!(wave === 0 && specialized.length > 0)
		)
			break;
		discoverCoreCrossCallCandidates(
			program,
			analyses,
			summaries,
			service,
			new Set(flow.reachability.liveFunctions),
		);
		const foldsByCaller = discoverProgramValueKindObservations(program, flow.valueKinds);
		const editors = new Map<CoreFunctionId, CoreEditor>();
		const appliedCallers = new Set<CoreFunctionId>(wave === 0 ? specialized : []);
		for (const functionId of appliedCallers)
			editors.set(functionId, CoreEditor.open(program, functionId));
		let published = appliedCallers.size !== 0;
		for (
			let candidate = service.next();
			candidate !== undefined;
			candidate = service.next()
		) {
			const exhausted = service.programBudgetExhaustionReason(phaseLimits);
			if (exhausted !== undefined) {
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
				candidate.kind === "guarded-inline" ||
				candidate.kind === "array-predicate-inline"
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
			const optimized = optimizeCaller(wave, functionId, editor);
			if (optimized.localPlanInput.function !== functionId) {
				throw new Error(
					`Cross-call session for function ${functionId} returned function ${optimized.localPlanInput.function}`,
				);
			}
			localPlanInputs.set(functionId, optimized.localPlanInput);
			callerLocalOptimizations++;
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
		if (flow.valueKinds !== priorFlow.valueKinds) {
			valueKindFunctionEvaluations += flow.valueKinds.statistics.functionsEvaluated;
		}
		const publishedChanged =
			flow.targets.changedCallers.size > 0 ||
			flow.summaries.changedFunctions.size > 0 ||
			flow.valueKinds.changedFunctions.size > 0 ||
			flow.reachability.statistics.resultSetUpdates > 0;
		if (!publishedChanged) break;
	}
	const valueKinds = flow.valueKinds;
	const budget = service.statisticsSince(budgetBaseline);
	return Object.freeze({
		summaries,
		localPlanInputs: Object.freeze([...localPlanInputs.values()]),
		statistics: Object.freeze({
			...budget,
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
			wildcardAggregateRecomputations:
				wildcardAggregateRecomputations + valueKinds.statistics.aggregateRecomputations,
			exactReverseCallerVisits:
				exactReverseCallerVisits + valueKinds.statistics.exactReverseCallerVisits,
			wildcardReverseCallerVisits:
				wildcardReverseCallerVisits + valueKinds.statistics.wildcardReverseCallerVisits,
		}),
	});
}
