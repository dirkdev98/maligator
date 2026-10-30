import {
	builtinOperations,
	builtinOperationDescriptor,
	builtinNormalResultKinds,
	exactBuiltinCallDescriptor,
	mathUnaryOperationKeys,
	primordialNode,
} from "../shared/builtin-registry.ts";
import {
	compilerFactIsWorldInvariant,
	knownFact,
	sourceSiteId,
} from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_OBJECT,
	compilerValueKindsHaveEmptyPrimitiveWrappers,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
} from "../shared/compiler-value-kinds.ts";
import {
	authorityFallback,
	normalizeFactRequirements,
} from "../shared/fact-implication.ts";
import { COMPILER_INT32_RANGE } from "../shared/integer-range.ts";
import {
	coreInitializedCapturedReadMembership,
	coreInitializedGlobalSlotMembership,
	coreReadsImportedBindingInitialized,
	coreReadsModuleBindingInitialized,
} from "./core-compilation.ts";
import { CORE_CONDITIONAL_VALUE_KIND_ANALYSIS } from "./core-conditional-value-kinds.ts";
import type { CoreConditionalValueKinds } from "./core-conditional-value-kinds.ts";
import { CoreEditor } from "./core-editor.ts";
import { CORE_FUNCTION_HAS_EDGE_ARGUMENTS } from "./core-function-features.ts";
import {
	coreFunctionPrototypeApply,
	expandCoreFunctionPrototypeApply,
} from "./core-function-prototype-call.ts";
import { removeCoreInstructions } from "./core-instruction-removal.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreValueControlFlowUseMask,
} from "./core-ir-control-flow.ts";
import type { CoreControlEdge } from "./core-ir-control-flow.ts";
import { CORE_LOCAL_EXCEPTION_FLOW_ANALYSIS } from "./core-ir-exception-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "./core-ir-provenance.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	coreValueKindObservation,
	coreValueKindObservationCandidate,
} from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import {
	CORE_SUPER_THIS_STATE_KEY,
	coreBlockId,
	coreFunctionId,
	coreInstructionId,
} from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreInstructionId,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import type {
	CoreFunctionPass,
	CoreFunctionPassContext,
	CorePassBudget,
} from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";
import {
	coreWeakCollectionKey,
	coreWeakCollectionNormalConstant,
} from "./core-weak-collection-facts.ts";
import type { CoreWeakCollectionNormalConstant } from "./core-weak-collection-facts.ts";

const LOCAL_BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 2_000_000,
	maxEdits: 1_000_000,
	exhaustion: "stop",
});

const CANONICAL_BLOCK_PARAMETER_BUDGET: CorePassBudget = Object.freeze({
	...LOCAL_BUDGET,
	maxEdits: 4_000_000,
});

const LOCAL_CHANGES = Object.freeze({
	cfg: true,
	calls: true,
	facts: true,
	representations: false,
});

function instructionOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index < 0 || index >= fn.kernel.instructionOperandCount(instruction)) {
		return undefined;
	}
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function instructionResult(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index < 0 || index >= fn.kernel.instructionResultCount(instruction)) {
		return undefined;
	}
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction) + index);
}

function copyInstructionOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	return Array.from({ length: count }, (_, index) => fn.kernel.operandAt(start + index));
}

function isFunctionParameter(fn: CoreFunctionStore, value: CoreValueId): boolean {
	for (let index = 0; index < fn.parameterCount; index++) {
		if (fn.kernel.functionParameter(index) === value) return true;
	}
	return false;
}

function definingInstruction(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function blockHasExceptionParameter(fn: CoreFunctionStore, block: CoreBlockId): boolean {
	const start = fn.kernel.blockParameterStart(block);
	const count = fn.kernel.blockParameterCount(block);
	for (let index = 0; index < count; index++) {
		if (fn.kernel.blockParameterRole(start + index) === 1) return true;
	}
	return false;
}

function handlerContainsValue(
	fn: CoreFunctionStore,
	block: CoreBlockId,
	value: CoreValueId,
): boolean {
	if (fn.kernel.blockHandlerBlock(block) === undefined) return false;
	const start = fn.kernel.blockHandlerArgumentStart(block);
	const count = fn.kernel.blockHandlerArgumentCount(block);
	for (let index = 0; index < count; index++) {
		if (fn.kernel.handlerArgumentAt(start + index) === value) return true;
	}
	return false;
}

function copyHandlerArguments(
	fn: CoreFunctionStore,
	block: CoreBlockId,
): Array<CoreValueId> {
	const start = fn.kernel.blockHandlerArgumentStart(block);
	const count = fn.kernel.blockHandlerArgumentCount(block);
	return Array.from({ length: count }, (_, index) =>
		fn.kernel.handlerArgumentAt(start + index),
	);
}

function sameHandler(
	fn: CoreFunctionStore,
	left: CoreBlockId,
	right: CoreBlockId,
): boolean {
	const leftHandler = fn.kernel.blockHandlerBlock(left);
	const rightHandler = fn.kernel.blockHandlerBlock(right);
	if (leftHandler !== rightHandler) return false;
	if (leftHandler === undefined) return true;
	const leftCount = fn.kernel.blockHandlerArgumentCount(left);
	if (leftCount !== fn.kernel.blockHandlerArgumentCount(right)) return false;
	const leftStart = fn.kernel.blockHandlerArgumentStart(left);
	const rightStart = fn.kernel.blockHandlerArgumentStart(right);
	for (let index = 0; index < leftCount; index++) {
		if (
			fn.kernel.handlerArgumentAt(leftStart + index) !==
			fn.kernel.handlerArgumentAt(rightStart + index)
		) {
			return false;
		}
	}
	return true;
}

// Construction isolates non-throwing instructions, such as constants, in handler-less
// blocks. An effect-free block can run under its predecessor's handler unobservably;
// absorbing it keeps same-block fusions available inside try regions. Allocations stay
// outside so handler scoping cannot block their sinking.
function resultUsedOutside(
	fn: CoreFunctionStore,
	block: CoreBlockId,
	merged: CoreBlockId,
): boolean {
	for (const instruction of fn.bodyInstructionIds(block)) {
		const start = fn.kernel.instructionResultStart(instruction);
		for (let index = 0; index < fn.kernel.instructionResultCount(instruction); index++) {
			const value = fn.kernel.resultAt(start + index);
			if (fn.kernel.valueHandlerUseCount(value) !== 0) return true;
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				const user = fn.instructionBlock(fn.kernel.useInstruction(use));
				if (user !== block && user !== merged) return true;
			}
		}
	}
	return false;
}

function absorbableUnderHandler(
	fn: CoreFunctionStore,
	predecessor: CoreBlockId,
	target: CoreBlockId,
): boolean {
	if (sameHandler(fn, predecessor, target)) return true;
	if (fn.kernel.blockHandlerBlock(target) !== undefined) return false;
	const terminatorKind = fn.instructionKind(fn.blockTerminator(target));
	if (terminatorKind !== "jump" && terminatorKind !== "branch") return false;
	for (const instruction of fn.bodyInstructionIds(target)) {
		const effects =
			fn.instructionEffectRefinement(instruction)?.effects ??
			fn.registry.byId(fn.instructionOpcode(instruction)).effects;
		if (
			effects.mayThrow ||
			effects.maySuspend ||
			effects.mayGc ||
			effects.callsUserCode ||
			effects.reads.length > 0 ||
			effects.writes.length > 0
		)
			return false;
	}
	return true;
}

function useOutsideBlock(
	fn: CoreFunctionStore,
	value: CoreValueId,
	block: CoreBlockId,
): boolean {
	if (fn.kernel.valueHandlerUseCount(value) > 0) return true;
	let use = fn.kernel.valueFirstUse(value);
	while (use >= 0) {
		const next = fn.kernel.useNext(use);
		if (
			fn.kernel.useLive(use) !== 0 &&
			fn.instructionBlock(fn.kernel.useInstruction(use)) !== block
		) {
			return true;
		}
		use = next;
	}
	return false;
}

function addUseInstructions(
	fn: CoreFunctionStore,
	value: CoreValueId,
	instructions: Set<CoreInstructionId>,
): void {
	let use = fn.kernel.valueFirstUse(value);
	while (use >= 0) {
		const next = fn.kernel.useNext(use);
		if (fn.kernel.useLive(use) !== 0) {
			instructions.add(fn.kernel.useInstruction(use));
		}
		use = next;
	}
}

function copyTerminatorEdge(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	offset: number,
): CoreEdge {
	const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
	const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
	if (offset < 0 || offset >= edgeCount) {
		throw new Error(`Malformed Core ${fn.instructionKind(instruction)} edges`);
	}
	const row = edgeStart + offset;
	const argumentStart = fn.kernel.terminatorEdgeArgumentStart(row);
	const argumentCount = fn.kernel.terminatorEdgeArgumentCount(row);
	return {
		block: fn.kernel.terminatorEdgeBlock(row),
		arguments: Array.from({ length: argumentCount }, (_, index) =>
			fn.kernel.operandAt(argumentStart + index),
		),
	};
}

function terminatorInputForEdit(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreTerminatorInput {
	const kind = fn.instructionKind(instruction);
	const firstOperand = instructionOperand(fn, instruction, 0);
	switch (kind) {
		case "jump":
			return { kind, edge: copyTerminatorEdge(fn, instruction, 0) };
		case "branch":
			if (firstOperand === undefined) throw new Error("Malformed Core branch operands");
			return {
				kind,
				condition: firstOperand,
				consequent: copyTerminatorEdge(fn, instruction, 0),
				alternate: copyTerminatorEdge(fn, instruction, 1),
			};
		case "guard": {
			const fact = fn.kernel.terminatorFact(instruction);
			if (firstOperand === undefined || fact === undefined) {
				throw new Error("Malformed Core guard");
			}
			return {
				kind,
				condition: firstOperand,
				fact,
				success: copyTerminatorEdge(fn, instruction, 0),
				fallback: copyTerminatorEdge(fn, instruction, 1),
			};
		}
		case "switch": {
			if (firstOperand === undefined) throw new Error("Malformed Core switch operands");
			const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
			const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
			return {
				kind,
				discriminant: firstOperand,
				cases: Array.from({ length: edgeCount - 1 }, (_, offset) => {
					const value = fn.kernel.terminatorEdgeCaseValue(edgeStart + offset);
					if (value === undefined)
						throw new Error(`Malformed Core switch case ${offset}`);
					return { value, edge: copyTerminatorEdge(fn, instruction, offset) };
				}),
				default: copyTerminatorEdge(fn, instruction, edgeCount - 1),
			};
		}
		case "return":
		case "throw":
			if (firstOperand === undefined) throw new Error(`Malformed Core ${kind} operands`);
			return { kind, value: firstOperand };
		case "unreachable":
			return { kind };
		case "operation":
			throw new Error(`Core instruction ${instruction} is not a terminator`);
	}
}

type LocalConstant =
	| { readonly kind: "undefined" }
	| { readonly kind: "null" }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "string"; readonly index: number };

const BUILTIN_OPERATIONS_BY_KEY = new Map<
	string,
	Array<(typeof builtinOperations)[number]>
>();
for (const operation of builtinOperations) {
	const candidates = BUILTIN_OPERATIONS_BY_KEY.get(operation.key) ?? [];
	candidates.push(operation);
	BUILTIN_OPERATIONS_BY_KEY.set(operation.key, candidates);
}

const MATH_UNARY_OPERATIONS: ReadonlySet<string> = new Set(
	mathUnaryOperationKeys.map(([operation]) => operation),
);

function constantForValue(
	fn: CoreFunctionStore,
	value: CoreValueId,
): LocalConstant | undefined {
	const instruction = definingInstruction(fn, value);
	if (instruction === undefined) return undefined;
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const attributes = fn.instructionAttributes(instruction);
	switch (fn.instructionOpcodeName(instruction)) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof attributes.value === "boolean"
				? { kind: "boolean", value: attributes.value }
				: undefined;
		case "createNumber":
		case "createF64":
			return typeof attributes.value === "number"
				? { kind: "number", value: attributes.value }
				: undefined;
		case "createString":
			return typeof attributes.stringIndex === "number"
				? { kind: "string", index: attributes.stringIndex }
				: undefined;
		default:
			return undefined;
	}
}

function valueHasUses(fn: CoreFunctionStore, value: CoreValueId): boolean {
	return fn.valueUseCount(value) + fn.kernel.valueHandlerUseCount(value) > 0;
}

function constantsAreInterchangeable(
	program: CoreProgram,
	left: LocalConstant,
	right: LocalConstant,
): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "undefined":
		case "null":
			return true;
		case "boolean":
			return left.value === (right as { readonly value: boolean }).value;
		case "number":
			return Object.is(left.value, (right as { readonly value: number }).value);
		case "string":
			return (
				decodeString(program, left.index) ===
				decodeString(program, (right as { readonly index: number }).index)
			);
	}
}

function insertConstant(
	editor: CoreEditor,
	fn: CoreFunctionStore,
	block: CoreBlockId,
	constant: LocalConstant,
	representation: CoreRepresentation,
): CoreValueId {
	const opcode =
		constant.kind === "undefined"
			? "createUndefined"
			: constant.kind === "null"
				? "createNull"
				: constant.kind === "boolean"
					? "createBoolean"
					: constant.kind === "string"
						? "createString"
						: representation === "boxed"
							? "createNumber"
							: "createF64";
	const attributes =
		constant.kind === "boolean" || constant.kind === "number"
			? { value: constant.value }
			: constant.kind === "string"
				? { stringIndex: constant.index }
				: {};
	let before = fn.blockTerminator(block);
	for (const instruction of fn.bodyInstructionIds(block)) {
		before = instruction;
		break;
	}
	return editor.insertInstruction(block, before, opcode, [], {
		attributes,
		outputRepresentations: [representation],
	}).outputs[0]!;
}

