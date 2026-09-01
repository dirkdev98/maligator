import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
	compilerValueKindMaskIsValid,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type {
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE =
	"exactCallArgumentRepresentations";
export const CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE = "exactBinaryInputKindMasks";
export const CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE = "exactScalarAfterTdz";
export const CORE_PRIMITIVE_OPERATOR_EFFECT_FACT = "primitive-operator-effects";

export type CoreExactScalarKind = "int32" | "number" | "boolean" | "string";
export type CoreExactCallArgumentRepresentation = "boxed" | CoreExactScalarKind;

export interface CoreValueKindAnalysis {
	kindMask(value: CoreValueId): CompilerValueKindMask;
	exactScalar(value: CoreValueId): CoreExactScalarKind | undefined;
}

const NUMERIC_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"-", "+", "~", "increment", "decrement", "tonumeric",
]);
const NON_COERCING_UNARY_OPERATORS: ReadonlySet<string> = new Set(["!", "typeof", "void"]);
const NUMERIC_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>",
]);
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
	"<", "<=", ">", ">=", "==", "!=", "===", "!==",
]);

function numberIsExactInt32(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) &&
		value >= -0x8000_0000 && value <= 0x7fff_ffff && !Object.is(value, -0);
}

function representationKind(fn: CoreFunctionStore, value: CoreValueId): CompilerValueKindMask | undefined {
	switch (fn.valueRepresentation(value)) {
		case "f64":
		case "i32": return COMPILER_VALUE_KIND_NUMBER;
		case "boolean": return COMPILER_VALUE_KIND_BOOLEAN;
		case "string":
		case "string-span": return COMPILER_VALUE_KIND_STRING;
		case "projected-elements":
		case "dense-elements":
		case "scalarized-object": return COMPILER_VALUE_KIND_OBJECT;
		case "boxed": return undefined;
	}
}

function staticOpcodeKind(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerValueKindMask | undefined {
	switch (fn.instructionOpcodeName(instruction)) {
		case "createUndefined": return COMPILER_VALUE_KIND_UNDEFINED;
		case "createNull": return COMPILER_VALUE_KIND_NULL;
		case "createBoolean": return COMPILER_VALUE_KIND_BOOLEAN;
		case "createF64":
		case "createNumber": return COMPILER_VALUE_KIND_NUMBER;
		case "createString": return COMPILER_VALUE_KIND_STRING;
		case "createBigint": return COMPILER_VALUE_KIND_BIGINT;
		case "createPrivateName":
		case "createPrivateNames": return COMPILER_VALUE_KIND_SYMBOL;
		case "createFunction":
		case "createArray":
		case "createObject":
		case "createObjectShaped":
		case "createModuleNamespace":
		case "createTemplateObject":
		case "instantiateLiteralTemplate": return COMPILER_VALUE_KIND_OBJECT;
		case "isEmpty":
		case "typeofCompare": return COMPILER_VALUE_KIND_BOOLEAN;
		default: return undefined;
	}
}

interface KindTransfer {
	readonly output: CoreValueId;
	readonly inputs: ReadonlyArray<CoreValueId>;
	readonly evaluate: (masks: Uint16Array) => CompilerValueKindMask;
}

function operationTransfer(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	output: CoreValueId,
): KindTransfer {
	const inputs = fn.instructionOperands(instruction);
	const staticKind = representationKind(fn, output) ?? staticOpcodeKind(fn, instruction);
	if (staticKind !== undefined) return { output, inputs: [], evaluate: () => staticKind };
	const opcode = fn.instructionOpcodeName(instruction);
	const operator = fn.instructionAttributes(instruction).operator;
	if (opcode === "move" && inputs.length === 1) {
		return { output, inputs, evaluate: (masks) => masks[inputs[0]!]! };
	}
	if (opcode === "unary" && inputs.length === 1 && typeof operator === "string") {
		return {
			output,
			inputs,
			evaluate(masks) {
				if (operator === "!") return COMPILER_VALUE_KIND_BOOLEAN;
				if (operator === "typeof") return COMPILER_VALUE_KIND_STRING;
				if (operator === "void") return COMPILER_VALUE_KIND_UNDEFINED;
				return NUMERIC_UNARY_OPERATORS.has(operator) &&
					compilerValueKindMaskIsSubset(masks[inputs[0]!]!, COMPILER_VALUE_KIND_NUMBER)
					? COMPILER_VALUE_KIND_NUMBER
					: COMPILER_VALUE_KIND_TOP;
			},
		};
	}
	if (opcode === "binary" && inputs.length === 2 && typeof operator === "string") {
		return {
			output,
			inputs,
			evaluate(masks) {
				if (COMPARISON_OPERATORS.has(operator)) return COMPILER_VALUE_KIND_BOOLEAN;
				const left = masks[inputs[0]!]!;
				const right = masks[inputs[1]!]!;
				if (left === 0 || right === 0) return 0;
				if (operator === "+" &&
					compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_STRING) &&
					compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_STRING)) {
					return COMPILER_VALUE_KIND_STRING;
				}
				return NUMERIC_BINARY_OPERATORS.has(operator) &&
					compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_NUMBER) &&
					compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_NUMBER)
					? COMPILER_VALUE_KIND_NUMBER
					: COMPILER_VALUE_KIND_TOP;
			},
		};
	}
	return { output, inputs: [], evaluate: () => COMPILER_VALUE_KIND_TOP };
}

