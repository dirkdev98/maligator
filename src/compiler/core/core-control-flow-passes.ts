import { CoreEditor } from "./core-editor.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type { CoreLoopComparison, CoreNumericRange } from "./core-ir-loops.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreInstructionId,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const CONTROL_FLOW_BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 1_000_000,
	maxEdits: 500_000,
	exhaustion: "stop",
});

const CONTROL_FLOW_CHANGES = Object.freeze({
	cfg: true,
	calls: true,
	facts: false,
	representations: false,
});

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
	return String(value);
}

function mapTerminatorEdges(
	payload: CoreTerminatorPayload,
	map: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorInput {
	switch (payload.kind) {
		case "jump":
			return { kind: "jump", edge: map(payload.edge) };
		case "branch":
			return {
				kind: "branch",
				condition: payload.condition,
				consequent: map(payload.consequent),
				alternate: map(payload.alternate),
			};
		case "guard":
			return {
				kind: "guard",
				condition: payload.condition,
				fact: payload.fact,
				success: map(payload.success),
				fallback: map(payload.fallback),
			};
		case "switch":
			return {
				kind: "switch",
				discriminant: payload.discriminant,
				cases: payload.cases.map(({ value, edge }) => ({ value, edge: map(edge) })),
				default: map(payload.default),
			};
		case "return":
			return { kind: "return", value: payload.value };
		case "throw":
			return { kind: "throw", value: payload.value };
		case "unreachable":
			return { kind: "unreachable" };
	}
}

function expressionKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	inputs = fn.instructionOperands(instruction),
): string | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
	const effects =
		fn.instructionEffectRefinement(instruction)?.effects ?? descriptor.effects;
	const outputs = fn.instructionResults(instruction);
	if (
		!descriptor.discardable ||
		descriptor.callTransfer !== undefined ||
		outputs.length !== 1 ||
		effects.mayThrow ||
		effects.maySuspend ||
		effects.mayGc ||
		effects.callsUserCode ||
		effects.reads.length > 0 ||
		effects.writes.length > 0
	)
		return undefined;
	return `${descriptor.opcode}|${inputs.join(",")}|${stableAttribute(fn.instructionAttributes(instruction))}|${fn.valueRepresentation(outputs[0]!)}`;
}

const eliminateDominatedRedundancy: CorePass = {
	name: "dominance-redundancy-elimination",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow"],
	preserves: ["exception-control-flow"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		const available = new Array<Map<string, CoreValueId>>(fn.blockCapacity);
		const replacements = new Map<CoreInstructionId, CoreValueId>();
		for (const block of cfg.reversePostorder) {
			const parent = cfg.immediateDominators[block];
			const current = new Map(
				parent === null || parent === undefined ? [] : available[parent],
			);
			for (const instruction of fn.bodyInstructionIds(block)) {
				const rooted = fn
					.instructionOperands(instruction)
					.map((value) => roots.get(value) ?? value);
				const key = expressionKey(fn, instruction, rooted);
				if (key === undefined) continue;
				const existing = current.get(key);
				if (existing === undefined)
					current.set(key, fn.instructionResults(instruction)[0]!);
				else replacements.set(instruction, existing);
			}
			available[block] = current;
		}
		if (replacements.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const [instruction, replacement] of replacements) {
			if (!fn.isInstructionLive(instruction)) continue;
			const result = fn.instructionResults(instruction)[0];
			if (result === undefined) continue;
			editor.replaceValueUses(result, replacement);
			editor.removeInstruction(instruction);
		}
		return editor.commit();
	},
};

function translatedInputs(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	block: CoreBlockId,
	predecessor: CoreBlockId,
	edge: CoreEdge,
	inputs: ReadonlyArray<CoreValueId>,
): ReadonlyArray<CoreValueId> | undefined {
	const parameters = fn.blockParameters(block);
	const translated: Array<CoreValueId> = [];
	for (const input of inputs) {
		const parameter = parameters.findIndex(({ value }) => value === input);
		if (parameter >= 0) {
			const value = edge.arguments[parameter];
			if (value === undefined) return undefined;
			translated.push(value);
			continue;
		}
		const definition = fn.valueDefinition(input);
		const definitionBlock =
			definition.kind === "instruction"
				? fn.instructionBlock(definition.instruction)
				: definition.block;
		if (
			definitionBlock === block ||
			!cfg.instructionDominatesBlock(definitionBlock, predecessor)
		)
			return undefined;
		translated.push(input);
	}
	return translated;
}