function rewriteEdges(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	rewrite: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorInput {
	const payload = terminatorInputForEdit(fn, instruction);
	switch (payload.kind) {
		case "jump":
			return { kind: "jump", edge: rewrite(payload.edge) };
		case "branch":
			return {
				kind: "branch",
				condition: payload.condition,
				consequent: rewrite(payload.consequent),
				alternate: rewrite(payload.alternate),
			};
		case "guard":
			return {
				kind: "guard",
				condition: payload.condition,
				fact: payload.fact,
				success: rewrite(payload.success),
				fallback: rewrite(payload.fallback),
			};
		case "switch":
			return {
				kind: "switch",
				discriminant: payload.discriminant,
				cases: payload.cases.map(({ value, edge }) => ({
					value,
					edge: rewrite(edge),
				})),
				default: rewrite(payload.default),
			};
		case "return":
			return { kind: "return", value: payload.value };
		case "throw":
			return { kind: "throw", value: payload.value };
		case "unreachable":
			return { kind: "unreachable" };
	}
}

function origin(
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueId {
	return environment.get(value) ?? value;
}

function enterEdge(
	fn: CoreFunctionStore,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): {
	readonly block: CoreBlockId;
	readonly environment: ReadonlyMap<CoreValueId, CoreValueId>;
} {
	if (!fn.isBlockLive(edge.block))
		throw new Error(`Unknown Core edge target ${edge.block}`);
	const next = new Map<CoreValueId, CoreValueId>();
	const parameterStart = fn.kernel.blockParameterStart(edge.block);
	const parameterCount = fn.kernel.blockParameterCount(edge.block);
	for (let index = 0; index < parameterCount; index++) {
		next.set(
			fn.kernel.blockParameterValue(parameterStart + index),
			origin(edge.arguments[index]!, environment),
		);
	}
	return { block: edge.block, environment: next };
}

function exactNumberTest(
	fn: CoreFunctionStore,
	block: CoreBlockId,
	condition: CoreValueId,
	subject: CoreValueId,
	value: number,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
	instructions: ReadonlyArray<CoreInstructionId>,
): boolean {
	if (instructions.length !== 2) return false;
	const [constant, compare] = instructions;
	if (constant === undefined || compare === undefined) return false;
	const constantResult = instructionResult(fn, constant, 0);
	const compareResult = instructionResult(fn, compare, 0);
	const compareLeft = instructionOperand(fn, compare, 0);
	const compareRight = instructionOperand(fn, compare, 1);
	return (
		fn.instructionOpcodeName(constant) === "createNumber" &&
		fn.instructionAttributes(constant).value === value &&
		fn.kernel.instructionResultCount(constant) === 1 &&
		fn.instructionOpcodeName(compare) === "binary" &&
		fn.instructionAttributes(compare).operator === "===" &&
		fn.kernel.instructionResultCount(compare) === 1 &&
		compareResult === condition &&
		fn.kernel.instructionOperandCount(compare) === 2 &&
		compareLeft !== undefined &&
		origin(compareLeft, environment) === subject &&
		compareRight === constantResult &&
		fn.instructionKind(fn.blockTerminator(block)) === "branch"
	);
}

function edgeTerminatesWith(
	fn: CoreFunctionStore,
	edge: CoreEdge,
	kind: "return" | "throw",
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	const target = enterEdge(fn, edge, environment);
	const terminator = fn.blockTerminator(target.block);
	return (
		!fn.hasBodyInstructions(target.block) &&
		fn.instructionKind(terminator) === kind &&
		instructionOperand(fn, terminator, 0) !== undefined &&
		origin(instructionOperand(fn, terminator, 0)!, target.environment) === value
	);
}

function edgeReturnsUndefined(
	fn: CoreFunctionStore,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	let state = enterEdge(fn, edge, environment);
	const visited = new Set<CoreBlockId>();
	for (;;) {
		const instructions = [...fn.bodyInstructionIds(state.block)];
		const terminator = fn.blockTerminator(state.block);
		if (instructions.length !== 0 || fn.instructionKind(terminator) !== "jump") break;
		if (visited.has(state.block)) return false;
		visited.add(state.block);
		state = enterEdge(fn, copyTerminatorEdge(fn, terminator, 0), state.environment);
	}
	const instructions = [...fn.bodyInstructionIds(state.block)];
	const [created] = instructions;
	if (created === undefined) return false;
	const createdResult = instructionResult(fn, created, 0);
	const terminator = fn.blockTerminator(state.block);
	return (
		instructions.length === 1 &&
		fn.instructionOpcodeName(created) === "createUndefined" &&
		fn.kernel.instructionResultCount(created) === 1 &&
		fn.instructionKind(terminator) === "return" &&
		instructionOperand(fn, terminator, 0) === createdResult
	);
}

const annotateTerminalYieldSites: CoreFunctionPass = {
	name: "annotate-terminal-yield-sites",
	stage: "canonicalize",
	requiredAnalyses: [],
	wakesOn: ["body", "cfg", "exceptionFlow"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		const fn = program.function(item.function);
		if (
			!fn.isGenerator ||
			fn.isAsync ||
			[...fn.blockIds()].some(
				(block) =>
					fn.kernel.blockHandlerBlock(block) !== undefined ||
					blockHasExceptionParameter(fn, block),
			)
		) {
			return undefined;
		}
		const terminal: Array<CoreInstructionId> = [];
		for (const block of fn.blockIds()) {
			const terminator = fn.blockTerminator(block);
			if (fn.instructionKind(terminator) !== "branch") continue;
			const condition = instructionOperand(fn, terminator, 0);
			if (condition === undefined) continue;
			const consequent = copyTerminatorEdge(fn, terminator, 0);
			const alternate = copyTerminatorEdge(fn, terminator, 1);
			const instructions = [...fn.bodyInstructionIds(block)];
			for (const [index, instruction] of instructions.entries()) {
				if (fn.instructionOpcodeName(instruction) !== "yield") continue;
				const yieldedValue = instructionResult(fn, instruction, 0);
				const resumeMode = instructionResult(fn, instruction, 1);
				if (
					yieldedValue === undefined ||
					resumeMode === undefined ||
					fn.kernel.instructionOperandCount(instruction) !== 1
				) {
					continue;
				}
				const rootEnvironment = new Map<CoreValueId, CoreValueId>();
				if (
					!exactNumberTest(
						fn,
						block,
						condition,
						resumeMode,
						1,
						rootEnvironment,
						instructions.slice(index + 1),
					) ||
					!edgeTerminatesWith(fn, consequent, "throw", yieldedValue, rootEnvironment)
				) {
					continue;
				}
				const resumed = enterEdge(fn, alternate, rootEnvironment);
				const resumedTerminator = fn.blockTerminator(resumed.block);
				if (fn.instructionKind(resumedTerminator) !== "branch") continue;
				const resumedCondition = instructionOperand(fn, resumedTerminator, 0);
				if (resumedCondition === undefined) continue;
				const resumedConsequent = copyTerminatorEdge(fn, resumedTerminator, 0);
				const resumedAlternate = copyTerminatorEdge(fn, resumedTerminator, 1);
				if (
					!exactNumberTest(
						fn,
						resumed.block,
						resumedCondition,
						resumeMode,
						2,
						resumed.environment,
						[...fn.bodyInstructionIds(resumed.block)],
					) ||
					!edgeTerminatesWith(
						fn,
						resumedConsequent,
						"return",
						yieldedValue,
						resumed.environment,
					) ||
					!edgeReturnsUndefined(fn, resumedAlternate, resumed.environment)
				) {
					continue;
				}
				if (fn.instructionAttributes(instruction).terminal !== true) {
					terminal.push(instruction);
				}
			}
		}
		if (terminal.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const instruction of terminal) {
			editor.replaceInstruction(
				instruction,
				"yield",
				copyInstructionOperands(fn, instruction),
				{
					attributes: {
						...fn.instructionAttributes(instruction),
						terminal: true,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
				},
			);
		}
		return editor.commit();
	},
};

function decodeString(program: CoreProgram, index: number): string | undefined {
	return program.stringConstants[index] === undefined
		? undefined
		: program.stringConstantText(index);
}

// Namespace names rank guesses; they do not certify mutable property values.
function builtinNamespaceHint(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	root: (value: CoreValueId) => CoreValueId,
	budget = 4,
): string | undefined {
	if (budget === 0) return undefined;
	const definition = definingInstruction(fn, root(value));
	if (definition === undefined) return undefined;
	const opcode = fn.instructionOpcodeName(definition);
	const attributes = fn.instructionAttributes(definition);
	if (opcode === "loadIntrinsic")
		return typeof attributes.intrinsic === "string" ? attributes.intrinsic : undefined;
	let index: unknown;
	if (opcode === "loadGlobalProperty") index = attributes.nameStringIndex;
	else if (opcode === "loadPropertyStatic") {
		const base = instructionOperand(fn, definition, 0);
		if (
			base === undefined ||
			builtinNamespaceHint(program, fn, base, root, budget - 1) !== "globalThis"
		)
			return undefined;
		index = attributes.stringIndex;
	}
	if (typeof index !== "number") return undefined;
	const name = decodeString(program, index);
	return name === undefined
		? undefined
		: (primordialNode(name) ?? primordialNode(`globalThis.${name}`))?.[0];
}

function builtinSourceSite(
	program: CoreProgram,
	fn: CoreFunctionStore,
	positionId: number | undefined,
	operation: string,
): ReturnType<typeof sourceSiteId> | undefined {
	if (positionId === undefined) return undefined;
	const position = program.sourcePositions[positionId];
	if (position === undefined) return undefined;
	const inlinedFunction =
		position.inlinedFunctionIndex === undefined
			? undefined
			: coreFunctionId(position.inlinedFunctionIndex);
	const owner =
		inlinedFunction === undefined
			? fn
			: program.hasFunction(inlinedFunction)
				? program.function(inlinedFunction)
				: undefined;
	return owner === undefined
		? undefined
		: sourceSiteId(
				owner.metadata.sourcePath,
				position.line,
				position.column,
				`builtin-call:${operation}`,
			);
}

function exactBuiltinReceiver(
	fn: CoreFunctionStore,
	value: CoreValueId,
	owner: string,
	receiverProof: NonNullable<
		ReturnType<typeof exactBuiltinCallDescriptor>
	>["receiverProof"],
): boolean {
	const instruction = definingInstruction(fn, value);
	if (instruction === undefined) return false;
	const constant = constantForValue(fn, value);
	switch (receiverProof) {
		case "intrinsic-object":
			return (
				fn.instructionOpcodeName(instruction) === "loadIntrinsic" &&
				fn.instructionAttributes(instruction).intrinsic === owner
			);
		case "primitive-boolean":
			return constant?.kind === "boolean" || fn.valueRepresentation(value) === "boolean";
		case "primitive-number":
			return (
				constant?.kind === "number" ||
				fn.valueRepresentation(value) === "f64" ||
				fn.valueRepresentation(value) === "i32"
			);
		case "primitive-string":
			return constant?.kind === "string";
		case "fresh-array":
		case "fresh-map":
		case "fresh-set":
		case "fresh-weak-map":
		case "fresh-weak-set":
			return false;
	}
	return false;
}

const rewriteExactBuiltinCalls: CoreFunctionPass = {
	name: "rewrite-exact-builtin-calls",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["call", "callKnown"],
	requiredAnalyses: [CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "facts", "representations"],
	changes: { ...LOCAL_CHANGES, representations: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		const fn = program.function(item.function);
		const calls = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				(fn.instructionOpcodeName(instruction) === "call" ||
					fn.instructionOpcodeName(instruction) === "callKnown"),
		);
		if (calls.length === 0) return undefined;
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		const edgeUses = coreValueControlFlowUseMask(fn);
		let kinds: CoreValueKindAnalysis | undefined;
		let editor: CoreEditor | undefined;
		const canScalarizeNumber = (value: CoreValueId) => {
			if (fn.valueRepresentation(value) === "f64") return true;
			if (edgeUses[value] !== 0) return false;
			const scalar = (kinds ??= context.analysis(
				CORE_LOCAL_VALUE_KIND_ANALYSIS,
			)).scalarKind(value);
			const definition = definingInstruction(fn, value);
			const operation =
				definition === undefined
					? undefined
					: fn.instructionAttributes(definition).operation;
			return (
				scalar === "number" &&
				definition !== undefined &&
				(["createNumber", "createF64"].includes(fn.instructionOpcodeName(definition)) ||
					(fn.instructionOpcodeName(definition) === "unary" &&
						fn.instructionAttributes(definition).operator === "+") ||
					(fn.instructionOpcodeName(definition) === "callKnown" &&
						!fn.instructionAttributes(definition).construct &&
						typeof operation === "string" &&
						builtinNormalResultKinds(operation) === COMPILER_VALUE_KIND_NUMBER))
			);
		};
		for (const instruction of calls) {
			if (!fn.isInstructionLive(instruction)) continue;
			if (fn.instructionOpcodeName(instruction) === "callKnown") {
				const attributes = fn.instructionAttributes(instruction);
				if (attributes.construct || attributes.argumentMode !== undefined) continue;
				const operation = attributes.operation;
				if (typeof operation !== "string") continue;
				if (builtinNormalResultKinds(operation) === COMPILER_VALUE_KIND_STRING) {
					const result = fn.kernel.resultAt(
						fn.kernel.instructionResultStart(instruction),
					);
					if (fn.valueRepresentation(result) === "boxed" && edgeUses[result] === 0) {
						editor ??= CoreEditor.open(program, item.function);
						editor.setValueRepresentation(result, "string");
					}
				}
				const stringSearch = [
					"String.prototype.indexOf",
					"String.prototype.lastIndexOf",
					"String.prototype.includes",
					"String.prototype.startsWith",
					"String.prototype.endsWith",
				].includes(operation);
				if (
					[
						"String.prototype.charCodeAt",
						"String.prototype.charAt",
						"String.prototype.at",
						"String.prototype.codePointAt",
					].includes(operation) ||
					stringSearch
				) {
					const receiver = instructionOperand(fn, instruction, 0);
					const definition =
						receiver === undefined ? undefined : definingInstruction(fn, receiver);
					if (
						receiver !== undefined &&
						edgeUses[receiver] === 0 &&
						fn.valueRepresentation(receiver) === "boxed" &&
						definition !== undefined &&
						fn.instructionOpcodeName(definition) === "binary" &&
						fn.instructionAttributes(definition).operator === "+" &&
						(kinds ??= context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS)).scalarKind(
							receiver,
						) === "string"
					) {
						editor ??= CoreEditor.open(program, item.function);
						editor.setValueRepresentation(receiver, "string");
					}
					const position = instructionOperand(fn, instruction, stringSearch ? 2 : 1);
					if (
						position !== undefined &&
						fn.valueRepresentation(position) !== "f64" &&
						canScalarizeNumber(position)
					) {
						editor ??= CoreEditor.open(program, item.function);
						editor.setValueRepresentation(position, "f64");
					}
				}
				const stringRange = [
					"String.prototype.slice",
					"String.prototype.substring",
					"String.prototype.substr",
				].includes(operation);
				if (
					stringRange ||
					operation === "String.prototype.repeat" ||
					operation === "String.prototype.padStart" ||
					operation === "String.prototype.padEnd" ||
					operation === "String.fromCharCode" ||
					operation === "String.fromCodePoint"
				) {
					const arguments_ = copyInstructionOperands(fn, instruction).slice(1);
					const count = stringRange
						? 2
						: operation.startsWith("String.prototype.")
							? 1
							: arguments_.length;
					for (const argument of arguments_.slice(0, count)) {
						if (
							fn.valueRepresentation(argument) !== "f64" &&
							canScalarizeNumber(argument)
						) {
							editor ??= CoreEditor.open(program, item.function);
							editor.setValueRepresentation(argument, "f64");
						}
					}
				}
				const numberPredicate = [
					"Number.isNaN",
					"Number.isFinite",
					"Number.isInteger",
					"Number.isSafeInteger",
				].includes(operation);
				if (
					numberPredicate ||
					[
						"Number.prototype.toString",
						"Number.prototype.toFixed",
						"Number.prototype.toExponential",
						"Number.prototype.toPrecision",
					].includes(operation)
				) {
					const receiver = instructionOperand(fn, instruction, numberPredicate ? 1 : 0);
					if (
						receiver !== undefined &&
						fn.valueRepresentation(receiver) !== "f64" &&
						canScalarizeNumber(receiver)
					) {
						editor ??= CoreEditor.open(program, item.function);
						editor.setValueRepresentation(receiver, "f64");
					}
					continue;
				}
				if (operation.startsWith("Math.")) {
					for (const argument of copyInstructionOperands(fn, instruction).slice(1)) {
						if (
							fn.valueRepresentation(argument) !== "f64" &&
							fn.valueRepresentation(argument) !== "i32" &&
							canScalarizeNumber(argument)
						) {
							editor ??= CoreEditor.open(program, item.function);
							editor.setValueRepresentation(argument, "f64");
						}
					}
				}
				const descriptor = builtinOperations.find(({ id }) => id === operation);
				const numericOpcode = MATH_UNARY_OPERATIONS.has(operation)
					? "mathUnaryNumber"
					: operation === "Math.min" || operation === "Math.max"
						? "mathBinaryNumber"
						: undefined;
				if (descriptor === undefined || numericOpcode === undefined) continue;
				const arguments_ = copyInstructionOperands(fn, instruction).slice(1);
				if (
					descriptor.nativeNumberArity !== arguments_.length ||
					fn.kernel.instructionResultCount(instruction) !== 1 ||
					!arguments_.every(canScalarizeNumber)
				)
					continue;
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(instruction, numericOpcode, arguments_, {
					attributes: {
						operation,
						worldAssumptions: attributes.worldAssumptions,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				for (const argument of arguments_) editor.setValueRepresentation(argument, "f64");
				const result = instructionResult(fn, instruction, 0)!;
				if (edgeUses[result] === 0) editor.setValueRepresentation(result, "f64");
				continue;
			}
			let existingKnownBuiltinCall =
				fn.instructionAttributes(instruction).knownBuiltinCall;
			const previousBuiltinOperation = (
				existingKnownBuiltinCall as { readonly operation?: unknown } | undefined
			)?.operation;
			const inputs = copyInstructionOperands(fn, instruction);
			const [callee, receiver] = inputs;
			if (callee === undefined || receiver === undefined) continue;
			const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
			const receiverRoot = root(receiver);
			const property = definingInstruction(fn, root(callee));
			if (property === undefined) continue;
			const propertyReceiver = instructionOperand(fn, property, 0);
			const globalCall = fn.instructionOpcodeName(property) === "loadGlobalProperty";
			if (
				!globalCall &&
				(fn.instructionOpcodeName(property) !== "loadPropertyStatic" ||
					propertyReceiver === undefined ||
					root(propertyReceiver) !== receiverRoot)
			) {
				continue;
			}
			const stringIndex =
				fn.instructionAttributes(property)[
					globalCall ? "nameStringIndex" : "stringIndex"
				];
			if (typeof stringIndex !== "number") continue;
			const key = decodeString(program, stringIndex);
			const namedCandidates =
				key === undefined
					? []
					: (BUILTIN_OPERATIONS_BY_KEY.get(key) ?? []).filter(
							(candidate) => !globalCall || candidate.owner === "globalThis",
						);
			const namespace =
				!globalCall && namedCandidates.some((candidate) => candidate.receiver === "none")
					? builtinNamespaceHint(program, fn, receiverRoot, root)
					: undefined;
			const namespaceCompatible = (candidate: (typeof builtinOperations)[number]) =>
				namespace === undefined ||
				candidate.receiver !== "none" ||
				candidate.owner === namespace;
			const candidates = namedCandidates.filter(namespaceCompatible);
			const previousDescriptor =
				typeof previousBuiltinOperation === "string"
					? builtinOperationDescriptor(previousBuiltinOperation)
					: undefined;
			if (
				previousDescriptor !== undefined &&
				(!namespaceCompatible(previousDescriptor) || previousDescriptor.key !== key)
			) {
				const attributes = { ...fn.instructionAttributes(instruction) };
				delete attributes.knownBuiltinCall;
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(instruction, "call", inputs, {
					attributes,
					sourcePosition: fn.instructionSourcePosition(instruction),
					effectRefinement: fn.instructionEffectRefinement(instruction),
				});
				existingKnownBuiltinCall = undefined;
			}
			const booleanReceiver = () =>
				(kinds ??= context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS)).scalarKind(
					receiverRoot,
				) === "boolean";
			const ownerMatches = candidates.filter((candidate) => {
				if (candidate.receiver === "boolean") return booleanReceiver();
				const exact = exactBuiltinCallDescriptor(candidate.id);
				return (
					(exact !== undefined &&
						exactBuiltinReceiver(
							fn,
							receiverRoot,
							candidate.owner,
							exact.receiverProof,
						)) ||
					constructedCollectionReceiver(fn, root, receiverRoot, candidate.receiver)
				);
			});
			const callbackFamily = candidates.find(
				(candidate) => candidate.guardedCallees !== undefined,
			);
			const compatibleCollectionCollision =
				candidates.length > 1 &&
				candidates.every((candidate) =>
					candidate.lowerings.includes("guarded-native-collection"),
				);
			const descriptor =
				candidates.length === 1
					? candidates[0]
					: ownerMatches.length === 1
						? ownerMatches[0]
						: callbackFamily !== undefined
							? callbackFamily
							: compatibleCollectionCollision
								? candidates[0]
								: undefined;
			if (descriptor === undefined) continue;
			if (descriptor.receiver === "boolean" && !booleanReceiver()) continue;
			const exact = exactBuiltinCallDescriptor(descriptor.id);
			const sharedIdentity = compilationContext.facts.builtinIdentities.get(
				descriptor.id,
			);
			const propertyResult = instructionResult(fn, property, 0);
			const arguments_ = inputs.slice(2);
			const receiverInstruction = definingInstruction(fn, receiverRoot);
			const exactIntrinsicReceiver =
				receiverInstruction !== undefined &&
				fn.instructionOpcodeName(receiverInstruction) === "loadIntrinsic" &&
				fn.instructionAttributes(receiverInstruction).intrinsic === descriptor.owner;
			const numericOpcode = MATH_UNARY_OPERATIONS.has(descriptor.id)
				? "mathUnaryNumber"
				: descriptor.id === "Math.min" || descriptor.id === "Math.max"
					? "mathBinaryNumber"
					: undefined;
			const numericRewrite =
				numericOpcode !== undefined &&
				exactIntrinsicReceiver &&
				compilerFactIsWorldInvariant(sharedIdentity) &&
				sharedIdentity.value === descriptor.id &&
				descriptor.nativeNumberArity === arguments_.length &&
				arguments_.every(canScalarizeNumber) &&
				fn.kernel.instructionResultCount(instruction) === 1 &&
				fn.kernel.instructionResultCount(property) === 1 &&
				propertyResult !== undefined &&
				fn.valueUseCount(propertyResult) +
					fn.kernel.valueHandlerUseCount(propertyResult) ===
					1
					? numericOpcode
					: undefined;
			const exactRewrite =
				exact !== undefined &&
				exactBuiltinReceiver(fn, receiverRoot, descriptor.owner, exact.receiverProof) &&
				compilerFactIsWorldInvariant(sharedIdentity) &&
				sharedIdentity.value === descriptor.id &&
				fn.kernel.instructionResultCount(property) === 1 &&
				propertyResult === callee &&
				fn.valueUseCount(callee) + fn.kernel.valueHandlerUseCount(callee) === 1
					? exact
					: undefined;
			const site = builtinSourceSite(
				program,
				fn,
				fn.instructionSourcePosition(instruction),
				descriptor.id,
			);
			const obligationId = `generic-call:${site ?? `${fn.id}:${instruction}`}`;
			const obligations =
				exactRewrite === undefined
					? [
							{
								kind: "fallback" as const,
								id: obligationId,
								cause: "loaded-callee" as const,
							},
							...(descriptor.realm === "realm-object-identity"
								? ([{ kind: "fallback", id: obligationId, cause: "realm" }] as const)
								: []),
						]
					: [
							authorityFallback(obligationId, {
								kind: "world",
								fact: "primordials.locked",
							}),
						];
			const identity =
				sharedIdentity?.kind === "known"
					? knownFact(
							sharedIdentity.value,
							normalizeFactRequirements({
								scope:
									site === undefined
										? { kind: "function" as const, id: fn.id }
										: { kind: "site" as const, id: site },
								dependencies: sharedIdentity.proof.dependencies,
								obligations: [...sharedIdentity.proof.obligations, ...obligations],
								origin: `guarded-builtin-site-analysis:${sharedIdentity.proof.origin}`,
							}),
						)
					: (sharedIdentity ?? {
							kind: "unknown" as const,
							reason: "not-analyzed" as const,
						});
			const knownBuiltinCall: KnownBuiltinCall = {
				operation: descriptor.id,
				identity,
				semantics:
					identity.kind === "known"
						? knownFact(
								{
									effects: descriptor.effects,
									result: descriptor.result,
									lowerings: descriptor.lowerings,
								},
								{
									...identity.proof,
									origin: `builtin-registry-semantics:${descriptor.id}`,
								},
							)
						: identity,
				...(site === undefined ? {} : { sourceSite: site }),
			};
			if (
				numericRewrite === undefined &&
				exactRewrite === undefined &&
				existingKnownBuiltinCall !== undefined &&
				!(
					descriptor.callback !== undefined &&
					ownerMatches.length === 1 &&
					typeof previousBuiltinOperation === "string" &&
					builtinOperationDescriptor(previousBuiltinOperation)?.guardedCallees !==
						undefined
				)
			) {
				continue;
			}
			editor ??= CoreEditor.open(program, item.function);
			if (numericRewrite !== undefined) {
				editor.replaceInstruction(instruction, numericRewrite, arguments_, {
					attributes: {
						operation: descriptor.id,
						worldAssumptions: {
							...builtinWorldAssumptions(descriptor.id, "exact-builtin-proof"),
						},
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				for (const argument of arguments_) editor.setValueRepresentation(argument, "f64");
				const result = instructionResult(fn, instruction, 0)!;
				if (edgeUses[result] === 0) editor.setValueRepresentation(result, "f64");
				editor.removeInstruction(property);
			} else if (exactRewrite === undefined) {
				editor.replaceInstruction(instruction, "call", inputs, {
					attributes: {
						...fn.instructionAttributes(instruction),
						knownBuiltinCall: knownBuiltinCall as unknown as CoreAttributeValue,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
					effectRefinement: fn.instructionEffectRefinement(instruction),
				});
			} else {
				const forwarded =
					exactRewrite.forwardedArgumentLimit === undefined
						? arguments_
						: arguments_.slice(0, exactRewrite.forwardedArgumentLimit);
				editor.replaceInstruction(instruction, "callKnown", [receiver, ...forwarded], {
					attributes: {
						...(typeof fn.instructionAttributes(instruction).sourceCall === "number"
							? { sourceCall: fn.instructionAttributes(instruction).sourceCall! }
							: {}),
						operation: exactRewrite.id,
						specialized: exactRewrite.id,
						worldAssumptions: {
							...builtinWorldAssumptions(exactRewrite.id, "exact-builtin-proof"),
						},
						knownBuiltinCall: knownBuiltinCall as unknown as CoreAttributeValue,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				editor.removeInstruction(property);
			}
		}
		return editor?.commit();
	},
};

const foldValueKindObservations: CoreFunctionPass = {
	name: "value-kind-observation-folding",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["unary", "binary", "typeofCompare", "callKnown"],
	candidates: {
		dependencies: ["body"],
		opcodes: ["unary", "binary", "typeofCompare", "callKnown"],
		matches(fn, instruction, opcode) {
			if (coreValueKindObservationCandidate(fn, instruction, opcode)) return true;
			const key = coreWeakCollectionKey(fn, instruction);
			return key !== undefined && key.result !== "mutator";
		},
	},
	requiredAnalyses: [
		CORE_CONDITIONAL_VALUE_KIND_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
		CORE_LOOP_INDUCTION_ANALYSIS,
		CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	],
	wakesOn: [
		"body",
		"cfg",
		"exceptionFlow",
		"memoryEffects",
		"normalResults",
		"representations",
	],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		let kinds: CoreValueKindAnalysis | undefined;
		const valueKinds = () => (kinds ??= context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS));
		let conditional: CoreConditionalValueKinds | undefined;
		const kindMask = (value: CoreValueId, block: CoreBlockId) => {
			const mask = valueKinds().kindMask(value);
			if ((mask & (mask - 1)) === 0) return mask;
			return (conditional ??= context.analysis(
				CORE_CONDITIONAL_VALUE_KIND_ANALYSIS,
			)).kindMask(value, block);
		};
		const replacements: Array<
			| { readonly instruction: CoreInstructionId; readonly result: boolean }
			| {
					readonly instruction: CoreInstructionId;
					readonly normal: CoreWeakCollectionNormalConstant;
			  }
		> = [];
		const integerRange = (value: CoreValueId, consumer: CoreInstructionId) =>
			context
				.analysis(CORE_LOOP_INDUCTION_ANALYSIS)
				.range(value, fn.instructionBlock(consumer)) ??
			(valueKinds().exactScalar(value) === "int32" ? COMPILER_INT32_RANGE : undefined);
		for (const instruction of context.instructions()) {
			if (
				fn.instructionOpcodeName(instruction) === "callKnown" &&
				fn.kernel.instructionResultCount(instruction) === 1
			) {
				const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
				const normal =
					fn.valueUseCount(output) + fn.kernel.valueHandlerUseCount(output) === 0
						? undefined
						: coreWeakCollectionNormalConstant(fn, instruction, (value) =>
								kindMask(value, fn.instructionBlock(instruction)),
							);
				if (normal !== undefined) {
					replacements.push({ instruction, normal });
					continue;
				}
			}
			const result = coreValueKindObservation(
				program,
				fn,
				instruction,
				(value) => kindMask(value, fn.instructionBlock(instruction)),
				integerRange,
				undefined,
				(value) =>
					context
						.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS)
						.valueClasses.exactHeapBrand(value),
			);
			if (result !== undefined) replacements.push({ instruction, result });
		}
		if (replacements.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const replacement of replacements) {
			const { instruction } = replacement;
			if ("normal" in replacement) {
				const normal = replacement.normal;
				const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
				const constant = editor.insertInstruction(
					fn.instructionBlock(instruction),
					instruction,
					normal.kind === "undefined" ? "createUndefined" : "createBoolean",
					[],
					{
						attributes: normal.kind === "boolean" ? { value: normal.value } : {},
						sourcePosition: fn.instructionSourcePosition(instruction),
					},
				);
				editor.replaceValueUses(output, constant.outputs[0]!);
				continue;
			}
			editor.replaceInstruction(instruction, "createBoolean", [], {
				attributes: { value: replacement.result },
				sourcePosition: fn.instructionSourcePosition(instruction),
			});
		}
		return editor.commit();
	},
};

const foldPrimitiveCoercions: CoreFunctionPass = {
	name: "primitive-coercion-folding",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["requireCoercible", "toPropertyKey", "deleteProperty"],
	requiredAnalyses: [
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
		CORE_CONDITIONAL_VALUE_KIND_ANALYSIS,
		CORE_LOOP_INDUCTION_ANALYSIS,
	],
	wakesOn: [
		"body",
		"cfg",
		"exceptionFlow",
		"memoryEffects",
		"normalResults",
		"representations",
	],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		let conditional: CoreConditionalValueKinds | undefined;
		const kindMask = (value: CoreValueId, block: CoreBlockId) => {
			const mask = kinds.kindMask(value);
			if ((mask & (mask - 1)) === 0) return mask;
			return (conditional ??= context.analysis(
				CORE_CONDITIONAL_VALUE_KIND_ANALYSIS,
			)).kindMask(value, block);
		};
		const coercible = (value: CoreValueId, block: CoreBlockId): boolean => {
			const mask = kindMask(value, block);
			return (
				mask !== 0 &&
				(mask & (COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_UNDEFINED)) === 0
			);
		};
		let editor: CoreEditor | undefined;
		const instructionCapacity = fn.instructionCapacity;
		for (let id = 0; id < instructionCapacity; id++) {
			const instruction = coreInstructionId(id);
			if (
				!fn.isInstructionLive(instruction) ||
				fn.instructionKind(instruction) !== "operation"
			)
				continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "requireCoercible") {
				const value = instructionOperand(fn, instruction, 0);
				if (value === undefined || !coercible(value, fn.instructionBlock(instruction)))
					continue;
				editor ??= CoreEditor.open(program, item.function);
				editor.removeInstruction(instruction);
				continue;
			}
			if (opcode === "deleteProperty") {
				const base = instructionOperand(fn, instruction, 0)!;
				const key = instructionOperand(fn, instruction, 1)!;
				const block = fn.instructionBlock(instruction);
				if (!compilerValueKindsHaveEmptyPrimitiveWrappers(kindMask(base, block)))
					continue;
				editor ??= CoreEditor.open(program, item.function);
				if ((kindMask(key, block) & COMPILER_VALUE_KIND_OBJECT) !== 0)
					editor.insertInstruction(block, instruction, "toPropertyKey", [base, key], {
						sourcePosition: fn.instructionSourcePosition(instruction),
					});
				editor.replaceInstruction(instruction, "createBoolean", [], {
					attributes: { value: true },
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				continue;
			}
			if (opcode !== "toPropertyKey") continue;
			const base = instructionOperand(fn, instruction, 0);
			const key = instructionOperand(fn, instruction, 1);
			const result = instructionResult(fn, instruction, 0);
			if (base === undefined || key === undefined || result === undefined) continue;
			const indexRange = context
				.analysis(CORE_LOOP_INDUCTION_ANALYSIS)
				.range(key, fn.instructionBlock(instruction));
			const compactIndex =
				indexRange !== undefined &&
				indexRange.minimum >= 0 &&
				indexRange.maximum <= 0x7fff_ffff;
			if (
				!compactIndex &&
				!compilerValueKindMaskIsSubset(
					kindMask(key, fn.instructionBlock(instruction)),
					COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL,
				)
			)
				continue;
			editor ??= CoreEditor.open(program, item.function);
			if (!coercible(base, fn.instructionBlock(instruction))) {
				editor.insertInstruction(
					fn.instructionBlock(instruction),
					instruction,
					"requireCoercible",
					[base],
					{
						outputCount: 0,
						sourcePosition: fn.instructionSourcePosition(instruction),
					},
				);
			}
			editor.replaceValueUses(result, key);
			editor.removeInstruction(instruction);
		}
		return editor?.commit();
	},
};

function flippedComparison(operator: CoreAttributeValue): string | undefined {
	switch (operator) {
		case "<":
			return ">";
		case "<=":
			return ">=";
		case ">":
			return "<";
		case ">=":
			return "<=";
		default:
			return undefined;
	}
}

function constructedCollectionReceiver(
	fn: CoreFunctionStore,
	root: (value: CoreValueId) => CoreValueId,
	value: CoreValueId,
	receiver: string,
): boolean {
	if (receiver === "array") {
		const construction = definingInstruction(fn, value);
		return (
			construction !== undefined &&
			fn.instructionOpcodeName(construction) === "createArray"
		);
	}
	const expected =
		receiver === "map"
			? "Map"
			: receiver === "set"
				? "Set"
				: receiver === "weak-map"
					? "WeakMap"
					: receiver === "weak-set"
						? "WeakSet"
						: undefined;
	if (expected === undefined) return false;
	const construction = definingInstruction(fn, value);
	if (construction === undefined) return false;
	if (fn.instructionOpcodeName(construction) !== "construct") return false;
	const constructor = instructionOperand(fn, construction, 0);
	if (constructor === undefined) return false;
	const constructorDefinition = definingInstruction(fn, root(constructor));
	if (constructorDefinition === undefined) return false;
	return (
		fn.instructionOpcodeName(constructorDefinition) === "loadIntrinsic" &&
		fn.instructionAttributes(constructorDefinition).intrinsic === expected
	);
}

function hasNumericAlgebraicOpportunity(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "binary"
		)
			continue;
		const left = instructionOperand(fn, instruction, 0);
		const right = instructionOperand(fn, instruction, 1);
		if (left === undefined || right === undefined) continue;
		const operator = fn.instructionAttributes(instruction).operator;
		const leftConstant = constantForValue(fn, left);
		const rightConstant = constantForValue(fn, right);
		if (
			(operator === "+" &&
				rightConstant?.kind === "number" &&
				Object.is(rightConstant.value, -0)) ||
			(operator === "*" &&
				rightConstant?.kind === "number" &&
				rightConstant.value === 1) ||
			(operator === "&" &&
				((leftConstant?.kind === "number" && leftConstant.value === 0) ||
					(rightConstant?.kind === "number" && rightConstant.value === 0))) ||
			(left === right && (operator === "<" || operator === ">")) ||
			(flippedComparison(operator) !== undefined && leftConstant?.kind === "number")
		)
			return true;
	}
	return false;
}

const rewriteNumericIdentities: CoreFunctionPass = {
	name: "numeric-algebraic-simplification",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["binary"],
	admission: {
		predicate: "binary operator with a supported algebraic identity or normalization",
		hasOpportunity({ program, function: functionId }) {
			return hasNumericAlgebraicOpportunity(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "normalResults", "representations"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const numeric = (value: CoreValueId): boolean => {
			const kind = kinds.scalarKind(value);
			return kind === "number";
		};
		let editor: CoreEditor | undefined;
		const instructionCapacity = fn.instructionCapacity;
		for (let id = 0; id < instructionCapacity; id++) {
			const instruction = coreInstructionId(id);
			if (
				!fn.isInstructionLive(instruction) ||
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "binary"
			)
				continue;
			const left = instructionOperand(fn, instruction, 0);
			const right = instructionOperand(fn, instruction, 1);
			const result = instructionResult(fn, instruction, 0);
			if (
				left === undefined ||
				right === undefined ||
				result === undefined ||
				!numeric(left) ||
				!numeric(right)
			)
				continue;
			const operator = fn.instructionAttributes(instruction).operator;
			const leftConstant = constantForValue(fn, left);
			const rightConstant = constantForValue(fn, right);
			let replacement: CoreValueId | undefined;
			if (
				operator === "+" &&
				rightConstant?.kind === "number" &&
				Object.is(rightConstant.value, -0)
			) {
				replacement = left;
			} else if (
				operator === "*" &&
				rightConstant?.kind === "number" &&
				rightConstant.value === 1
			) {
				replacement = left;
			}
			if (
				replacement !== undefined &&
				fn.valueRepresentation(replacement) === fn.valueRepresentation(result)
			) {
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceValueUses(result, replacement);
				editor.removeInstruction(instruction);
				continue;
			}
			if (
				operator === "&" &&
				((leftConstant?.kind === "number" && leftConstant.value === 0) ||
					(rightConstant?.kind === "number" && rightConstant.value === 0))
			) {
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(instruction, "createNumber", [], {
					attributes: { value: 0 },
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				continue;
			}
			if (left === right && (operator === "<" || operator === ">")) {
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(instruction, "createBoolean", [], {
					attributes: { value: false },
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				continue;
			}
			const flipped = flippedComparison(operator);
			if (flipped !== undefined && leftConstant?.kind === "number") {
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(instruction, "binary", [right, left], {
					attributes: {
						...fn.instructionAttributes(instruction),
						operator: flipped,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
					effectRefinement: fn.instructionEffectRefinement(instruction),
				});
			}
		}
		return editor?.commit();
	},
};

const foldRedundantTdzChecks: CoreFunctionPass = {
	name: "redundant-tdz-check-folding",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["throwIfTdz"],
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "memoryEffects", "normalResults", "representations"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const checks = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "throwIfTdz",
		);
		if (checks.length === 0) return undefined;
		const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const initializedGlobals = coreInitializedGlobalSlotMembership(
			context.compilationContext,
		);
		const initializedCaptures = coreInitializedCapturedReadMembership(
			context.compilationContext,
		);
		const precedes = (first: CoreInstructionId, second: CoreInstructionId): boolean => {
			const firstBlock = fn.instructionBlock(first);
			const secondBlock = fn.instructionBlock(second);
			if (firstBlock !== secondBlock)
				return control.instructionDominatesBlock(firstBlock, secondBlock);
			for (const instruction of fn.instructionIds(firstBlock)) {
				if (instruction === second) return false;
				if (instruction === first) return true;
			}
			return false;
		};
		const emptyInitializer = (value: CoreValueId | undefined): boolean => {
			if (value === undefined || fn.kernel.valueDefinitionKind(value) !== 1) return false;
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			const opcode = fn.instructionOpcodeName(definition);
			return (
				opcode === "createEmpty" ||
				(opcode === "move" && emptyInitializer(instructionOperand(fn, definition, 0)))
			);
		};
		// The owner's own cells exist once per activation; a per-iteration loop scope
		// (a negative owner) is created fresh by its push and only copied afterwards.
		// Either is reset only by an explicit empty store or, for a scope, its push.
		let ownCells:
			| Map<
					string,
					{
						readonly stores: Array<CoreInstructionId>;
						readonly resets: Array<CoreInstructionId>;
					}
			  >
			| undefined;
		const scopePushes = new Map<number, Array<CoreInstructionId>>();
		const cellKey = (owner: number, index: number) => `${owner}:${index}`;
		const ownCellWrites = () => {
			if (ownCells !== undefined) return ownCells;
			ownCells = new Map();
			for (const instruction of fn.instructionIds()) {
				const header = fn.instructionHeader(instruction);
				if (typeof header === "string") continue;
				const opcode = header.opcode;
				const attributes = fn.kernel.instructionAttributes(instruction);
				if (opcode === "envPush" && typeof attributes.scopeId === "number") {
					const pushes = scopePushes.get(attributes.scopeId) ?? [];
					pushes.push(instruction);
					scopePushes.set(attributes.scopeId, pushes);
					continue;
				}
				const { functionIndex, index } = attributes;
				if (
					opcode !== "storeCaptured" ||
					typeof functionIndex !== "number" ||
					typeof index !== "number" ||
					(functionIndex !== item.function && functionIndex >= 0)
				)
					continue;
				const key = cellKey(functionIndex, index);
				const cell = ownCells.get(key) ?? { stores: [], resets: [] };
				(emptyInitializer(instructionOperand(fn, instruction, 0))
					? cell.resets
					: cell.stores
				).push(instruction);
				ownCells.set(key, cell);
			}
			return ownCells;
		};
		// A read is initialized once a value store dominates it and every reset of
		// that cell dominates the store.
		const ownerInitialized = (
			load: CoreInstructionId,
			owner: number,
			index: number,
		): boolean => {
			const cell = ownCellWrites().get(cellKey(owner, index));
			if (cell === undefined) return false;
			const resets = [
				...cell.resets,
				...(owner < 0 ? (scopePushes.get(owner) ?? []) : []),
			];
			return cell.stores.some(
				(store) =>
					precedes(store, load) && resets.every((reset) => precedes(reset, store)),
			);
		};
		const initializedCapture = (load: CoreInstructionId): boolean => {
			const { functionIndex, index } = fn.instructionAttributes(load);
			return (
				typeof functionIndex === "number" &&
				typeof index === "number" &&
				(initializedCaptures.has(`${item.function}:${functionIndex}:${index}`) ||
					((functionIndex === item.function || functionIndex < 0) &&
						ownerInitialized(load, functionIndex, index)))
			);
		};
		let writtenGlobals: ReadonlySet<unknown> | undefined;
		const initializedGlobal = (load: CoreInstructionId): boolean => {
			const index = fn.instructionAttributes(load).index;
			if (typeof index !== "number") return false;
			if (
				coreReadsModuleBindingInitialized(
					context.compilationContext,
					item.function,
					index,
				) ||
				coreReadsImportedBindingInitialized(
					context.compilationContext,
					fn.metadata.sourcePath,
					index,
				)
			)
				return true;
			if (!initializedGlobals.has(index)) return false;
			writtenGlobals ??= new Set(
				[...fn.instructionIds()].flatMap((instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "storeGlobal"
						? [fn.instructionAttributes(instruction).index]
						: [],
				),
			);
			return !writtenGlobals.has(index);
		};
		const isSuperThisStateKey = (stringIndex: unknown): boolean => {
			const units =
				typeof stringIndex === "number"
					? program.stringConstants[stringIndex]
					: undefined;
			return (
				units !== undefined &&
				units.length === CORE_SUPER_THIS_STATE_KEY.length &&
				units.every((unit, index) => unit === CORE_SUPER_THIS_STATE_KEY.charCodeAt(index))
			);
		};
		// Only code lowered for derived constructors names the state key, and the state
		// object stays in a synthetic binding no other function can reach.
		let referencesSuperThisState: boolean | undefined;
		const mayLoadSuperThisState = (instruction: CoreInstructionId, opcode: string) => {
			referencesSuperThisState ??= [...fn.instructionIds()].some(
				(candidate) =>
					fn.instructionKind(candidate) === "operation" &&
					isSuperThisStateKey(fn.instructionAttributes(candidate).stringIndex),
			);
			if (!referencesSuperThisState) return false;
			if (opcode !== "loadProperty")
				return isSuperThisStateKey(fn.instructionAttributes(instruction).stringIndex);
			const key = instructionOperand(fn, instruction, 1);
			if (key === undefined) return true;
			if ((kinds.kindMask(key) & COMPILER_VALUE_KIND_STRING) === 0) return false;
			if (fn.kernel.valueDefinitionKind(key) !== 1) return true;
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(key));
			return (
				fn.instructionOpcodeName(definition) !== "createString" ||
				isSuperThisStateKey(fn.instructionAttributes(definition).stringIndex)
			);
		};
		const definitionMayBeEmpty = (instruction: CoreInstructionId): boolean => {
			const opcode = fn.instructionOpcodeName(instruction);
			return opcode === "loadProperty" ||
				opcode === "loadPropertyStatic" ||
				opcode === "loadPropertyStaticShapeCase"
				? mayLoadSuperThisState(instruction, opcode)
				: opcode === "loadGlobal"
					? !initializedGlobal(instruction)
					: opcode === "loadCaptured"
						? !initializedCapture(instruction)
						: ["createEmpty", "loadLocal", "loadThis"].includes(opcode);
		};
		// A cycle of moves and block parameters only forwards what enters it, so
		// emptiness spreads forward from its sources to a fixpoint.
		let possiblyEmpty: ReadonlySet<CoreValueId> | undefined;
		const mayBeEmpty = (value: CoreValueId): boolean => {
			if (possiblyEmpty !== undefined) return possiblyEmpty.has(value);
			const empty = new Set<CoreValueId>();
			const moves: Array<{
				readonly result: CoreValueId;
				readonly source: CoreValueId | undefined;
			}> = [];
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const resultStart = fn.kernel.instructionResultStart(instruction);
				const resultCount = fn.kernel.instructionResultCount(instruction);
				if (resultCount === 0) continue;
				if (fn.instructionOpcodeName(instruction) === "move") {
					moves.push({
						result: fn.kernel.resultAt(resultStart),
						source: instructionOperand(fn, instruction, 0),
					});
				} else if (definitionMayBeEmpty(instruction)) {
					for (let index = 0; index < resultCount; index++)
						empty.add(fn.kernel.resultAt(resultStart + index));
				}
			}
			const parameters: Array<{
				readonly value: CoreValueId;
				readonly index: number;
				readonly incoming: ReadonlyArray<CoreControlEdge>;
			}> = [];
			for (const block of fn.blockIds()) {
				const parameterStart = fn.kernel.blockParameterStart(block);
				const incoming = control.predecessors[block] ?? [];
				for (let index = 0; index < fn.kernel.blockParameterCount(block); index++) {
					const value = fn.kernel.blockParameterValue(parameterStart + index);
					if (
						fn.kernel.blockParameterRole(parameterStart + index) === 1 ||
						isFunctionParameter(fn, value)
					)
						continue;
					if (incoming.length === 0) empty.add(value);
					else parameters.push({ value, index, incoming });
				}
			}
			for (let changed = true; changed;) {
				changed = false;
				for (const { result, source } of moves) {
					if (empty.has(result) || (source !== undefined && !empty.has(source))) continue;
					empty.add(result);
					changed = true;
				}
				for (const { value, index, incoming } of parameters) {
					if (empty.has(value)) continue;
					if (
						incoming.some((edge) => {
							const argument =
								edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
							return argument === undefined || empty.has(argument);
						})
					) {
						empty.add(value);
						changed = true;
					}
				}
			}
			possiblyEmpty = empty;
			return empty.has(value);
		};
		const redundant: Array<{
			readonly instruction: CoreInstructionId;
			readonly input: CoreValueId;
		}> = [];
		for (const instruction of checks) {
			const input = instructionOperand(fn, instruction, 0);
			if (
				input === undefined ||
				(kinds.kindMask(input) === COMPILER_VALUE_KIND_TOP && mayBeEmpty(input))
			)
				continue;
			redundant.push({ instruction, input });
		}
		if (redundant.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const { instruction, input } of redundant) {
			if (fn.kernel.instructionResultCount(instruction) === 0) {
				editor.removeInstruction(instruction);
			} else {
				editor.replaceInstruction(instruction, "move", [input]);
			}
		}
		return editor.commit();
	},
};

const lowerLocalExplicitThrows: CoreFunctionPass = {
	name: "local-explicit-throw-lowering",
	stage: "canonicalize",
	requiredAnalyses: [CORE_LOCAL_EXCEPTION_FLOW_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects", "representations"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		if (fn.handlerBlockCount === 0) return undefined;
		const flows = context.analysis(CORE_LOCAL_EXCEPTION_FLOW_ANALYSIS);
		const first = flows.find(
			(flow) => fn.instructionKind(fn.blockTerminator(flow.handler)) !== "guard",
		);
		if (first === undefined) return undefined;
		const handler = first.handler;
		const group = flows.filter((flow) => flow.handler === handler);
		const parameterStart = fn.kernel.blockParameterStart(handler);
		const parameterCount = fn.kernel.blockParameterCount(handler);
		const parameters = Array.from({ length: parameterCount }, (_, index) => {
			const value = fn.kernel.blockParameterValue(parameterStart + index);
			return { value, representation: fn.valueRepresentation(value) };
		});
		const handlerTerminator = fn.blockTerminator(handler);
		const handlerSourcePosition = fn.instructionSourcePosition(handlerTerminator);
		const editor = CoreEditor.open(program, item.function);
		const continuation = editor.createBlock(
			parameters.map(({ representation }) => ({ representation })),
		);
		const continuationParameterStart = fn.kernel.blockParameterStart(continuation);
		const continuationParameters = Array.from({ length: parameterCount }, (_, index) =>
			fn.kernel.blockParameterValue(continuationParameterStart + index),
		);
		for (const instruction of [...fn.bodyInstructionIds(handler)]) {
			editor.moveInstruction(instruction, continuation);
		}
		for (const [index, parameter] of parameters.entries()) {
			editor.replaceValueUses(parameter.value, continuationParameters[index]!);
		}
		const replacements = new Map(
			parameters.map(
				({ value }, index) => [value, continuationParameters[index]!] as const,
			),
		);
		for (const factId of fn.factIds()) {
			const fact = fn.fact(factId);
			let changed = false;
			const claims = fact.claims.map((claim) => {
				if (!("subject" in claim)) return claim;
				const subject = replacements.get(claim.subject);
				if (subject === undefined) return claim;
				changed = true;
				return { ...claim, subject };
			});
			if (!changed) continue;
			editor.replaceFact(factId, {
				kind: fact.kind,
				value: fact.value,
				claims,
				validity: fact.validity,
				obligations: fact.obligations,
				origin: fact.origin,
			});
		}
		const outerHandler = fn.kernel.blockHandlerBlock(handler);
		if (outerHandler !== undefined) {
			editor.setHandler(continuation, outerHandler, copyHandlerArguments(fn, handler));
		}
		editor.setTerminator(continuation, {
			...terminatorInputForEdit(fn, handlerTerminator),
			sourcePosition: handlerSourcePosition,
		});
		for (const flow of group) {
			editor.clearHandler(flow.source);
			editor.replaceTerminator(flow.source, {
				kind: "jump",
				edge: {
					block: continuation,
					arguments: [flow.thrownValue, ...flow.handlerArguments],
				},
			});
		}
		editor.removeBlock(handler);
		return editor.commit();
	},
};

interface AbruptTail {
	readonly result: CoreValueId;
	readonly instructions: Array<CoreInstructionId>;
}

function removeUnreachableControlFlow(
	context: CoreFunctionPassContext,
	abruptTails?: ReadonlyMap<CoreBlockId, AbruptTail>,
) {
	const { program, item } = context;
	const fn = program.function(item.function);
	const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).structural;
	const reachable = new Set(abruptTails === undefined ? control.reachable : []);
	const pendingRoots = fn.bodyEntry === undefined ? [] : [fn.bodyEntry];
	if (abruptTails !== undefined) pendingRoots.push(fn.entry);
	while (pendingRoots.length > 0) {
		const block = pendingRoots.pop()!;
		if (reachable.has(block)) continue;
		reachable.add(block);
		for (const edge of control.successors[block] ?? []) {
			if (edge.kind === "exceptional" || !abruptTails?.has(block))
				pendingRoots.push(edge.to);
		}
	}
	const blocks = [...fn.blockIds()].filter((block) => !reachable.has(block));
	const cuts = [...(abruptTails ?? [])].filter(
		([block, tail]) =>
			reachable.has(block) &&
			(tail.instructions.length > 0 ||
				fn.instructionKind(fn.blockTerminator(block)) !== "return" ||
				instructionOperand(fn, fn.blockTerminator(block), 0) !== tail.result),
	);
	if (blocks.length === 0 && cuts.length === 0) return undefined;
	const editor = CoreEditor.open(program, item.function);
	const removed = new Set(blocks);
	for (const block of fn.blockIds()) {
		const handler = fn.kernel.blockHandlerBlock(block);
		if (handler !== undefined && (removed.has(block) || removed.has(handler))) {
			editor.clearHandler(block);
		}
	}
	const pending = new Set(blocks.flatMap((block) => [...fn.instructionIds(block)]));
	const removedGuardFacts = [...blocks, ...cuts.map(([block]) => block)].flatMap(
		(block) => {
			const fact = fn.kernel.terminatorFact(fn.blockTerminator(block));
			return fact === undefined ? [] : [fact];
		},
	);
	for (const [block, tail] of cuts) {
		for (const instruction of tail.instructions) pending.add(instruction);
		// Execution blocks require a control transfer even after an operation that always throws.
		editor.replaceTerminator(block, { kind: "return", value: tail.result });
	}
	removeCoreInstructions(editor, pending);
	for (const block of blocks) editor.removeBlock(block);
	for (const fact of removedGuardFacts) editor.removeFact(fact);
	return editor.commit();
}

const removeUnreachableBlocks: CoreFunctionPass = {
	name: "unreachable-block-removal",
	stage: "canonicalize",
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run: removeUnreachableControlFlow,
};

const removeBuiltinErrorContinuations: CoreFunctionPass = {
	name: "builtin-error-continuation-removal",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["builtinError"],
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const fn = context.program.function(context.item.function);
		const abruptTails = new Map<CoreBlockId, AbruptTail>();
		for (const block of fn.blockIds()) {
			let tail: AbruptTail | undefined;
			for (const instruction of fn.bodyInstructionIds(block)) {
				if (tail !== undefined) tail.instructions.push(instruction);
				else if (fn.instructionOpcodeName(instruction) === "builtinError")
					tail = {
						result: instructionResult(fn, instruction, 0)!,
						instructions: [],
					};
			}
			if (tail !== undefined) abruptTails.set(block, tail);
		}
		return removeUnreachableControlFlow(context, abruptTails);
	},
};

const eliminateForwardingBlocks: CoreFunctionPass = {
	name: "forwarding-block-elimination",
	stage: "canonicalize",
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["cfg", "body", "exceptionFlow"],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).structural;
		const candidates = new Array<{
			readonly block: CoreBlockId;
			readonly incoming: ReadonlyArray<CoreControlEdge>;
			readonly parameters: ReadonlyArray<CoreValueId>;
			readonly edges: readonly [CoreEdge] | readonly [CoreEdge, CoreEdge];
			readonly condition?: number;
		}>();
		for (const block of fn.blockIds()) {
			if (
				block === fn.entry ||
				block === fn.bodyEntry ||
				fn.kernel.blockHandlerBlock(block) !== undefined
			) {
				continue;
			}
			if (fn.hasBodyInstructions(block)) continue;
			const parameterStart = fn.kernel.blockParameterStart(block);
			const parameterCount = fn.kernel.blockParameterCount(block);
			let hasOutsideUse = false;
			for (let index = 0; index < parameterCount; index++) {
				if (
					useOutsideBlock(
						fn,
						fn.kernel.blockParameterValue(parameterStart + index),
						block,
					)
				) {
					hasOutsideUse = true;
					break;
				}
			}
			if (hasOutsideUse) continue;
			const terminator = fn.blockTerminator(block);
			const kind = fn.instructionKind(terminator);
			const incoming = control.predecessors[block] ?? [];
			if (incoming.length === 0 || incoming.some(({ kind }) => kind === "exceptional"))
				continue;
			const parameters = Array.from({ length: parameterCount }, (_, index) =>
				fn.kernel.blockParameterValue(parameterStart + index),
			);
			if (kind === "branch") {
				const conditionValue = instructionOperand(fn, terminator, 0);
				if (conditionValue === undefined) continue;
				const consequent = copyTerminatorEdge(fn, terminator, 0);
				const alternate = copyTerminatorEdge(fn, terminator, 1);
				const condition = parameters.indexOf(conditionValue);
				if (
					condition < 0 ||
					incoming.some((edge) => {
						const value = edge.arguments[condition];
						if (value === undefined) return true;
						const constant = constantForValue(fn, value);
						if (constant?.kind !== "boolean") return true;
						return (constant.value ? consequent : alternate).block === block;
					})
				)
					continue;
				candidates.push({
					block,
					incoming,
					parameters,
					edges: [consequent, alternate],
					condition,
				});
				continue;
			}
			if (kind !== "jump") continue;
			const edge = copyTerminatorEdge(fn, terminator, 0);
			if (edge.block === block) continue;
			candidates.push({
				block,
				incoming,
				parameters,
				edges: [edge],
			});
		}
		if (candidates.length === 0) return undefined;
		const candidateBlocks = new Set(candidates.map(({ block }) => block));
		const sinks = candidates.filter(({ edges }) =>
			edges.every(({ block }) => !candidateBlocks.has(block)),
		);
		const selected = sinks.length === 0 ? [candidates[0]!] : sinks;
		const editor = CoreEditor.open(program, item.function);
		for (const candidate of selected) {
			const translate = (edge: CoreEdge, target: CoreEdge): CoreEdge => ({
				block: target.block,
				arguments: target.arguments.map((value) => {
					const parameter = candidate.parameters.indexOf(value);
					return parameter < 0 ? value : edge.arguments[parameter]!;
				}),
			});
			for (const source of new Set(candidate.incoming.map(({ from }) => from))) {
				const sourceTerminator = fn.blockTerminator(source);
				editor.replaceTerminator(
					source,
					rewriteEdges(fn, sourceTerminator, (edge) => {
						if (edge.block !== candidate.block) return edge;
						if (candidate.edges.length === 1) {
							return translate(edge, candidate.edges[0]);
						}
						const conditionValue = constantForValue(
							fn,
							edge.arguments[candidate.condition!]!,
						);
						if (conditionValue?.kind !== "boolean") return edge;
						return translate(
							edge,
							conditionValue.value ? candidate.edges[0] : candidate.edges[1],
						);
					}),
				);
			}
		}
		for (const { block } of selected) editor.removeBlock(block);
		return editor.commit();
	},
};

const mergeLinearBlocks: CoreFunctionPass = {
	name: "linear-block-merging",
	stage: "canonicalize",
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["cfg", "body", "exceptionFlow"],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item, remainingEdits } = context;
		const fn = program.function(item.function);
		const bundle = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS);
		const control = bundle.structural;
		const throwsToHandler = (block: CoreBlockId) =>
			(bundle.exceptional().successors[block] ?? []).some(
				({ kind }) => kind === "exceptional",
			);
		let selected: Array<{
			readonly predecessor: CoreBlockId;
			readonly target: CoreBlockId;
			readonly edgeArguments: ReadonlyArray<CoreValueId>;
			readonly parameters: ReadonlyArray<CoreValueId>;
			readonly bodyInstructions: ReadonlyArray<CoreInstructionId>;
		}> = [];
		const selectedBlocks = new Set<CoreBlockId>();
		let estimatedEdits = 0;
		for (const predecessor of fn.blockIds()) {
			const predecessorTerminator = fn.blockTerminator(predecessor);
			if (fn.instructionKind(predecessorTerminator) !== "jump") continue;
			const predecessorEdge = copyTerminatorEdge(fn, predecessorTerminator, 0);
			const target = predecessorEdge.block;
			if (
				target === predecessor ||
				target === fn.entry ||
				target === fn.bodyEntry ||
				!fn.isBlockLive(target) ||
				!absorbableUnderHandler(fn, predecessor, target)
			)
				continue;
			const incoming = control.predecessors[target] ?? [];
			if (
				incoming.length !== 1 ||
				incoming[0]!.kind !== "ordinary" ||
				incoming[0]!.from !== predecessor
			)
				continue;
			const parameterStart = fn.kernel.blockParameterStart(target);
			const parameterCount = fn.kernel.blockParameterCount(target);
			if (parameterCount !== predecessorEdge.arguments.length) continue;
			if (selectedBlocks.has(predecessor) || selectedBlocks.has(target)) continue;
			// A result reaches the handler only from a block that cannot throw into it.
			if (
				throwsToHandler(target) &&
				!throwsToHandler(predecessor) &&
				resultUsedOutside(fn, predecessor, target)
			)
				continue;
			const bodyInstructions = [...fn.bodyInstructionIds(target)];
			const parameters = Array.from({ length: parameterCount }, (_, index) =>
				fn.kernel.blockParameterValue(parameterStart + index),
			);
			const parameterValues = new Set(parameters);
			const replacementInstructions = new Set<CoreInstructionId>();
			for (const value of parameterValues) {
				addUseInstructions(fn, value, replacementInstructions);
			}
			const handlerEdits =
				parameterValues.size === 0
					? 0
					: [...fn.blockIds()].filter((block) => {
							for (const value of parameterValues) {
								if (handlerContainsValue(fn, block, value)) return true;
							}
							return false;
						}).length;
			const candidateEdits =
				bodyInstructions.length + replacementInstructions.size + handlerEdits + 2;
			if (estimatedEdits + candidateEdits > remainingEdits) {
				context.deferForBudget();
				continue;
			}
			selected.push({
				predecessor,
				target,
				edgeArguments: predecessorEdge.arguments,
				parameters,
				bodyInstructions,
			});
			selectedBlocks.add(predecessor);
			selectedBlocks.add(target);
			estimatedEdits += candidateEdits;
		}
		if (selected.length === 0) return undefined;
		const rawReplacements = new Map(
			selected.flatMap(({ edgeArguments, parameters }) =>
				parameters.map((parameter, index) => [parameter, edgeArguments[index]!] as const),
			),
		);
		const resolveReplacement = (value: CoreValueId): CoreValueId | undefined => {
			const seen = new Set<CoreValueId>([value]);
			let replacement = rawReplacements.get(value)!;
			while (rawReplacements.has(replacement)) {
				if (seen.has(replacement)) return undefined;
				seen.add(replacement);
				replacement = rawReplacements.get(replacement)!;
			}
			return replacement;
		};
		let replacements = new Map<CoreValueId, CoreValueId>();
		let cyclic = false;
		for (const value of rawReplacements.keys()) {
			const replacement = resolveReplacement(value);
			if (replacement === undefined) {
				cyclic = true;
				break;
			}
			replacements.set(value, replacement);
		}
		if (cyclic) {
			selected = [selected[0]!];
			replacements = new Map(
				selected[0]!.parameters.map((parameter, index) => [
					parameter,
					selected[0]!.edgeArguments[index]!,
				]),
			);
		}
		const editor = CoreEditor.open(program, item.function);
		editor.replaceValueUsesMany(replacements);
		for (const { predecessor, target, bodyInstructions } of selected) {
			for (const instruction of bodyInstructions) {
				editor.moveInstruction(instruction, predecessor, fn.blockTerminator(predecessor));
			}
			editor.replaceTerminator(
				predecessor,
				terminatorInputForEdit(fn, fn.blockTerminator(target)),
			);
			editor.removeBlock(target);
		}
		return editor.commit();
	},
};

const simplifyBlockParameters: CoreFunctionPass = {
	name: "block-parameter-simplification",
	stage: "canonicalize",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_EDGE_ARGUMENTS,
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["cfg", "body"],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const bundle = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS);
		const control = bundle.structural;
		let editor: CoreEditor | undefined;
		for (const block of fn.blockIds()) {
			const parameterCount = fn.kernel.blockParameterCount(block);
			if (parameterCount === 0) continue;
			const incoming = control.predecessors[block] ?? [];
			if (incoming.length === 0 || incoming.some(({ kind }) => kind === "exceptional")) {
				continue;
			}
			const parameterStart = fn.kernel.blockParameterStart(block);
			const predecessors = [...new Set(incoming.map(({ from }) => from))];
			let argumentRows:
				| Array<{ readonly start: number; readonly count: number }>
				| undefined;
			const removable: Array<{
				readonly index: number;
				readonly parameter: {
					readonly value: CoreValueId;
					readonly representation: CoreRepresentation;
				};
				readonly replacement: CoreValueId | undefined;
				readonly replacementConstant: LocalConstant | undefined;
				readonly sameValue: boolean;
				readonly unused: boolean;
			}> = [];
			for (let index = parameterCount - 1; index >= 0; index--) {
				const row = parameterStart + index;
				if (fn.kernel.blockParameterRole(row) !== 0) continue;
				const value = fn.kernel.blockParameterValue(row);
				const unused = !valueHasUses(fn, value);
				if (unused) {
					removable.push({
						index,
						parameter: { value, representation: fn.valueRepresentation(value) },
						replacement: undefined,
						replacementConstant: undefined,
						sameValue: false,
						unused,
					});
					continue;
				}
				if (argumentRows === undefined) {
					argumentRows = [];
					for (const source of predecessors) {
						const terminator = fn.blockTerminator(source);
						const start = fn.kernel.terminatorEdgeStart(terminator);
						const count = fn.kernel.terminatorEdgeCount(terminator);
						for (let offset = 0; offset < count; offset++) {
							const edge = start + offset;
							if (fn.kernel.terminatorEdgeBlock(edge) !== block) continue;
							argumentRows.push({
								start: fn.kernel.terminatorEdgeArgumentStart(edge),
								count: fn.kernel.terminatorEdgeArgumentCount(edge),
							});
						}
					}
				}
				const firstRow = argumentRows[0];
				const replacement =
					firstRow !== undefined && index < firstRow.count
						? fn.kernel.operandAt(firstRow.start + index)
						: undefined;
				if (replacement === undefined || replacement === value) continue;
				let sameValue = true;
				for (const row of argumentRows) {
					if (
						index >= row.count ||
						fn.kernel.operandAt(row.start + index) !== replacement
					) {
						sameValue = false;
						break;
					}
				}
				const replacementConstant = sameValue
					? undefined
					: constantForValue(fn, replacement);
				if (sameValue) {
					const dominance = bundle.exceptional();
					const kind = fn.kernel.valueDefinitionKind(replacement);
					const owner = fn.kernel.valueDefinitionOwner(replacement);
					const dominates =
						kind === 0
							? dominance.dominates(coreBlockId(owner), block)
							: kind === 1 &&
								dominance.instructionDominatesBlock(
									fn.instructionBlock(coreInstructionId(owner)),
									block,
								);
					if (!dominates) continue;
				} else {
					if (
						replacementConstant === undefined ||
						fn.kernel.valueHandlerUseCount(value) !== 0
					)
						continue;
					let interchangeable = true;
					for (const row of argumentRows) {
						const argument =
							index < row.count ? fn.kernel.operandAt(row.start + index) : undefined;
						const constant =
							argument === undefined ? undefined : constantForValue(fn, argument);
						if (
							constant === undefined ||
							!constantsAreInterchangeable(program, replacementConstant, constant)
						) {
							interchangeable = false;
							break;
						}
					}
					if (!interchangeable) continue;
				}
				removable.push({
					index,
					parameter: { value, representation: fn.valueRepresentation(value) },
					replacement,
					replacementConstant,
					sameValue,
					unused,
				});
			}
			if (removable.length === 0) continue;
			editor ??= CoreEditor.open(program, item.function);
			const replacements = new Map<CoreValueId, CoreValueId>();
			for (const {
				parameter,
				replacement,
				replacementConstant,
				sameValue,
				unused,
			} of removable) {
				if (!unused) {
					const selected = sameValue
						? replacement!
						: insertConstant(
								editor,
								fn,
								block,
								replacementConstant!,
								parameter.representation,
							);
					replacements.set(parameter.value, selected);
				}
			}
			editor.replaceValueUsesMany(replacements);
			const removedIndexes = new Set(removable.map(({ index }) => index));
			for (const predecessor of predecessors) {
				const predecessorTerminator = fn.blockTerminator(predecessor);
				editor.replaceTerminator(
					predecessor,
					rewriteEdges(fn, predecessorTerminator, (edge) =>
						edge.block === block
							? {
									block,
									arguments: edge.arguments.filter(
										(_, argumentIndex) => !removedIndexes.has(argumentIndex),
									),
								}
							: edge,
					),
				);
			}
			for (const { index } of removable) editor.removeBlockParameter(block, index);
		}
		return editor?.commit();
	},
};

