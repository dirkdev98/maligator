import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreCrossCallFunctionOptimizationResult } from "./core-function-optimization-session.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreCalleeTargetsAreOpen } from "./core-ir-call-targets.ts";
import type { CoreLocalOptimizationPlanInput } from "./core-ir-region-selection.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { coreValueKindObservation } from "./core-ir-value-kinds.ts";
import type { CoreProgramValueKinds } from "./core-ir-value-kinds.ts";
import type {
	CoreEdge,
	CoreFunctionId,
	CoreInstructionId,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "./core-program-flow-analysis.ts";
import type { CoreProgramFlowState } from "./core-program-flow-analysis.ts";
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

interface LinearInlineTarget {
	readonly function: CoreFunctionStore;
	readonly returnValue: CoreValueId;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly blocks: ReadonlyArray<{
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

function materializeTerminatorEdge(fn: CoreFunctionStore, edge: number): CoreEdge {
	const start = fn.kernel.terminatorEdgeArgumentStart(edge);
	const count = fn.kernel.terminatorEdgeArgumentCount(edge);
	const arguments_: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++)
		arguments_.push(fn.kernel.operandAt(start + index));
	return { block: fn.kernel.terminatorEdgeBlock(edge), arguments: arguments_ };
}

function materializeTerminatorInput(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreTerminatorInput {
	const kind = fn.instructionKind(instruction);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
	switch (kind) {
		case "jump":
			return { kind, edge: materializeTerminatorEdge(fn, edgeStart) };
		case "branch":
			return {
				kind,
				condition: fn.kernel.operandAt(operandStart),
				consequent: materializeTerminatorEdge(fn, edgeStart),
				alternate: materializeTerminatorEdge(fn, edgeStart + 1),
			};
		case "guard": {
			const fact = fn.kernel.terminatorFact(instruction);
			if (fact === undefined) throw new Error(`Core guard ${instruction} has no fact`);
			return {
				kind,
				condition: fn.kernel.operandAt(operandStart),
				fact,
				success: materializeTerminatorEdge(fn, edgeStart),
				fallback: materializeTerminatorEdge(fn, edgeStart + 1),
			};
		}
		case "switch": {
			const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
			const cases: Array<
				Extract<CoreTerminatorInput, { kind: "switch" }>["cases"][number]
			> = [];
			for (let index = 0; index < edgeCount - 1; index++) {
				const value = fn.kernel.terminatorEdgeCaseValue(edgeStart + index);
				if (value === undefined)
					throw new Error(`Core switch ${instruction} has no case`);
				cases.push({
					value,
					edge: materializeTerminatorEdge(fn, edgeStart + index),
				});
			}
			return {
				kind,
				discriminant: fn.kernel.operandAt(operandStart),
				cases,
				default: materializeTerminatorEdge(fn, edgeStart + edgeCount - 1),
			};
		}
		case "return":
		case "throw":
			return { kind, value: fn.kernel.operandAt(operandStart) };
		case "unreachable":
			return { kind };
		case "operation":
			throw new Error(`Core instruction ${instruction} is not a terminator`);
	}
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
	"loadArgument",
	"loadArgumentCount",
	"loadCallee",
	"loadCaptured",
	"loadNewTarget",
	"loadStaticArgument",
	"storeCaptured",
]);

function linearInlineTarget(
	program: CoreProgram,
	target: CoreFunctionId,
): LinearInlineTarget | undefined {
	const fn = program.function(target);
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.metadata.isClassConstructor ||
		fn.metadata.capturedCount !== 0 ||
		fn.factCapacity !== 0
	)
		return undefined;
	const available = new Set<CoreValueId>();
	for (let index = 0; index < fn.parameterCount; index++)
		available.add(fn.kernel.functionParameter(index));
	const entryParameterStart = fn.kernel.blockParameterStart(fn.entry);
	const entryParameterCount = fn.kernel.blockParameterCount(fn.entry);
	for (let index = 0; index < entryParameterCount; index++) {
		if (!available.has(fn.kernel.blockParameterValue(entryParameterStart + index)))
			return undefined;
	}
	const blocks: Array<{
		readonly instructions: ReadonlyArray<CoreInstructionId>;
		readonly parameters: ReadonlyArray<readonly [CoreValueId, CoreValueId]>;
	}> = [];
	const instructions: Array<CoreInstructionId> = [];
	const visited = new Set<number>();
	let block = fn.entry;
	let parameters: ReadonlyArray<readonly [CoreValueId, CoreValueId]> = [];
	for (;;) {
		if (visited.has(block) || fn.kernel.blockHandlerBlock(block) !== undefined)
			return undefined;
		visited.add(block);
		for (const [parameter, incoming] of parameters) {
			if (!available.has(incoming)) return undefined;
			available.add(parameter);
		}
		const body = [...fn.bodyInstructionIds(block)];
		blocks.push({ instructions: body, parameters });
		instructions.push(...body);
		for (const instruction of body) {
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				INLINE_UNSUPPORTED_OPCODES.has(opcode) ||
				(opcode === "loadThis" && !fn.metadata.strict) ||
				fn.instructionEffectRefinement(instruction) !== undefined
			)
				return undefined;
			if (opcode !== "loadThis") {
				const operandStart = fn.kernel.instructionOperandStart(instruction);
				const operandCount = fn.kernel.instructionOperandCount(instruction);
				for (let index = 0; index < operandCount; index++) {
					if (!available.has(fn.kernel.operandAt(operandStart + index))) return undefined;
				}
			}
			const resultStart = fn.kernel.instructionResultStart(instruction);
			const resultCount = fn.kernel.instructionResultCount(instruction);
			for (let index = 0; index < resultCount; index++)
				available.add(fn.kernel.resultAt(resultStart + index));
		}
		const terminator = fn.blockTerminator(block);
		const terminatorKind = fn.instructionKind(terminator);
		if (terminatorKind === "return") {
			const returnValue = fn.kernel.operandAt(
				fn.kernel.instructionOperandStart(terminator),
			);
			if (!available.has(returnValue)) return undefined;
			return {
				function: fn,
				returnValue,
				instructions,
				blocks,
			};
		}
		if (terminatorKind !== "jump") return undefined;
		const edge = fn.kernel.terminatorEdgeStart(terminator);
		const targetBlock = fn.kernel.terminatorEdgeBlock(edge);
		if (visited.has(targetBlock)) {
			return undefined;
		}
		const parameterStart = fn.kernel.blockParameterStart(targetBlock);
		const parameterCount = fn.kernel.blockParameterCount(targetBlock);
		const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
		const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
		if (parameterCount !== argumentCount) return undefined;
		const nextParameters: Array<readonly [CoreValueId, CoreValueId]> = [];
		for (let index = 0; index < parameterCount; index++) {
			nextParameters.push([
				fn.kernel.blockParameterValue(parameterStart + index),
				fn.kernel.operandAt(argumentStart + index),
			]);
		}
		parameters = nextParameters;
		block = targetBlock;
	}
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
		const current = fn.instructionAttributes(site.instruction);
		if (
			site.targets.functions.length !== 1 ||
			current[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true
		)
			continue;
		const target = site.targets.functions[0]!;
		const linear = linearInlineTarget(program, target);
		const open = coreCalleeTargetsAreOpen(site.targets);
		service.offer(
			Object.freeze({
				kind: open ? "guarded-inline" : "inline",
				caller: functionId,
				site: site.instruction,
				revision: summaries.version(target),
				priorityClass: open ? 1 : 2,
				priorityScore: 0,
				targets: Object.freeze([target]),
				generatedCodeCost: (linear?.instructions.length ?? 0) + (open ? 1 : 0),
				compilerWorkCost:
					(linear?.instructions.length ?? 0) +
					(linear?.function.valueCapacity ?? 0) +
					(open ? 4 : 1),
				expansive: true,
				...(target === functionId
					? { unsupportedReason: "recursive" as const }
					: linear === undefined
						? { unsupportedReason: "unsupported-graph" as const }
						: {}),
			}),
		);
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

function applyLinearInline(
	program: CoreProgram,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
): AppliedTransform | undefined {
	const target = candidate.targets[0];
	if (target === undefined) return undefined;
	const linear = linearInlineTarget(program, target);
	const caller = program.function(candidate.caller);
	if (
		linear === undefined ||
		!caller.isInstructionLive(candidate.site) ||
		caller.instructionKind(candidate.site) !== "operation"
	)
		return undefined;
	const descriptor = caller.registry.byId(caller.instructionOpcode(candidate.site));
	if (
		descriptor.callTransfer?.invocation !== "call" ||
		descriptor.callTransfer.result !== "call-completion"
	)
		return undefined;
	const operands = materializeInstructionOperands(caller, candidate.site);
	const callResults = materializeInstructionResults(caller, candidate.site);
	if (callResults.length !== 1) return undefined;
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
		linear.instructions.some(
			(instruction) => linear.function.instructionOpcodeName(instruction) === "loadThis",
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
		linear.instructions,
		linear.function,
	);
	const values = new Map<CoreValueId, CoreValueId>();
	let introduced = 0;
	for (let index = 0; index < linear.function.parameterCount; index++) {
		const parameter = linear.function.kernel.functionParameter(index);
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
	for (const inlineBlock of linear.blocks) {
		for (const [parameter, incoming] of inlineBlock.parameters) {
			const value = values.get(incoming);
			if (value === undefined)
				throw new Error("Validated inline edge has no caller value");
			values.set(parameter, value);
		}
		for (const instruction of inlineBlock.instructions) {
			const opcode = linear.function.instructionOpcodeName(instruction);
			if (opcode === "loadThis") {
				const output =
					linear.function.kernel.instructionResultCount(instruction) === 0
						? undefined
						: linear.function.kernel.resultAt(
								linear.function.kernel.instructionResultStart(instruction),
							);
				if (output === undefined || receiver === undefined) return undefined;
				values.set(output, receiver);
				continue;
			}
			const inputStart = linear.function.kernel.instructionOperandStart(instruction);
			const inputCount = linear.function.kernel.instructionOperandCount(instruction);
			const inputs: Array<CoreValueId | undefined> = [];
			for (let index = 0; index < inputCount; index++)
				inputs.push(values.get(linear.function.kernel.operandAt(inputStart + index)));
			if (inputs.some((value) => value === undefined)) {
				throw new Error("Validated inline input has no caller value");
			}
			const outputs = materializeInstructionResults(linear.function, instruction);
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
					sourcePosition: sourcePositions.get(instruction),
				},
			);
			introduced++;
			for (const [index, output] of outputs.entries()) {
				values.set(output, inserted.outputs[index]!);
			}
		}
	}
	const replacement = values.get(linear.returnValue);
	if (replacement === undefined) {
		throw new Error("Validated inline return has no caller value");
	}
	editor.replaceValueUses(callResults[0]!, replacement);
	editor.removeInstruction(candidate.site);
	return {
		instructionsIntroduced: introduced,
		blocksIntroduced: 0,
	};
}

function applyGuardedLinearInline(
	program: CoreProgram,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
): AppliedTransform | undefined {
	const target = candidate.targets[0];
	if (target === undefined) return undefined;
	const linear = linearInlineTarget(program, target);
	const caller = program.function(candidate.caller);
	if (
		linear === undefined ||
		!caller.isInstructionLive(candidate.site) ||
		caller.instructionKind(candidate.site) !== "operation"
	)
		return undefined;
	const descriptor = caller.registry.byId(caller.instructionOpcode(candidate.site));
	if (
		descriptor.callTransfer?.invocation !== "call" ||
		descriptor.callTransfer.result !== "call-completion"
	)
		return undefined;
	const operands = materializeInstructionOperands(caller, candidate.site);
	const callResults = materializeInstructionResults(caller, candidate.site);
	if (callResults.length !== 1) return undefined;
	const callResult = callResults[0]!;
	if (
		linear.function.valueRepresentation(linear.returnValue) !==
		caller.valueRepresentation(callResult)
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
	const callee = operands[descriptor.callTransfer.calleeOperand];
	if (callee === undefined) return undefined;
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
		linear.instructions,
		linear.function,
	);
	const tail: Array<CoreInstructionId> = [];
	for (
		let instruction = caller.instructionNext(candidate.site);
		instruction !== undefined && instruction !== originalTerminator;
		instruction = caller.instructionNext(instruction)
	)
		tail.push(instruction);
	const handlerBlock = caller.kernel.blockHandlerBlock(block);
	const handlerArguments: Array<CoreValueId> = [];
	const handlerArgumentStart = caller.kernel.blockHandlerArgumentStart(block);
	const handlerArgumentCount = caller.kernel.blockHandlerArgumentCount(block);
	for (let index = 0; index < handlerArgumentCount; index++)
		handlerArguments.push(caller.kernel.handlerArgumentAt(handlerArgumentStart + index));
	const callAttributes = caller.instructionAttributes(candidate.site);
	const callRefinement = caller.instructionEffectRefinement(candidate.site);
	const fast = editor.createBlock();
	const fallback = editor.createBlock();
	const join = editor.createBlock([
		{ representation: caller.valueRepresentation(callResult) },
	]);
	const joinedResult = caller.kernel.blockParameterValue(
		caller.kernel.blockParameterStart(join),
	);
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.replaceValueUses(callResult, joinedResult);
	const joinedTerminator = {
		...materializeTerminatorInput(caller, originalTerminator),
		...(terminatorPosition === undefined ? {} : { sourcePosition: terminatorPosition }),
	};
	editor.setTerminator(join, joinedTerminator);

	editor.moveInstruction(candidate.site, fallback);
	editor.replaceInstruction(
		candidate.site,
		caller.instructionOpcodeName(candidate.site),
		operands,
		{
			attributes: {
				...callAttributes,
				[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true,
			},
			sourcePosition: callerPosition,
			...(callRefinement === undefined ? {} : { effectRefinement: callRefinement }),
		},
	);
	editor.setTerminator(fallback, {
		kind: "jump",
		edge: { block: join, arguments: [callResult] },
		sourcePosition: callerPosition,
	});

	const values = new Map<CoreValueId, CoreValueId>();
	let introduced = 1;
	for (let index = 0; index < linear.function.parameterCount; index++) {
		const parameter = linear.function.kernel.functionParameter(index);
		const argument = arguments_[index];
		if (argument !== undefined) {
			values.set(parameter, argument);
			continue;
		}
		const created = editor.appendInstruction(fast, "createUndefined", [], {
			sourcePosition: callerPosition,
		});
		values.set(parameter, created.outputs[0]!);
		introduced++;
	}
	for (const inlineBlock of linear.blocks) {
		for (const [parameter, incoming] of inlineBlock.parameters) {
			const value = values.get(incoming);
			if (value === undefined)
				throw new Error("Validated guarded inline edge has no caller value");
			values.set(parameter, value);
		}
		for (const instruction of inlineBlock.instructions) {
			const opcode = linear.function.instructionOpcodeName(instruction);
			if (opcode === "loadThis") {
				const output =
					linear.function.kernel.instructionResultCount(instruction) === 0
						? undefined
						: linear.function.kernel.resultAt(
								linear.function.kernel.instructionResultStart(instruction),
							);
				if (output === undefined || receiver === undefined)
					throw new Error("Validated guarded inline receiver is unavailable");
				values.set(output, receiver);
				continue;
			}
			const inputStart = linear.function.kernel.instructionOperandStart(instruction);
			const inputCount = linear.function.kernel.instructionOperandCount(instruction);
			const inputs: Array<CoreValueId | undefined> = [];
			for (let index = 0; index < inputCount; index++)
				inputs.push(values.get(linear.function.kernel.operandAt(inputStart + index)));
			if (inputs.some((value) => value === undefined))
				throw new Error("Validated guarded inline input has no caller value");
			const outputs = materializeInstructionResults(linear.function, instruction);
			const inserted = editor.appendInstruction(
				fast,
				opcode,
				inputs as ReadonlyArray<CoreValueId>,
				{
					outputCount: outputs.length,
					outputRepresentations: outputs.map((value) =>
						linear.function.valueRepresentation(value),
					),
					attributes: linear.function.instructionAttributes(instruction),
					sourcePosition: sourcePositions.get(instruction),
				},
			);
			introduced++;
			for (const [index, output] of outputs.entries())
				values.set(output, inserted.outputs[index]!);
		}
	}
	const fastResult = values.get(linear.returnValue);
	if (fastResult === undefined)
		throw new Error("Validated guarded inline return has no caller value");
	editor.setTerminator(fast, {
		kind: "jump",
		edge: { block: join, arguments: [fastResult] },
		sourcePosition: callerPosition,
	});
	const guard = editor.appendInstruction(block, "guardFunctionIndex", [callee], {
		outputRepresentations: ["boolean"],
		attributes: { functionIndex: target },
		sourcePosition: callerPosition,
	});
	editor.replaceTerminator(block, {
		kind: "branch",
		condition: guard.outputs[0]!,
		consequent: { block: fast, arguments: [] },
		alternate: { block: fallback, arguments: [] },
		sourcePosition: callerPosition,
	});
	if (handlerBlock !== undefined) {
		for (const guardedBlock of [fast, fallback, join])
			editor.setHandler(guardedBlock, handlerBlock, handlerArguments);
	}
	return {
		instructionsIntroduced: introduced,
		blocksIntroduced: 3,
	};
}

function applyCandidate(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
): AppliedTransform | undefined {
	switch (candidate.kind) {
		case "inline":
			return applyLinearInline(program, candidate, editor);
		case "guarded-inline":
			return applyGuardedLinearInline(program, candidate, editor);
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
	for (let wave = 0; wave < 2; wave++) {
		if (service.programBudgetExhaustionReason(phaseLimits) !== undefined) break;
		discoverCoreCrossCallCandidates(program, summaries, service);
		const foldsByCaller = discoverProgramValueKindObservations(program, flow.valueKinds);
		const editors = new Map<CoreFunctionId, CoreEditor>();
		const appliedCallers = new Set<CoreFunctionId>();
		let published = false;
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
			if (candidate.kind === "inline" || candidate.kind === "guarded-inline") {
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
