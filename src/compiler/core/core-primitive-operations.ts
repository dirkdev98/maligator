import {
	evaluateConstantBuiltin,
	evaluateConstantStringSplit,
} from "../shared/constant-builtins.ts";
import type { ConstantValue } from "../shared/constant-evaluator.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import { coreStaticStringRawParts } from "./core-string-construction.ts";
import type { CoreStringPart } from "./core-string-construction.ts";

export const lowerPrimitiveOperations: CoreFunctionPass = {
	name: "lower-primitive-operations",
	admission: {
		predicate: "primitive call, scalar Math kernel, equality, or string-length candidate",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				const attributes = fn.instructionAttributes(instruction);
				if (opcode === "mathUnaryNumber" || opcode === "mathBinaryNumber") return true;
				if (
					opcode === "callKnown" &&
					!attributes.construct &&
					attributes.argumentMode === undefined
				)
					return true;
				if (
					opcode === "binary" &&
					["===", "!==", "==", "!="].includes(attributes.operator as string)
				)
					return true;
				if (opcode === "loadPropertyStatic" && !attributes.primitiveStringLength) {
					const units = program.stringConstants[attributes.stringIndex as number];
					if (
						units?.length === 6 &&
						units.every((unit, index) => unit === "length".charCodeAt(index))
					)
						return true;
				}
			}
			return false;
		},
	},
	stage: "memory",
	requiredFunctionOpcodesAny: [
		"callKnown",
		"mathUnaryNumber",
		"mathBinaryNumber",
		"binary",
		"loadPropertyStatic",
	],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const plans: Array<
			| { instruction: CoreInstructionId; value: ConstantValue }
			| { instruction: CoreInstructionId; elements: ReadonlyArray<string> }
			| { instruction: CoreInstructionId; stringParts: ReadonlyArray<CoreStringPart> }
			| {
					instruction: CoreInstructionId;
					operation: CoreStaticMemberOperation;
					truthiness?: true;
			  }
		> = [];
		let sequenceEdits = 0;
		for (const instruction of fn.instructionIds()) {
			if (plans.length * 4 + sequenceEdits + 4 > context.remainingEdits) break;
			if (
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "loadPropertyStatic"
			) {
				const attributes = fn.instructionAttributes(instruction);
				if (
					attributes.primitiveStringLength ||
					analysis.string(attributes.stringIndex as number) !== "length"
				)
					continue;
				const input = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
					fact = analysis.query(input);
				if (fact.kind === "known" && fact.brand === "string") {
					const value = analysis.constant(input);
					if (value?.kind === "string")
						plans.push({
							instruction,
							value: { kind: "number", value: value.value.length },
						});
					else
						plans.push({
							instruction,
							operation: {
								opcode: "loadPropertyStatic",
								inputs: [input],
								attributes: { ...attributes, primitiveStringLength: true },
							},
						});
				}
				continue;
			}
			if (
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "binary" &&
				["===", "!==", "==", "!="].includes(
					fn.instructionAttributes(instruction).operator as string,
				)
			) {
				const start = fn.kernel.instructionOperandStart(instruction);
				const left = analysis.query(fn.kernel.operandAt(start)),
					right = analysis.query(fn.kernel.operandAt(start + 1));
				if (
					left.kind === "known" &&
					right.kind === "known" &&
					left.brand === "symbol" &&
					right.brand === "symbol"
				) {
					const a = left.identity,
						b = right.identity;
					if (
						a !== undefined &&
						b !== undefined &&
						["fresh-per-evaluation", "symbol-registry", "intrinsic"].includes(a.kind) &&
						["fresh-per-evaluation", "symbol-registry", "intrinsic"].includes(b.kind)
					) {
						if (
							a.kind === "fresh-per-evaluation" &&
							b.kind === "fresh-per-evaluation" &&
							a.function === b.function &&
							a.value === b.value
						)
							continue;
						const same =
							(a.kind === "symbol-registry" || a.kind === "intrinsic") &&
							b.kind === a.kind &&
							a.key === b.key;
						plans.push({
							instruction,
							value: {
								kind: "boolean",
								value: (
									fn.instructionAttributes(instruction).operator as string
								).startsWith("!")
									? !same
									: same,
							},
						});
					}
				}
				continue;
			}
			if (
				fn.instructionKind(instruction) !== "operation" ||
				!["callKnown", "mathUnaryNumber", "mathBinaryNumber"].includes(
					fn.instructionOpcodeName(instruction),
				)
			)
				continue;
			const attributes = fn.instructionAttributes(instruction);
			if (attributes.construct || attributes.argumentMode !== undefined) continue;
			const operation = attributes.operation as string;
			if (
				!/^(Boolean|Number|String|BigInt|Symbol|Math)(\.|$)/.test(operation) &&
				![
					"Object.prototype.toString",
					"globalThis.escape",
					"globalThis.unescape",
					"parseInt",
					"parseFloat",
					"isNaN",
					"isFinite",
					"encodeURI",
					"encodeURIComponent",
					"decodeURI",
					"decodeURIComponent",
					"escape",
					"unescape",
				].includes(operation)
			)
				continue;
			const inputs = Array.from(
				{ length: fn.kernel.instructionOperandCount(instruction) },
				(_, index) =>
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
			);
			const numericOperation = fn.instructionOpcodeName(instruction) !== "callKnown";
			if (
				[
					"Number.isNaN",
					"Number.isFinite",
					"Number.isInteger",
					"Number.isSafeInteger",
				].includes(operation) &&
				fn.kernel.valueUseCount(
					fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				) === 0 &&
				fn.kernel.valueHandlerUseCount(
					fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				) === 0
			) {
				plans.push({ instruction, value: { kind: "undefined" } });
				continue;
			}
			if (operation === "Object.prototype.toString") {
				const fact = analysis.query(inputs[0]!);
				if (
					fact.kind === "known" &&
					[
						"number",
						"string",
						"boolean",
						"bigint",
						"symbol",
						"null",
						"undefined",
					].includes(fact.brand)
				) {
					const tag =
						fact.brand === "bigint"
							? "BigInt"
							: fact.brand[0]!.toUpperCase() + fact.brand.slice(1);
					plans.push({
						instruction,
						value: { kind: "string", value: `[object ${tag}]` },
					});
				}
				continue;
			}
			if (
				[
					"Symbol.prototype.description<get>",
					"Symbol.prototype.toString",
					"Symbol.keyFor",
					"String",
				].includes(operation)
			) {
				const receiver =
					inputs[operation === "String" || operation === "Symbol.keyFor" ? 1 : 0];
				const fact = receiver === undefined ? undefined : analysis.query(receiver);
				if (fact?.kind === "known" && fact.brand === "symbol") {
					const description = program.staticDescriptions.description(fact.description);
					if (description.kind === "symbol") {
						let value: ConstantValue | undefined;
						if (operation === "Symbol.keyFor") {
							if (description.reference?.kind === "registry")
								value = { kind: "string", value: description.reference.key };
							else if (
								description.reference?.kind === "well-known" ||
								fact.identity?.kind === "fresh-per-evaluation"
							)
								value = { kind: "undefined" };
						} else if (description.description !== undefined) {
							value =
								operation === "Symbol.prototype.description<get>"
									? description.description === null
										? { kind: "undefined" }
										: { kind: "string", value: description.description }
									: { kind: "string", value: `Symbol(${description.description ?? ""})` };
						}
						if (value !== undefined) {
							plans.push({ instruction, value });
							continue;
						}
					}
				}
			}
			if (
				operation === "Symbol" &&
				fn.kernel.valueUseCount(
					fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				) === 0 &&
				fn.kernel.valueHandlerUseCount(
					fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				) === 0
			) {
				const first =
					inputs[1] === undefined
						? { kind: "undefined" as const }
						: analysis.constant(inputs[1]);
				if (evaluateConstantBuiltin("String", undefined, [first]).kind === "value") {
					plans.push({ instruction, value: { kind: "undefined" } });
					continue;
				}
				if (inputs[1] !== undefined) {
					plans.push({
						instruction,
						operation: {
							opcode: "unary",
							inputs: [inputs[1]],
							attributes: { operator: "tostring" },
						},
					});
					continue;
				}
			}
			if (operation === "String.raw") {
				const stringParts = coreStaticStringRawParts(
					program,
					fn,
					analysis,
					instruction,
					inputs,
				);
				if (
					stringParts !== undefined &&
					plans.length * 4 + sequenceEdits + stringParts.length * 3 + 4 <=
						context.remainingEdits
				) {
					if (stringParts.length === 1 && typeof stringParts[0] === "string")
						plans.push({ instruction, value: { kind: "string", value: stringParts[0] } });
					else {
						plans.push({ instruction, stringParts });
						sequenceEdits += stringParts.length * 3;
					}
				}
				continue;
			}
			if (operation === "String.prototype.split") {
				const elements = evaluateConstantStringSplit(
					analysis.constant(inputs[0]!),
					inputs.slice(1).map((value) => analysis.constant(value)),
				);
				if (
					elements !== undefined &&
					plans.length * 4 + sequenceEdits + elements.length * 2 + 4 <=
						context.remainingEdits
				) {
					plans.push({ instruction, elements });
					sequenceEdits += elements.length * 2;
				}
				continue;
			}
			const evaluated = evaluateConstantBuiltin(
				operation,
				operation.includes(".prototype.") ? analysis.constant(inputs[0]!) : undefined,
				inputs.slice(numericOperation ? 0 : 1).map((value) => analysis.constant(value)),
			);
			if (evaluated.kind === "value") {
				plans.push({ instruction, value: evaluated.value });
				continue;
			}
			if (numericOperation) continue;
			if (operation === "Boolean" && inputs[1] !== undefined) {
				plans.push({
					instruction,
					operation: {
						opcode: "unary",
						inputs: [inputs[1]],
						attributes: { operator: "!" },
					},
					truthiness: true,
				});
			} else if (operation === "Number.isNaN" && inputs[1] !== undefined) {
				plans.push({
					instruction,
					operation: {
						opcode: "binary",
						inputs: [inputs[1], inputs[1]],
						attributes: { operator: "!==" },
					},
				});
			} else if (operation.endsWith(".prototype.valueOf")) {
				const fact = analysis.query(inputs[0]!);
				if (
					fact.kind === "known" &&
					fact.brand === operation.slice(0, operation.indexOf(".")).toLowerCase()
				)
					plans.push({
						instruction,
						operation: { opcode: "move", inputs: [inputs[0]!] },
					});
			} else if (
				(operation === "Number" || operation === "String") &&
				inputs[1] !== undefined
			) {
				const fact = analysis.query(inputs[1]);
				if (fact.kind === "known" && fact.brand === operation.toLowerCase())
					plans.push({ instruction, operation: { opcode: "move", inputs: [inputs[1]] } });
			}
		}
		if (plans.length === 0) return undefined;
		const editor = CoreEditor.open(program, fn.id);
		const strings = new Map<string, number>(),
			bigints = new Map<bigint, number>();
		const stringIndex = (value: string) => {
			let index = strings.get(value);
			if (index === undefined) {
				index = program.stringConstants.findIndex(
					(units) =>
						units.length === value.length &&
						units.every((unit, index) => unit === value.charCodeAt(index)),
				);
				if (index < 0)
					index = editor.appendStringConstants([
						Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)),
					]);
				strings.set(value, index);
			}
			return index;
		};
		for (const plan of plans) {
			if ("stringParts" in plan) {
				const block = fn.instructionBlock(plan.instruction);
				let result: CoreValueId | undefined;
				for (const part of plan.stringParts) {
					const value = editor.insertInstruction(
						block,
						plan.instruction,
						typeof part === "string" ? "createString" : "unary",
						typeof part === "string" ? [] : [part.value],
						{
							attributes:
								typeof part === "string"
									? { stringIndex: stringIndex(part) }
									: { operator: "tostring" },
						},
					).outputs[0]!;
					result =
						result === undefined
							? value
							: editor.insertInstruction(
									block,
									plan.instruction,
									"binary",
									[result, value],
									{ attributes: { operator: "+" } },
								).outputs[0]!;
				}
				editor.replaceInstruction(plan.instruction, "move", [result!]);
				continue;
			}
			if ("elements" in plan) {
				const words = [8, plan.elements.length];
				for (const value of plan.elements) words.push(5, stringIndex(value));
				const template = editor.appendLiteralTemplate(words, false);
				editor.replaceInstruction(plan.instruction, "instantiateLiteralTemplate", [], {
					attributes: template,
				});
				continue;
			}
			if ("operation" in plan) {
				const operation = plan.operation;
				let inputs = operation.inputs;
				if (plan.truthiness)
					inputs = editor.insertInstruction(
						fn.instructionBlock(plan.instruction),
						plan.instruction,
						operation.opcode,
						inputs,
						{ attributes: operation.attributes },
					).outputs;
				editor.replaceInstruction(plan.instruction, operation.opcode, inputs, {
					attributes: operation.attributes,
				});
				continue;
			}
			const value = plan.value;
			let operation: CoreStaticMemberOperation;
			if (value.kind === "undefined" || value.kind === "null")
				operation = {
					opcode: value.kind === "null" ? "createNull" : "createUndefined",
					inputs: [],
				};
			else if (value.kind === "number" || value.kind === "boolean")
				operation = {
					opcode:
						value.kind === "boolean"
							? "createBoolean"
							: fn.valueRepresentation(
										fn.kernel.resultAt(
											fn.kernel.instructionResultStart(plan.instruction),
										),
								  ) !== "f64" &&
								  Number.isInteger(value.value) &&
								  value.value >= -0x80000000 &&
								  value.value <= 0x7fffffff &&
								  !Object.is(value.value, -0)
								? "createNumber"
								: "createF64",
					inputs: [],
					attributes: { value: value.value },
				};
			else if (value.kind === "string") {
				operation = {
					opcode: "createString",
					inputs: [],
					attributes: { stringIndex: stringIndex(value.value) },
				};
			} else {
				let index = bigints.get(value.value);
				if (index === undefined) {
					index = program.bigintConstants.indexOf(value.value);
					if (index < 0) index = editor.appendBigintConstants([value.value]);
					bigints.set(value.value, index);
				}
				operation = {
					opcode: "createBigint",
					inputs: [],
					attributes: { bigintIndex: index },
				};
			}
			editor.replaceInstruction(plan.instruction, operation.opcode, operation.inputs, {
				attributes: operation.attributes,
			});
		}
		return editor.commit();
	},
};