const eliminatePartialRedundancy: CorePass = {
	name: "partial-redundancy-elimination",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow"],
	preserves: [],
	changes: CONTROL_FLOW_CHANGES,
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		for (const block of cfg.reversePostorder) {
			if (
				fn.blockHandler(block) !== undefined ||
				cfg.loops.some((loop) => loop.header === block)
			)
				continue;
			const incoming = (cfg.predecessors[block] ?? []).filter(
				({ kind }) => kind === "ordinary",
			);
			if (
				incoming.length < 2 ||
				incoming.length !== (cfg.predecessors[block] ?? []).length ||
				new Set(incoming.map(({ from }) => from)).size !== incoming.length
			)
				continue;
			for (const instruction of fn.bodyInstructionIds(block)) {
				const key = expressionKey(fn, instruction);
				if (key === undefined) continue;
				const outputs = fn.instructionResults(instruction);
				const translated = incoming.map((edge) =>
					translatedInputs(
						fn,
						cfg,
						block,
						edge.from,
						{ block, arguments: edge.arguments },
						fn.instructionOperands(instruction),
					),
				);
				if (translated.some((inputs) => inputs === undefined)) continue;
				const available = incoming.map((edge, index) => {
					const expected = expressionKey(fn, instruction, translated[index]);
					for (const candidate of fn.bodyInstructionIds(edge.from)) {
						if (expressionKey(fn, candidate) === expected)
							return fn.instructionResults(candidate)[0];
					}
					return undefined;
				});
				const existing = available.filter((value) => value !== undefined).length;
				if (existing === 0 || existing === incoming.length) continue;
				if (
					incoming.some(
						(edge, index) =>
							available[index] === undefined &&
							(cfg.successors[edge.from] ?? []).filter(({ kind }) => kind === "ordinary")
								.length !== 1,
					)
				)
					continue;
				const editor = CoreEditor.open(program, item.function);
				for (const [index, edge] of incoming.entries()) {
					if (available[index] !== undefined) continue;
					available[index] = editor.insertInstruction(
						edge.from,
						fn.blockTerminator(edge.from),
						fn.instructionOpcodeName(instruction),
						translated[index]!,
						{
							attributes: fn.instructionAttributes(instruction),
							outputRepresentations: [fn.valueRepresentation(outputs[0]!)],
							sourcePosition: fn.instructionSourcePosition(instruction),
						},
					).outputs[0];
				}
				const parameter = editor.appendBlockParameter(block, {
					representation: fn.valueRepresentation(outputs[0]!),
				});
				for (const [index, edge] of incoming.entries()) {
					editor.redirectEdge(edge.from, block, {
						block,
						arguments: [...edge.arguments, available[index]!],
					});
				}
				editor.replaceValueUses(outputs[0]!, parameter);
				editor.removeInstruction(instruction);
				return editor.commit();
			}
		}
		return undefined;
	},
};

function proveComparison(
	operator: CoreLoopComparison,
	range: CoreNumericRange,
	bound: number,
): boolean | undefined {
	switch (operator) {
		case "<":
			return range.maximum < bound ? true : range.minimum >= bound ? false : undefined;
		case "<=":
			return range.maximum <= bound ? true : range.minimum > bound ? false : undefined;
		case ">":
			return range.minimum > bound ? true : range.maximum <= bound ? false : undefined;
		case ">=":
			return range.minimum >= bound ? true : range.maximum < bound ? false : undefined;
	}
}

function numberConstant(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
	const definition = fn.valueDefinition(value);
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation"
	)
		return undefined;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	const attribute = fn.instructionAttributes(definition.instruction).value;
	return (opcode === "createNumber" || opcode === "createF64") &&
		typeof attribute === "number"
		? attribute
		: undefined;
}

