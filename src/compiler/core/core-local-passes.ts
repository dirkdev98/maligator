import { buildCoreControlFlow, coreTerminatorEdges } from "./core-ir-control-flow.ts";
import { CoreEditor } from "./core-editor.ts";
import type {
	CoreAttributeValue,
	CoreEdge,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreTerminatorInput,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

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

function constantForValue(fn: CoreFunctionStore, value: CoreValueId): LocalConstant | undefined {
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
		case "number":
			return { opcode: "createNumber", attributes: { value: constant.value } };
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
		case "+": return { kind: "number", value: left + right };
		case "-": return { kind: "number", value: left - right };
		case "*": return { kind: "number", value: left * right };
		case "/": return { kind: "number", value: left / right };
		case "%": return { kind: "number", value: left % right };
		case "**": return { kind: "number", value: left ** right };
		case "&": return { kind: "number", value: left & right };
		case "|": return { kind: "number", value: left | right };
		case "^": return { kind: "number", value: left ^ right };
		case "<<": return { kind: "number", value: left << right };
		case ">>": return { kind: "number", value: left >> right };
		case ">>>": return { kind: "number", value: left >>> right };
		case "<": return { kind: "boolean", value: left < right };
		case "<=": return { kind: "boolean", value: left <= right };
		case ">": return { kind: "boolean", value: left > right };
		case ">=": return { kind: "boolean", value: left >= right };
		case "==":
		case "===": return { kind: "boolean", value: left === right };
		case "!=":
		case "!==": return { kind: "boolean", value: left !== right };
		default: return undefined;
	}
}

function numberUnary(operator: CoreAttributeValue, value: number): LocalConstant | undefined {
	switch (operator) {
		case "!": return { kind: "boolean", value: !value };
		case "-": return { kind: "number", value: -value };
		case "+": return { kind: "number", value };
		case "~": return { kind: "number", value: ~value };
		case "tonumeric": return { kind: "number", value };
		case "increment": return { kind: "number", value: value + 1 };
		case "decrement": return { kind: "number", value: value - 1 };
		default: return undefined;
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
		case "jump": return { kind: "jump", edge: rewrite(payload.edge) };
		case "branch": return {
			kind: "branch",
			condition: payload.condition,
			consequent: rewrite(payload.consequent),
			alternate: rewrite(payload.alternate),
		};
		case "guard": return {
			kind: "guard",
			condition: payload.condition,
			fact: payload.fact,
			success: rewrite(payload.success),
			fallback: rewrite(payload.fallback),
		};
		case "switch": return {
			kind: "switch",
			discriminant: payload.discriminant,
			cases: payload.cases.map(({ value, edge }) => ({ value, edge: rewrite(edge) })),
			default: rewrite(payload.default),
		};
		case "return": return { kind: "return", value: payload.value };
		case "throw": return { kind: "throw", value: payload.value };
		case "unreachable": return { kind: "unreachable" };
	}
}

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
		) return undefined;
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
		) return undefined;
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
			}
		} else if (payload.kind === "switch") {
			const discriminant = constantForValue(fn, payload.discriminant);
			if (discriminant !== undefined) {
				selected = payload.cases.find(({ value }) =>
					immediateEqualsConstant(value, discriminant),
				)?.edge ?? payload.default;
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
		if (!descriptor.discardable) return undefined;
		if (fn.instructionResults(item.instruction).some((value) => valueHasUses(fn, value))) {
			return undefined;
		}
		const editor = CoreEditor.open(program, item.function);
		editor.removeInstruction(item.instruction);
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
				) continue;
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
	requiredAnalyses: [],
	wakesOn: ["cfg", "exceptionFlow"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = buildCoreControlFlow(program, item.function, {
			exceptions: true,
		});
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
		const pending = new Set(
			blocks.flatMap((block) => [...fn.instructionIds(block)]),
		);
		while (pending.size > 0) {
			let removed = false;
			for (const instruction of pending) {
				if (
					fn.instructionResults(instruction).some((value) => valueHasUses(fn, value))
				) continue;
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
	requiredAnalyses: [],
	wakesOn: ["cfg", "body", "exceptionFlow"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = buildCoreControlFlow(program, item.function, { exceptions: true });
		for (const block of fn.blockIds()) {
			if (block === fn.entry || block === fn.bodyEntry || fn.blockHandler(block) !== undefined) {
				continue;
			}
			if ([...fn.bodyInstructionIds(block)].length !== 0) continue;
			if (
				fn.blockParameters(block).some(({ value }) =>
					[...fn.uses(value)].some(
						({ instruction }) => fn.instructionBlock(instruction) !== block,
					),
				)
			) continue;
			const payload = fn.terminatorPayload(fn.blockTerminator(block));
			if (payload.kind !== "jump" || payload.edge.block === block) continue;
			const incoming = control.predecessors[block] ?? [];
			if (
				incoming.length === 0 ||
				incoming.some(({ kind }) => kind === "exceptional") ||
				new Set(incoming.map(({ from }) => from)).size !== incoming.length
			) continue;
			const parameters = fn.blockParameters(block).map(({ value }) => value);
			const editor = CoreEditor.open(program, item.function);
			for (const edge of incoming) {
				const replacementArguments = payload.edge.arguments.map((value) => {
					const parameter = parameters.indexOf(value);
					return parameter < 0 ? value : edge.arguments[parameter]!;
				});
				editor.redirectEdge(edge.from, block, {
					block: payload.edge.block,
					arguments: replacementArguments,
				});
			}
			editor.removeBlock(block);
			return editor.commit();
		}
		return undefined;
	},
};

const simplifyBlockParameters: CorePass = {
	name: "block-parameter-simplification",
	stage: "canonicalize",
	scope: "function",
	requiredAnalyses: [],
	wakesOn: ["cfg", "body"],
	preserves: [],
	changes: { ...LOCAL_CHANGES, cfg: true },
	budget: LOCAL_BUDGET,
	run({ program, item }) {
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const control = buildCoreControlFlow(program, item.function, { exceptions: true });
		let editor: CoreEditor | undefined;
		for (const block of fn.blockIds()) {
			const incoming = control.predecessors[block] ?? [];
			if (incoming.length === 0 || incoming.some(({ kind }) => kind === "exceptional")) {
				continue;
			}
			for (let index = fn.blockParameters(block).length - 1; index >= 0; index--) {
				const parameters = fn.blockParameters(block);
				if (parameters[index]!.role !== "value") continue;
				const currentIncoming = [
					...new Set(incoming.map(({ from }) => from)),
				].flatMap((source) =>
					coreTerminatorEdges(
						fn.terminatorPayload(fn.blockTerminator(source)),
					).filter((edge) => edge.block === block),
				);
				const arguments_ = currentIncoming.map((edge) => edge.arguments[index]);
				const replacement = arguments_[0];
				const replacementDefinition =
					replacement === undefined ? undefined : fn.valueDefinition(replacement);
				if (
					replacement === undefined ||
					replacement === parameters[index]!.value ||
					(replacementDefinition?.kind === "block-parameter" &&
						replacementDefinition.block === block) ||
					arguments_.some((argument) => argument !== replacement)
				) continue;
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceValueUses(parameters[index]!.value, replacement);
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

export const CORE_LOCAL_CANONICALIZATION_PASSES: ReadonlyArray<CorePass> = [
	foldConstants,
	propagateMoves,
	foldControlFlow,
	localValueNumbering,
	removeDeadInstructions,
	simplifyBlockParameters,
	eliminateForwardingBlocks,
	removeUnreachableBlocks,
];