const canonicalizeBlockParameters: CoreFunctionPass = {
	name: "canonical-block-parameter-elimination",
	stage: "canonicalize",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_EDGE_ARGUMENTS,
	requiredAnalyses: [
		CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
		CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	],
	wakesOn: ["cfg", "body", "representations"],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: CANONICAL_BLOCK_PARAMETER_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		const plans: Array<{
			readonly block: CoreBlockId;
			readonly predecessors: ReadonlyArray<CoreBlockId>;
			readonly replacements: ReadonlyArray<{
				readonly index: number;
				readonly parameter: CoreValueId;
				readonly replacement: CoreValueId;
			}>;
		}> = [];
		for (const block of fn.blockIds()) {
			const incoming = control.predecessors[block] ?? [];
			if (incoming.length === 0 || incoming.some(({ kind }) => kind === "exceptional")) {
				continue;
			}
			const parameterStart = fn.kernel.blockParameterStart(block);
			const parameterCount = fn.kernel.blockParameterCount(block);
			const replacements: Array<{
				readonly index: number;
				readonly parameter: CoreValueId;
				readonly replacement: CoreValueId;
			}> = [];
			for (let index = parameterCount - 1; index >= 0; index--) {
				const row = parameterStart + index;
				if (fn.kernel.blockParameterRole(row) !== 0) continue;
				const parameter = fn.kernel.blockParameterValue(row);
				const replacement = roots.get(parameter) ?? parameter;
				const replacementOwner = fn.kernel.valueDefinitionOwner(replacement);
				const replacementDominates =
					fn.kernel.valueDefinitionKind(replacement) === 0
						? control.dominates(coreBlockId(replacementOwner), block)
						: control.instructionDominatesBlock(
								fn.instructionBlock(coreInstructionId(replacementOwner)),
								block,
							);
				if (
					replacement === parameter ||
					!fn.isValueLive(replacement) ||
					!replacementDominates ||
					fn.valueRepresentation(replacement) !== fn.valueRepresentation(parameter)
				)
					continue;
				replacements.push({ index, parameter, replacement });
			}
			if (replacements.length > 0) {
				plans.push({
					block,
					predecessors: [...new Set(incoming.map(({ from }) => from))],
					replacements,
				});
			}
		}
		if (plans.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceValueUsesMany(
			new Map(
				plans.flatMap(({ replacements }) =>
					replacements.map(({ parameter, replacement }) => [parameter, replacement]),
				),
			),
		);
		for (const { block, predecessors, replacements } of plans) {
			const removedIndexes = new Set(replacements.map(({ index }) => index));
			for (const predecessor of predecessors) {
				const predecessorTerminator = fn.blockTerminator(predecessor);
				editor.replaceTerminator(
					predecessor,
					rewriteEdges(fn, predecessorTerminator, (edge) =>
						edge.block === block
							? {
									block,
									arguments: edge.arguments.filter(
										(_, argumentIndex) => !removedIndexes.has(argumentIndex),
									),
								}
							: edge,
					),
				);
			}
			for (const { index } of replacements) editor.removeBlockParameter(block, index);
		}
		return editor.commit();
	},
};