export function analyzeCoreValueKinds(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): CoreValueKindAnalysis {
	const transfers: Array<KindTransfer> = [];
	for (const block of fn.blockIds()) {
		const incoming = cfg.predecessors[block] ?? [];
		for (const [index, parameter] of fn.blockParameters(block).entries()) {
			const representation = representationKind(fn, parameter.value);
			if (representation !== undefined || parameter.role === "exception" || incoming.length === 0) {
				const kind = representation ?? COMPILER_VALUE_KIND_TOP;
				transfers.push({ output: parameter.value, inputs: [], evaluate: () => kind });
				continue;
			}
			const inputs = incoming.flatMap((edge) => {
				const value = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				return value === undefined ? [] : [value];
			});
			transfers.push({
				output: parameter.value,
				inputs,
				evaluate: (masks) => inputs.reduce((mask, value) => mask | masks[value]!, 0),
			});
		}
		for (const instruction of fn.bodyInstructionIds(block)) {
			for (const output of fn.instructionResults(instruction)) {
				transfers.push(operationTransfer(fn, instruction, output));
			}
		}
	}
	const dependents = Array.from({ length: fn.valueCapacity }, () => new Array<number>());
	for (const [index, transfer] of transfers.entries()) {
		for (const input of transfer.inputs) dependents[input]!.push(index);
	}
	const masks = new Uint16Array(fn.valueCapacity);
	const queue = transfers.map((_, index) => index);
	const queued = new Uint8Array(transfers.length);
	queued.fill(1);
	let cursor = 0;
	while (cursor < queue.length) {
		const index = queue[cursor++]!;
		queued[index] = 0;
		const transfer = transfers[index]!;
		const next = masks[transfer.output]! | transfer.evaluate(masks);
		if (next === masks[transfer.output]) continue;
		masks[transfer.output] = next;
		for (const dependent of dependents[transfer.output]!) {
			if (queued[dependent] !== 0) continue;
			queued[dependent] = 1;
			queue.push(dependent);
		}
	}
	const exactInt32 = new Uint8Array(fn.valueCapacity);
	for (let index = 0; index < fn.valueCapacity; index++) {
		const value = coreValueId(index);
		if (!fn.isValueLive(value)) continue;
		if (fn.valueRepresentation(value) === "i32") exactInt32[value] = 1;
		const definition = fn.valueDefinition(value);
		if (definition.kind !== "instruction" || fn.instructionKind(definition.instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(definition.instruction);
		if ((opcode === "createNumber" || opcode === "createF64") &&
			numberIsExactInt32(fn.instructionAttributes(definition.instruction).value)) exactInt32[value] = 1;
	}
	const result: CoreValueKindAnalysis = {
		kindMask(value) {
			return masks[value] === 0 ? COMPILER_VALUE_KIND_TOP : masks[value]!;
		},
		exactScalar(value) {
			const mask = masks[value] === 0 ? COMPILER_VALUE_KIND_TOP : masks[value]!;
			if (mask === COMPILER_VALUE_KIND_NUMBER) return exactInt32[value] === 1 ? "int32" : "number";
			if (mask === COMPILER_VALUE_KIND_BOOLEAN) return "boolean";
			if (mask === COMPILER_VALUE_KIND_STRING) return "string";
			return undefined;
		},
	};
	return Object.freeze(result);
}

export const CORE_LOCAL_VALUE_KIND_ANALYSIS: CoreAnalysisDefinition<CoreValueKindAnalysis> = {
	key: "local-value-kinds",
	scope: "function",
	functionDependencies: ["body", "cfg", "representations"],
	compute({ program, request }) {
		if (request.scope !== "function") throw new Error("Expected function analysis");
		return analyzeCoreValueKinds(
			program.function(request.function),
			buildCoreControlFlow(program, request.function, { exceptions: true }),
		);
	},
};

export function coreExactBinaryInputKindMasks(
	value: unknown,
): readonly [CompilerValueKindMask, CompilerValueKindMask] | undefined {
	if (!Array.isArray(value) || value.length !== 2 ||
		!compilerValueKindMaskIsValid(value[0]) || !compilerValueKindMaskIsValid(value[1])) return undefined;
	return value as unknown as readonly [CompilerValueKindMask, CompilerValueKindMask];
}

export function coreBinaryInputKindMasksHaveExactNativeSemantics(
	operator: unknown,
	masks: readonly [CompilerValueKindMask, CompilerValueKindMask],
): boolean {
	return typeof operator === "string" && COMPARISON_OPERATORS.has(operator) &&
		compilerValueKindMaskIsSubset(masks[0], COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED) &&
		compilerValueKindMaskIsSubset(masks[1], COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED);
}

export function corePrimitiveOperatorEffectRefinement(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	masks: ReadonlyArray<CompilerValueKindMask>,
): CoreInstructionEffects | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const operator = fn.instructionAttributes(instruction).operator;
	let primitive = false;
	let gcFree = false;
	if (opcode === "unary" && masks.length === 1 && typeof operator === "string") {
		const numberOnly = compilerValueKindMaskIsSubset(masks[0]!, COMPILER_VALUE_KIND_NUMBER);
		primitive = NON_COERCING_UNARY_OPERATORS.has(operator) ||
			(NUMERIC_UNARY_OPERATORS.has(operator) && numberOnly);
		gcFree = NON_COERCING_UNARY_OPERATORS.has(operator) || numberOnly;
	} else if (opcode === "binary" && masks.length === 2 && typeof operator === "string") {
		const numbersOnly = masks.every((mask) => compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NUMBER));
		primitive = ["===", "!=="].includes(operator) ||
			(NUMERIC_BINARY_OPERATORS.has(operator) && numbersOnly) ||
			(operator === "+" && masks.every((mask) => compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_STRING))) ||
			coreBinaryInputKindMasksHaveExactNativeSemantics(operator, [masks[0]!, masks[1]!]);
		gcFree = ["===", "!=="].includes(operator) ||
			(numbersOnly && (NUMERIC_BINARY_OPERATORS.has(operator) || COMPARISON_OPERATORS.has(operator)));
	}
	if (!primitive) return undefined;
	const baseline = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
	return {
		reads: baseline.reads.filter((domain) => domain !== "host"),
		writes: baseline.writes.filter((domain) => domain !== "host"),
		mayThrow: false,
		maySuspend: baseline.maySuspend,
		mayGc: gcFree ? false : baseline.mayGc,
		callsUserCode: false,
	};
}

export function coreExactCallArgumentRepresentations(
	value: unknown,
	parameterCount?: number,
): ReadonlyArray<CoreExactCallArgumentRepresentation> | undefined {
	if (!Array.isArray(value) || (parameterCount !== undefined && value.length !== parameterCount) ||
		value.some((entry) => entry !== "boxed" && entry !== "int32" && entry !== "number" && entry !== "boolean" && entry !== "string")) return undefined;
	return value as ReadonlyArray<CoreExactCallArgumentRepresentation>;
}

export interface CoreExactValueFactSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

export function materializeCoreExactScalarRepresentations(
	program: CoreProgram,
): CoreExactValueFactSelection {
	return { program, changed: false };
}

export function selectCoreExactValueFacts(program: CoreProgram): CoreExactValueFactSelection {
	return { program, changed: false };
}
