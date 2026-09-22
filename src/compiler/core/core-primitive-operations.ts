import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import { mathUnaryOperationKeys } from "../shared/builtin-registry.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import {
	evaluateConstantBuiltin,
	evaluateConstantStringSplit,
} from "../shared/constant-builtins.ts";
import { PORTABLE_CONSTANT_TARGET } from "../shared/constant-evaluator.ts";
import type { ConstantValue } from "../shared/constant-evaluator.ts";
import { knownOperationIndex, knownOperations } from "../shared/known-operations.ts";
import { provePrimordialAccess } from "../shared/primordial-catalog.ts";
import type { StringCollationPlan } from "../shared/string-collation-plan.ts";
import { CoreEditor } from "./core-editor.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
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
import {
	eliminateSymbolDescription,
	forwardSymbolDescription,
} from "./core-symbol-descriptions.ts";
import {
	lowerPrimitiveWrapperObservation,
	primitiveWrapperObservation,
} from "./core-wrapper-observations.ts";
import type { PrimitiveWrapperObservation } from "./core-wrapper-observations.ts";

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
	"Symbol.prototype.description<get>",
]);

function primitivePrototypePayload(
	analysis: CoreStaticValueAnalysis,
	receiver: CoreValueId,
	operation: string,
): ConstantValue | undefined {
	if (!wrapperPayloadMethods.has(operation)) return undefined;
	const fact = analysis.query(receiver);
	if (
		fact.kind !== "known" ||
		fact.canonical === undefined ||
		!operation.startsWith(`${fact.canonical}.`)
	)
		return undefined;
	switch (fact.canonical) {
		case "Boolean.prototype":
			return { kind: "boolean", value: false };
		case "Number.prototype":
			return { kind: "number", value: 0 };
		case "String.prototype":
			return { kind: "string", value: "" };
	}
	return undefined;
}

type PrimitiveWrapperPayload =
	| { kind: "value"; input: CoreValueId }
	| { kind: "normalize"; constructor: CoreInstructionId; input?: CoreValueId };