const forwardRestArguments: CoreFunctionPass = {
	name: "forward-rest-arguments",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["createRestArguments", "createArgumentsObject"],
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		if (
			fn.isGenerator ||
			fn.isAsync ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			fn.metadata.mappedArguments
		)
			return undefined;
		// An unmapped arguments object forwards like a rest array from index 0. With a
		// second producer the object's identity could be observed across both.
		let argumentsObjects = 0;
		for (const instruction of fn.instructionIds())
			if (
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "createArgumentsObject"
			)
				argumentsObjects++;
		let editor: CoreEditor | undefined;
		for (const producer of fn.instructionIds()) {
			if (fn.instructionKind(producer) !== "operation") continue;
			const producerOpcode = fn.instructionOpcodeName(producer);
			const argumentsObject =
				producerOpcode === "createArgumentsObject" && argumentsObjects === 1;
			if (producerOpcode !== "createRestArguments" && !argumentsObject) continue;
			const rest = instructionResult(fn, producer, 0)!;
			if (fn.kernel.valueHandlerUseCount(rest) !== 0) continue;
			const consumers: Array<{
				instruction: CoreInstructionId;
				inputs: Array<CoreValueId>;
				apply: boolean;
			}> = [];
			let valid = true;
			for (
				let use = fn.kernel.valueFirstUse(rest);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const consumer = coreInstructionId(fn.kernel.useInstruction(use));
				if (fn.instructionKind(consumer) !== "operation") {
					valid = false;
					break;
				}
				const opcode = fn.instructionOpcodeName(consumer);
				const inputs = copyInstructionOperands(fn, consumer);
				const apply = opcode === "call" && inputs.length === 4 && inputs[3] === rest;
				if (
					fn.instructionKind(consumer) !== "operation" ||
					(!apply && !(opcode === "callSpreadIterable" && inputs[2] === rest)) ||
					inputs.filter((input) => input === rest).length !== 1
				) {
					valid = false;
					break;
				}
				if (apply) {
					const property = definingInstruction(fn, inputs[0]!);
					if (
						property === undefined ||
						fn.instructionOpcodeName(property) !== "loadPropertyStatic" ||
						instructionOperand(fn, property, 0) !== inputs[1]
					) {
						valid = false;
						break;
					}
					const key = fn.instructionAttributes(property).stringIndex;
					if (typeof key !== "number" || decodeString(program, key) !== "apply") {
						valid = false;
						break;
					}
				}
				consumers.push({ instruction: consumer, inputs, apply });
			}
			if (!valid || consumers.length === 0) continue;
			const startIndex = argumentsObject
				? 0
				: fn.instructionAttributes(producer).startIndex;
			if (typeof startIndex !== "number") continue;
			const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
			if (
				consumers.some(
					({ instruction }) =>
						!control.dominates(
							fn.instructionBlock(producer),
							fn.instructionBlock(instruction),
						),
				)
			)
				continue;
			editor ??= CoreEditor.open(program, item.function);
			editor.replaceInstruction(producer, "createRestArgumentsState", [], {
				sourcePosition: fn.instructionSourcePosition(producer),
			});
			for (const { instruction: consumer, inputs, apply } of consumers) {
				editor.replaceInstruction(
					consumer,
					"callRestArguments",
					apply
						? [...inputs.slice(0, 3), rest]
						: [inputs[0]!, inputs[1]!, inputs[1]!, rest, ...inputs.slice(3)],
					{
						attributes: argumentsObject
							? { startIndex, apply, argumentsObject }
							: { startIndex, apply },
						sourcePosition: fn.instructionSourcePosition(consumer),
					},
				);
			}
		}
		return editor?.commit();
	},
};

