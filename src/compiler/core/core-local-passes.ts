import {
	builtinOperations,
	exactBuiltinCallDescriptor,
	mathUnaryOperationKeys,
} from "../shared/builtin-registry.ts";
import {
	compilerFactIsWorldInvariant,
	knownFact,
	sourceSiteId,
} from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
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
import { CoreEditor } from "./core-editor.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
} from "./core-ir-control-flow.ts";
import type { CoreControlEdge } from "./core-ir-control-flow.ts";
import { CORE_LOCAL_EXCEPTION_FLOW_ANALYSIS } from "./core-ir-exception-flow.ts";
import { coreOpcodeSet } from "./core-ir-opcodes.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreBlockId, coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreFactId,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

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

function instructionResultsHaveUses(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const start = fn.kernel.instructionResultStart(instruction);
	const count = fn.kernel.instructionResultCount(instruction);
	for (let index = 0; index < count; index++) {
		if (valueHasUses(fn, fn.kernel.resultAt(start + index))) return true;
	}
	return false;
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

function useOutsideBlock(
	fn: CoreFunctionStore,
	value: CoreValueId,
	block: CoreBlockId,
): boolean {
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

function copyTerminatorEdgesTo(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	target: CoreBlockId,
): Array<CoreEdge> {
	const edges = new Array<CoreEdge>();
	const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
	const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
	for (let offset = 0; offset < edgeCount; offset++) {
		if (fn.kernel.terminatorEdgeBlock(edgeStart + offset) === target) {
			edges.push(copyTerminatorEdge(fn, instruction, offset));
		}
	}
	return edges;
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
	if (fn.valueUseCount(value) > 0) return true;
	for (const block of fn.blockIds()) {
		if (handlerContainsValue(fn, block, value)) return true;
	}
	return false;
}

function immediateEqualsConstant(
	immediate: CoreImmediate,
	constant: LocalConstant,
): boolean {
	if (immediate.kind !== constant.kind) return false;
	switch (immediate.kind) {
		case "undefined":
		case "null":
			return true;
		case "boolean":
		case "number":
			return immediate.value === (constant as { readonly value: unknown }).value;
		case "string":
			return immediate.index === (constant as { readonly index: number }).index;
	}
}

function constantOpcode(constant: LocalConstant): {
	readonly opcode: string;
	readonly attributes: CoreInstructionAttributes;
} {
	switch (constant.kind) {
		case "undefined":
			return { opcode: "createUndefined", attributes: {} };
		case "null":
			return { opcode: "createNull", attributes: {} };
		case "boolean":
			return { opcode: "createBoolean", attributes: { value: constant.value } };
		case "number": {
			const int32 =
				!Object.is(constant.value, -0) &&
				Number.isInteger(constant.value) &&
				constant.value >= -0x8000_0000 &&
				constant.value <= 0x7fff_ffff;
			return {
				opcode: int32 ? "createNumber" : "createF64",
				attributes: { value: constant.value },
			};
		}
		case "string":
			return { opcode: "createString", attributes: { stringIndex: constant.index } };
	}
}

function numberBinary(
	operator: CoreAttributeValue,
	left: number,
	right: number,
): LocalConstant | undefined {
	switch (operator) {
		case "+":
			return { kind: "number", value: left + right };
		case "-":
			return { kind: "number", value: left - right };
		case "*":
			return { kind: "number", value: left * right };
		case "/":
			return { kind: "number", value: left / right };
		case "%":
			return { kind: "number", value: left % right };
		case "**":
			return { kind: "number", value: left ** right };
		case "&":
			return { kind: "number", value: left & right };
		case "|":
			return { kind: "number", value: left | right };
		case "^":
			return { kind: "number", value: left ^ right };
		case "<<":
			return { kind: "number", value: left << right };
		case ">>":
			return { kind: "number", value: left >> right };
		case ">>>":
			return { kind: "number", value: left >>> right };
		case "<":
			return { kind: "boolean", value: left < right };
		case "<=":
			return { kind: "boolean", value: left <= right };
		case ">":
			return { kind: "boolean", value: left > right };
		case ">=":
			return { kind: "boolean", value: left >= right };
		case "==":
		case "===":
			return { kind: "boolean", value: left === right };
		case "!=":
		case "!==":
			return { kind: "boolean", value: left !== right };
		default:
			return undefined;
	}
}

function numberUnary(
	operator: CoreAttributeValue,
	value: number,
): LocalConstant | undefined {
	switch (operator) {
		case "!":
			return { kind: "boolean", value: !value };
		case "-":
			return { kind: "number", value: -value };
		case "+":
			return { kind: "number", value };
		case "~":
			return { kind: "number", value: ~value };
		case "tonumeric":
			return { kind: "number", value };
		case "increment":
			return { kind: "number", value: value + 1 };
		case "decrement":
			return { kind: "number", value: value - 1 };
		default:
			return undefined;
	}
}

function strictPrimitiveEquality(
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
		case "number":
			return left.value === (right as { readonly value: unknown }).value;
		case "string": {
			const rightString = right as { readonly kind: "string"; readonly index: number };
			return (
				decodeString(program, left.index) === decodeString(program, rightString.index)
			);
		}
	}
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

function abstractPrimitiveEquality(
	program: CoreProgram,
	left: LocalConstant,
	right: LocalConstant,
): boolean {
	if (left.kind === right.kind) return strictPrimitiveEquality(program, left, right);
	if (
		(left.kind === "null" && right.kind === "undefined") ||
		(left.kind === "undefined" && right.kind === "null")
	)
		return true;
	if (left.kind === "boolean") {
		return abstractPrimitiveEquality(
			program,
			{ kind: "number", value: left.value ? 1 : 0 },
			right,
		);
	}
	if (right.kind === "boolean") {
		return abstractPrimitiveEquality(program, left, {
			kind: "number",
			value: right.value ? 1 : 0,
		});
	}
	if (left.kind === "number" && right.kind === "string") {
		const value = decodeString(program, right.index);
		return value !== undefined && left.value === Number(value);
	}
	if (left.kind === "string" && right.kind === "number") {
		const value = decodeString(program, left.index);
		return value !== undefined && Number(value) === right.value;
	}
	return false;
}

function foldInstruction(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): LocalConstant | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const attributes = fn.instructionAttributes(instruction);
	if (opcode === "binary") {
		const leftValue = instructionOperand(fn, instruction, 0);
		const rightValue = instructionOperand(fn, instruction, 1);
		if (leftValue === undefined || rightValue === undefined) return undefined;
		const left = constantForValue(fn, leftValue);
		const right = constantForValue(fn, rightValue);
		if (left === undefined || right === undefined) return undefined;
		if (
			attributes.operator === "==" ||
			attributes.operator === "!=" ||
			attributes.operator === "===" ||
			attributes.operator === "!=="
		) {
			const loose = attributes.operator === "==" || attributes.operator === "!=";
			const equal = loose
				? abstractPrimitiveEquality(program, left, right)
				: strictPrimitiveEquality(program, left, right);
			return {
				kind: "boolean",
				value:
					attributes.operator === "!=" || attributes.operator === "!==" ? !equal : equal,
			};
		}
		return left.kind === "number" && right.kind === "number"
			? numberBinary(attributes.operator, left.value, right.value)
			: undefined;
	}
	if (opcode === "unary") {
		const inputValue = instructionOperand(fn, instruction, 0);
		const input = inputValue === undefined ? undefined : constantForValue(fn, inputValue);
		return input?.kind === "number"
			? numberUnary(attributes.operator, input.value)
			: input?.kind === "boolean" && attributes.operator === "!"
				? { kind: "boolean", value: !input.value }
				: undefined;
	}
	if (opcode === "typeofCompare") {
		const inputValue = instructionOperand(fn, instruction, 0);
		const input = inputValue === undefined ? undefined : constantForValue(fn, inputValue);
		if (input === undefined || typeof attributes.expected !== "string") return undefined;
		const actual = input.kind === "null" ? "object" : input.kind;
		const matches = actual === attributes.expected;
		return {
			kind: "boolean",
			value: attributes.negated === true ? !matches : matches,
		};
	}
	return undefined;
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
				cases: payload.cases.map(({ value, edge }) => ({ value, edge: rewrite(edge) })),
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
		[...fn.bodyInstructionIds(target.block)].length === 0 &&
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

const annotateTerminalYieldSites: CorePass = {
	name: "annotate-terminal-yield-sites",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [],
	wakesOn: ["body", "cfg", "exceptionFlow"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "function") return undefined;
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
					attributes: { ...fn.instructionAttributes(instruction), terminal: true },
					sourcePosition: fn.instructionSourcePosition(instruction),
				},
			);
		}
		return editor.commit();
	},
};