function primitiveWrapperPayload(
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	receiver: CoreValueId,
	operation: string,
): PrimitiveWrapperPayload | undefined {
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
			fn.kernel.instructionOperandCount(definition) < 1 ||
			(constructor !== "Object" &&
				(!attributes.construct || !["Boolean", "Number", "String"].includes(constructor)))
		)
			return undefined;
		if (attributes.construct) {
			const target = analysis.queryAt(fn.kernel.operandAt(start), definition);
			if (target.kind !== "known" || target.canonical !== constructor) return undefined;
		}
		if (constructor !== "Object" && constructor.toLowerCase() !== brand) return undefined;
		const input =
			fn.kernel.instructionOperandCount(definition) > 1
				? fn.kernel.operandAt(start + 1)
				: undefined;
		const fact = input !== undefined ? analysis.queryAt(input, definition) : undefined;
		// Escaping wrappers keep their identity, but their primitive internal slot cannot change.
		if (input !== undefined && fact?.kind === "known" && fact.brand === brand)
			return { kind: "value", input };
		if (constructor !== "Object")
			return { kind: "normalize", constructor: definition, input };
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
const wrapperPropertyKeyCalls = new Map([
	["Object.hasOwn", 2],
	["Object.defineProperty", 2],
	["Object.getOwnPropertyDescriptor", 2],
	["Object.prototype.hasOwnProperty", 1],
	["Object.prototype.propertyIsEnumerable", 1],
	["Object.prototype.__defineGetter__", 1],
	["Object.prototype.__defineSetter__", 1],
	["Object.prototype.__lookupGetter__", 1],
	["Object.prototype.__lookupSetter__", 1],
	["Reflect.get", 2],
	["Reflect.set", 2],
	["Reflect.has", 2],
	["Reflect.deleteProperty", 2],
	["Reflect.defineProperty", 2],
	["Reflect.getOwnPropertyDescriptor", 2],
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
				if (
					opcode === "callKnown" &&
					(attributes.argumentMode === undefined ||
						(attributes.construct &&
							(attributes.argumentMode === "array-like" ||
								attributes.argumentMode === "nullable-array-like")))
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
		const constantTarget = {
			...PORTABLE_CONSTANT_TARGET,
			intl: context.compilationContext.facts.world.ecmaFeatures.intl,
		};
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
			parameters: ReadonlyArray<
				| { index: number; operation: CoreStaticMemberOperation }
				| { index: number; string: string }
			>;
		}> = [];
		const payloadPlans: Array<{
			instruction: CoreInstructionId;
			method: string;
			inputs: ReadonlyArray<CoreValueId>;
			payload: PrimitiveWrapperPayload;
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
				const left = analysis.queryAt(fn.kernel.operandAt(start), instruction);
				if (
					left.kind !== "known" ||
					(left.brand !== "symbol" &&
						(left.brand !== "function" || left.identity?.kind !== "intrinsic")) ||
					left.identity === undefined ||
					!["fresh-per-evaluation", "symbol-registry", "intrinsic"].includes(
						left.identity.kind,
					)
				)
					continue;
				const right = analysis.queryAt(fn.kernel.operandAt(start + 1), instruction);
				if (
					right.kind === "known" &&
					((left.brand === "symbol" && right.brand === "symbol") ||
						(left.brand === "function" &&
							right.brand === "function" &&
							right.identity?.kind === "intrinsic"))
				) {
					const a = left.identity,
						b = right.identity;
					if (
						b !== undefined &&
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
			const operation = attributes.operation as string;
			if (
				!/^(Boolean|Number|String|BigInt|Symbol|Math)(\.|$)/.test(operation) &&
				![
					"Object",
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
			const newTarget = attributes.construct
				? analysis.queryAt(
						fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
						instruction,
					)
				: undefined;
			const targetConstructable =
				newTarget?.kind !== "known"
					? undefined
					: newTarget.brand !== "function"
						? false
						: knownOperations()[knownOperationIndex(newTarget.canonical ?? "") ?? -1]
								?.constructable;
			if (
				attributes.construct &&
				(attributes.argumentMode === undefined ||
					attributes.argumentMode === "array-like" ||
					attributes.argumentMode === "nullable-array-like") &&
				(knownOperations()[knownOperationIndex(operation) ?? -1]?.constructable ===
					false ||
					targetConstructable === false)
			) {
				// Reflect checks constructability before reading its list; source spreads run first.
				if (newTarget?.kind === "known") analysis.verify(newTarget, instruction);
				plans.push({
					instruction,
					operation: {
						opcode: "builtinError",
						inputs: [],
						attributes: { error: "notConstructor" },
					},
				});
				continue;
			}
			if (attributes.argumentMode !== undefined) continue;
			const inputs = Array.from(
				{ length: fn.kernel.instructionOperandCount(instruction) },
				(_, index) =>
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
			);
			const numericOperation = fn.instructionOpcodeName(instruction) !== "callKnown";
			if (operation === "Object" && inputs[1] !== undefined) {
				const fact = analysis.queryAt(inputs[1], instruction);
				const target = attributes.construct
					? analysis.queryAt(inputs[0]!, instruction)
					: undefined;
				if (
					fact.kind === "known" &&
					["object", "array", "function"].includes(fact.brand) &&
					(!attributes.construct ||
						(target?.kind === "known" && target.canonical === "Object"))
				) {
					analysis.verify(fact, instruction);
					plans.push({ instruction, operation: { opcode: "move", inputs: [inputs[1]] } });
				}
				continue;
			}
			if (attributes.construct) {
				if (
					["Boolean", "Number", "String"].includes(operation) &&
					inputs[1] !== undefined
				) {
					const input = analysis.queryAt(inputs[1], instruction);
					if (
						input.kind === "known" &&
						input.brand !== operation.toLowerCase() &&
						!(operation === "String" && input.brand === "symbol")
					) {
						const evaluated = evaluateConstantBuiltin(
							operation,
							undefined,
							[analysis.constant(inputs[1], instruction)],
							constantTarget,
						);
						const value =
							operation === "Boolean" &&
							["object", "array", "function", "symbol"].includes(input.brand)
								? ({ kind: "boolean", value: true } as const)
								: evaluated.kind === "value"
									? evaluated.value
									: undefined;
						if (
							value?.kind === "boolean" ||
							value?.kind === "number" ||
							value?.kind === "string"
						) {
							analysis.verify(input, instruction);
							parameterPlans.push({
								instruction,
								inputs,
								parameters: [
									value.kind === "string"
										? { index: 1, string: value.value }
										: {
												index: 1,
												operation: {
													opcode:
														value.kind === "boolean" ? "createBoolean" : "createF64",
													inputs: [],
													attributes: { value: value.value },
												},
											},
								],
							});
							sequenceEdits += 2;
						}
					}
				}
				const target = newTarget!;
				if (
					(operation === "BigInt" || operation === "Symbol") &&
					target.kind === "known" &&
					targetConstructable === true
				) {
					analysis.verify(target, instruction);
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
				} else if (target.kind === "known" && target.canonical === operation) {
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
				(operation === "BigInt.asIntN" || operation === "BigInt.asUintN") &&
				inputs[1] !== undefined &&
				inputs[2] !== undefined
			) {
				const width = analysis.constant(inputs[1], instruction),
					input = analysis.queryAt(inputs[2], instruction);
				if (
					width !== undefined &&
					input.kind === "known" &&
					(input.brand === "bigint" || input.brand === "boolean")
				) {
					// One becomes zero only after a zero-width ToIndex conversion.
					const witness: ConstantValue =
						input.brand === "bigint"
							? { kind: "bigint", value: 1n }
							: { kind: "boolean", value: true };
					const evaluated = evaluateConstantBuiltin(
						operation,
						undefined,
						[width, witness],
						constantTarget,
					);
					if (
						evaluated.kind === "value" &&
						evaluated.value.kind === "bigint" &&
						evaluated.value.value === 0n
					) {
						analysis.verify(input, instruction);
						plans.push({ instruction, value: evaluated.value });
						continue;
					}
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
				operation === "Symbol.prototype.description<get>" ||
				operation === "Symbol.prototype.toString" ||
				operation === "Symbol.keyFor" ||
				operation === "String"
			) {
				const forwarded = forwardSymbolDescription(
					context,
					analysis,
					instruction,
					inputs[operation === "Symbol.keyFor" || operation === "String" ? 1 : 0],
					operation === "Symbol.keyFor"
						? "key"
						: operation === "Symbol.prototype.description<get>"
							? "description"
							: "string",
				);
				if (forwarded !== undefined) return forwarded;
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
			if (
				operation === "String.prototype.repeat" ||
				operation === "String.prototype.padStart" ||
				operation === "String.prototype.padEnd" ||
				operation === "String.prototype.slice" ||
				operation === "String.prototype.substring" ||
				operation === "String.prototype.substr" ||
				operation === "String.prototype.includes" ||
				operation === "String.prototype.startsWith" ||
				operation === "String.prototype.endsWith" ||
				operation === "String.prototype.concat"
			) {
				const receiver = inputs[0]!;
				const fact = analysis.queryAt(receiver, instruction);
				if (fact.kind === "known" && fact.brand === "string") {
					if (
						operation === "String.prototype.concat" &&
						inputs.length <= 4096 &&
						inputs.slice(1).every((input) => {
							const part = analysis.constant(input, instruction);
							return part?.kind === "string" && part.value.length === 0;
						})
					) {
						plans.push({
							instruction,
							operation: { opcode: "move", inputs: [receiver] },
						});
						continue;
					}
					const integer = (input: CoreValueId | undefined, fallback = 0) => {
						if (input === undefined) return fallback;
						const value = analysis.constant(input, instruction);
						if (value === undefined || value.kind === "bigint") return undefined;
						if (value.kind === "undefined") return fallback;
						const converted = evaluateConstantBuiltin(
							"Number",
							undefined,
							[value],
							constantTarget,
						);
						if (converted.kind !== "value" || converted.value.kind !== "number")
							return undefined;
						return Number.isNaN(converted.value.value)
							? 0
							: Math.trunc(converted.value.value);
					};
					const search =
						operation === "String.prototype.includes" ||
						operation === "String.prototype.startsWith" ||
						operation === "String.prototype.endsWith";
					if (search && inputs[1] !== undefined) {
						const needle = analysis.constant(inputs[1], instruction);
						if (
							needle?.kind === "string" &&
							needle.value.length === 0 &&
							integer(inputs[2]) !== undefined
						) {
							plans.push({ instruction, value: { kind: "boolean", value: true } });
							continue;
						}
					}
					const count =
						search || operation === "String.prototype.concat"
							? undefined
							: integer(inputs[1]);
					if (count !== undefined) {
						const repeat = operation === "String.prototype.repeat";
						if (repeat && count === 0) {
							plans.push({ instruction, value: { kind: "string", value: "" } });
							continue;
						}
						const range =
							operation === "String.prototype.slice" ||
							operation === "String.prototype.substring" ||
							operation === "String.prototype.substr";
						const end = range ? integer(inputs[2], Infinity) : undefined;
						if (range && end !== undefined) {
							const empty =
								operation === "String.prototype.substr"
									? end <= 0 || count === Infinity
									: operation === "String.prototype.substring"
										? count === end || (count <= 0 && end <= 0)
										: count === end ||
											count === Infinity ||
											end === -Infinity ||
											(count < 0 === end < 0 && end <= count);
							if (empty) {
								plans.push({ instruction, value: { kind: "string", value: "" } });
								continue;
							}
						}
						const filler =
							!repeat && !range && inputs[2] !== undefined
								? analysis.constant(inputs[2], instruction)
								: undefined;
						const identity = repeat
							? count === 1
							: range
								? (operation === "String.prototype.substring"
										? count <= 0
										: count === 0 || count === -Infinity) && end === Infinity
								: count <= 0 || (filler?.kind === "string" && filler.value.length === 0);
						if (identity) {
							plans.push({
								instruction,
								operation: { opcode: "move", inputs: [receiver] },
							});
							continue;
						}
					}
				}
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
				payloadPlans.push({ instruction, method: operation, inputs, payload });
				sequenceEdits += payload.kind === "normalize" ? 4 : 1;
				continue;
			}
			const prototypePayload =
				!numericOperation && inputs[0] !== undefined
					? primitivePrototypePayload(analysis, inputs[0], operation)
					: undefined;
			const evaluated = evaluateConstantBuiltin(
				operation,
				operation.includes(".prototype.")
					? (prototypePayload ?? analysis.constant(inputs[0]!, instruction))
					: undefined,
				inputs
					.slice(numericOperation ? 0 : 1)
					.map((value) => analysis.constant(value, instruction)),
				constantTarget,
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
			if (prototypePayload?.kind === "number") {
				parameterPlans.push({
					instruction,
					inputs,
					parameters: [
						{
							index: 0,
							operation: {
								opcode: "createNumber",
								inputs: [],
								attributes: { value: prototypePayload.value },
							},
						},
					],
				});
				sequenceEdits++;
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
		const normalizedPayloads = new Map<CoreInstructionId, CoreValueId>();
		for (const plan of payloadPlans) {
			let input: CoreValueId;
			if (plan.payload.kind === "value") input = plan.payload.input;
			else {
				const { constructor } = plan.payload;
				const normalized = normalizedPayloads.get(constructor);
				if (normalized !== undefined) input = normalized;
				else {
					const attributes = fn.instructionAttributes(constructor);
					const start = fn.kernel.instructionOperandStart(constructor);
					const inputs = Array.from(
						{ length: fn.kernel.instructionOperandCount(constructor) },
						(_, index) => fn.kernel.operandAt(start + index),
					);
					const position = fn.instructionSourcePosition(constructor);
					// Capture conversion here to avoid repeating effects or retaining discarded objects.
					if (attributes.operation === "String" && plan.payload.input !== undefined)
						input = editor.insertInstruction(
							fn.instructionBlock(constructor),
							constructor,
							"unary",
							[plan.payload.input],
							{ attributes: { operator: "tostring" }, sourcePosition: position },
						).outputs[0]!;
					else
						input = editor.insertInstruction(
							fn.instructionBlock(constructor),
							constructor,
							"callKnown",
							inputs.slice(0, 2),
							{
								attributes: { ...attributes, construct: false },
								sourcePosition: position,
							},
						).outputs[0]!;
					editor.replaceOperands(constructor, [inputs[0]!, input, ...inputs.slice(2)]);
					normalizedPayloads.set(constructor, input);
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
		const bigints = new Map<bigint, number>();
		const stringIndex = (value: string) =>
			program.stringConstantSlot(value, "first") ??
			editor.appendStringConstants([
				Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)),
			]);
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
			for (const parameter of plan.parameters) {
				const { index } = parameter;
				const operation =
					"operation" in parameter
						? parameter.operation
						: {
								opcode: "createString",
								inputs: [],
								attributes: { stringIndex: stringIndex(parameter.string) },
							};
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
			}
			editor.replaceOperands(plan.instruction, inputs);
		}
		return editor.commit();
	},
};

type WrapperPropertyRead =
	| { kind: "value"; nodeIndex: number; target: string }
	| { kind: "getter"; target: string }
	| { kind: "undefined" };

function primitiveWrapperAllocation(
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
) {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction),
		operation = attributes.operation as string;
	if (
		(!attributes.construct && operation !== "Object") ||
		attributes.argumentMode !== undefined ||
		!["Boolean", "Number", "String", "Object"].includes(operation)
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const args = Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) => fn.kernel.operandAt(start + index),
	);
	if (attributes.construct) {
		const newTarget = analysis.query(args[0]!);
		if (newTarget.kind !== "known" || newTarget.canonical !== operation) return undefined;
	}
	let wrapper = operation;
	if (operation === "Object") {
		const input = args[1] === undefined ? undefined : analysis.query(args[1]);
		if (
			input?.kind !== "known" ||
			!["number", "string", "boolean", "bigint", "symbol"].includes(input.brand)
		)
			return undefined;
		wrapper =
			input.brand === "bigint"
				? "BigInt"
				: input.brand[0]!.toUpperCase() + input.brand.slice(1);
	}
	return { instruction, attributes, operation, args, wrapper };
}

function primitiveWrapperIdentityEqual(
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	value: CoreValueId,
	other: CoreValueId | undefined,
): boolean | undefined {
	if (value === other) return true;
	if (other === undefined) return false;
	const fact = analysis.query(other);
	if (
		fact.kind === "known" &&
		["undefined", "null", "boolean", "number", "string", "bigint", "symbol"].includes(
			fact.brand,
		)
	)
		return false;
	// Different allocation sites cannot alias; loop-carried values may select either site.
	if (
		fn.kernel.valueDefinitionKind(value) === 1 &&
		fn.kernel.valueDefinitionKind(other) === 1 &&
		primitiveWrapperAllocation(
			fn,
			analysis,
			coreInstructionId(fn.kernel.valueDefinitionOwner(value)),
		) !== undefined &&
		primitiveWrapperAllocation(
			fn,
			analysis,
			coreInstructionId(fn.kernel.valueDefinitionOwner(other)),
		) !== undefined
	)
		return false;
	return undefined;
}

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
	requiredAnalyses: [
		CORE_STATIC_VALUE_ANALYSIS,
		CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "memoryEffects", "facts", "representations"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const lockedCoercions =
			context.compilationContext.facts.world.primordialPolicy === "locked" &&
			!context.compilationContext.facts.world.realms;
		let kinds: CoreValueKindAnalysis | undefined;
		for (const instruction of fn.instructionIds()) {
			const allocation = primitiveWrapperAllocation(fn, analysis, instruction);
			if (allocation === undefined) continue;
			const { wrapper } = allocation;
			const root = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			const allocations = new Map([[instruction, allocation]]);
			const pending: Array<CoreValueId> = [root],
				visited = new Set<CoreValueId>(),
				constantConsumers = new Map<CoreInstructionId, boolean>(),
				stringCoercions = new Set<CoreInstructionId>(),
				truthyBranches = new Set<CoreInstructionId>(),
				objectObservations = new Map<CoreInstructionId, PrimitiveWrapperObservation>(),
				propertyReads = new Map<CoreInstructionId, WrapperPropertyRead>();
			const wrapperPrototype = (): WrapperPropertyRead | undefined => {
				if (!lockedCoercions) return undefined;
				const resolution = provePrimordialAccess(
					context.compilationContext.facts.world,
					{ kind: "intrinsic", id: wrapper, realm: "current" },
					"prototype",
				)?.resolution;
				const nodeIndex = resolution?.descriptor[2],
					target = resolution?.value?.[0];
				return typeof nodeIndex === "number" && target !== undefined
					? { kind: "value", nodeIndex, target }
					: undefined;
			};
			const wrapperPropertyRead = (
				instruction: CoreInstructionId,
				receiver: CoreValueId,
			): WrapperPropertyRead | undefined => {
				if (
					!lockedCoercions ||
					fn.instructionKind(instruction) !== "operation" ||
					fn.instructionOpcodeName(instruction) !== "loadPropertyStatic" ||
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)) !== receiver
				)
					return undefined;
				const property = analysis.string(
					fn.instructionAttributes(instruction).stringIndex as number,
				);
				// String wrappers have own length and indexed properties ahead of their prototype.
				if (
					wrapper === "String" &&
					(property === "length" || /^(0|[1-9][0-9]*)$/.test(property))
				)
					return undefined;
				const proof = provePrimordialAccess(
					context.compilationContext.facts.world,
					{ kind: "intrinsic", id: `${wrapper}.prototype`, realm: "current" },
					property,
				);
				if (proof?.kind === "absent") return { kind: "undefined" };
				const resolution = proof?.resolution;
				const target = resolution?.getter?.[0] ?? resolution?.value?.[0];
				if (target === undefined) return undefined;
				if (resolution?.getter !== undefined) {
					if (target === "Object.prototype.__proto__<get>") return wrapperPrototype();
					return target.startsWith(`${wrapper}.prototype.`)
						? { kind: "getter", target }
						: undefined;
				}
				const nodeIndex = resolution?.descriptor[2];
				if (typeof nodeIndex !== "number") return undefined;
				return { kind: "value", nodeIndex, target };
			};
			let safe = true;
			while (pending.length && safe) {
				const value = pending.pop()!;
				if (visited.has(value)) continue;
				visited.add(value);
				if (visited.size > 64 || fn.kernel.valueHandlerUseCount(value) !== 0) {
					safe = false;
					break;
				}
				if (fn.kernel.valueDefinitionKind(value) === 0) {
					const block = coreBlockId(fn.kernel.valueDefinitionOwner(value));
					const index = fn.kernel.valueDefinitionIndex(value);
					const incoming =
						context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional()
							.predecessors[block] ?? [];
					if (
						block === fn.entry ||
						incoming.length === 0 ||
						incoming.some(
							(edge) => edge.kind !== "ordinary" || edge.arguments[index] === undefined,
						)
					) {
						safe = false;
						break;
					}
					for (const edge of incoming) pending.push(edge.arguments[index]!);
				} else {
					const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
					if (fn.instructionOpcodeName(definition) === "move")
						pending.push(
							fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition)),
						);
					else {
						const source = primitiveWrapperAllocation(fn, analysis, definition);
						if (source === undefined || source.wrapper !== wrapper) {
							safe = false;
							break;
						}
						allocations.set(definition, source);
					}
				}
				for (
					let use = fn.kernel.valueFirstUse(value);
					use >= 0;
					use = fn.kernel.useNext(use)
				) {
					const consumer = fn.kernel.useInstruction(use);
					if (fn.instructionKind(consumer) !== "operation") {
						if (
							fn.instructionKind(consumer) === "branch" &&
							fn.kernel.useOperand(use) === 0
						) {
							truthyBranches.add(consumer);
							continue;
						}
						const operand =
							fn.kernel.instructionOperandStart(consumer) + fn.kernel.useOperand(use);
						const edgeStart = fn.kernel.terminatorEdgeStart(consumer);
						let forwarded = false;
						for (
							let offset = 0;
							offset < fn.kernel.terminatorEdgeCount(consumer);
							offset++
						) {
							const edge = edgeStart + offset;
							const index = operand - fn.kernel.terminatorEdgeArgumentStart(edge);
							if (index < 0 || index >= fn.kernel.terminatorEdgeArgumentCount(edge))
								continue;
							const block = fn.kernel.terminatorEdgeBlock(edge);
							pending.push(
								fn.kernel.blockParameterValue(
									fn.kernel.blockParameterStart(block) + index,
								),
							);
							forwarded = true;
							break;
						}
						if (forwarded) continue;
						safe = false;
						break;
					}
					let opcode = fn.instructionOpcodeName(consumer);
					let consumerAttributes = fn.instructionAttributes(consumer);
					let argumentOffset = 0;
					const propertyRead = wrapperPropertyRead(consumer, value);
					if (
						opcode === "callKnown" &&
						!consumerAttributes.construct &&
						consumerAttributes.argumentMode === undefined &&
						lockedCoercions
					) {
						const operation = consumerAttributes.operation as string;
						const operand = fn.kernel.useOperand(use);
						if (
							(operand === 1 &&
								["Object.getPrototypeOf", "Reflect.getPrototypeOf"].includes(
									operation,
								)) ||
							(operand === 0 && operation === "Object.prototype.__proto__<get>")
						) {
							const prototype = wrapperPrototype();
							if (prototype !== undefined) {
								propertyReads.set(consumer, prototype);
								continue;
							}
						}
						if (operand === 1 && operation === "Object.prototype.isPrototypeOf") {
							const receiver = analysis.query(
								fn.kernel.operandAt(fn.kernel.instructionOperandStart(consumer)),
							);
							if (
								receiver.kind === "known" &&
								(receiver.canonical === "Object.prototype" ||
									receiver.canonical === `${wrapper}.prototype`)
							) {
								constantConsumers.set(consumer, true);
								continue;
							}
						}
						if (
							operand === 1 &&
							[
								"Object.isExtensible",
								"Reflect.isExtensible",
								"Object.isFrozen",
								"Object.isSealed",
							].includes(operation)
						) {
							constantConsumers.set(consumer, operation.endsWith("isExtensible"));
							continue;
						}
					}
					if (propertyRead !== undefined) {
						propertyReads.set(consumer, propertyRead);
						continue;
					}
					if (opcode === "call" && fn.kernel.useOperand(use) === 1) {
						const callee = fn.kernel.operandAt(
							fn.kernel.instructionOperandStart(consumer),
						);
						if (fn.kernel.valueDefinitionKind(callee) === 1) {
							const lookup = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
							const method = wrapperPropertyRead(lookup, value);
							if (method?.kind === "value") {
								propertyReads.set(lookup, method);
								opcode = "callKnown";
								consumerAttributes = { ...consumerAttributes, operation: method.target };
								argumentOffset = 1;
							}
						}
					}
					const consumerStart =
						fn.kernel.instructionOperandStart(consumer) + argumentOffset;
					const consumerOperand = fn.kernel.useOperand(use) - argumentOffset;
					if (
						lockedCoercions &&
						(opcode === "binary" ||
							(opcode === "callKnown" &&
								!consumerAttributes.construct &&
								consumerAttributes.argumentMode === undefined))
					) {
						const observation = primitiveWrapperObservation(
							fn,
							analysis,
							context.compilationContext.facts.world,
							wrapper,
							consumer,
							value,
							consumerOperand,
							(opcode === "binary"
								? consumerAttributes.operator
								: consumerAttributes.operation) as string,
							argumentOffset,
						);
						if (observation !== undefined) {
							objectObservations.set(consumer, observation);
							continue;
						}
					}
					const index =
						opcode === "loadProperty" && consumerOperand === 0
							? analysis.constant(fn.kernel.operandAt(consumerStart + 1))
							: undefined;
					const indexFact =
						wrapper === "String" && opcode === "loadProperty" && consumerOperand === 0
							? analysis.query(fn.kernel.operandAt(consumerStart + 1))
							: undefined;
					const numericIndex =
						indexFact !== undefined &&
						((indexFact.kind === "known" && indexFact.brand === "number") ||
							(kinds ??= context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS)).kindMask(
								fn.kernel.operandAt(consumerStart + 1),
							) === COMPILER_VALUE_KIND_NUMBER);
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
						opcode === "binary" &&
						["===", "!==", "==", "!="].includes(consumerAttributes.operator as string)
					) {
						const operator = consumerAttributes.operator as string;
						const other = fn.kernel.operandAt(
							consumerStart + (consumerOperand === 0 ? 1 : 0),
						);
						if (operator === "==" || operator === "!=") {
							const fact = analysis.query(other);
							if (
								fact.kind === "known" &&
								["boolean", "number", "string", "bigint", "symbol"].includes(fact.brand)
							) {
								if (lockedCoercions) continue;
								safe = false;
								break;
							}
						}
						const equal = primitiveWrapperIdentityEqual(fn, analysis, value, other);
						if (equal === undefined) {
							safe = false;
							break;
						}
						constantConsumers.set(consumer, operator.startsWith("!") ? !equal : equal);
					} else if (
						opcode === "callKnown" &&
						!consumerAttributes.construct &&
						consumerAttributes.argumentMode === undefined &&
						consumerAttributes.operation === "Object.is"
					) {
						if (consumerOperand === 1 || consumerOperand === 2) {
							const otherIndex = consumerOperand === 1 ? 2 : 1;
							const other =
								otherIndex < fn.kernel.instructionOperandCount(consumer) - argumentOffset
									? fn.kernel.operandAt(consumerStart + otherIndex)
									: undefined;
							const equal = primitiveWrapperIdentityEqual(fn, analysis, value, other);
							if (equal === undefined) {
								safe = false;
								break;
							}
							constantConsumers.set(consumer, equal);
						}
					} else if (
						lockedCoercions &&
						((consumerOperand === 1 &&
							[
								"loadProperty",
								"storeProperty",
								"deleteProperty",
								"defineProperty",
								"toPropertyKey",
							].includes(opcode)) ||
							(opcode === "binary" &&
								consumerAttributes.operator === "in" &&
								consumerOperand === 0) ||
							(opcode === "callKnown" &&
								!consumerAttributes.construct &&
								consumerAttributes.argumentMode === undefined &&
								wrapperPropertyKeyCalls.get(consumerAttributes.operation as string) ===
									consumerOperand))
					)
						continue;
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
						opcode === "callKnown" &&
						!consumerAttributes.construct &&
						consumerAttributes.argumentMode === undefined &&
						noncoercingNumberPredicates.has(consumerAttributes.operation as string)
					) {
						if (consumerOperand === 1) constantConsumers.set(consumer, false);
					} else if (
						lockedCoercions &&
						opcode === "callKnown" &&
						!consumerAttributes.construct &&
						consumerAttributes.argumentMode === undefined &&
						wrapperCoercingCalls.has(consumerAttributes.operation as string)
					) {
						if (consumerOperand === 1) {
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
						consumerOperand > 0 &&
						wrapperCoercingStringArguments.has(consumerAttributes.operation as string)
					) {
						const position = consumerOperand;
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
							const pattern = analysis.query(fn.kernel.operandAt(consumerStart + 1));
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
						consumerOperand === 0 &&
						(property === "length" ||
							(lockedCoercions &&
								((property !== undefined &&
									(/^(0|[1-9][0-9]*)$/.test(property) ||
										property === "-0" ||
										property === String(Number(property)))) ||
									numericIndex)))
					)
						continue;
					else if (
						opcode !== "callKnown" ||
						consumerOperand !== 0 ||
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
						fn.kernel.instructionOperandCount(consumer) - argumentOffset > 1
					) {
						// A symbol protocol receives the original wrapper before receiver ToString.
						const argument = analysis.query(fn.kernel.operandAt(consumerStart + 1));
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
				context.remainingEdits <
					constantConsumers.size +
						stringCoercions.size +
						allocations.size +
						propertyReads.size +
						objectObservations.size * 20 +
						truthyBranches.size
			)
				continue;
			const stringConversions = new Set<CoreInstructionId>();
			for (const { instruction, operation, args } of allocations.values())
				if (
					operation === "String" &&
					args[1] !== undefined &&
					analysis.constant(args[1]) === undefined
				)
					stringConversions.add(instruction);
			const editor = CoreEditor.open(program, fn.id);
			for (const [consumer, observation] of objectObservations)
				lowerPrimitiveWrapperObservation(editor, fn, consumer, observation);
			for (const [lookup, read] of propertyReads) {
				if (read.kind === "undefined") {
					editor.replaceInstruction(lookup, "createUndefined", []);
					continue;
				}
				const worldAssumptions = {
					...builtinWorldAssumptions(read.target, "exact-builtin-proof", true),
				};
				if (read.kind === "getter") {
					const receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(lookup));
					editor.replaceInstruction(lookup, "callKnown", [receiver], {
						attributes: { operation: read.target, worldAssumptions },
					});
				} else
					editor.replaceInstruction(lookup, "loadPrimordial", [], {
						attributes: { nodeIndex: read.nodeIndex, worldAssumptions },
					});
			}
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
			for (const {
				instruction: producer,
				operation,
				args,
				attributes,
			} of allocations.values()) {
				if (operation === "Object")
					editor.replaceInstruction(producer, "move", [args[1]!]);
				else if (args[1] !== undefined && stringConversions.has(producer)) {
					// String construction uses ordinary ToString, including Symbol rejection.
					editor.replaceInstruction(producer, "unary", [args[1]], {
						attributes: { operator: "tostring" },
					});
				} else
					editor.replaceInstruction(producer, "callKnown", args, {
						attributes: { ...attributes, construct: false },
					});
			}
			for (const branch of truthyBranches) {
				const payload = coreTerminatorInput(fn, branch);
				if (payload.kind !== "branch")
					throw new Error("Expected a wrapper truthiness branch");
				editor.replaceTerminator(fn.instructionBlock(branch), {
					kind: "jump",
					edge: payload.consequent,
				});
			}
			return editor.commit();
		}
		return undefined;
	},
};
