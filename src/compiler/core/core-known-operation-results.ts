import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { literalDefinition, literalGraph, literalResult } from "./core-literal-graph.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { coreStaticArrayJoin } from "./core-static-array-strings.ts";
import { coreStaticDataQueryPlan } from "./core-static-data-query.ts";
import { coreStaticMemberOperation } from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export function coreStaticArraySearchPlan(
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
	const includes = attributes.operation === "Array.prototype.includes";
	const backwards = attributes.operation === "Array.prototype.lastIndexOf";
	if (
		(!includes && !backwards && attributes.operation !== "Array.prototype.indexOf") ||
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
	let start = backwards ? array.length - 1 : 0;
	if (array.length > 0 && args[2] !== undefined) {
		const from = analysis.constant(args[2], instruction);
		if (from === undefined || from.kind === "bigint") return undefined;
		const converted = evaluateConstantBuiltin("Number", undefined, [from]);
		if (converted.kind !== "value" || converted.value.kind !== "number") return undefined;
		const number = converted.value.value;
		const integer = Number.isNaN(number) ? 0 : Math.trunc(number);
		start = backwards
			? integer < 0
				? array.length + integer
				: Math.min(integer, array.length - 1)
			: integer < 0
				? Math.max(array.length + integer, 0)
				: integer;
	}
	const elements: Array<{ index: number; operation: CoreStaticMemberOperation }> = [];
	let supported = true;
	for (
		let index = start;
		index >= 0 && index < array.length;
		index += backwards ? -1 : 1
	) {
		const property = array.properties.find((property) => property.key === String(index));
		if (property === undefined) {
			if (analysis.inherited(fact, String(index))?.kind !== "absent") {
				supported = false;
				break;
			}
			if (includes)
				elements.push({ index, operation: { opcode: "createUndefined", inputs: [] } });
		} else {
			const operation =
				property.descriptor.kind === "data"
					? coreStaticMemberOperation(program, property.descriptor.value, fact.operands)
					: undefined;
			if (operation === undefined) {
				supported = false;
				break;
			}
			elements.push({ index, operation });
		}
	}
	if (!supported) return undefined;
	return { args, elements, fact, includes };
}

export const lowerKnownOperationResults: CoreFunctionPass = {
	name: "lower-known-operation-results",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown"],
	admission: {
		predicate: "array search, join, or own-key call with a static receiver candidate",
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
						"Array.prototype.indexOf",
						"Array.prototype.lastIndexOf",
						"Array.prototype.join",
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
			const joined = coreStaticArrayJoin(
				program,
				fn,
				context.compilationContext.facts.world,
				analysis,
				instruction,
			);
			if (joined !== undefined && context.remainingEdits >= 2) {
				analysis.verify(joined.fact, instruction);
				const editor = CoreEditor.open(program, fn.id);
				const units = Array.from({ length: joined.value.length }, (_, index) =>
					joined.value.charCodeAt(index),
				);
				let stringIndex = program.stringConstants.findIndex(
					(candidate) =>
						candidate.length === units.length &&
						candidate.every((unit, index) => unit === units[index]),
				);
				if (stringIndex < 0) stringIndex = editor.appendStringConstants([units]);
				editor.replaceInstruction(instruction, "createString", [], {
					attributes: { stringIndex },
				});
				return editor.commit();
			}
			const query = coreStaticDataQueryPlan(program, fn, analysis, instruction);
			const plan =
				query?.constantResult === undefined &&
				(query === undefined || query.queryKind === "includes")
					? coreStaticArraySearchPlan(program, fn, analysis, instruction)
					: undefined;
			if (plan === undefined) {
				if (query === undefined || context.remainingEdits < 6) continue;
				analysis.verify(query.fact, instruction);
				const editor = CoreEditor.open(program, fn.id),
					block = fn.instructionBlock(instruction);
				if (query.constantResult !== undefined) {
					editor.replaceInstruction(
						instruction,
						typeof query.constantResult === "boolean" ? "createBoolean" : "createNumber",
						[],
						{ attributes: { value: query.constantResult } },
					);
				} else {
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
						editor.insertInstruction(block, instruction, "createUndefined", [])
							.outputs[0]!;
					const from =
						query.queryKind === "has-own"
							? undef()
							: (query.args[2] ??
								(query.queryKind === "last-index-of"
									? editor.insertInstruction(block, instruction, "createF64", [], {
											attributes: { value: Infinity },
										}).outputs[0]!
									: undef()));
					editor.replaceInstruction(
						instruction,
						"queryStaticData",
						[query.args[1] ?? undef(), from],
						{ attributes: { ...template, queryKind: query.queryKind } },
					);
				}
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
			const { args, elements, fact, includes } = plan;
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
				opcode: includes ? "createBoolean" : "createNumber",
				inputs: [],
				attributes: { value: includes ? false : -1 },
			});
			if (elements.length > 0) {
				const needle = args[1] ?? emit({ opcode: "createUndefined", inputs: [] });
				if (includes) {
					const needleNaN = binary("!==", needle, needle);
					for (const { operation } of elements) {
						const value = emit(operation);
						const equal = binary("===", needle, value);
						const bothNaN = binary("&", needleNaN, binary("!==", value, value));
						result = binary("|", result, binary("|", equal, bothNaN));
					}
					result = binary(
						"!==",
						result,
						emit({ opcode: "createNumber", inputs: [], attributes: { value: 0 } }),
					);
				} else {
					// Reverse the comparison order so the first search match wins without control flow.
					for (let cursor = elements.length - 1; cursor >= 0; cursor--) {
						const { index, operation } = elements[cursor]!;
						const equal = binary("===", needle, emit(operation));
						const position = emit({
							opcode: "createNumber",
							inputs: [],
							attributes: { value: index },
						});
						result = binary(
							"+",
							result,
							binary("*", binary("-", position, result), equal),
						);
					}
				}
			}
			editor.replaceInstruction(instruction, "move", [result]);
			return editor.commit();
		}
		return undefined;
	},
};
