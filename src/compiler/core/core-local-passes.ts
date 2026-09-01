import {
	builtinOperations,
	exactBuiltinCallDescriptor,
} from "../shared/builtin-registry.ts";
import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import type { KnownBuiltinCall } from "../shared/compiler-facts.ts";
import { CoreEditor } from "./core-editor.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
	coreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionId,
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

function foldInstruction(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): LocalConstant | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const inputs = fn.instructionOperands(instruction);
	const attributes = fn.instructionAttributes(instruction);
	if (opcode === "binary") {
		const left = constantForValue(fn, inputs[0]!);
		const right = constantForValue(fn, inputs[1]!);
		return left?.kind === "number" && right?.kind === "number"
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
			return constant?.kind === "boolean";
		case "primitive-number":
			return constant?.kind === "number";
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
	requiredAnalyses: [],
	wakesOn: ["body", "facts"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: LOCAL_CHANGES,
	budget: LOCAL_BUDGET,
	run({ program, compilationContext, item }) {
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionOpcodeName(item.instruction) !== "call"
		) {
			return undefined;
		}
		const inputs = fn.instructionOperands(item.instruction);
		const [callee, receiver] = inputs;
		if (
			callee === undefined ||
			receiver === undefined ||
			fn.valueUseCount(callee) !== 1
		) {
			return undefined;
		}
		const calleeDefinition = fn.valueDefinition(callee);
		if (calleeDefinition.kind !== "instruction") return undefined;
		const property = calleeDefinition.instruction;
		if (
			fn.instructionOpcodeName(property) !== "loadPropertyStatic" ||
			fn.instructionOperands(property)[0] !== receiver
		) {
			return undefined;
		}
		const stringIndex = fn.instructionAttributes(property).stringIndex;
		if (typeof stringIndex !== "number") return undefined;
		const key = decodeString(program, stringIndex);
		const candidates =
			key === undefined ? [] : (BUILTIN_OPERATIONS_BY_KEY.get(key) ?? []);
		const descriptor = candidates.find((candidate) => {
			const exact = exactBuiltinCallDescriptor(candidate.id);
			return (
				exact !== undefined &&
				exactBuiltinReceiver(fn, receiver, candidate.owner, exact.receiverProof)
			);
		});
		if (descriptor === undefined) return undefined;
		const exact = exactBuiltinCallDescriptor(descriptor.id)!;
		const identity = compilationContext.facts.builtinIdentities.get(descriptor.id);
		if (!compilerFactIsWorldInvariant(identity) || identity.value !== descriptor.id) {
			return undefined;
		}
		const knownBuiltinCall: KnownBuiltinCall = {
			operation: descriptor.id,
			identity,
			semantics: {
				kind: "known",
				value: {
					effects: descriptor.effects,
					result: descriptor.result,
					lowerings: descriptor.lowerings,
				},
				proof: {
					...identity.proof,
					origin: `builtin-registry-semantics:${descriptor.id}`,
				},
			},
		};
		const arguments_ = inputs.slice(2);
		const forwarded =
			exact.forwardedArgumentLimit === undefined
				? arguments_
				: arguments_.slice(0, exact.forwardedArgumentLimit);
		const editor = CoreEditor.open(program, item.function);
		editor.replaceInstruction(item.instruction, "callBuiltin", [receiver, ...forwarded], {
			attributes: {
				operation: exact.id,
				knownBuiltinCall: knownBuiltinCall as unknown as CoreAttributeValue,
			},
			sourcePosition: fn.instructionSourcePosition(item.instruction),
		});
		editor.removeInstruction(property);
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
		const folded = foldInstruction(fn, item.instruction);
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
		}
		if (selected === undefined) return undefined;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceTerminator(item.block, { kind: "jump", edge: selected });
		return editor.commit();
	},
};

const removeDeadInstructions: CorePass = {
	name: "local-dead-instruction-elimination",
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
		if (!fn.isInstructionLive(item.instruction)) return undefined;
		if (fn.instructionKind(item.instruction) !== "operation") return undefined;
		const descriptor = program.registry.byId(fn.instructionOpcode(item.instruction));
		const attributes = fn.instructionAttributes(item.instruction);
		const locallyDiscardable =
			descriptor.discardable ||
			(descriptor.opcode === "unary" && attributes.operator === "typeof");
		if (!locallyDiscardable) return undefined;
		if (
			fn.instructionResults(item.instruction).some((value) => valueHasUses(fn, value))
		) {
			return undefined;
		}
		const editor = CoreEditor.open(program, item.function);
		editor.removeInstruction(item.instruction);
		return editor.commit();
	},
};

const foldRedundantTdzChecks: CorePass = {
	name: "redundant-tdz-check-folding",
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
			fn.instructionOpcodeName(item.instruction) !== "throwIfTdz"
		)
			return undefined;
		const [input] = fn.instructionOperands(item.instruction);
		if (
			input === undefined ||
			context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS).exactScalar(input) === undefined
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
		while (pending.size > 0) {
			let removed = false;
			for (const instruction of pending) {
				if (fn.instructionResults(instruction).some((value) => valueHasUses(fn, value)))
					continue;
				editor.removeInstruction(instruction);
				pending.delete(instruction);
				removed = true;
			}
			if (!removed) throw new Error("Unreachable Core instructions retain external uses");
		}
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
		for (const predecessor of fn.blockIds()) {
			const predecessorTerminator = fn.terminatorPayload(fn.blockTerminator(predecessor));
			if (predecessorTerminator.kind !== "jump") continue;
			const target = predecessorTerminator.edge.block;
			if (
				target === fn.entry ||
				target === fn.bodyEntry ||
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
				const unused = !valueHasUses(fn, parameters[index]!.value);
				const replacementDefinition =
					replacement === undefined ? undefined : fn.valueDefinition(replacement);
				if (
					!unused &&
					(replacement === undefined ||
						replacement === parameters[index]!.value ||
						(replacementDefinition?.kind === "block-parameter" &&
							replacementDefinition.block === block) ||
						arguments_.some((argument) => argument !== replacement))
				)
					continue;
				editor ??= CoreEditor.open(program, item.function);
				if (!unused) editor.replaceValueUses(parameters[index]!.value, replacement!);
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
	propagateMoves,
	foldControlFlow,
	localValueNumbering,
	foldRedundantTdzChecks,
	removeDeadInstructions,
	canonicalizeBlockParameters,
	simplifyBlockParameters,
	eliminateForwardingBlocks,
	mergeLinearBlocks,
	removeUnreachableBlocks,
];