export const eliminatePrimitiveWrappers: CoreFunctionPass = {
	name: "eliminate-primitive-wrappers",
	admission: {
		predicate: "primitive wrapper constructor or Object conversion",
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
					attributes.argumentMode === undefined &&
					(attributes.operation === "Object" ||
						(Boolean(attributes.construct) &&
							["Boolean", "Number", "String"].includes(attributes.operation as string)))
				);
			});
		},
	},
	stage: "memory",
	requiredFunctionOpcodesAny: ["callKnown"],
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
			const attributes = fn.instructionAttributes(instruction),
				operation = attributes.operation as string;
			if (
				(!attributes.construct && operation !== "Object") ||
				attributes.argumentMode !== undefined ||
				!["Boolean", "Number", "String", "Object"].includes(operation)
			)
				continue;
			const start = fn.kernel.instructionOperandStart(instruction);
			const args = Array.from(
				{ length: fn.kernel.instructionOperandCount(instruction) },
				(_, index) => fn.kernel.operandAt(start + index),
			);
			const newTarget = analysis.query(args[0]!);
			if (
				attributes.construct &&
				(newTarget.kind !== "known" || newTarget.canonical !== operation)
			)
				continue;
			const root = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			let wrapper = operation;
			if (operation === "Object") {
				const input = args[1] === undefined ? undefined : analysis.query(args[1]);
				if (
					input?.kind !== "known" ||
					!["number", "string", "boolean", "bigint", "symbol"].includes(input.brand)
				)
					continue;
				wrapper =
					input.brand === "bigint"
						? "BigInt"
						: input.brand[0]!.toUpperCase() + input.brand.slice(1);
			}
			const pending: Array<CoreValueId> = [root],
				visited = new Set<CoreValueId>(),
				truthiness = new Set<CoreInstructionId>();
			let safe = true;
			while (pending.length && safe) {
				const value = pending.pop()!;
				if (visited.has(value)) continue;
				visited.add(value);
				if (visited.size > 64 || fn.kernel.valueHandlerUseCount(value) !== 0) {
					safe = false;
					break;
				}
				for (
					let use = fn.kernel.valueFirstUse(value);
					use >= 0;
					use = fn.kernel.useNext(use)
				) {
					const consumer = fn.kernel.useInstruction(use);
					if (fn.instructionKind(consumer) !== "operation") {
						safe = false;
						break;
					}
					const opcode = fn.instructionOpcodeName(consumer),
						consumerAttributes = fn.instructionAttributes(consumer);
					if (opcode === "move")
						pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(consumer)));
					else if (opcode === "unary" && consumerAttributes.operator === "!")
						truthiness.add(consumer);
					else if (
						wrapper === "String" &&
						opcode === "loadPropertyStatic" &&
						(analysis.string(consumerAttributes.stringIndex as number) === "length" ||
							/^(0|[1-9][0-9]*)$/.test(
								analysis.string(consumerAttributes.stringIndex as number),
							))
					)
						continue;
					else if (
						opcode !== "callKnown" ||
						fn.kernel.useOperand(use) !== 0 ||
						consumerAttributes.construct ||
						consumerAttributes.argumentMode !== undefined ||
						!(
							(consumerAttributes.operation as string).startsWith(
								`${wrapper}.prototype.`,
							) || consumerAttributes.operation === "Object.prototype.toString"
						)
					) {
						safe = false;
						break;
					} else if (
						wrapper === "String" &&
						["match", "matchAll", "search", "split", "replace", "replaceAll"].some(
							(method) => consumerAttributes.operation === `String.prototype.${method}`,
						) &&
						fn.kernel.instructionOperandCount(consumer) > 1
					) {
						// A symbol protocol receives the original wrapper before receiver ToString.
						const argument = analysis.query(
							fn.kernel.operandAt(fn.kernel.instructionOperandStart(consumer) + 1),
						);
						if (
							argument.kind !== "known" ||
							![
								"undefined",
								"null",
								"boolean",
								"number",
								"string",
								"bigint",
								"symbol",
							].includes(argument.brand)
						) {
							safe = false;
							break;
						}
					}
				}
			}
			if (!safe || context.remainingEdits < truthiness.size + 1) continue;
			const editor = CoreEditor.open(program, fn.id);
			for (const consumer of truthiness)
				editor.replaceInstruction(consumer, "createBoolean", [], {
					attributes: { value: false },
				});
			if (operation === "Object")
				editor.replaceInstruction(instruction, "move", [args[1]!]);
			else if (
				operation === "String" &&
				args[1] !== undefined &&
				analysis.constant(args[1]) === undefined
			) {
				// Unlike String(symbol), construction uses ordinary ToString and must throw.
				editor.replaceInstruction(instruction, "unary", [args[1]], {
					attributes: { operator: "tostring" },
				});
			} else
				editor.replaceInstruction(instruction, "callKnown", args, {
					attributes: { ...attributes, construct: false },
				});
			return editor.commit();
		}
		return undefined;
	},
};
