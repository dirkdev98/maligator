import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type { CoreLoopComparison, CoreNumericRange } from "./core-ir-loops.ts";
import { CoreEditor } from "./core-editor.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreInstructionId,
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
		return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${key}:${stableAttribute(entry)}`).join(",")}}`;
	}
	if (typeof value === "number") {
		return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
	}
	return String(value);
}

function expressionKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	inputs = fn.instructionOperands(instruction),
): string | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
	const effects = fn.instructionEffectRefinement(instruction)?.effects ?? descriptor.effects;
	const outputs = fn.instructionResults(instruction);
	if (!descriptor.discardable || descriptor.callTransfer !== undefined ||
		outputs.length !== 1 || effects.mayThrow ||
		effects.maySuspend || effects.mayGc || effects.callsUserCode ||
		effects.reads.length > 0 || effects.writes.length > 0) return undefined;
	return `${descriptor.opcode}|${inputs.join(",")}|${stableAttribute(fn.instructionAttributes(instruction))}|${fn.valueRepresentation(outputs[0]!)}`;
}

const eliminateDominatedRedundancy: CorePass = {
	name: "dominance-redundancy-elimination",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS, CORE_CANONICAL_VALUE_ROOTS_ANALYSIS],
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
			const current = new Map(parent === null || parent === undefined ? [] : available[parent]);
			for (const instruction of fn.bodyInstructionIds(block)) {
				const rooted = fn.instructionOperands(instruction).map((value) => roots.get(value) ?? value);
				const key = expressionKey(fn, instruction, rooted);
				if (key === undefined) continue;
				const existing = current.get(key);
				if (existing === undefined) current.set(key, fn.instructionResults(instruction)[0]!);
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
		const definitionBlock = definition.kind === "instruction"
			? fn.instructionBlock(definition.instruction)
			: definition.block;
		if (definitionBlock === block || !cfg.instructionDominatesBlock(definitionBlock, predecessor)) return undefined;
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
			if (fn.blockHandler(block) !== undefined) continue;
			const incoming = (cfg.predecessors[block] ?? []).filter(({ kind }) => kind === "ordinary");
			if (incoming.length < 2 || incoming.length !== (cfg.predecessors[block] ?? []).length ||
				new Set(incoming.map(({ from }) => from)).size !== incoming.length) continue;
			for (const instruction of fn.bodyInstructionIds(block)) {
				const key = expressionKey(fn, instruction);
				if (key === undefined) continue;
				const outputs = fn.instructionResults(instruction);
				const translated = incoming.map((edge) => translatedInputs(
					fn, cfg, block, edge.from, { block, arguments: edge.arguments }, fn.instructionOperands(instruction),
				));
				if (translated.some((inputs) => inputs === undefined)) continue;
				const available = incoming.map((edge, index) => {
					const expected = expressionKey(fn, instruction, translated[index]);
					for (const candidate of fn.bodyInstructionIds(edge.from)) {
						if (expressionKey(fn, candidate) === expected) return fn.instructionResults(candidate)[0];
					}
					return undefined;
				});
				const existing = available.filter((value) => value !== undefined).length;
				if (existing === 0 || existing === incoming.length) continue;
				if (incoming.some((edge, index) => available[index] === undefined &&
					(cfg.successors[edge.from] ?? []).filter(({ kind }) => kind === "ordinary").length !== 1)) continue;
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
		case "<": return range.maximum < bound ? true : range.minimum >= bound ? false : undefined;
		case "<=": return range.maximum <= bound ? true : range.minimum > bound ? false : undefined;
		case ">": return range.minimum > bound ? true : range.maximum <= bound ? false : undefined;
		case ">=": return range.minimum >= bound ? true : range.maximum < bound ? false : undefined;
	}
}

function numberConstant(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction" || fn.instructionKind(definition.instruction) !== "operation") return undefined;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	const attribute = fn.instructionAttributes(definition.instruction).value;
	return (opcode === "createNumber" || opcode === "createF64") && typeof attribute === "number" ? attribute : undefined;
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
		if (condition.kind !== "instruction" || fn.instructionKind(condition.instruction) !== "operation" ||
			fn.instructionOpcodeName(condition.instruction) !== "binary") return undefined;
		const inputs = fn.instructionOperands(condition.instruction);
		let operator = fn.instructionAttributes(condition.instruction).operator as CoreLoopComparison;
		if (!(["<", "<=", ">", ">="] as ReadonlyArray<unknown>).includes(operator) || inputs.length !== 2) return undefined;
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		let range = ranges.range(inputs[0]!, item.block);
		let bound = numberConstant(fn, inputs[1]!);
		if (range === undefined || bound === undefined) {
			range = ranges.range(inputs[1]!, item.block);
			bound = numberConstant(fn, inputs[0]!);
			operator = operator === "<" ? ">" : operator === "<=" ? ">=" : operator === ">" ? "<" : "<=";
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

export const CORE_CONTROL_FLOW_PASSES: ReadonlyArray<CorePass> = [
	eliminateDominatedRedundancy,
	eliminatePartialRedundancy,
	foldPathComparisons,
];