// Larger literals keep one allocation rather than widening the call.
const SPREAD_LITERAL_ELEMENT_LIMIT = 16;

/**
 * Under locked primordials, spreading an Array literal that nothing else observes passes
 * exactly its defined elements: the intrinsic iterator and its `next` cannot change, and
 * every index below the literal's length is an own data property.
 */
const spreadArrayLiteralArguments: CoreFunctionPass = {
	name: "spread-array-literal-arguments",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["callSpreadIterable"],
	requiredAnalyses: [],
	wakesOn: ["body", "cfg"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		if (compilationContext.facts.world.primordialPolicy !== "locked") return undefined;
		const fn = program.function(item.function);
		let editor: CoreEditor | undefined;
		// Rewrites remove instructions, so candidates come from a snapshot.
		const literals = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "createArray",
		);
		for (const producer of literals) {
			const length = fn.instructionAttributes(producer).length;
			const array = instructionResult(fn, producer, 0);
			if (
				typeof length !== "number" ||
				!Number.isInteger(length) ||
				length < 0 ||
				length > SPREAD_LITERAL_ELEMENT_LIMIT ||
				array === undefined ||
				fn.kernel.valueHandlerUseCount(array) !== 0
			)
				continue;
			const elements = new Array<CoreValueId | undefined>(length).fill(undefined);
			const definitions = new Set<CoreInstructionId>();
			const calls: Array<{
				instruction: CoreInstructionId;
				operands: Array<CoreValueId>;
			}> = [];
			let valid = true;
			for (
				let use = fn.kernel.valueFirstUse(array);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const consumer = coreInstructionId(fn.kernel.useInstruction(use));
				const operands =
					fn.instructionKind(consumer) === "operation"
						? copyInstructionOperands(fn, consumer)
						: [];
				const opcode =
					fn.instructionKind(consumer) === "operation"
						? fn.instructionOpcodeName(consumer)
						: undefined;
				if (
					opcode === "callSpreadIterable" &&
					operands[2] === array &&
					operands.filter((operand) => operand === array).length === 1
				) {
					calls.push({ instruction: consumer, operands });
					continue;
				}
				const attributes =
					opcode === "defineProperty" ? fn.instructionAttributes(consumer) : undefined;
				const key =
					operands[1] === undefined ? undefined : constantForValue(fn, operands[1]);
				const index =
					key?.kind === "number" && Number.isInteger(key.value) ? key.value : -1;
				if (
					attributes === undefined ||
					operands[0] !== array ||
					operands[2] === array ||
					attributes.enumerable !== true ||
					attributes.writable === false ||
					attributes.configurable === false ||
					fn.instructionBlock(consumer) !== fn.instructionBlock(producer) ||
					index < 0 ||
					index >= length ||
					elements[index] !== undefined
				) {
					valid = false;
					break;
				}
				elements[index] = operands[2];
				definitions.add(consumer);
			}
			if (!valid || calls.length === 0 || elements.includes(undefined)) continue;
			// SSA already places other blocks' calls after the literal's whole block; within
			// it, a call must still follow every definition.
			const pending = new Set(definitions);
			for (
				let next = fn.instructionNext(producer);
				next !== undefined && valid;
				next = fn.instructionNext(next)
			) {
				pending.delete(next);
				if (calls.some(({ instruction }) => instruction === next) && pending.size > 0)
					valid = false;
			}
			if (!valid) continue;
			editor ??= CoreEditor.open(program, item.function);
			for (const { instruction, operands } of calls) {
				const sourceCall = fn.instructionAttributes(instruction).sourceCall;
				editor.replaceInstruction(
					instruction,
					"call",
					[
						operands[0]!,
						operands[1]!,
						...operands.slice(3),
						...(elements as Array<CoreValueId>),
					],
					{
						...(typeof sourceCall === "number" ? { attributes: { sourceCall } } : {}),
						sourcePosition: fn.instructionSourcePosition(instruction),
					},
				);
			}
			for (const definition of definitions) editor.removeInstruction(definition);
			editor.removeInstruction(producer);
		}
		return editor?.commit();
	},
};

