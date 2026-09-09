import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import { mathUnaryOperationKeys } from "../shared/builtin-registry.ts";
import {
	evaluateConstantBuiltin,
	evaluateConstantStringSplit,
} from "../shared/constant-builtins.ts";
import type { ConstantValue } from "../shared/constant-evaluator.ts";
import { knownOperationIndex, knownOperations } from "../shared/known-operations.ts";
import type { StringCollationPlan } from "../shared/string-collation-plan.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { corePrimitiveBuiltinError } from "./core-primitive-errors.ts";
import { coreStaticNumberSum } from "./core-static-number-sum.ts";
import { coreStaticConstantOperation } from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import { coreStringCollationPlan } from "./core-string-collation.ts";
import {
	coreStaticStringRawParts,
	coreStaticStringReplacementParts,
} from "./core-string-construction.ts";
import type { CoreStringPart } from "./core-string-construction.ts";
import { eliminateSymbolDescription } from "./core-symbol-descriptions.ts";

const noncoercingNumberPredicates = new Set([
	"Number.isNaN",
	"Number.isFinite",
	"Number.isInteger",
	"Number.isSafeInteger",
]);
const wrapperPayloadMethods = new Set([
	"Boolean.prototype.valueOf",
	"Boolean.prototype.toString",
	"Number.prototype.valueOf",
	"Number.prototype.toString",
	"Number.prototype.toFixed",
	"Number.prototype.toExponential",
	"Number.prototype.toPrecision",
	"String.prototype.valueOf",
	"String.prototype.toString",
	"BigInt.prototype.valueOf",
	"BigInt.prototype.toString",
	"Symbol.prototype.valueOf",
	"Symbol.prototype.toString",
	"Symbol.prototype[%Symbol.toPrimitive%]",
]);

function primitiveWrapperPayload(
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	receiver: CoreValueId,
	operation: string,
): { input: CoreValueId; booleanConstructor?: CoreInstructionId } | undefined {
	if (!wrapperPayloadMethods.has(operation)) return undefined;
	const brand = operation.slice(0, operation.indexOf(".")).toLowerCase();
	for (let depth = 0; depth < 64; depth++) {
		if (fn.kernel.valueDefinitionKind(receiver) !== 1) return undefined;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(receiver));
		const start = fn.kernel.instructionOperandStart(definition);
		if (fn.instructionOpcodeName(definition) === "move") {
			receiver = fn.kernel.operandAt(start);
			continue;
		}
		if (fn.instructionOpcodeName(definition) !== "callKnown") return undefined;
		const attributes = fn.instructionAttributes(definition);
		const constructor = attributes.operation as string;
		if (
			attributes.argumentMode !== undefined ||
			fn.kernel.instructionOperandCount(definition) < 2 ||
			(constructor !== "Object" &&
				(!attributes.construct || !["Boolean", "Number", "String"].includes(constructor)))
		)
			return undefined;
		if (attributes.construct) {
			const target = analysis.queryAt(fn.kernel.operandAt(start), definition);
			if (target.kind !== "known" || target.canonical !== constructor) return undefined;
		}
		const input = fn.kernel.operandAt(start + 1);
		const fact = analysis.queryAt(input, definition);
		if (constructor !== "Object" && constructor.toLowerCase() !== brand) return undefined;
		// Escaping wrappers keep their identity, but their primitive internal slot cannot change.
		if (constructor === "Boolean")
			return {
				input,
				booleanConstructor:
					fact.kind !== "known" || fact.brand !== "boolean" ? definition : undefined,
			};
		if (fact.kind === "known" && fact.brand === brand) return { input };
		return undefined;
	}
	return undefined;
}
// These kernels retain their receiver guard even when the receiver is a constant.
const guardedStringSearchReceivers = new Set([
	"String.prototype.indexOf",
	"String.prototype.lastIndexOf",
	"String.prototype.includes",
	"String.prototype.startsWith",
	"String.prototype.endsWith",
]);
const wrapperCoercingUnaryOperators = new Set([
	"+",
	"-",
	"~",
	"tonumeric",
	"tostring",
	"increment",
	"decrement",
]);
const wrapperCoercingBinaryOperators = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"<",
	"<=",
	">",
	">=",
]);
const wrapperCoercingCalls = new Set<string>([
	"Boolean",
	"Number",
	"String",
	"BigInt",
	"isNaN",
	"isFinite",
	...mathUnaryOperationKeys.map(([operation]) => operation),
	"Math.atan2",
	"Math.pow",
	"Math.imul",
	"Math.clz32",
	"Math.hypot",
	"Math.min",
	"Math.max",
	"Math.f16round",
	"parseInt",
	"parseFloat",
	"Number.prototype.toString",
	"Number.prototype.toFixed",
	"Number.prototype.toExponential",
	"Number.prototype.toPrecision",
	"BigInt.asIntN",
	"BigInt.asUintN",
	"BigInt.prototype.toString",
	"Symbol",
	"Symbol.for",
	"encodeURI",
	"encodeURIComponent",
	"decodeURI",
	"decodeURIComponent",
	"globalThis.escape",
	"globalThis.unescape",
]);