const foldPathComparisons: CorePass = {
	name: "path-range-control-folding",
	stage: "control-flow",
	scope: "block",
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: CONTROL_FLOW_CHANGES,
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "block") return undefined;
		const fn = program.function(item.function);
		if (!fn.isBlockLive(item.block)) return undefined;
		const terminator = fn.terminatorPayload(fn.blockTerminator(item.block));
		if (terminator.kind !== "branch") return undefined;
		const condition = fn.valueDefinition(terminator.condition);
		if (
			condition.kind !== "instruction" ||
			fn.instructionKind(condition.instruction) !== "operation" ||
			fn.instructionOpcodeName(condition.instruction) !== "binary"
		)
			return undefined;
		const inputs = fn.instructionOperands(condition.instruction);
		let operator = fn.instructionAttributes(condition.instruction)
			.operator as CoreLoopComparison;
		if (
			!(["<", "<=", ">", ">="] as ReadonlyArray<unknown>).includes(operator) ||
			inputs.length !== 2
		)
			return undefined;
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		if (
			inputs.some(
				(value) =>
					ranges.induction(value)?.comparison?.instruction === condition.instruction,
			)
		)
			return undefined;
		let range = ranges.range(inputs[0]!, item.block);
		let bound = numberConstant(fn, inputs[1]!);
		if (range === undefined || bound === undefined) {
			range = ranges.range(inputs[1]!, item.block);
			bound = numberConstant(fn, inputs[0]!);
			operator =
				operator === "<" ? ">" : operator === "<=" ? ">=" : operator === ">" ? "<" : "<=";
		}
		if (range === undefined || bound === undefined) return undefined;
		const result = proveComparison(operator, range, bound);
		if (result === undefined) return undefined;
		const selected = result ? terminator.consequent : terminator.alternate;
		const editor = CoreEditor.open(program, item.function);
		editor.replaceTerminator(item.block, { kind: "jump", edge: selected });
		return editor.commit();
	},
};

const LOOP_SCALAR_OPERATIONS: ReadonlySet<string> = new Set([
	"move",
	"unary",
	"binary",
	"typeofCompare",
	"rootUse",
]);

const LOOP_SCALAR_CONSUMERS: ReadonlySet<string> = new Set(["storeProperty"]);