const foldStaticPropertyKeys: CorePass = {
	name: "fold-static-property-keys",
	stage: "canonicalize",
	scope: "instruction",
	instructionOpcodes: coreOpcodeSet("loadProperty", "storeProperty"),
	requiredAnalyses: [],
	wakesOn: ["body"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation"
		) {
			return undefined;
		}
		const opcode = fn.instructionOpcodeName(item.instruction);
		if (opcode !== "loadProperty" && opcode !== "storeProperty") return undefined;
		const key = instructionOperand(fn, item.instruction, 1);
		if (key === undefined) return undefined;
		const constant = constantForValue(fn, key);
		if (constant?.kind !== "string") return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(
			item.instruction,
			opcode === "loadProperty" ? "loadPropertyStatic" : "storePropertyStatic",
			copyInstructionOperands(fn, item.instruction).filter((_, index) => index !== 1),
			{
				attributes: {
					...fn.instructionAttributes(item.instruction),
					stringIndex: constant.index,
				},
				sourcePosition: fn.instructionSourcePosition(item.instruction),
			},
		);
		return editor.commit();
	},
};

function decodeString(program: CoreProgram, index: number): string | undefined {
	const units = program.stringConstants[index];
	return units === undefined ? undefined : String.fromCodePoint(...units);
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
			return false;
	}
	return false;
}