const wrapperCoercingStringArguments = new Set([
	"String.fromCharCode",
	"String.fromCodePoint",
	"String.prototype.at",
	"String.prototype.charAt",
	"String.prototype.charCodeAt",
	"String.prototype.codePointAt",
	"String.prototype.includes",
	"String.prototype.indexOf",
	"String.prototype.lastIndexOf",
	"String.prototype.startsWith",
	"String.prototype.endsWith",
	"String.prototype.slice",
	"String.prototype.substring",
	"String.prototype.substr",
	"String.prototype.concat",
	"String.prototype.repeat",
	"String.prototype.padStart",
	"String.prototype.padEnd",
	"String.raw",
	"String.prototype.normalize",
	"String.prototype.split",
	"String.prototype.replace",
	"String.prototype.replaceAll",
	"String.prototype.anchor",
	"String.prototype.fontcolor",
	"String.prototype.fontsize",
	"String.prototype.link",
]);

export const lowerPrimitiveOperations: CoreFunctionPass = {
	name: "lower-primitive-operations",
	admission: {
		predicate:
			"primitive call, constant unary result, scalar Math kernel, equality, or string length",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				const attributes = fn.instructionAttributes(instruction);
				if (opcode === "mathUnaryNumber" || opcode === "mathBinaryNumber") return true;
				if (opcode === "unary") return true;
				if (opcode === "callKnown" && attributes.argumentMode === undefined) return true;
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
		"unary",
		"loadPropertyStatic",
	],
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const plans: Array<
			| {
					instruction: CoreInstructionId;
					collation: StringCollationPlan;
					inputs: ReadonlyArray<CoreValueId>;
			  }
			| { instruction: CoreInstructionId; value: ConstantValue }
			| { instruction: CoreInstructionId; elements: ReadonlyArray<string> }
			| {
					instruction: CoreInstructionId;
					numberParts: ReadonlyArray<CoreStaticMemberOperation>;
			  }
			| {
					instruction: CoreInstructionId;
					stringParts: ReadonlyArray<CoreStringPart>;
			  }
			| {
					instruction: CoreInstructionId;
					operation: CoreStaticMemberOperation;
					truthiness?: true;
			  }
		> = [];
		const parameterPlans: Array<{
			instruction: CoreInstructionId;
			inputs: ReadonlyArray<CoreValueId>;
			parameters: ReadonlyArray<{ index: number; operation: CoreStaticMemberOperation }>;
		}> = [];
		const payloadPlans: Array<{
			instruction: CoreInstructionId;
			method: string;
			inputs: ReadonlyArray<CoreValueId>;
			input: CoreValueId;
			booleanConstructor?: CoreInstructionId;
		}> = [];
		let sequenceEdits = 0;
		for (const instruction of fn.instructionIds()) {
			if (plans.length * 4 + sequenceEdits + 4 > context.remainingEdits) break;
			if (
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "unary"
			) {
				const value = analysis.constant(
					fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				);
				if (value !== undefined) plans.push({ instruction, value });
				continue;
			}
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
					fact = analysis.queryAt(input, instruction);
				if (fact.kind === "known" && fact.brand === "string") {
					const value = analysis.constant(input, instruction);
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
				const left = analysis.queryAt(fn.kernel.operandAt(start), instruction),
					right = analysis.queryAt(fn.kernel.operandAt(start + 1), instruction);
				if (
					left.kind === "known" &&
					right.kind === "known" &&
					((left.brand === "symbol" && right.brand === "symbol") ||
						(left.brand === "function" &&
							right.brand === "function" &&
							left.identity?.kind === "intrinsic" &&
							right.identity?.kind === "intrinsic"))
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
			if (attributes.argumentMode !== undefined) continue;
			const operation = attributes.operation as string;
			if (
				!/^(Boolean|Number|String|BigInt|Symbol|Math)(\.|$)/.test(operation) &&
				![
					"Object.prototype.toString",
					"Object.prototype.toLocaleString",
					"Object.prototype.valueOf",
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
			if (attributes.construct) {
				const target = analysis.queryAt(inputs[0]!, instruction);
				if (
					knownOperations()[knownOperationIndex(operation) ?? -1]?.constructable === false
				)
					plans.push({
						instruction,
						operation: {
							opcode: "builtinError",
							inputs: [],
							attributes: { error: "notConstructor" },
						},
					});
				else if (
					(operation === "BigInt" || operation === "Symbol") &&
					target.kind === "known" &&
					target.canonical === operation
				)
					plans.push({
						instruction,
						operation: {
							opcode: "builtinError",
							inputs: [],
							attributes: {
								error: operation === "BigInt" ? "bigintConstructor" : "symbolConstructor",
							},
						},
					});
				else if (target.kind === "known" && target.canonical === operation) {
					const error = corePrimitiveBuiltinError(
						analysis,
						instruction,
						operation,
						inputs,
						true,
					);
					if (error !== undefined)
						plans.push({
							instruction,
							operation: {
								opcode: "builtinError",
								inputs: [],
								attributes: { error },
							},
						});
				}
				continue;
			}
			if (!numericOperation) {
				const error = corePrimitiveBuiltinError(analysis, instruction, operation, inputs);
				if (error !== undefined) {
					plans.push({
						instruction,
						operation: {
							opcode: "builtinError",
							inputs: [],
							attributes: { error },
						},
					});
					continue;
				}
			}
			if (
				noncoercingNumberPredicates.has(operation) &&
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
			if (operation === "Object.prototype.toLocaleString") {
				const receiver = inputs[0]!,
					fact = analysis.queryAt(receiver, instruction);
				if (
					fact.kind === "known" &&
					context.compilationContext.facts.world.primordialPolicy === "locked" &&
					!context.compilationContext.facts.world.realms
				) {
					const target = analysis.inherited(fact, "toString")?.resolution?.value?.[0];
					if (target !== undefined && knownOperationIndex(target) !== undefined) {
						analysis.verify(fact, instruction);
						plans.push({
							instruction,
							operation: {
								opcode: "callKnown",
								inputs: [receiver],
								attributes: {
									operation: target,
									worldAssumptions: {
										...builtinWorldAssumptions(target, "exact-builtin-proof", true),
									},
								},
							},
						});
					}
				}
				continue;
			}
			if (operation === "Object.prototype.valueOf") {
				const receiver = inputs[0]!,
					fact = analysis.queryAt(receiver, instruction);
				if (fact.kind === "known") {
					if (["object", "array", "function"].includes(fact.brand))
						plans.push({
							instruction,
							operation: { opcode: "move", inputs: [receiver] },
						});
					else if (
						!["undefined", "null"].includes(fact.brand) &&
						context.compilationContext.facts.world.primordialPolicy === "locked" &&
						!context.compilationContext.facts.world.realms
					)
						plans.push({
							instruction,
							operation: {
								opcode: "callKnown",
								inputs: [receiver, receiver],
								attributes: {
									operation: "Object",
									worldAssumptions: {
										...builtinWorldAssumptions("Object", "primitive", true),
									},
								},
							},
						});
				}
				continue;
			}
			if (operation === "Object.prototype.toString") {
				const fact = analysis.queryAt(inputs[0]!, instruction);
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
				const fact =
					receiver === undefined ? undefined : analysis.queryAt(receiver, instruction);
				if (fact?.kind === "known" && fact.brand === "symbol") {
					const description = program.staticDescriptions.description(fact.description);
					if (description.kind === "symbol") {
						let value: ConstantValue | undefined;
						if (operation === "Symbol.keyFor") {
							if (description.reference?.kind === "registry")
								value = { kind: "string", value: description.reference.key };
							else if (
								description.reference?.kind === "well-known" ||
								description.registered === false
							)
								value = { kind: "undefined" };
						} else if (description.description !== undefined) {
							value =
								operation === "Symbol.prototype.description<get>"
									? description.description === null
										? { kind: "undefined" }
										: { kind: "string", value: description.description }
									: {
											kind: "string",
											value: `Symbol(${description.description ?? ""})`,
										};
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
						: analysis.constant(inputs[1], instruction);
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
			if (operation === "String.prototype.localeCompare") {
				const plan = coreStringCollationPlan(program, analysis, instruction, inputs);
				if (plan !== undefined)
					plans.push({
						instruction,
						collation: plan,
						inputs: inputs.slice(0, 2),
					});
				continue;
			}
			if (operation === "Symbol") {
				const eliminated = eliminateSymbolDescription(
					context,
					analysis,
					instruction,
					inputs[1],
				);
				if (eliminated !== undefined) return eliminated;
			}
			if (
				operation === "String.raw" ||
				operation === "String.prototype.replace" ||
				operation === "String.prototype.replaceAll"
			) {
				const stringParts =
					operation === "String.raw"
						? coreStaticStringRawParts(program, fn, analysis, instruction, inputs)
						: coreStaticStringReplacementParts(analysis, operation, inputs);
				const edits =
					stringParts?.reduce(
						(total, part) =>
							total + (typeof part !== "string" && "callback" in part ? 8 : 3),
						0,
					) ?? 0;
				if (
					stringParts !== undefined &&
					plans.length * 4 + sequenceEdits + edits + 4 <= context.remainingEdits
				) {
					if (stringParts.length === 1 && typeof stringParts[0] === "string")
						plans.push({
							instruction,
							value: { kind: "string", value: stringParts[0] },
						});
					else {
						plans.push({ instruction, stringParts });
						sequenceEdits += edits;
					}
					continue;
				}
				if (operation === "String.raw") continue;
			}
			if (operation === "Math.sumPrecise") {
				const sum = coreStaticNumberSum(
					program,
					context.compilationContext.facts.world,
					analysis,
					instruction,
					inputs[1],
				);
				if (sum?.error !== undefined)
					plans.push({
						instruction,
						operation: {
							opcode: "builtinError",
							inputs: [],
							attributes: { error: sum.error },
						},
					});
				else if (sum?.value !== undefined) plans.push({ instruction, value: sum.value });
				else if (
					sum?.elements !== undefined &&
					plans.length * 4 + sequenceEdits + sum.elements.length + 4 <=
						context.remainingEdits
				) {
					plans.push({ instruction, numberParts: sum.elements });
					sequenceEdits += sum.elements.length;
				}
				continue;
			}
			if (operation === "String.prototype.split") {
				const elements = evaluateConstantStringSplit(
					analysis.constant(inputs[0]!, instruction),
					inputs.slice(1).map((value) => analysis.constant(value, instruction)),
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
			if (operation === "Math.pow") {
				const base = inputs[numericOperation ? 0 : 1],
					exponent = inputs[numericOperation ? 1 : 2];
				if (base !== undefined && exponent !== undefined) {
					const fact = analysis.queryAt(base, instruction),
						power = analysis.constant(exponent, instruction);
					if (
						fact.kind === "known" &&
						fact.brand === "number" &&
						power?.kind === "number" &&
						power.value === 0
					) {
						plans.push({ instruction, value: { kind: "number", value: 1 } });
						continue;
					}
				}
			}
			if (operation === "Math.hypot" && inputs.length === 2) {
				const fact = analysis.queryAt(inputs[1]!, instruction);
				if (fact.kind === "known" && fact.brand === "number") {
					plans.push({
						instruction,
						operation: {
							opcode: "callKnown",
							inputs,
							attributes: {
								operation: "Math.abs",
								worldAssumptions: { ...builtinWorldAssumptions("Math.abs", "primitive") },
							},
						},
					});
					continue;
				}
			}
			const payload =
				!numericOperation && inputs[0] !== undefined
					? primitiveWrapperPayload(fn, analysis, inputs[0], operation)
					: undefined;
			if (payload !== undefined) {
				payloadPlans.push({ instruction, method: operation, inputs, ...payload });
				sequenceEdits += payload.booleanConstructor !== undefined ? 4 : 1;
				continue;
			}
			const evaluated = evaluateConstantBuiltin(
				operation,
				operation.includes(".prototype.")
					? analysis.constant(inputs[0]!, instruction)
					: undefined,
				inputs
					.slice(numericOperation ? 0 : 1)
					.map((value) => analysis.constant(value, instruction)),
			);
			if (evaluated.kind === "value") {
				plans.push({ instruction, value: evaluated.value });
				continue;
			}
			if (
				evaluated.kind === "throw" &&
				evaluated.builtinError !== undefined &&
				!numericOperation
			) {
				plans.push({
					instruction,
					operation: {
						opcode: "builtinError",
						inputs: [],
						attributes: { error: evaluated.builtinError },
					},
				});
				continue;
			}
			if (numericOperation) continue;
			if (operation === "Boolean.prototype.toString" || operation === "String") {
				const input = inputs[operation === "String" ? 1 : 0];
				const fact =
					input === undefined ? undefined : analysis.queryAt(input, instruction);
				if (input !== undefined && fact?.kind === "known" && fact.brand === "boolean") {
					plans.push({
						instruction,
						operation: {
							opcode: "unary",
							inputs: [input],
							attributes: { operator: "tostring" },
						},
					});
					continue;
				}
			}
			// Exposing callback receiver constants can increase intermediate string allocations.
			if (
				operation !== "String.prototype.replace" &&
				operation !== "String.prototype.replaceAll"
			) {
				const parameters: Array<{ index: number; operation: CoreStaticMemberOperation }> =
					[];
				for (const [index, input] of inputs.entries()) {
					if (index === 0 && guardedStringSearchReceivers.has(operation)) continue;
					if (fn.kernel.valueDefinitionKind(input) !== 1) continue;
					const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(input));
					if (
						!["loadGlobal", "loadCaptured"].includes(fn.instructionOpcodeName(definition))
					)
						continue;
					const fact = analysis.queryAt(input, instruction);
					if (
						fact.kind !== "known" ||
						!["undefined", "null", "boolean", "number", "string"].includes(fact.brand)
					)
						continue;
					const constant = coreStaticConstantOperation(program, fact.description);
					if (constant !== undefined) parameters.push({ index, operation: constant });
				}
				if (
					parameters.length > 0 &&
					plans.length * 4 + sequenceEdits + parameters.length + 5 <=
						context.remainingEdits
				) {
					parameterPlans.push({ instruction, inputs, parameters });
					sequenceEdits += parameters.length + 1;
				}
			}
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
			} else if (
				operation.endsWith(".prototype.valueOf") ||
				operation === "String.prototype.toString" ||
				operation === "Symbol.prototype[%Symbol.toPrimitive%]"
			) {
				const fact = analysis.queryAt(inputs[0]!, instruction);
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
				const fact = analysis.queryAt(inputs[1], instruction);
				if (fact.kind === "known" && fact.brand === operation.toLowerCase())
					plans.push({
						instruction,
						operation: { opcode: "move", inputs: [inputs[1]] },
					});
			}
		}
		if (plans.length === 0 && parameterPlans.length === 0 && payloadPlans.length === 0)
			return undefined;
		const editor = CoreEditor.open(program, fn.id);
		const booleanPayloads = new Map<CoreInstructionId, CoreValueId>();
		for (const plan of payloadPlans) {
			let input = plan.input;
			if (plan.booleanConstructor !== undefined) {
				const constructor = plan.booleanConstructor;
				const normalized = booleanPayloads.get(constructor);
				if (normalized !== undefined) input = normalized;
				else {
					// Boolean wrappers discard their input; forwarding must not retain it across suspension.
					for (let step = 0; step < 2; step++)
						input = editor.insertInstruction(
							fn.instructionBlock(constructor),
							constructor,
							"unary",
							[input],
							{
								attributes: { operator: "!" },
								sourcePosition: fn.instructionSourcePosition(constructor),
							},
						).outputs[0]!;
					const start = fn.kernel.instructionOperandStart(constructor);
					const inputs = Array.from(
						{ length: fn.kernel.instructionOperandCount(constructor) },
						(_, index) => (index === 1 ? input : fn.kernel.operandAt(start + index)),
					);
					editor.replaceOperands(constructor, inputs);
					booleanPayloads.set(constructor, input);
				}
			}
			if (
				plan.method.endsWith(".prototype.valueOf") ||
				plan.method === "String.prototype.toString" ||
				plan.method === "Symbol.prototype[%Symbol.toPrimitive%]"
			)
				editor.replaceInstruction(plan.instruction, "move", [input]);
			else if (plan.method === "Boolean.prototype.toString")
				editor.replaceInstruction(plan.instruction, "unary", [input], {
					attributes: { operator: "tostring" },
				});
			else editor.replaceOperands(plan.instruction, [input, ...plan.inputs.slice(1)]);
		}
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
			if ("collation" in plan) {
				const that =
					plan.inputs[1] ??
					editor.insertInstruction(
						fn.instructionBlock(plan.instruction),
						plan.instruction,
						"createUndefined",
						[],
						{ sourcePosition: fn.instructionSourcePosition(plan.instruction) },
					).outputs[0]!;
				editor.replaceInstruction(
					plan.instruction,
					"preparedStringCompare",
					[plan.inputs[0]!, that],
					{
						attributes: {
							stringIndex: stringIndex(plan.collation.locale),
							options: plan.collation.options,
							worldAssumptions: fn.instructionAttributes(plan.instruction)
								.worldAssumptions,
						},
					},
				);
				continue;
			}
			if ("numberParts" in plan) {
				const block = fn.instructionBlock(plan.instruction);
				const sourcePosition = fn.instructionSourcePosition(plan.instruction);
				const values = plan.numberParts.map(
					(part) =>
						editor.insertInstruction(block, plan.instruction, part.opcode, part.inputs, {
							sourcePosition,
							attributes: part.attributes,
						}).outputs[0]!,
				);
				editor.replaceInstruction(
					plan.instruction,
					values.length === 1
						? "move"
						: values.length === 2
							? "binary"
							: "preciseNumberSum",
					values,
					{
						attributes:
							values.length === 1
								? {}
								: values.length === 2
									? { operator: "+" }
									: {
											worldAssumptions: fn.instructionAttributes(plan.instruction)
												.worldAssumptions,
										},
					},
				);
				continue;
			}
			if ("stringParts" in plan) {
				const block = fn.instructionBlock(plan.instruction);
				const sourcePosition = fn.instructionSourcePosition(plan.instruction);
				let result: CoreValueId | undefined;
				for (const part of plan.stringParts) {
					let input: CoreValueId | undefined;
					if (typeof part !== "string") {
						if ("value" in part) input = part.value;
						else {
							const thisArg = editor.insertInstruction(
								block,
								plan.instruction,
								"createUndefined",
								[],
								{ sourcePosition },
							).outputs[0]!;
							const position = editor.insertInstruction(
								block,
								plan.instruction,
								"createNumber",
								[],
								{ sourcePosition, attributes: { value: part.position } },
							).outputs[0]!;
							input = editor.insertInstruction(
								block,
								plan.instruction,
								"call",
								[part.callback, thisArg, part.match, position, part.source],
								{ sourcePosition },
							).outputs[0]!;
						}
					}
					const value = editor.insertInstruction(
						block,
						plan.instruction,
						typeof part === "string" ? "createString" : "unary",
						typeof part === "string" ? [] : [input!],
						{
							sourcePosition,
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
									{ sourcePosition, attributes: { operator: "+" } },
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
		const replaced = new Set(plans.map((plan) => plan.instruction));
		for (const plan of parameterPlans) {
			if (replaced.has(plan.instruction)) continue;
			const inputs = [...plan.inputs];
			for (const { index, operation } of plan.parameters)
				inputs[index] = editor.insertInstruction(
					fn.instructionBlock(plan.instruction),
					plan.instruction,
					operation.opcode,
					operation.inputs,
					{
						attributes: operation.attributes,
						sourcePosition: fn.instructionSourcePosition(plan.instruction),
					},
				).outputs[0]!;
			editor.replaceOperands(plan.instruction, inputs);
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
		const lockedCoercions =
			context.compilationContext.facts.world.primordialPolicy === "locked" &&
			!context.compilationContext.facts.world.realms;
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
				constantConsumers = new Map<CoreInstructionId, boolean>(),
				stringCoercions = new Set<CoreInstructionId>();
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
					const index =
						opcode === "loadProperty" && fn.kernel.useOperand(use) === 0
							? analysis.constant(
									fn.kernel.operandAt(fn.kernel.instructionOperandStart(consumer) + 1),
								)
							: undefined;
					const property =
						opcode === "loadPropertyStatic"
							? analysis.string(consumerAttributes.stringIndex as number)
							: index?.kind === "number" &&
								  Number.isInteger(index.value) &&
								  index.value >= 0 &&
								  index.value < 0xffffffff
								? String(index.value)
								: undefined;
					if (opcode === "move")
						pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(consumer)));
					else if (opcode === "unary" && consumerAttributes.operator === "!")
						constantConsumers.set(consumer, false);
					else if (
						lockedCoercions &&
						((opcode === "unary" &&
							wrapperCoercingUnaryOperators.has(consumerAttributes.operator as string)) ||
							(opcode === "binary" &&
								wrapperCoercingBinaryOperators.has(
									consumerAttributes.operator as string,
								)))
					)
						continue;
					else if (
						opcode === "binary" &&
						(consumerAttributes.operator === "===" ||
							consumerAttributes.operator === "!==") &&
						fn.kernel.operandAt(fn.kernel.instructionOperandStart(consumer)) ===
							fn.kernel.operandAt(fn.kernel.instructionOperandStart(consumer) + 1)
					) {
						// The wrapper is an object even when its primitive payload is NaN.
						constantConsumers.set(consumer, consumerAttributes.operator === "===");
					} else if (
						opcode === "callKnown" &&
						!consumerAttributes.construct &&
						consumerAttributes.argumentMode === undefined &&
						noncoercingNumberPredicates.has(consumerAttributes.operation as string)
					) {
						if (fn.kernel.useOperand(use) === 1) constantConsumers.set(consumer, false);
					} else if (
						lockedCoercions &&
						opcode === "callKnown" &&
						!consumerAttributes.construct &&
						consumerAttributes.argumentMode === undefined &&
						wrapperCoercingCalls.has(consumerAttributes.operation as string)
					) {
						if (fn.kernel.useOperand(use) === 1) {
							if (consumerAttributes.operation === "Boolean")
								constantConsumers.set(consumer, true);
							else if (consumerAttributes.operation === "String" && wrapper === "Symbol")
								stringCoercions.add(consumer);
						}
					} else if (
						lockedCoercions &&
						opcode === "callKnown" &&
						!consumerAttributes.construct &&
						consumerAttributes.argumentMode === undefined &&
						fn.kernel.useOperand(use) > 0 &&
						wrapperCoercingStringArguments.has(consumerAttributes.operation as string)
					) {
						const position = fn.kernel.useOperand(use);
						if (consumerAttributes.operation === "String.raw" && position === 1) {
							safe = false;
							break;
						}
						if (
							position === 2 &&
							[
								"String.prototype.split",
								"String.prototype.replace",
								"String.prototype.replaceAll",
							].includes(consumerAttributes.operation as string)
						) {
							// Custom symbol protocols receive the original limit or replacement value.
							const pattern = analysis.query(
								fn.kernel.operandAt(fn.kernel.instructionOperandStart(consumer) + 1),
							);
							if (
								pattern.kind !== "known" ||
								![
									"undefined",
									"null",
									"boolean",
									"number",
									"string",
									"bigint",
									"symbol",
								].includes(pattern.brand)
							) {
								safe = false;
								break;
							}
						}
					} else if (
						wrapper === "String" &&
						property !== undefined &&
						(property === "length" || /^(0|[1-9][0-9]*)$/.test(property))
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
							) ||
							(wrapper === "Symbol" &&
								consumerAttributes.operation ===
									"Symbol.prototype[%Symbol.toPrimitive%]") ||
							consumerAttributes.operation === "Object.prototype.toString"
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
			if (
				!safe ||
				context.remainingEdits < constantConsumers.size + stringCoercions.size + 1
			)
				continue;
			const editor = CoreEditor.open(program, fn.id);
			for (const [consumer, value] of constantConsumers)
				editor.replaceInstruction(consumer, "createBoolean", [], {
					attributes: { value },
				});
			for (const consumer of stringCoercions) {
				// String only grants descriptive conversion to a primitive Symbol argument.
				const input = fn.kernel.operandAt(
					fn.kernel.instructionOperandStart(consumer) + 1,
				);
				editor.replaceInstruction(consumer, "unary", [input], {
					attributes: { operator: "tostring" },
				});
			}
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