const applyArrayLiteralArguments: CoreFunctionPass = {
	name: "apply-array-literal-arguments",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["call"],
	requiredAnalyses: [],
	wakesOn: ["body", "cfg"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		const fn = program.function(item.function);
		let editor: CoreEditor | undefined;
		for (const site of [...fn.instructionIds()].filter(
			(site) =>
				fn.instructionKind(site) === "operation" &&
				fn.instructionOpcodeName(site) === "call",
		)) {
			const call = coreFunctionPrototypeApply(program, fn, site);
			if (
				call === undefined ||
				fn.kernel.valueDefinitionKind(call.array) !== 1 ||
				fn.kernel.valueHandlerUseCount(call.array) !== 0
			)
				continue;
			const producer = coreInstructionId(fn.kernel.valueDefinitionOwner(call.array));
			const block = fn.instructionBlock(site);
			if (
				fn.instructionKind(producer) !== "operation" ||
				fn.instructionOpcodeName(producer) !== "createArray" ||
				fn.instructionBlock(producer) !== block
			)
				continue;
			const length = fn.instructionAttributes(producer).length;
			if (
				typeof length !== "number" ||
				!Number.isInteger(length) ||
				length < 0 ||
				length > SPREAD_LITERAL_ELEMENT_LIMIT
			)
				continue;
			const elements = new Array<CoreValueId | undefined>(length).fill(undefined);
			const definitions = new Set<CoreInstructionId>();
			let valid = true;
			for (
				let use = fn.kernel.valueFirstUse(call.array);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const consumer = coreInstructionId(fn.kernel.useInstruction(use));
				const operands =
					fn.instructionKind(consumer) === "operation"
						? copyInstructionOperands(fn, consumer)
						: [];
				if (
					consumer === site &&
					operands.filter((value) => value === call.array).length === 1
				)
					continue;
				const attributes =
					fn.instructionKind(consumer) === "operation" &&
					fn.instructionOpcodeName(consumer) === "defineProperty"
						? fn.instructionAttributes(consumer)
						: undefined;
				const key =
					operands[1] === undefined ? undefined : constantForValue(fn, operands[1]);
				const index =
					key?.kind === "number" && Number.isInteger(key.value) ? key.value : -1;
				if (
					attributes === undefined ||
					operands.length !== 3 ||
					operands[0] !== call.array ||
					operands[2] === call.array ||
					attributes.enumerable !== true ||
					attributes.writable === false ||
					attributes.configurable === false ||
					fn.instructionBlock(consumer) !== block ||
					index < 0 ||
					index >= length ||
					elements[index] !== undefined
				) {
					valid = false;
					break;
				}
				elements[index] = operands[2];
				definitions.add(consumer);
			}
			if (!valid || elements.includes(undefined)) continue;
			const construction = [producer];
			const pending = new Set(definitions);
			let reached = false;
			for (
				let next = fn.instructionNext(producer);
				next !== undefined;
				next = fn.instructionNext(next)
			) {
				if (next === site) {
					reached = true;
					break;
				}
				if (pending.delete(next)) construction.push(next);
			}
			if (!reached || pending.size !== 0) continue;
			editor ??= CoreEditor.open(program, item.function);
			expandCoreFunctionPrototypeApply(
				fn,
				editor,
				site,
				call,
				elements as Array<CoreValueId>,
				construction,
			);
		}
		return editor?.commit();
	},
};