const rewriteExactBuiltinCalls: CorePass = {
	name: "rewrite-exact-builtin-calls",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "facts"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { ...LOCAL_CHANGES, representations: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const calls = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "call",
		);
		if (calls.length === 0) return undefined;
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		let kinds: CoreValueKindAnalysis | undefined;
		let editor: CoreEditor | undefined;
		for (const instruction of calls) {
			if (!fn.isInstructionLive(instruction)) continue;
			const existingKnownBuiltinCall =
				fn.instructionAttributes(instruction).knownBuiltinCall;
			const inputs = copyInstructionOperands(fn, instruction);
			const [callee, receiver] = inputs;
			if (callee === undefined || receiver === undefined) continue;
			const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
			const receiverRoot = root(receiver);
			const property = definingInstruction(fn, root(callee));
			if (property === undefined) continue;
			const propertyReceiver = instructionOperand(fn, property, 0);
			if (
				fn.instructionOpcodeName(property) !== "loadPropertyStatic" ||
				propertyReceiver === undefined ||
				root(propertyReceiver) !== receiverRoot
			) {
				continue;
			}
			const stringIndex = fn.instructionAttributes(property).stringIndex;
			if (typeof stringIndex !== "number") continue;
			const key = decodeString(program, stringIndex);
			const candidates =
				key === undefined ? [] : (BUILTIN_OPERATIONS_BY_KEY.get(key) ?? []);
			const ownerMatches = candidates.filter((candidate) => {
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
			const compatibleCollectionCollision =
				candidates.length === 2 &&
				(key === "has" || key === "delete") &&
				candidates.some(({ owner }) => owner === "Map.prototype") &&
				candidates.some(({ owner }) => owner === "Set.prototype");
			const descriptor =
				candidates.length === 1
					? candidates[0]
					: ownerMatches.length === 1
						? ownerMatches[0]
						: compatibleCollectionCollision
							? candidates[0]
							: undefined;
			if (descriptor === undefined) continue;
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
			const nativeMathArgument = (value: CoreValueId): boolean => {
				if (fn.valueRepresentation(value) === "f64") return true;
				const scalar = (kinds ??= context.analysis(
					CORE_LOCAL_VALUE_KIND_ANALYSIS,
				)).exactScalar(value);
				if (scalar !== "int32" && scalar !== "number") return false;
				const definition = definingInstruction(fn, value);
				return (
					definition !== undefined &&
					(fn.instructionOpcodeName(definition) === "createNumber" ||
						fn.instructionOpcodeName(definition) === "createF64")
				);
			};
			const numericRewrite =
				numericOpcode !== undefined &&
				exactIntrinsicReceiver &&
				compilerFactIsWorldInvariant(sharedIdentity) &&
				sharedIdentity.value === descriptor.id &&
				descriptor.nativeNumberArity === arguments_.length &&
				arguments_.every(nativeMathArgument) &&
				fn.kernel.instructionResultCount(instruction) === 1 &&
				fn.kernel.instructionResultCount(property) === 1 &&
				propertyResult !== undefined &&
				fn.valueUseCount(propertyResult) === 1
					? numericOpcode
					: undefined;
			const exactRewrite =
				exact !== undefined &&
				exactBuiltinReceiver(fn, receiverRoot, descriptor.owner, exact.receiverProof) &&
				compilerFactIsWorldInvariant(sharedIdentity) &&
				sharedIdentity.value === descriptor.id &&
				fn.kernel.instructionResultCount(property) === 1 &&
				propertyResult === callee &&
				fn.valueUseCount(callee) === 1
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
				existingKnownBuiltinCall !== undefined
			) {
				continue;
			}
			editor ??= CoreEditor.open(program, item.function);
			if (numericRewrite !== undefined) {
				editor.replaceInstruction(instruction, numericRewrite, arguments_, {
					attributes: { operation: descriptor.id },
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				for (const argument of arguments_) editor.setValueRepresentation(argument, "f64");
				editor.setValueRepresentation(instructionResult(fn, instruction, 0)!, "f64");
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
				editor.replaceInstruction(instruction, "callBuiltin", [receiver, ...forwarded], {
					attributes: {
						operation: exactRewrite.id,
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

const foldConstants: CorePass = {
	name: "local-constant-folding",
	stage: "canonicalize",
	scope: "instruction",
	instructionOpcodes: coreOpcodeSet("binary", "unary", "typeofCompare"),
	requiredAnalyses: [],
	wakesOn: ["body"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.kernel.instructionResultCount(item.instruction) !== 1
		)
			return undefined;
		const folded = foldInstruction(program, fn, item.instruction);
		if (folded === undefined) return undefined;
		const replacement = constantOpcode(folded);
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(item.instruction, replacement.opcode, [], {
			attributes: replacement.attributes,
			sourcePosition: fn.instructionSourcePosition(item.instruction),
		});
		return editor.commit();
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

function typeofObservation(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	other: CoreValueId,
	kindMask: (value: CoreValueId) => number,
): boolean | undefined {
	const definition = definingInstruction(fn, value);
	if (
		definition === undefined ||
		fn.instructionKind(definition) !== "operation" ||
		fn.instructionOpcodeName(definition) !== "unary" ||
		fn.instructionAttributes(definition).operator !== "typeof"
	)
		return undefined;
	const input = instructionOperand(fn, definition, 0);
	const constant = constantForValue(fn, other);
	if (input === undefined || constant?.kind !== "string") return undefined;
	const actual = exactPrimitiveTypeof(kindMask(input));
	const expected = String.fromCharCode(
		...(program.stringConstants[constant.index] ?? []),
	);
	return actual === undefined ? undefined : actual === expected;
}

const TYPEOF_RESULTS: ReadonlySet<string> = new Set([
	"undefined",
	"object",
	"boolean",
	"number",
	"string",
	"symbol",
	"bigint",
	"function",
]);

const foldValueKindObservations: CorePass = {
	name: "value-kind-observation-folding",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const replacements: Array<{
			readonly instruction: CoreInstructionId;
			readonly result: boolean;
		}> = [];
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			let result: boolean | undefined;
			if (opcode === "unary" && fn.instructionAttributes(instruction).operator === "!") {
				const input = instructionOperand(fn, instruction, 0);
				if (
					input !== undefined &&
					compilerValueKindMaskIsSubset(
						kinds.kindMask(input),
						COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_NULL,
					)
				)
					result = true;
			} else if (
				opcode === "binary" &&
				fn.kernel.instructionOperandCount(instruction) === 2
			) {
				const left = instructionOperand(fn, instruction, 0)!;
				const right = instructionOperand(fn, instruction, 1)!;
				const operator = fn.instructionAttributes(instruction).operator;
				if (operator === "===" || operator === "!==") {
					const typeofResult =
						typeofObservation(program, fn, left, right, (value) =>
							kinds.kindMask(value),
						) ??
						typeofObservation(program, fn, right, left, (value) => kinds.kindMask(value));
					const equal =
						typeofResult ??
						((kinds.kindMask(left) & kinds.kindMask(right)) === 0 ? false : undefined);
					result = equal === undefined ? undefined : operator === "===" ? equal : !equal;
				}
			}
			if (result !== undefined) replacements.push({ instruction, result });
		}
		if (replacements.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const { instruction, result } of replacements) {
			editor.replaceInstruction(instruction, "createBoolean", [], {
				attributes: { value: result },
				sourcePosition: fn.instructionSourcePosition(instruction),
			});
		}
		return editor.commit();
	},
};

const foldTypeofComparisons: CorePass = {
	name: "typeof-comparison-canonicalization",
	stage: "canonicalize",
	scope: "instruction",
	instructionOpcodes: coreOpcodeSet("binary"),
	requiredAnalyses: [],
	wakesOn: ["body"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionOpcodeName(item.instruction) !== "binary"
		)
			return undefined;
		const operator = fn.instructionAttributes(item.instruction).operator;
		if (
			operator !== "===" &&
			operator !== "!==" &&
			operator !== "==" &&
			operator !== "!="
		)
			return undefined;
		if (fn.kernel.instructionOperandCount(item.instruction) !== 2) return undefined;
		const left = instructionOperand(fn, item.instruction, 0)!;
		const right = instructionOperand(fn, item.instruction, 1)!;
		const typeofInput = (value: CoreValueId): CoreValueId | undefined => {
			const definition = definingInstruction(fn, value);
			if (
				definition === undefined ||
				fn.instructionKind(definition) !== "operation" ||
				fn.instructionOpcodeName(definition) !== "unary" ||
				fn.instructionAttributes(definition).operator !== "typeof"
			)
				return undefined;
			return instructionOperand(fn, definition, 0);
		};
		const leftInput = typeofInput(left);
		const rightInput = typeofInput(right);
		const input = leftInput ?? rightInput;
		const constant = constantForValue(fn, leftInput === undefined ? left : right);
		if (input === undefined || constant?.kind !== "string") return undefined;
		const expected = String.fromCharCode(
			...(program.stringConstants[constant.index] ?? []),
		);
		if (!TYPEOF_RESULTS.has(expected)) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(item.instruction, "typeofCompare", [input], {
			attributes: { expected, negated: operator === "!==" || operator === "!=" },
			sourcePosition: fn.instructionSourcePosition(item.instruction),
		});
		return editor.commit();
	},
};

const foldPrimitiveCoercions: CorePass = {
	name: "primitive-coercion-folding",
	stage: "canonicalize",
	scope: "instruction",
	instructionOpcodes: coreOpcodeSet("requireCoercible", "toPropertyKey", "unary"),
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation"
		)
			return undefined;
		const opcode = fn.instructionOpcodeName(item.instruction);
		if (opcode !== "requireCoercible" && opcode !== "toPropertyKey" && opcode !== "unary")
			return undefined;
		if (opcode === "unary") {
			const input = instructionOperand(fn, item.instruction, 0);
			const result = instructionResult(fn, item.instruction, 0);
			if (
				fn.instructionAttributes(item.instruction).operator !== "tonumeric" ||
				input === undefined ||
				result === undefined ||
				(fn.valueRepresentation(input) !== "f64" &&
					fn.valueRepresentation(input) !== "i32") ||
				fn.valueRepresentation(result) !== fn.valueRepresentation(input)
			)
				return undefined;
			const editor = CoreEditor.open(program, item.function);
			editor.replaceValueUses(result, input);
			editor.removeInstruction(item.instruction);
			return editor.commit();
		}
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const coercible = (value: CoreValueId): boolean => {
			const mask = kinds.kindMask(value);
			return (
				mask !== 0 &&
				(mask & (COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_UNDEFINED)) === 0
			);
		};
		if (opcode === "requireCoercible") {
			const value = instructionOperand(fn, item.instruction, 0);
			if (value === undefined || !coercible(value)) return undefined;
			const editor = CoreEditor.open(program, item.function);
			editor.removeInstruction(item.instruction);
			return editor.commit();
		}
		const base = instructionOperand(fn, item.instruction, 0);
		const key = instructionOperand(fn, item.instruction, 1);
		const result = instructionResult(fn, item.instruction, 0);
		if (base === undefined || key === undefined || result === undefined) return undefined;
		if (
			!compilerValueKindMaskIsSubset(
				kinds.kindMask(key),
				COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL,
			)
		)
			return undefined;
		const editor = CoreEditor.open(program, item.function);
		if (!coercible(base)) {
			editor.insertInstruction(
				fn.instructionBlock(item.instruction),
				item.instruction,
				"requireCoercible",
				[base],
				{
					outputCount: 0,
					sourcePosition: fn.instructionSourcePosition(item.instruction),
				},
			);
		}
		editor.replaceValueUses(result, key);
		editor.removeInstruction(item.instruction);
		return editor.commit();
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
	if (receiver !== "map" && receiver !== "set") return false;
	const construction = definingInstruction(fn, value);
	if (construction === undefined) return false;
	if (fn.instructionOpcodeName(construction) !== "construct") return false;
	const constructor = instructionOperand(fn, construction, 0);
	if (constructor === undefined) return false;
	const constructorDefinition = definingInstruction(fn, root(constructor));
	if (constructorDefinition === undefined) return false;
	return (
		fn.instructionOpcodeName(constructorDefinition) === "loadIntrinsic" &&
		fn.instructionAttributes(constructorDefinition).intrinsic ===
			(receiver === "map" ? "Map" : "Set")
	);
}

const rewriteNumericIdentities: CorePass = {
	name: "numeric-algebraic-simplification",
	stage: "canonicalize",
	scope: "instruction",
	instructionOpcodes: coreOpcodeSet("binary"),
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionOpcodeName(item.instruction) !== "binary"
		)
			return undefined;
		const left = instructionOperand(fn, item.instruction, 0);
		const right = instructionOperand(fn, item.instruction, 1);
		const result = instructionResult(fn, item.instruction, 0);
		if (left === undefined || right === undefined || result === undefined)
			return undefined;
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const numeric = (value: CoreValueId): boolean => {
			const kind = kinds.exactScalar(value);
			return kind === "number" || kind === "int32";
		};
		if (!numeric(left) || !numeric(right)) return undefined;
		const operator = fn.instructionAttributes(item.instruction).operator;
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
			const editor = CoreEditor.open(program, item.function);
			editor.replaceValueUses(result, replacement);
			editor.removeInstruction(item.instruction);
			return editor.commit();
		}
		if (
			operator === "&" &&
			((leftConstant?.kind === "number" && leftConstant.value === 0) ||
				(rightConstant?.kind === "number" && rightConstant.value === 0))
		) {
			const editor = CoreEditor.open(program, item.function);
			editor.replaceInstruction(item.instruction, "createNumber", [], {
				attributes: { value: 0 },
				sourcePosition: fn.instructionSourcePosition(item.instruction),
			});
			return editor.commit();
		}
		if (left === right && (operator === "<" || operator === ">")) {
			const editor = CoreEditor.open(program, item.function);
			editor.replaceInstruction(item.instruction, "createBoolean", [], {
				attributes: { value: false },
				sourcePosition: fn.instructionSourcePosition(item.instruction),
			});
			return editor.commit();
		}
		const flipped = flippedComparison(operator);
		if (flipped !== undefined && leftConstant?.kind === "number") {
			const editor = CoreEditor.open(program, item.function);
			editor.replaceInstruction(item.instruction, "binary", [right, left], {
				attributes: {
					...fn.instructionAttributes(item.instruction),
					operator: flipped,
				},
				sourcePosition: fn.instructionSourcePosition(item.instruction),
				effectRefinement: fn.instructionEffectRefinement(item.instruction),
			});
			return editor.commit();
		}
		return undefined;
	},
};

const foldControlFlow: CorePass = {
	name: "local-control-folding",
	stage: "canonicalize",
	scope: "block",
	requiredAnalyses: [],
	wakesOn: ["body", "cfg"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "block") return undefined;
		const fn = program.function(item.function);
		if (!fn.isBlockLive(item.block)) return undefined;
		const terminator = fn.blockTerminator(item.block);
		const kind = fn.instructionKind(terminator);
		let selected: CoreEdge | undefined;
		let removedFact: CoreFactId | undefined;
		if (kind === "branch") {
			const conditionValue = instructionOperand(fn, terminator, 0);
			if (conditionValue === undefined) return undefined;
			const consequent = copyTerminatorEdge(fn, terminator, 0);
			const alternate = copyTerminatorEdge(fn, terminator, 1);
			const condition = constantForValue(fn, conditionValue);
			if (condition?.kind === "boolean") {
				selected = condition.value ? consequent : alternate;
			} else if (sameEdge(consequent, alternate)) {
				selected = consequent;
			}
		} else if (kind === "switch") {
			const discriminantValue = instructionOperand(fn, terminator, 0);
			if (discriminantValue === undefined) return undefined;
			const discriminant = constantForValue(fn, discriminantValue);
			if (discriminant !== undefined) {
				const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
				const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
				for (let offset = 0; offset < edgeCount - 1; offset++) {
					const value = fn.kernel.terminatorEdgeCaseValue(edgeStart + offset);
					if (value !== undefined && immediateEqualsConstant(value, discriminant)) {
						selected = copyTerminatorEdge(fn, terminator, offset);
						break;
					}
				}
				selected ??= copyTerminatorEdge(fn, terminator, edgeCount - 1);
			}
		} else if (kind === "guard") {
			const success = copyTerminatorEdge(fn, terminator, 0);
			const fallback = copyTerminatorEdge(fn, terminator, 1);
			if (!sameEdge(success, fallback)) return undefined;
			const factId = fn.kernel.terminatorFact(terminator);
			if (factId === undefined) return undefined;
			const fact = fn.fact(factId);
			const exclusivelyGuardsTerminator = fact.obligations.every(
				(obligation) =>
					obligation.kind === "guard" && obligation.instruction === terminator,
			);
			const usedByRefinement = [...fn.instructionIds()].some(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionEffectRefinement(instruction)?.proof === factId,
			);
			if (exclusivelyGuardsTerminator && !usedByRefinement) {
				selected = success;
				removedFact = factId;
			}
		}
		if (selected === undefined) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceTerminator(item.block, { kind: "jump", edge: selected });
		if (removedFact !== undefined) editor.removeFact(removedFact);
		return editor.commit();
	},
};

const foldRedundantTdzChecks: CorePass = {
	name: "redundant-tdz-check-folding",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const checks = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "throwIfTdz",
		);
		if (checks.length === 0) return undefined;
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const known = new Map<CoreValueId, boolean>();
		const visiting = new Set<CoreValueId>();
		const excludesEmpty = (value: CoreValueId): boolean => {
			const cached = known.get(value);
			if (cached !== undefined) return cached;
			if (visiting.has(value)) return false;
			visiting.add(value);
			const definitionKind = fn.kernel.valueDefinitionKind(value);
			const definitionOwner = fn.kernel.valueDefinitionOwner(value);
			const definitionIndex = fn.kernel.valueDefinitionIndex(value);
			let result: boolean;
			if (definitionKind === 0) {
				const block = coreBlockId(definitionOwner);
				const parameterRow = fn.kernel.blockParameterStart(block) + definitionIndex;
				if (
					fn.kernel.blockParameterRole(parameterRow) === 1 ||
					isFunctionParameter(fn, value)
				) {
					result = true;
				} else {
					const incoming = control.predecessors[block] ?? [];
					result =
						incoming.length > 0 &&
						incoming.every((edge) => {
							const argument =
								edge.arguments[
									edge.kind === "exceptional" ? definitionIndex - 1 : definitionIndex
								];
							return argument !== undefined && excludesEmpty(argument);
						});
				}
			} else {
				const instruction = coreInstructionId(definitionOwner);
				const opcode = fn.instructionOpcodeName(instruction);
				const source = instructionOperand(fn, instruction, 0);
				result =
					opcode === "move"
						? source !== undefined && excludesEmpty(source)
						: ![
								"createEmpty",
								"loadCaptured",
								"loadGlobal",
								"loadLocal",
								"loadProperty",
								"loadPropertyStatic",
								"loadPropertyStaticShapeCase",
								"loadThis",
							].includes(opcode);
			}
			visiting.delete(value);
			known.set(value, result);
			return result;
		};
		const redundant: Array<{
			readonly instruction: CoreInstructionId;
			readonly input: CoreValueId;
		}> = [];
		for (const instruction of checks) {
			const input = instructionOperand(fn, instruction, 0);
			if (
				input === undefined ||
				(kinds.kindMask(input) === COMPILER_VALUE_KIND_TOP && !excludesEmpty(input))
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

function stableAttribute(value: CoreAttributeValue): string {
	if (Array.isArray(value)) return `[${value.map(stableAttribute).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${key}:${stableAttribute(entry)}`)
			.join(",")}}`;
	}
	if (typeof value === "number") {
		return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
	}
	return JSON.stringify(value);
}

const localValueNumbering: CorePass = {
	name: "local-value-numbering",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [],
	wakesOn: ["body"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const replacements = new Map<CoreInstructionId, CoreValueId>();
		for (const block of fn.blockIds()) {
			const available = new Map<string, CoreValueId>();
			for (const instruction of fn.bodyInstructionIds(block)) {
				const descriptor = program.registry.byId(fn.instructionOpcode(instruction));
				const effects = descriptor.effects;
				if (
					fn.kernel.instructionResultCount(instruction) !== 1 ||
					!descriptor.discardable ||
					effects.reads.length > 0 ||
					effects.writes.length > 0 ||
					effects.mayThrow ||
					effects.maySuspend ||
					effects.mayGc ||
					effects.callsUserCode
				)
					continue;
				const operandStart = fn.kernel.instructionOperandStart(instruction);
				const operandCount = fn.kernel.instructionOperandCount(instruction);
				let operandKey = "";
				for (let index = 0; index < operandCount; index++) {
					if (index > 0) operandKey += ",";
					operandKey += fn.kernel.operandAt(operandStart + index);
				}
				const key = `${descriptor.opcode}|${operandKey}|${stableAttribute(fn.instructionAttributes(instruction))}`;
				const existing = available.get(key);
				if (existing === undefined)
					available.set(key, instructionResult(fn, instruction, 0)!);
				else replacements.set(instruction, existing);
			}
		}
		if (replacements.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const [instruction, replacement] of replacements) {
			if (!fn.isInstructionLive(instruction)) continue;
			const result = instructionResult(fn, instruction, 0);
			if (result === undefined) continue;
			editor.replaceValueUses(result, replacement);
			editor.removeInstruction(instruction);
		}
		return editor.commit();
	},
};

const lowerLocalExplicitThrows: CorePass = {
	name: "local-explicit-throw-lowering",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [CORE_LOCAL_EXCEPTION_FLOW_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects", "representations"],
	preserves: [],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
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

const removeUnreachableBlocks: CorePass = {
	name: "unreachable-block-removal",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["cfg", "exceptionFlow"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const reachable = new Set(control.reachable);
		const pendingRoots = fn.bodyEntry === undefined ? [] : [fn.bodyEntry];
		while (pendingRoots.length > 0) {
			const block = pendingRoots.pop()!;
			if (reachable.has(block)) continue;
			reachable.add(block);
			for (const edge of control.successors[block] ?? []) pendingRoots.push(edge.to);
		}
		const blocks = [...fn.blockIds()].filter((block) => !reachable.has(block));
		if (blocks.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		const removed = new Set(blocks);
		for (const block of fn.blockIds()) {
			if (removed.has(block)) continue;
			const handler = fn.kernel.blockHandlerBlock(block);
			if (handler !== undefined && removed.has(handler)) editor.clearHandler(block);
		}
		const pending = new Set(blocks.flatMap((block) => [...fn.instructionIds(block)]));
		const queue = new Array<CoreInstructionId>();
		const queued = new Set<CoreInstructionId>();
		const enqueueIfDead = (instruction: CoreInstructionId): void => {
			if (
				!pending.has(instruction) ||
				queued.has(instruction) ||
				instructionResultsHaveUses(fn, instruction)
			) {
				return;
			}
			queued.add(instruction);
			queue.push(instruction);
		};
		for (const instruction of pending) enqueueIfDead(instruction);
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const instruction = queue[cursor]!;
			queued.delete(instruction);
			if (!pending.has(instruction)) continue;
			if (instructionResultsHaveUses(fn, instruction)) continue;
			const dependencies = copyInstructionOperands(fn, instruction).flatMap((value) => {
				const definition = definingInstruction(fn, value);
				return definition === undefined ? [] : [definition];
			});
			editor.removeInstruction(instruction);
			pending.delete(instruction);
			for (const dependency of dependencies) enqueueIfDead(dependency);
		}
		if (pending.size > 0)
			throw new Error("Unreachable Core instructions retain external uses");
		for (const block of blocks) editor.removeBlock(block);
		return editor.commit();
	},
};

const eliminateForwardingBlocks: CorePass = {
	name: "forwarding-block-elimination",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["cfg", "body", "exceptionFlow"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
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
			if ([...fn.bodyInstructionIds(block)].length !== 0) continue;
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

function sameEdge(left: CoreEdge | undefined, right: CoreEdge | undefined): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.block === right.block &&
			left.arguments.length === right.arguments.length &&
			left.arguments.every((value, index) => value === right.arguments[index]))
	);
}

const mergeLinearBlocks: CorePass = {
	name: "linear-block-merging",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["cfg", "body", "exceptionFlow"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item, remainingEdits } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const protectedLoopBlocks = new Set(
			control.loops.flatMap((loop) => [
				loop.header,
				...loop.latches,
				...loop.exits.filter(({ dedicated }) => dedicated).map(({ to }) => to),
			]),
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
				protectedLoopBlocks.has(predecessor) ||
				protectedLoopBlocks.has(target) ||
				!fn.isBlockLive(target) ||
				!sameHandler(fn, predecessor, target)
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
			if (estimatedEdits + candidateEdits > remainingEdits) continue;
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

const simplifyBlockParameters: CorePass = {
	name: "block-parameter-simplification",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["cfg", "body"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		let editor: CoreEditor | undefined;
		for (const block of fn.blockIds()) {
			const incoming = control.predecessors[block] ?? [];
			if (incoming.length === 0 || incoming.some(({ kind }) => kind === "exceptional")) {
				continue;
			}
			const parameterStart = fn.kernel.blockParameterStart(block);
			const parameterCount = fn.kernel.blockParameterCount(block);
			const parameters = Array.from({ length: parameterCount }, (_, index) => {
				const row = parameterStart + index;
				const value = fn.kernel.blockParameterValue(row);
				return {
					value,
					representation: fn.valueRepresentation(value),
					role: fn.kernel.blockParameterRole(row) === 1 ? "exception" : "value",
				} as const;
			});
			const predecessors = [...new Set(incoming.map(({ from }) => from))];
			const currentIncoming = predecessors.flatMap((source) =>
				copyTerminatorEdgesTo(fn, fn.blockTerminator(source), block),
			);
			const removable: Array<{
				readonly index: number;
				readonly parameter: (typeof parameters)[number];
				readonly replacement: CoreValueId | undefined;
				readonly replacementConstant: LocalConstant | undefined;
				readonly sameValue: boolean;
				readonly unused: boolean;
			}> = [];
			for (let index = parameters.length - 1; index >= 0; index--) {
				if (parameters[index]!.role !== "value") continue;
				const arguments_ = currentIncoming.map((edge) => edge.arguments[index]);
				const replacement = arguments_[0];
				const replacementConstant =
					replacement === undefined ? undefined : constantForValue(fn, replacement);
				const equivalentConstants =
					replacementConstant !== undefined &&
					arguments_.every((argument) => {
						if (argument === undefined) return false;
						const constant = constantForValue(fn, argument);
						return (
							constant !== undefined &&
							constantsAreInterchangeable(program, replacementConstant, constant)
						);
					});
				const sameValue = arguments_.every((argument) => argument === replacement);
				const unused = !valueHasUses(fn, parameters[index]!.value);
				const replacementDefinitionKind =
					replacement === undefined
						? undefined
						: fn.kernel.valueDefinitionKind(replacement);
				const replacementDefinitionOwner =
					replacement === undefined
						? undefined
						: fn.kernel.valueDefinitionOwner(replacement);
				if (
					!unused &&
					(replacement === undefined ||
						replacement === parameters[index]!.value ||
						(replacementDefinitionKind === 0 && replacementDefinitionOwner === block) ||
						(!equivalentConstants && !sameValue))
				)
					continue;
				removable.push({
					index,
					parameter: parameters[index]!,
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

const canonicalizeBlockParameters: CorePass = {
	name: "canonical-block-parameter-elimination",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	],
	wakesOn: ["cfg", "body", "representations"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: CANONICAL_BLOCK_PARAMETER_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
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
				if (
					replacement === parameter ||
					!fn.isValueLive(replacement) ||
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

export const CORE_LOCAL_CANONICALIZATION_PASSES: ReadonlyArray<CorePass> = [
	annotateTerminalYieldSites,
	foldStaticPropertyKeys,
	rewriteExactBuiltinCalls,
	foldConstants,
	foldTypeofComparisons,
	foldPrimitiveCoercions,
	rewriteNumericIdentities,
	foldControlFlow,
	localValueNumbering,
	canonicalizeBlockParameters,
	simplifyBlockParameters,
	eliminateForwardingBlocks,
	mergeLinearBlocks,
	removeUnreachableBlocks,
	foldValueKindObservations,
	lowerLocalExplicitThrows,
	foldRedundantTdzChecks,
];

export const CORE_LOCAL_FINALIZATION_PASSES: ReadonlyArray<CorePass> = [
	{
		...rewriteExactBuiltinCalls,
		name: "post-representation-exact-builtin-calls",
		stage: "finalize",
	},
	{
		...foldPrimitiveCoercions,
		name: "post-representation-primitive-coercion-folding",
		stage: "finalize",
	},
	{
		...foldRedundantTdzChecks,
		name: "post-memory-tdz-check-folding",
		stage: "finalize",
	},
	{
		...removeUnreachableBlocks,
		name: "post-memory-unreachable-block-removal",
		stage: "finalize",
	},
];
