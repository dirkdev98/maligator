import { CoreEditor } from "./core-editor.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { literalDefinition, literalGraph, literalResult } from "./core-literal-graph.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { coreStaticDataQueryPlan } from "./core-static-data-query.ts";
import { coreStaticMemberOperation } from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export function coreStaticIncludesPlan(
	program: CoreProgram,
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
) {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (
		attributes.operation !== "Array.prototype.includes" ||
		attributes.construct ||
		attributes.argumentMode !== undefined
	)
		return undefined;
	const args = Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) =>
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
	);
	const fact = analysis.queryAt(args[0]!, instruction);
	if (fact.kind !== "known") return undefined;
	const array = program.staticDescriptions.description(fact.description);
	if (
		array.kind !== "array" ||
		array.length === null ||
		array.length > 16 ||
		array.ownKeysComplete === false
	)
		return undefined;
	let start = 0;
	if (array.length > 0 && args[2] !== undefined) {
		const from = analysis.constant(args[2]);
		if (from === undefined || from.kind === "string" || from.kind === "bigint")
			return undefined;
		const number = from.kind === "undefined" ? 0 : Number(from.value);
		const integer = Number.isNaN(number) ? 0 : Math.trunc(number);
		start = integer < 0 ? Math.max(array.length + integer, 0) : integer;
	}
	const elements: Array<CoreStaticMemberOperation> = [];
	let supported = true;
	for (let index = start; index < array.length; index++) {
		const property = array.properties.find((property) => property.key === String(index));
		if (property === undefined) {
			if (analysis.inherited(fact, String(index))?.kind !== "absent") {
				supported = false;
				break;
			}
			elements.push({ opcode: "createUndefined", inputs: [] });
		} else {
			const operation =
				property.descriptor.kind === "data"
					? coreStaticMemberOperation(program, property.descriptor.value, fact.operands)
					: undefined;
			if (operation === undefined) {
				supported = false;
				break;
			}
			elements.push(operation);
		}
	}
	if (!supported) return undefined;
	return { args, elements, fact };
}

export const lowerKnownOperationResults: CoreFunctionPass = {
	name: "lower-known-operation-results",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown"],
	admission: {
		predicate: "positional includes or own-key call with a static receiver candidate",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			return [...fn.instructionIds()].some((instruction) => {
				if (
					fn.instructionKind(instruction) !== "operation" ||
					fn.instructionOpcodeName(instruction) !== "callKnown"
				)
					return false;
				const attributes = fn.instructionAttributes(instruction);
				return (
					[
						"Array.prototype.includes",
						"Object.prototype.hasOwnProperty",
						"Object.hasOwn",
					].includes(attributes.operation as string) &&
					!attributes.construct &&
					attributes.argumentMode === undefined
				);
			});
		},
	},
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		for (const instruction of fn.instructionIds()) {
			const plan = coreStaticIncludesPlan(program, fn, analysis, instruction);
			if (plan === undefined) {
				const query = coreStaticDataQueryPlan(program, fn, analysis, instruction);
				if (query === undefined || context.remainingEdits < 6) continue;
				analysis.verify(query.fact, instruction);
				const editor = CoreEditor.open(program, fn.id),
					block = fn.instructionBlock(instruction);
				const words = query.words ?? [8, query.keys.length];
				if (query.queryKind === "has-own") {
					const indices = new Map(
						program.stringConstants.map((_, index) => [analysis.string(index), index]),
					);
					const added: Array<Array<number>> = [];
					for (const key of query.keys) {
						let index = indices.get(key);
						if (index === undefined) {
							index = program.stringConstants.length + added.length;
							indices.set(key, index);
							added.push(
								Array.from({ length: key.length }, (_, index) => key.charCodeAt(index)),
							);
						}
						words.push(5, index);
					}
					editor.appendStringConstants(added);
				}
				const template = editor.appendLiteralTemplate(words, false);
				const undef = () =>
					editor.insertInstruction(block, instruction, "createUndefined", []).outputs[0]!;
				editor.replaceInstruction(
					instruction,
					"queryStaticData",
					[
						query.args[1] ?? undef(),
						query.queryKind === "includes" ? (query.args[2] ?? undef()) : undef(),
					],
					{ attributes: { ...template, queryKind: query.queryKind } },
				);
				const root = literalDefinition(fn, query.args[0]!);
				if (root !== undefined) {
					const uses = (value: CoreValueId) => {
						const uses = [];
						for (
							let use = fn.kernel.valueFirstUse(value);
							use >= 0;
							use = fn.kernel.useNext(use)
						)
							uses.push({
								instruction: fn.kernel.useInstruction(use),
								operand: fn.kernel.useOperand(use),
							});
						return uses;
					};
					const graph = literalGraph(program, fn, root, uses);
					if (
						graph !== undefined &&
						graph.allocations.size + graph.initializers.size + 6 <=
							context.remainingEdits &&
						[...graph.allocations].every(
							(allocation) =>
								fn.kernel.valueHandlerUseCount(literalResult(fn, allocation)) === 0 &&
								uses(literalResult(fn, allocation)).every(
									(use) =>
										graph.allocations.has(use.instruction) ||
										graph.initializers.has(use.instruction),
								),
						)
					) {
						for (const initializer of graph.initializers)
							editor.removeInstruction(initializer);
						for (const allocation of graph.allocations)
							editor.removeInstruction(allocation);
					}
				}
				return editor.commit();
			}
			if (8 * plan.elements.length + 5 > context.remainingEdits) continue;
			const { args, elements, fact } = plan;
			analysis.verify(fact, instruction);
			const editor = CoreEditor.open(program, fn.id),
				block = fn.instructionBlock(instruction);
			const emit = (operation: CoreStaticMemberOperation) =>
				editor.insertInstruction(block, instruction, operation.opcode, operation.inputs, {
					attributes: operation.attributes,
				}).outputs[0]!;
			const binary = (operator: string, left: CoreValueId, right: CoreValueId) =>
				emit({ opcode: "binary", inputs: [left, right], attributes: { operator } });
			let result = emit({
				opcode: "createBoolean",
				inputs: [],
				attributes: { value: false },
			});
			if (elements.length > 0) {
				const needle = args[1] ?? emit({ opcode: "createUndefined", inputs: [] });
				const needleNaN = binary("!==", needle, needle);
				for (const element of elements) {
					const value = emit(element);
					const equal = binary("===", needle, value);
					const bothNaN = binary("&", needleNaN, binary("!==", value, value));
					result = binary("|", result, binary("|", equal, bothNaN));
				}
				result = binary(
					"!==",
					result,
					emit({ opcode: "createNumber", inputs: [], attributes: { value: 0 } }),
				);
			}
			editor.replaceInstruction(instruction, "move", [result]);
			return editor.commit();
		}
		return undefined;
	},
};