const selectLoopScalarRepresentations: CorePass = {
	name: "loop-scalar-representation-selection",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_LOOP_INDUCTION_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "representations"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { ...CONTROL_FLOW_CHANGES, representations: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const inductions = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS).inductions;
		if (inductions.length === 0) return undefined;
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const numeric = (value: CoreValueId): boolean => {
			const scalar = kinds.exactScalar(value);
			return scalar === "number" || scalar === "int32";
		};
		const selected = new Set<CoreValueId>();
		for (const induction of inductions) {
			selected.add(induction.value);
			selected.add(induction.initial);
			selected.add(induction.update);
		}
		let progress = true;
		while (progress) {
			progress = false;
			const add = (value: CoreValueId): void => {
				if (!selected.has(value) && numeric(value)) {
					selected.add(value);
					progress = true;
				}
			};
			for (const block of fn.blockIds()) {
				const incoming = (cfg.predecessors[block] ?? []).filter(
					({ kind }) => kind === "ordinary",
				);
				for (const [index, parameter] of fn.blockParameters(block).entries()) {
					const arguments_ = incoming.flatMap((edge) => {
						const argument = edge.arguments[index];
						return argument === undefined ? [] : [argument];
					});
					if (
						selected.has(parameter.value) ||
						arguments_.some((value) => selected.has(value))
					) {
						add(parameter.value);
						for (const argument of arguments_) add(argument);
					}
				}
				for (const instruction of fn.bodyInstructionIds(block)) {
					const opcode = fn.instructionOpcodeName(instruction);
					if (!LOOP_SCALAR_OPERATIONS.has(opcode)) {
						continue;
					}
					const operands = fn.instructionOperands(instruction);
					const results = fn.instructionResults(instruction);
					if (
						opcode === "move" &&
						operands.length === 1 &&
						results.length === 1 &&
						fn.valueRepresentation(operands[0]!) !== fn.valueRepresentation(results[0]!)
					)
						continue;
					const connected = [...operands, ...results].filter(numeric);
					if (!connected.some((value) => selected.has(value))) continue;
					for (const value of connected) add(value);
				}
			}
		}
		for (const value of selected) {
			for (const { instruction } of fn.uses(value)) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				if (!LOOP_SCALAR_OPERATIONS.has(opcode) && !LOOP_SCALAR_CONSUMERS.has(opcode))
					return undefined;
			}
		}
		const representation: CoreRepresentation = [...selected].every(
			(value) => kinds.exactScalar(value) === "int32",
		)
			? "i32"
			: "f64";
		const candidates = [...selected].filter(
			(value) => fn.valueRepresentation(value) !== representation,
		);
		if (candidates.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const value of candidates) editor.setValueRepresentation(value, representation);
		for (const block of fn.blockIds()) {
			let bridged = false;
			const payload = fn.terminatorPayload(fn.blockTerminator(block));
			const replacement = mapTerminatorEdges(payload, (edge) => {
				const parameters = fn.blockParameters(edge.block);
				const arguments_ = edge.arguments.map((argument, index) => {
					const target = parameters[index];
					if (
						target === undefined ||
						fn.valueRepresentation(argument) === target.representation
					)
						return argument;
					bridged = true;
					return editor.insertInstruction(
						block,
						fn.blockTerminator(block),
						"move",
						[argument],
						{ outputRepresentations: [target.representation] },
					).outputs[0]!;
				});
				return { block: edge.block, arguments: arguments_ };
			});
			if (bridged) editor.replaceTerminator(block, replacement);
		}
		return editor.commit();
	},
};

const reduceBoundedRemainders: CorePass = {
	name: "path-range-strength-reduction",
	stage: "control-flow",
	scope: "block",
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "block") return undefined;
		const fn = program.function(item.function);
		if (!fn.isBlockLive(item.block)) return undefined;
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const numericRepresentation = (value: CoreValueId): "f64" | "i32" | undefined => {
			const representation = fn.valueRepresentation(value);
			if (representation === "f64" || representation === "i32") return representation;
			const scalar = kinds.exactScalar(value);
			return scalar === "int32" ? "i32" : scalar === "number" ? "f64" : undefined;
		};
		for (const instruction of fn.bodyInstructionIds(item.block)) {
			if (
				fn.instructionOpcodeName(instruction) !== "binary" ||
				fn.instructionAttributes(instruction).operator !== "%"
			)
				continue;
			const inputs = fn.instructionOperands(instruction);
			const outputs = fn.instructionResults(instruction);
			if (inputs.length !== 2 || outputs.length !== 1) continue;
			const dividendRepresentation = numericRepresentation(inputs[0]!);
			if (
				dividendRepresentation === undefined ||
				numericRepresentation(inputs[1]!) === undefined ||
				numericRepresentation(outputs[0]!) !== dividendRepresentation
			)
				continue;
			const dividend = ranges.range(inputs[0]!, item.block);
			const divisor = ranges.range(inputs[1]!, item.block);
			if (
				dividend === undefined ||
				divisor === undefined ||
				divisor.minimum !== divisor.maximum ||
				!Number.isSafeInteger(divisor.minimum) ||
				divisor.minimum <= dividend.maximum ||
				dividend.minimum < 0
			)
				continue;
			const editor = CoreEditor.open(program, item.function);
			editor.replaceInstruction(instruction, "move", [inputs[0]!]);
			return editor.commit();
		}
		return undefined;
	},
};

export const CORE_CONTROL_FLOW_PASSES: ReadonlyArray<CorePass> = [
	eliminateDominatedRedundancy,
	eliminatePartialRedundancy,
	selectLoopScalarRepresentations,
	foldPathComparisons,
	reduceBoundedRemainders,
];
