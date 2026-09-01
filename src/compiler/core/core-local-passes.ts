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
	coreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import { CORE_LOCAL_EXCEPTION_FLOW_ANALYSIS } from "./core-ir-exception-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import { coreFunctionId } from "./core-ir.ts";
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
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const LOCAL_BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 2_000_000,
	maxEdits: 1_000_000,
	exhaustion: "stop",
});

const LOCAL_CHANGES = Object.freeze({
	cfg: true,
	calls: true,
	facts: true,
	representations: false,
});

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
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction") return undefined;
	const instruction = definition.instruction;
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
		if (fn.blockHandler(block)?.arguments.includes(value) === true) return true;
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
	return editor.insertInstruction(block, fn.blockTerminator(block), opcode, [], {
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
	const inputs = fn.instructionOperands(instruction);
	const attributes = fn.instructionAttributes(instruction);
	if (opcode === "binary") {
		const left = constantForValue(fn, inputs[0]!);
		const right = constantForValue(fn, inputs[1]!);
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
		const input = constantForValue(fn, inputs[0]!);
		return input?.kind === "number"
			? numberUnary(attributes.operator, input.value)
			: input?.kind === "boolean" && attributes.operator === "!"
				? { kind: "boolean", value: !input.value }
				: undefined;
	}
	if (opcode === "typeofCompare") {
		const input = constantForValue(fn, inputs[0]!);
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
	payload: CoreTerminatorPayload,
	rewrite: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorInput {
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
	for (const [index, parameter] of fn.blockParameters(edge.block).entries()) {
		next.set(parameter.value, origin(edge.arguments[index]!, environment));
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
	const constantResults = fn.instructionResults(constant);
	const compareResults = fn.instructionResults(compare);
	const compareInputs = fn.instructionOperands(compare);
	return (
		fn.instructionOpcodeName(constant) === "createNumber" &&
		fn.instructionAttributes(constant).value === value &&
		constantResults.length === 1 &&
		fn.instructionOpcodeName(compare) === "binary" &&
		fn.instructionAttributes(compare).operator === "===" &&
		compareResults.length === 1 &&
		compareResults[0] === condition &&
		compareInputs.length === 2 &&
		origin(compareInputs[0]!, environment) === subject &&
		compareInputs[1] === constantResults[0] &&
		fn.terminatorPayload(fn.blockTerminator(block)).kind === "branch"
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
	const terminator = fn.terminatorPayload(fn.blockTerminator(target.block));
	return (
		[...fn.bodyInstructionIds(target.block)].length === 0 &&
		terminator.kind === kind &&
		origin(terminator.value, target.environment) === value
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
		const terminator = fn.terminatorPayload(fn.blockTerminator(state.block));
		if (instructions.length !== 0 || terminator.kind !== "jump") break;
		if (visited.has(state.block)) return false;
		visited.add(state.block);
		state = enterEdge(fn, terminator.edge, state.environment);
	}
	const instructions = [...fn.bodyInstructionIds(state.block)];
	const [created] = instructions;
	if (created === undefined) return false;
	const createdResults = fn.instructionResults(created);
	const terminator = fn.terminatorPayload(fn.blockTerminator(state.block));
	return (
		instructions.length === 1 &&
		fn.instructionOpcodeName(created) === "createUndefined" &&
		createdResults.length === 1 &&
		terminator.kind === "return" &&
		terminator.value === createdResults[0]
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
					fn.blockHandler(block) !== undefined ||
					fn.blockParameters(block).some(({ role }) => role === "exception"),
			)
		) {
			return undefined;
		}
		const terminal: Array<CoreInstructionId> = [];
		for (const block of fn.blockIds()) {
			const terminator = fn.terminatorPayload(fn.blockTerminator(block));
			if (terminator.kind !== "branch") continue;
			const instructions = [...fn.bodyInstructionIds(block)];
			for (const [index, instruction] of instructions.entries()) {
				if (fn.instructionOpcodeName(instruction) !== "yield") continue;
				const [yieldedValue, resumeMode] = fn.instructionResults(instruction);
				const inputs = fn.instructionOperands(instruction);
				if (
					yieldedValue === undefined ||
					resumeMode === undefined ||
					inputs.length !== 1
				) {
					continue;
				}
				const rootEnvironment = new Map<CoreValueId, CoreValueId>();
				if (
					!exactNumberTest(
						fn,
						block,
						terminator.condition,
						resumeMode,
						1,
						rootEnvironment,
						instructions.slice(index + 1),
					) ||
					!edgeTerminatesWith(
						fn,
						terminator.consequent,
						"throw",
						yieldedValue,
						rootEnvironment,
					)
				) {
					continue;
				}
				const resumed = enterEdge(fn, terminator.alternate, rootEnvironment);
				const resumedTerminator = fn.terminatorPayload(fn.blockTerminator(resumed.block));
				if (resumedTerminator.kind !== "branch") continue;
				if (
					!exactNumberTest(
						fn,
						resumed.block,
						resumedTerminator.condition,
						resumeMode,
						2,
						resumed.environment,
						[...fn.bodyInstructionIds(resumed.block)],
					) ||
					!edgeTerminatesWith(
						fn,
						resumedTerminator.consequent,
						"return",
						yieldedValue,
						resumed.environment,
					) ||
					!edgeReturnsUndefined(fn, resumedTerminator.alternate, resumed.environment)
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
				fn.instructionOperands(instruction),
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
		const inputs = fn.instructionOperands(item.instruction);
		const key = inputs[1];
		if (key === undefined) return undefined;
		const constant = constantForValue(fn, key);
		if (constant?.kind !== "string") return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(
			item.instruction,
			opcode === "loadProperty" ? "loadPropertyStatic" : "storePropertyStatic",
			inputs.filter((_, index) => index !== 1),
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
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction") return false;
	const instruction = definition.instruction;
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
	scope: "instruction",
	requiredAnalyses: [CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "facts"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { ...LOCAL_CHANGES, representations: true },
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionOpcodeName(item.instruction) !== "call"
		) {
			return undefined;
		}
		const existingKnownBuiltinCall = fn.instructionAttributes(
			item.instruction,
		).knownBuiltinCall;
		const inputs = fn.instructionOperands(item.instruction);
		const [callee, receiver] = inputs;
		if (callee === undefined || receiver === undefined) return undefined;
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
		const receiverRoot = root(receiver);
		const calleeDefinition = fn.valueDefinition(root(callee));
		if (calleeDefinition.kind !== "instruction") return undefined;
		const property = calleeDefinition.instruction;
		const propertyReceiver = fn.instructionOperands(property)[0];
		if (
			fn.instructionOpcodeName(property) !== "loadPropertyStatic" ||
			propertyReceiver === undefined ||
			root(propertyReceiver) !== receiverRoot
		) {
			return undefined;
		}
		const stringIndex = fn.instructionAttributes(property).stringIndex;
		if (typeof stringIndex !== "number") return undefined;
		const key = decodeString(program, stringIndex);
		const candidates =
			key === undefined ? [] : (BUILTIN_OPERATIONS_BY_KEY.get(key) ?? []);
		const ownerMatches = candidates.filter((candidate) => {
			const exact = exactBuiltinCallDescriptor(candidate.id);
			return (
				(exact !== undefined &&
					exactBuiltinReceiver(fn, receiverRoot, candidate.owner, exact.receiverProof)) ||
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
		if (descriptor === undefined) return undefined;
		const exact = exactBuiltinCallDescriptor(descriptor.id);
		const sharedIdentity = compilationContext.facts.builtinIdentities.get(descriptor.id);
		const propertyResults = fn.instructionResults(property);
		const arguments_ = inputs.slice(2);
		const receiverDefinition = fn.valueDefinition(receiverRoot);
		const exactIntrinsicReceiver =
			receiverDefinition.kind === "instruction" &&
			fn.instructionOpcodeName(receiverDefinition.instruction) === "loadIntrinsic" &&
			fn.instructionAttributes(receiverDefinition.instruction).intrinsic ===
				descriptor.owner;
		const numericOpcode = MATH_UNARY_OPERATIONS.has(descriptor.id)
			? "mathUnaryNumber"
			: descriptor.id === "Math.min" || descriptor.id === "Math.max"
				? "mathBinaryNumber"
				: undefined;
		const nativeMathArgument = (value: CoreValueId): boolean => {
			if (fn.valueRepresentation(value) === "f64") return true;
			const scalar = kinds.exactScalar(value);
			if (scalar !== "int32" && scalar !== "number") return false;
			const definition = fn.valueDefinition(value);
			return (
				definition.kind === "instruction" &&
				(fn.instructionOpcodeName(definition.instruction) === "createNumber" ||
					fn.instructionOpcodeName(definition.instruction) === "createF64")
			);
		};
		const numericRewrite =
			numericOpcode !== undefined &&
			exactIntrinsicReceiver &&
			compilerFactIsWorldInvariant(sharedIdentity) &&
			sharedIdentity.value === descriptor.id &&
			descriptor.nativeNumberArity === arguments_.length &&
			arguments_.every(nativeMathArgument) &&
			fn.instructionResults(item.instruction).length === 1 &&
			propertyResults.length === 1 &&
			fn.valueUseCount(propertyResults[0]!) === 1
				? numericOpcode
				: undefined;
		const exactRewrite =
			exact !== undefined &&
			exactBuiltinReceiver(fn, receiverRoot, descriptor.owner, exact.receiverProof) &&
			compilerFactIsWorldInvariant(sharedIdentity) &&
			sharedIdentity.value === descriptor.id &&
			propertyResults.length === 1 &&
			propertyResults[0] === callee &&
			fn.valueUseCount(callee) === 1
				? exact
				: undefined;
		const site = builtinSourceSite(
			program,
			fn,
			fn.instructionSourcePosition(item.instruction),
			descriptor.id,
		);
		const obligationId = `generic-call:${site ?? `${fn.id}:${item.instruction}`}`;
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
			return undefined;
		}
		const editor = CoreEditor.open(program, item.function);
		if (numericRewrite !== undefined) {
			editor.replaceInstruction(item.instruction, numericRewrite, arguments_, {
				attributes: { operation: descriptor.id },
				sourcePosition: fn.instructionSourcePosition(item.instruction),
			});
			for (const argument of arguments_) editor.setValueRepresentation(argument, "f64");
			editor.setValueRepresentation(fn.instructionResults(item.instruction)[0]!, "f64");
			editor.removeInstruction(property);
		} else if (exactRewrite === undefined) {
			editor.replaceInstruction(item.instruction, "call", inputs, {
				attributes: {
					...fn.instructionAttributes(item.instruction),
					knownBuiltinCall: knownBuiltinCall as unknown as CoreAttributeValue,
				},
				sourcePosition: fn.instructionSourcePosition(item.instruction),
				effectRefinement: fn.instructionEffectRefinement(item.instruction),
			});
		} else {
			const forwarded =
				exactRewrite.forwardedArgumentLimit === undefined
					? arguments_
					: arguments_.slice(0, exactRewrite.forwardedArgumentLimit);
			editor.replaceInstruction(
				item.instruction,
				"callBuiltin",
				[receiver, ...forwarded],
				{
					attributes: {
						operation: exactRewrite.id,
						knownBuiltinCall: knownBuiltinCall as unknown as CoreAttributeValue,
					},
					sourcePosition: fn.instructionSourcePosition(item.instruction),
				},
			);
			editor.removeInstruction(property);
		}
		return editor.commit();
	},
};

const foldConstants: CorePass = {
	name: "local-constant-folding",
	stage: "canonicalize",
	scope: "instruction",
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
			fn.instructionResults(item.instruction).length !== 1
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
	const definition = fn.valueDefinition(value);
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation" ||
		fn.instructionOpcodeName(definition.instruction) !== "unary" ||
		fn.instructionAttributes(definition.instruction).operator !== "typeof"
	)
		return undefined;
	const [input] = fn.instructionOperands(definition.instruction);
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
	scope: "instruction",
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
		const operands = fn.instructionOperands(item.instruction);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		let result: boolean | undefined;
		if (
			opcode === "unary" &&
			fn.instructionAttributes(item.instruction).operator === "!"
		) {
			const input = operands[0];
			if (
				input !== undefined &&
				compilerValueKindMaskIsSubset(
					kinds.kindMask(input),
					COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_NULL,
				)
			)
				result = true;
		} else if (opcode === "binary" && operands.length === 2) {
			const operator = fn.instructionAttributes(item.instruction).operator;
			if (operator === "===" || operator === "!==") {
				const typeofResult =
					typeofObservation(program, fn, operands[0]!, operands[1]!, (value) =>
						kinds.kindMask(value),
					) ??
					typeofObservation(program, fn, operands[1]!, operands[0]!, (value) =>
						kinds.kindMask(value),
					);
				const equal =
					typeofResult ??
					((kinds.kindMask(operands[0]!) & kinds.kindMask(operands[1]!)) === 0
						? false
						: undefined);
				result = equal === undefined ? undefined : operator === "===" ? equal : !equal;
			}
		}
		if (result === undefined) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(item.instruction, "createBoolean", [], {
			attributes: { value: result },
			sourcePosition: fn.instructionSourcePosition(item.instruction),
		});
		return editor.commit();
	},
};

const foldTypeofComparisons: CorePass = {
	name: "typeof-comparison-canonicalization",
	stage: "canonicalize",
	scope: "instruction",
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
		const operands = fn.instructionOperands(item.instruction);
		if (operands.length !== 2) return undefined;
		const typeofInput = (value: CoreValueId): CoreValueId | undefined => {
			const definition = fn.valueDefinition(value);
			if (
				definition.kind !== "instruction" ||
				fn.instructionKind(definition.instruction) !== "operation" ||
				fn.instructionOpcodeName(definition.instruction) !== "unary" ||
				fn.instructionAttributes(definition.instruction).operator !== "typeof"
			)
				return undefined;
			return fn.instructionOperands(definition.instruction)[0];
		};
		const leftInput = typeofInput(operands[0]!);
		const rightInput = typeofInput(operands[1]!);
		const input = leftInput ?? rightInput;
		const constant = constantForValue(
			fn,
			leftInput === undefined ? operands[0]! : operands[1]!,
		);
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
		const operands = fn.instructionOperands(item.instruction);
		if (opcode === "unary") {
			const [input] = operands;
			const [result] = fn.instructionResults(item.instruction);
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
			const value = operands[0];
			if (value === undefined || !coercible(value)) return undefined;
			const editor = CoreEditor.open(program, item.function);
			editor.removeInstruction(item.instruction);
			return editor.commit();
		}
		const [base, key] = operands;
		const [result] = fn.instructionResults(item.instruction);
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
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction") return false;
	const construction = definition.instruction;
	if (fn.instructionOpcodeName(construction) !== "construct") return false;
	const constructor = fn.instructionOperands(construction)[0];
	if (constructor === undefined) return false;
	const constructorDefinition = fn.valueDefinition(root(constructor));
	if (constructorDefinition.kind !== "instruction") return false;
	return (
		fn.instructionOpcodeName(constructorDefinition.instruction) === "loadIntrinsic" &&
		fn.instructionAttributes(constructorDefinition.instruction).intrinsic ===
			(receiver === "map" ? "Map" : "Set")
	);
}

const rewriteNumericIdentities: CorePass = {
	name: "numeric-algebraic-simplification",
	stage: "canonicalize",
	scope: "instruction",
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
		const [left, right] = fn.instructionOperands(item.instruction);
		const [result] = fn.instructionResults(item.instruction);
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

const propagateMoves: CorePass = {
	name: "local-copy-propagation",
	stage: "canonicalize",
	scope: "instruction",
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
			fn.instructionOpcodeName(item.instruction) !== "move"
		)
			return undefined;
		const [result] = fn.instructionResults(item.instruction);
		const [input] = fn.instructionOperands(item.instruction);
		if (result === undefined || input === undefined) return undefined;
		if (fn.valueRepresentation(result) !== fn.valueRepresentation(input))
			return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceValueUses(result, input);
		editor.removeInstruction(item.instruction);
		return editor.commit();
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
		const payload = fn.terminatorPayload(fn.blockTerminator(item.block));
		let selected: CoreEdge | undefined;
		let removedFact: CoreFactId | undefined;
		if (payload.kind === "branch") {
			const condition = constantForValue(fn, payload.condition);
			if (condition?.kind === "boolean") {
				selected = condition.value ? payload.consequent : payload.alternate;
			} else if (sameEdge(payload.consequent, payload.alternate)) {
				selected = payload.consequent;
			}
		} else if (payload.kind === "switch") {
			const discriminant = constantForValue(fn, payload.discriminant);
			if (discriminant !== undefined) {
				selected =
					payload.cases.find(({ value }) => immediateEqualsConstant(value, discriminant))
						?.edge ?? payload.default;
			}
		} else if (payload.kind === "guard" && sameEdge(payload.success, payload.fallback)) {
			const terminator = fn.blockTerminator(item.block);
			const fact = fn.fact(payload.fact);
			const exclusivelyGuardsTerminator = fact.obligations.every(
				(obligation) =>
					obligation.kind === "guard" && obligation.instruction === terminator,
			);
			const usedByRefinement = [...fn.instructionIds()].some(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionEffectRefinement(instruction)?.proof === payload.fact,
			);
			if (exclusivelyGuardsTerminator && !usedByRefinement) {
				selected = payload.success;
				removedFact = payload.fact;
			}
		}
		if (selected === undefined) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceTerminator(item.block, { kind: "jump", edge: selected });
		if (removedFact !== undefined) editor.removeFact(removedFact);
		return editor.commit();
	},
};

const removeDeadInstructions: CorePass = {
	name: "local-dead-instruction-elimination",
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
		const removable = (instruction: CoreInstructionId): boolean => {
			if (
				!fn.isInstructionLive(instruction) ||
				fn.instructionKind(instruction) !== "operation"
			)
				return false;
			const descriptor = program.registry.byId(fn.instructionOpcode(instruction));
			const attributes = fn.instructionAttributes(instruction);
			if (
				!descriptor.discardable &&
				!(descriptor.opcode === "unary" && attributes.operator === "typeof")
			)
				return false;
			return fn
				.instructionResults(instruction)
				.every((value) => !valueHasUses(fn, value));
		};
		const pending = [...fn.instructionIds()].filter(removable);
		if (pending.length === 0) return undefined;
		const queued = new Set(pending);
		const editor = CoreEditor.open(program, item.function);
		while (pending.length > 0) {
			const instruction = pending.pop()!;
			queued.delete(instruction);
			if (!removable(instruction)) continue;
			const operands = [...fn.instructionOperands(instruction)];
			editor.removeInstruction(instruction);
			for (const operand of operands) {
				const definition = fn.valueDefinition(operand);
				if (
					definition.kind !== "instruction" ||
					queued.has(definition.instruction) ||
					!removable(definition.instruction)
				)
					continue;
				queued.add(definition.instruction);
				pending.push(definition.instruction);
			}
		}
		return editor.commit();
	},
};

const foldRedundantTdzChecks: CorePass = {
	name: "redundant-tdz-check-folding",
	stage: "canonicalize",
	scope: "instruction",
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
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionOpcodeName(item.instruction) !== "throwIfTdz"
		)
			return undefined;
		const [input] = fn.instructionOperands(item.instruction);
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const known = new Map<CoreValueId, boolean>();
		const visiting = new Set<CoreValueId>();
		const excludesEmpty = (value: CoreValueId): boolean => {
			const cached = known.get(value);
			if (cached !== undefined) return cached;
			if (visiting.has(value)) return false;
			visiting.add(value);
			const definition = fn.valueDefinition(value);
			let result: boolean;
			if (definition.kind === "block-parameter") {
				const parameter = fn.blockParameters(definition.block)[definition.index];
				if (parameter?.role === "exception" || fn.parameters.includes(value)) {
					result = true;
				} else {
					const incoming = control.predecessors[definition.block] ?? [];
					result =
						incoming.length > 0 &&
						incoming.every((edge) => {
							const argument =
								edge.arguments[
									edge.kind === "exceptional" ? definition.index - 1 : definition.index
								];
							return argument !== undefined && excludesEmpty(argument);
						});
				}
			} else {
				const opcode = fn.instructionOpcodeName(definition.instruction);
				const source = fn.instructionOperands(definition.instruction)[0];
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
		if (
			input === undefined ||
			(kinds.kindMask(input) === COMPILER_VALUE_KIND_TOP && !excludesEmpty(input))
		)
			return undefined;
		const editor = CoreEditor.open(program, item.function);
		if (fn.instructionResults(item.instruction).length === 0) {
			editor.removeInstruction(item.instruction);
		} else {
			editor.replaceInstruction(item.instruction, "move", [input]);
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
				const results = fn.instructionResults(instruction);
				const effects = descriptor.effects;
				if (
					results.length !== 1 ||
					!descriptor.discardable ||
					effects.reads.length > 0 ||
					effects.writes.length > 0 ||
					effects.mayThrow ||
					effects.maySuspend ||
					effects.mayGc ||
					effects.callsUserCode
				)
					continue;
				const key = `${descriptor.opcode}|${fn.instructionOperands(instruction).join(",")}|${stableAttribute(fn.instructionAttributes(instruction))}`;
				const existing = available.get(key);
				if (existing === undefined) available.set(key, results[0]!);
				else replacements.set(instruction, existing);
			}
		}
		if (replacements.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const [instruction, replacement] of replacements) {
			if (!fn.isInstructionLive(instruction)) continue;
			const [result] = fn.instructionResults(instruction);
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
			(flow) => fn.terminatorPayload(fn.blockTerminator(flow.handler)).kind !== "guard",
		);
		if (first === undefined) return undefined;
		const handler = first.handler;
		const group = flows.filter((flow) => flow.handler === handler);
		const parameters = fn.blockParameters(handler);
		const handlerTerminator = fn.blockTerminator(handler);
		const handlerSourcePosition = fn.instructionSourcePosition(handlerTerminator);
		const editor = CoreEditor.open(program, item.function);
		const continuation = editor.createBlock(
			parameters.map(({ representation }) => ({ representation })),
		);
		const continuationParameters = fn
			.blockParameters(continuation)
			.map(({ value }) => value);
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
		const outerHandler = fn.blockHandler(handler);
		if (outerHandler !== undefined) {
			editor.setHandler(continuation, outerHandler.block, outerHandler.arguments);
		}
		editor.setTerminator(continuation, {
			...fn.terminatorPayload(handlerTerminator),
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
			const handler = fn.blockHandler(block);
			if (handler !== undefined && removed.has(handler.block)) editor.clearHandler(block);
		}
		const pending = new Set(blocks.flatMap((block) => [...fn.instructionIds(block)]));
		const queue = new Array<CoreInstructionId>();
		const queued = new Set<CoreInstructionId>();
		const enqueueIfDead = (instruction: CoreInstructionId): void => {
			if (
				!pending.has(instruction) ||
				queued.has(instruction) ||
				fn.instructionResults(instruction).some((value) => valueHasUses(fn, value))
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
			if (fn.instructionResults(instruction).some((value) => valueHasUses(fn, value)))
				continue;
			const dependencies = fn.instructionOperands(instruction).flatMap((value) => {
				const definition = fn.valueDefinition(value);
				return definition.kind === "instruction" ? [definition.instruction] : [];
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
		for (const block of fn.blockIds()) {
			if (
				block === fn.entry ||
				block === fn.bodyEntry ||
				fn.blockHandler(block) !== undefined
			) {
				continue;
			}
			if ([...fn.bodyInstructionIds(block)].length !== 0) continue;
			if (
				fn
					.blockParameters(block)
					.some(({ value }) =>
						[...fn.uses(value)].some(
							({ instruction }) => fn.instructionBlock(instruction) !== block,
						),
					)
			)
				continue;
			const payload = fn.terminatorPayload(fn.blockTerminator(block));
			const incoming = control.predecessors[block] ?? [];
			if (incoming.length === 0 || incoming.some(({ kind }) => kind === "exceptional"))
				continue;
			const parameters = fn.blockParameters(block).map(({ value }) => value);
			const translate = (edge: CoreEdge, target: CoreEdge): CoreEdge => ({
				block: target.block,
				arguments: target.arguments.map((value) => {
					const parameter = parameters.indexOf(value);
					return parameter < 0 ? value : edge.arguments[parameter]!;
				}),
			});
			if (payload.kind === "branch") {
				const condition = parameters.indexOf(payload.condition);
				if (
					condition < 0 ||
					incoming.some((edge) => {
						const value = edge.arguments[condition];
						return value === undefined || constantForValue(fn, value)?.kind !== "boolean";
					})
				)
					continue;
				const editor = CoreEditor.open(program, item.function);
				for (const source of new Set(incoming.map(({ from }) => from))) {
					editor.replaceTerminator(
						source,
						rewriteEdges(fn.terminatorPayload(fn.blockTerminator(source)), (edge) => {
							if (edge.block !== block) return edge;
							const conditionValue = constantForValue(fn, edge.arguments[condition]!);
							if (conditionValue?.kind !== "boolean") return edge;
							return translate(
								edge,
								conditionValue.value ? payload.consequent : payload.alternate,
							);
						}),
					);
				}
				editor.removeBlock(block);
				return editor.commit();
			}
			if (payload.kind !== "jump" || payload.edge.block === block) continue;
			const editor = CoreEditor.open(program, item.function);
			for (const source of new Set(incoming.map(({ from }) => from))) {
				editor.replaceTerminator(
					source,
					rewriteEdges(fn.terminatorPayload(fn.blockTerminator(source)), (edge) => {
						if (edge.block !== block) return edge;
						return translate(edge, payload.edge);
					}),
				);
			}
			editor.removeBlock(block);
			return editor.commit();
		}
		return undefined;
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
		const { program, item } = context;
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
		for (const predecessor of fn.blockIds()) {
			const predecessorTerminator = fn.terminatorPayload(fn.blockTerminator(predecessor));
			if (predecessorTerminator.kind !== "jump") continue;
			const target = predecessorTerminator.edge.block;
			if (
				target === fn.entry ||
				target === fn.bodyEntry ||
				protectedLoopBlocks.has(predecessor) ||
				protectedLoopBlocks.has(target) ||
				!fn.isBlockLive(target) ||
				!sameEdge(fn.blockHandler(predecessor), fn.blockHandler(target))
			)
				continue;
			const incoming = control.predecessors[target] ?? [];
			if (
				incoming.length !== 1 ||
				incoming[0]!.kind !== "ordinary" ||
				incoming[0]!.from !== predecessor
			)
				continue;
			const parameters = fn.blockParameters(target);
			if (parameters.length !== predecessorTerminator.edge.arguments.length) continue;
			const editor = CoreEditor.open(program, item.function);
			for (const [index, parameter] of parameters.entries()) {
				editor.replaceValueUses(
					parameter.value,
					predecessorTerminator.edge.arguments[index]!,
				);
			}
			for (const instruction of [...fn.bodyInstructionIds(target)]) {
				const outputs = fn.instructionResults(instruction);
				const inserted = editor.insertInstruction(
					predecessor,
					fn.blockTerminator(predecessor),
					fn.instructionOpcodeName(instruction),
					fn.instructionOperands(instruction),
					{
						outputCount: outputs.length,
						outputRepresentations: outputs.map((value) => fn.valueRepresentation(value)),
						attributes: fn.instructionAttributes(instruction),
						sourcePosition: fn.instructionSourcePosition(instruction),
						effectRefinement: fn.instructionEffectRefinement(instruction),
					},
				);
				for (const [index, output] of outputs.entries()) {
					editor.replaceValueUses(output, inserted.outputs[index]!);
				}
				editor.removeInstruction(instruction);
			}
			editor.replaceTerminator(
				predecessor,
				fn.terminatorPayload(fn.blockTerminator(target)),
			);
			editor.removeBlock(target);
			return editor.commit();
		}
		return undefined;
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
			for (let index = fn.blockParameters(block).length - 1; index >= 0; index--) {
				const parameters = fn.blockParameters(block);
				if (parameters[index]!.role !== "value") continue;
				const currentIncoming = [...new Set(incoming.map(({ from }) => from))].flatMap(
					(source) =>
						coreTerminatorEdges(fn.terminatorPayload(fn.blockTerminator(source))).filter(
							(edge) => edge.block === block,
						),
				);
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
				const replacementDefinition =
					replacement === undefined ? undefined : fn.valueDefinition(replacement);
				if (
					!unused &&
					(replacement === undefined ||
						replacement === parameters[index]!.value ||
						(replacementDefinition?.kind === "block-parameter" &&
							replacementDefinition.block === block) ||
						(!equivalentConstants && !sameValue))
				)
					continue;
				editor ??= CoreEditor.open(program, item.function);
				if (!unused) {
					const selected = sameValue
						? replacement!
						: insertConstant(
								editor,
								fn,
								block,
								replacementConstant!,
								parameters[index]!.representation,
							);
					editor.replaceValueUses(parameters[index]!.value, selected);
				}
				for (const predecessor of new Set(incoming.map(({ from }) => from))) {
					const predecessorPayload = fn.terminatorPayload(
						fn.blockTerminator(predecessor),
					);
					editor.replaceTerminator(
						predecessor,
						rewriteEdges(predecessorPayload, (edge) =>
							edge.block === block
								? {
										block,
										arguments: edge.arguments.filter(
											(_, argumentIndex) => argumentIndex !== index,
										),
									}
								: edge,
						),
					);
				}
				editor.removeBlockParameter(block, index);
			}
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
	budget: LOCAL_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		for (const block of fn.blockIds()) {
			const incoming = control.predecessors[block] ?? [];
			if (incoming.length === 0 || incoming.some(({ kind }) => kind === "exceptional")) {
				continue;
			}
			for (let index = fn.blockParameters(block).length - 1; index >= 0; index--) {
				const parameter = fn.blockParameters(block)[index]!;
				if (parameter.role !== "value") continue;
				const replacement = roots.get(parameter.value) ?? parameter.value;
				if (
					replacement === parameter.value ||
					!fn.isValueLive(replacement) ||
					fn.valueRepresentation(replacement) !== parameter.representation
				)
					continue;
				const editor = CoreEditor.open(program, item.function);
				editor.replaceValueUses(parameter.value, replacement);
				for (const predecessor of new Set(incoming.map(({ from }) => from))) {
					editor.replaceTerminator(
						predecessor,
						rewriteEdges(fn.terminatorPayload(fn.blockTerminator(predecessor)), (edge) =>
							edge.block === block
								? {
										block,
										arguments: edge.arguments.filter(
											(_, argumentIndex) => argumentIndex !== index,
										),
									}
								: edge,
						),
					);
				}
				editor.removeBlockParameter(block, index);
				return editor.commit();
			}
		}
		return undefined;
	},
};

export const CORE_LOCAL_CANONICALIZATION_PASSES: ReadonlyArray<CorePass> = [
	annotateTerminalYieldSites,
	foldStaticPropertyKeys,
	rewriteExactBuiltinCalls,
	foldConstants,
	foldValueKindObservations,
	foldTypeofComparisons,
	foldPrimitiveCoercions,
	rewriteNumericIdentities,
	propagateMoves,
	foldControlFlow,
	localValueNumbering,
	lowerLocalExplicitThrows,
	foldRedundantTdzChecks,
	removeDeadInstructions,
	canonicalizeBlockParameters,
	simplifyBlockParameters,
	eliminateForwardingBlocks,
	mergeLinearBlocks,
	removeUnreachableBlocks,
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
		...removeDeadInstructions,
		name: "post-representation-dead-instruction-removal",
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