function canonicalRestElementIndex(key: string | number): number | undefined {
	const index = typeof key === "number" ? key : Number(key);
	if (
		!Number.isInteger(index) ||
		index < 0 ||
		index > 0x7fff_ffff ||
		(typeof key === "string" && String(index) !== key)
	) {
		return undefined;
	}
	return index;
}

const scalarizeRestArgumentReads: CoreFunctionPass = {
	name: "scalarize-rest-argument-reads",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["createRestArguments"],
	requiredAnalyses: [],
	wakesOn: ["body", "facts"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, compilationContext, item }) {
		const fn = program.function(item.function);
		if (
			fn.isGenerator ||
			fn.isAsync ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			fn.metadata.mappedArguments ||
			!compilerFactIsWorldInvariant(
				compilationContext.facts.protectors.get("array-elements"),
			)
		) {
			return undefined;
		}
		for (const producer of fn.instructionIds()) {
			if (
				fn.instructionKind(producer) !== "operation" ||
				fn.instructionOpcodeName(producer) !== "createRestArguments"
			) {
				continue;
			}
			const startIndex = fn.instructionAttributes(producer).startIndex;
			if (
				typeof startIndex !== "number" ||
				!Number.isInteger(startIndex) ||
				startIndex < 0 ||
				startIndex > 0x7fff_ffff
			) {
				continue;
			}
			const rest = instructionResult(fn, producer, 0);
			if (rest === undefined || fn.kernel.valueHandlerUseCount(rest) !== 0) continue;
			const reads: Array<{
				readonly instruction: CoreInstructionId;
				readonly result: CoreValueId;
				readonly argumentIndex: number;
			}> = [];
			const lengthReads: Array<{
				readonly instruction: CoreInstructionId;
				readonly result: CoreValueId;
			}> = [];
			let valid = true;
			for (
				let use = fn.kernel.valueFirstUse(rest);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const instruction = fn.kernel.useInstruction(use);
				if (fn.instructionKind(instruction) !== "operation") {
					valid = false;
					break;
				}
				const opcode = fn.instructionOpcodeName(instruction);
				if (
					(opcode !== "loadProperty" && opcode !== "loadPropertyStatic") ||
					instructionOperand(fn, instruction, 0) !== rest
				) {
					valid = false;
					break;
				}
				const attributes = fn.instructionAttributes(instruction);
				const result = instructionResult(fn, instruction, 0);
				let elementIndex: number | undefined;
				if (opcode === "loadPropertyStatic") {
					const stringIndex = attributes.stringIndex;
					if (typeof stringIndex === "number") {
						const key = decodeString(program, stringIndex);
						if (key === "length" && result !== undefined) {
							lengthReads.push({ instruction, result });
							continue;
						}
						if (key !== undefined) elementIndex = canonicalRestElementIndex(key);
					}
				} else {
					const key = instructionOperand(fn, instruction, 1);
					const constant = key === undefined ? undefined : constantForValue(fn, key);
					if (constant?.kind === "number") {
						elementIndex = canonicalRestElementIndex(constant.value);
					} else if (constant?.kind === "string") {
						const value = decodeString(program, constant.index);
						if (value !== undefined) elementIndex = canonicalRestElementIndex(value);
					}
				}
				const argumentIndex =
					elementIndex === undefined ? undefined : startIndex + elementIndex;
				if (
					result === undefined ||
					argumentIndex === undefined ||
					argumentIndex > 0x7fff_ffff
				) {
					valid = false;
					break;
				}
				reads.push({ instruction, result, argumentIndex });
			}
			if (!valid || (reads.length === 0 && lengthReads.length === 0)) continue;

			let before = fn.blockTerminator(fn.entry);
			let argumentCount: CoreValueId | undefined;
			const snapshots = new Map<number, CoreValueId>();
			for (const instruction of fn.bodyInstructionIds(fn.entry)) {
				const opcode = fn.instructionOpcodeName(instruction);
				if (opcode !== "loadArgumentCount" && opcode !== "loadArgument") {
					before = instruction;
					break;
				}
				if (opcode === "loadArgumentCount") {
					argumentCount = instructionResult(fn, instruction, 0);
				} else {
					const index = fn.instructionAttributes(instruction).index;
					const result = instructionResult(fn, instruction, 0);
					if (typeof index === "number" && result !== undefined) {
						snapshots.set(index, result);
					}
				}
			}
			const editor = CoreEditor.open(program, item.function);
			if (lengthReads.length > 0 && argumentCount === undefined) {
				argumentCount = editor.insertInstruction(
					fn.entry,
					before,
					"loadArgumentCount",
					[],
					{ sourcePosition: fn.instructionSourcePosition(producer) },
				).outputs[0]!;
			}
			let restLength = argumentCount;
			if (lengthReads.length > 0 && startIndex > 0) {
				const prefixLength = editor.insertInstruction(
					fn.entry,
					before,
					"createNumber",
					[],
					{
						attributes: { value: startIndex },
						sourcePosition: fn.instructionSourcePosition(producer),
					},
				).outputs[0]!;
				const difference = editor.insertInstruction(
					fn.entry,
					before,
					"binary",
					[argumentCount!, prefixLength],
					{
						attributes: { operator: "-" },
						sourcePosition: fn.instructionSourcePosition(producer),
					},
				).outputs[0]!;
				const zero = editor.insertInstruction(fn.entry, before, "createNumber", [], {
					attributes: { value: 0 },
					sourcePosition: fn.instructionSourcePosition(producer),
				}).outputs[0]!;
				restLength = editor.insertInstruction(
					fn.entry,
					before,
					"mathBinaryNumber",
					[difference, zero],
					{
						attributes: {
							operation: "Math.max",
							worldAssumptions: {
								...builtinWorldAssumptions("Math.max", "primitive"),
							},
						},
						sourcePosition: fn.instructionSourcePosition(producer),
					},
				).outputs[0]!;
			}
			for (const argumentIndex of [
				...new Set(reads.map((read) => read.argumentIndex)),
			].sort((left, right) => left - right)) {
				if (snapshots.has(argumentIndex)) continue;
				const snapshot = editor.insertInstruction(fn.entry, before, "loadArgument", [], {
					attributes: { index: argumentIndex },
					sourcePosition: fn.instructionSourcePosition(producer),
				}).outputs[0]!;
				snapshots.set(argumentIndex, snapshot);
			}
			for (const read of reads) {
				editor.replaceValueUses(read.result, snapshots.get(read.argumentIndex)!);
				editor.removeInstruction(read.instruction);
			}
			for (const read of lengthReads) {
				editor.replaceValueUses(read.result, restLength!);
				editor.removeInstruction(read.instruction);
			}
			editor.removeInstruction(producer);
			return editor.commit();
		}
		return undefined;
	},
};

