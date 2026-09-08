import { CoreEditor } from "./core-editor.ts";
import type { CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { coreStaticMemberOperation } from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";

export const lowerKnownOperationResults: CoreFunctionPass = {
	name: "lower-known-operation-results",
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown"],
	admission: {
		predicate: "positional Array.includes call with a static receiver candidate",
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
					attributes.operation === "Array.prototype.includes" &&
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
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "callKnown"
			)
				continue;
			const attributes = fn.instructionAttributes(instruction);
			if (
				attributes.operation !== "Array.prototype.includes" ||
				attributes.construct ||
				attributes.argumentMode !== undefined
			)
				continue;
			const args = Array.from(
				{ length: fn.kernel.instructionOperandCount(instruction) },
				(_, index) =>
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
			);
			const fact = analysis.queryAt(args[0]!, instruction);
			if (fact.kind !== "known") continue;
			const array = program.staticDescriptions.description(fact.description);
			if (
				array.kind !== "array" ||
				array.length === null ||
				array.length > 16 ||
				array.ownKeysComplete === false
			)
				continue;
			let start = 0;
			if (array.length > 0 && args[2] !== undefined) {
				const from = analysis.constant(args[2]);
				if (from === undefined || from.kind === "string" || from.kind === "bigint")
					continue;
				const number = from.kind === "undefined" ? 0 : Number(from.value);
				const integer = Number.isNaN(number) ? 0 : Math.trunc(number);
				start = integer < 0 ? Math.max(array.length + integer, 0) : integer;
			}
			const elements: Array<CoreStaticMemberOperation> = [];
			let supported = true;
			for (let index = start; index < array.length; index++) {
				const property = array.properties.find(
					(property) => property.key === String(index),
				);
				if (property === undefined) {
					if (analysis.inherited(fact, String(index))?.kind !== "absent") {
						supported = false;
						break;
					}
					elements.push({ opcode: "createUndefined", inputs: [] });
				} else {
					const operation =
						property.descriptor.kind === "data"
							? coreStaticMemberOperation(
									program,
									property.descriptor.value,
									fact.operands,
								)
							: undefined;
					if (operation === undefined) {
						supported = false;
						break;
					}
					elements.push(operation);
				}
			}
			if (!supported || 8 * elements.length + 5 > context.remainingEdits) continue;
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