const scalarizeBoundedRestReads: CoreFunctionPass = {
	name: "scalarize-bounded-rest-reads",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["createRestArguments"],
	requiredAnalyses: [
		CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
		CORE_LOOP_INDUCTION_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow", "facts", "representations"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		const fn = program.function(item.function);
		if (
			fn.isGenerator ||
			fn.isAsync ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			fn.metadata.mappedArguments ||
			fn.handlerBlockCount !== 0 ||
			!compilerFactIsWorldInvariant(
				compilationContext.facts.protectors.get("array-elements"),
			)
		) {
			return undefined;
		}
		for (const producer of fn.instructionIds()) {
			if (
				fn.instructionKind(producer) !== "operation" ||
				fn.instructionOpcodeName(producer) !== "createRestArguments"
			) {
				continue;
			}
			const startIndex = fn.instructionAttributes(producer).startIndex;
			if (
				typeof startIndex !== "number" ||
				!Number.isInteger(startIndex) ||
				startIndex < 0
			) {
				continue;
			}
			const rest = instructionResult(fn, producer, 0);
			if (
				rest === undefined ||
				fn.valueUseCount(rest) === 0 ||
				fn.kernel.valueHandlerUseCount(rest) !== 0
			) {
				continue;
			}
			let restUse = -1;
			const lengthReads: Array<{
				readonly instruction: CoreInstructionId;
				readonly result: CoreValueId;
			}> = [];
			let elementUses = 0;
			let valid = true;
			for (
				let use = fn.kernel.valueFirstUse(rest);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				const user = fn.kernel.useInstruction(use);
				if (fn.instructionKind(user) !== "operation") {
					valid = false;
					break;
				}
				const opcode = fn.instructionOpcodeName(user);
				if (opcode === "loadProperty" && instructionOperand(fn, user, 0) === rest) {
					elementUses++;
					if (restUse < 0) restUse = use;
					continue;
				}
				if (opcode === "loadPropertyStatic" && instructionOperand(fn, user, 0) === rest) {
					const stringIndex = fn.instructionAttributes(user).stringIndex;
					const result = instructionResult(fn, user, 0);
					if (
						typeof stringIndex === "number" &&
						decodeString(program, stringIndex) === "length" &&
						result !== undefined
					) {
						lengthReads.push({ instruction: user, result });
						continue;
					}
				}
				valid = false;
				break;
			}
			if (!valid || restUse < 0) continue;
			const load = fn.kernel.useInstruction(restUse);
			const key = instructionOperand(fn, load, 1);
			const loadResult = instructionResult(fn, load, 0);
			const block = fn.instructionBlock(load);
			const terminator = fn.blockTerminator(block);
			if (
				key === undefined ||
				loadResult === undefined ||
				fn.valueUseCount(loadResult) === 0 ||
				fn.kernel.valueHandlerUseCount(loadResult) !== 0
			) {
				continue;
			}
			const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
			if (
				!control.reachable.has(block) ||
				!control.dominates(fn.instructionBlock(producer), block)
			) {
				continue;
			}
			const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
			if (kinds.kindMask(key) !== COMPILER_VALUE_KIND_NUMBER) continue;
			const range = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS).range(key, block);
			if (
				range?.minimum !== 0 ||
				range.maximum < 1 ||
				range.maximum > 7 ||
				startIndex + range.maximum > 0x7fff_ffff
			) {
				continue;
			}

			let before = fn.blockTerminator(fn.entry);
			let argumentCount: CoreValueId | undefined;
			const snapshots = new Map<number, CoreValueId>();
			for (const instruction of fn.bodyInstructionIds(fn.entry)) {
				const opcode = fn.instructionOpcodeName(instruction);
				if (opcode !== "loadArgumentCount" && opcode !== "loadArgument") {
					before = instruction;
					break;
				}
				if (opcode === "loadArgumentCount") {
					argumentCount = instructionResult(fn, instruction, 0);
				} else {
					const index = fn.instructionAttributes(instruction).index;
					const result = instructionResult(fn, instruction, 0);
					if (typeof index === "number" && result !== undefined) {
						snapshots.set(index, result);
					}
				}
			}
			const editor = CoreEditor.open(program, item.function);
			if (lengthReads.length > 0 && argumentCount === undefined) {
				argumentCount = editor.insertInstruction(
					fn.entry,
					before,
					"loadArgumentCount",
					[],
					{ sourcePosition: fn.instructionSourcePosition(producer) },
				).outputs[0]!;
			}
			let restLength = argumentCount;
			if (lengthReads.length > 0 && startIndex > 0) {
				const prefixLength = editor.insertInstruction(
					fn.entry,
					before,
					"createNumber",
					[],
					{
						attributes: { value: startIndex },
						sourcePosition: fn.instructionSourcePosition(producer),
					},
				).outputs[0]!;
				const difference = editor.insertInstruction(
					fn.entry,
					before,
					"binary",
					[argumentCount!, prefixLength],
					{
						attributes: { operator: "-" },
						sourcePosition: fn.instructionSourcePosition(producer),
					},
				).outputs[0]!;
				const zero = editor.insertInstruction(fn.entry, before, "createNumber", [], {
					attributes: { value: 0 },
					sourcePosition: fn.instructionSourcePosition(producer),
				}).outputs[0]!;
				restLength = editor.insertInstruction(
					fn.entry,
					before,
					"mathBinaryNumber",
					[difference, zero],
					{
						attributes: {
							operation: "Math.max",
							worldAssumptions: {
								...builtinWorldAssumptions("Math.max", "primitive"),
							},
						},
						sourcePosition: fn.instructionSourcePosition(producer),
					},
				).outputs[0]!;
			}
			for (
				let argumentIndex = startIndex;
				argumentIndex <= startIndex + range.maximum;
				argumentIndex++
			) {
				if (snapshots.has(argumentIndex)) continue;
				const snapshot = editor.insertInstruction(fn.entry, before, "loadArgument", [], {
					attributes: { index: argumentIndex },
					sourcePosition: fn.instructionSourcePosition(producer),
				}).outputs[0]!;
				snapshots.set(argumentIndex, snapshot);
			}
			const sourcePosition = fn.instructionSourcePosition(terminator);
			const selectedEdges: Array<CoreEdge> = [];
			const terminalReturn =
				fn.valueUseCount(loadResult) === 1 &&
				fn.instructionNext(load) === terminator &&
				fn.instructionKind(terminator) === "return" &&
				instructionOperand(fn, terminator, 0) === loadResult;
			if (terminalReturn) {
				for (let offset = 0; offset <= range.maximum; offset++) {
					const selected = editor.createBlock();
					editor.setTerminator(selected, {
						kind: "return",
						value: snapshots.get(startIndex + offset)!,
						...(sourcePosition === undefined ? {} : { sourcePosition }),
					});
					selectedEdges.push({ block: selected, arguments: [] });
				}
			} else {
				const tail: Array<CoreInstructionId> = [];
				for (
					let instruction = fn.instructionNext(load);
					instruction !== undefined && instruction !== terminator;
					instruction = fn.instructionNext(instruction)
				) {
					tail.push(instruction);
				}
				const continuation = editor.createBlock([
					{ representation: fn.valueRepresentation(loadResult) },
				]);
				const selected = fn.kernel.blockParameterValue(
					fn.kernel.blockParameterStart(continuation),
				);
				for (const instruction of tail) editor.moveInstruction(instruction, continuation);
				editor.replaceValueUses(loadResult, selected);
				editor.setTerminator(continuation, {
					...terminatorInputForEdit(fn, terminator),
					...(sourcePosition === undefined ? {} : { sourcePosition }),
				});
				for (let offset = 0; offset <= range.maximum; offset++) {
					selectedEdges.push({
						block: continuation,
						arguments: [snapshots.get(startIndex + offset)!],
					});
				}
			}
			if (range.maximum === 1) {
				editor.replaceTerminator(block, {
					kind: "branch",
					condition: key,
					consequent: selectedEdges[1]!,
					alternate: selectedEdges[0]!,
				});
			} else {
				editor.replaceTerminator(block, {
					kind: "switch",
					discriminant: key,
					cases: Array.from({ length: range.maximum }, (_, value) => ({
						value: { kind: "number", value },
						edge: selectedEdges[value]!,
					})),
					default: selectedEdges[range.maximum]!,
				});
			}
			for (const read of lengthReads) {
				editor.replaceValueUses(read.result, restLength!);
				editor.removeInstruction(read.instruction);
			}
			editor.removeInstruction(load);
			if (elementUses === 1) editor.removeInstruction(producer);
			return editor.commit();
		}
		return undefined;
	},
};

export const CORE_LOCAL_CANONICALIZATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateTerminalYieldSites,
	forwardRestArguments,
	spreadArrayLiteralArguments,
	applyArrayLiteralArguments,
	scalarizeRestArgumentReads,
	scalarizeBoundedRestReads,
	rewriteExactBuiltinCalls,
	foldPrimitiveCoercions,
	rewriteNumericIdentities,
	canonicalizeBlockParameters,
	simplifyBlockParameters,
	eliminateForwardingBlocks,
	mergeLinearBlocks,
	removeBuiltinErrorContinuations,
	removeUnreachableBlocks,
	foldValueKindObservations,
	lowerLocalExplicitThrows,
	foldRedundantTdzChecks,
];

export const CORE_MANDATORY_CANONICALIZATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	canonicalizeBlockParameters,
];

export const CORE_CONSTRUCTION_ANNOTATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateTerminalYieldSites,
];

export const CORE_CONSTRUCTION_NORMALIZATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	simplifyBlockParameters,
	eliminateForwardingBlocks,
	mergeLinearBlocks,
	removeUnreachableBlocks,
];

// General parameter folding and block merging need changed edges; dead parameters also follow body edits.
// Forwarding elimination stays out: it would undo the preheaders that loop analyses need.
function afterLateCfgEdits(pass: CoreFunctionPass): CoreFunctionPass {
	return { ...pass, wakesOn: ["cfg"] };
}

export const eliminateUnusedBlockParameters: CoreFunctionPass = {
	...simplifyBlockParameters,
	name: "unused-block-parameter-elimination",
	admission: {
		predicate: "unused ordinary block parameter",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const block of fn.blockIds()) {
				if (block === fn.entry) continue;
				const count = fn.kernel.blockParameterCount(block);
				if (count === 0) continue;
				const start = fn.kernel.blockParameterStart(block);
				if (fn.kernel.blockParameterRole(start) === 1) continue;
				for (let index = 0; index < count; index++) {
					if (!valueHasUses(fn, fn.kernel.blockParameterValue(start + index)))
						return true;
				}
			}
			return false;
		},
	},
};

export const CORE_LATE_CANONICALIZATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	forwardRestArguments,
	spreadArrayLiteralArguments,
	applyArrayLiteralArguments,
	rewriteExactBuiltinCalls,
	foldPrimitiveCoercions,
	afterLateCfgEdits(canonicalizeBlockParameters),
	afterLateCfgEdits(simplifyBlockParameters),
	eliminateUnusedBlockParameters,
	afterLateCfgEdits(mergeLinearBlocks),
	foldValueKindObservations,
	foldRedundantTdzChecks,
	removeBuiltinErrorContinuations,
	removeUnreachableBlocks,
];
import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
