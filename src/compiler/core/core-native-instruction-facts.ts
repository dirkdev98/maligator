import { builtinPreservesIntegerInput } from "../shared/builtin-registry.ts";
import {
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_NUMBER,
} from "../shared/compiler-value-kinds.ts";
import {
	encodeInstructionEffects,
	INSTRUCTION_MAY_THROW,
} from "../shared/instruction-facts.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
	compilerIntegerRangesEqual,
} from "../shared/integer-range.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_CONDITIONAL_VALUE_KIND_ANALYSIS } from "./core-conditional-value-kinds.ts";
import type { CoreConditionalValueKinds } from "./core-conditional-value-kinds.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type { CoreLoopInductionAnalysis } from "./core-ir-loops.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import {
	corePrimitiveEffectRefinement,
	coreInstructionResultIntegerRange,
	coreInstructionLengthIntegerRange,
	coreIntegerPreservedResultInput,
} from "./core-ir-value-kinds.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
	CoreBlockId,
} from "./core-ir.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreFunctionVersions,
	CoreProgram,
} from "./core-store.ts";

export interface CoreInstructionFacts {
	readonly masks: ReadonlyArray<number>;
	readonly results: ReadonlyArray<number>;
	readonly inputIntegerRanges?: ReadonlyArray<CompilerIntegerRange | undefined>;
	readonly resultIntegerRanges?: ReadonlyArray<CompilerIntegerRange | undefined>;
	readonly effectMask: number;
}

export interface CoreInstructionFactPlan {
	readonly function: CoreFunctionId;
	readonly instructions: ReadonlyArray<CoreInstructionFacts | undefined>;
}

const kindProofs = new WeakMap<
	CoreInstructionFactPlan,
	{ fn: CoreFunctionStore; versions: CoreFunctionVersions; dataVersion: number }
>();

export function coreInstructionFactProofIsCurrent(
	program: CoreProgram,
	plan: CoreInstructionFactPlan,
): boolean {
	const proof = kindProofs.get(plan);
	return (
		proof?.fn === program.function(plan.function) &&
		proof.dataVersion === program.versions.data &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
	);
}

export function coreInstructionFactPlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<CoreInstructionFactPlan> {
	const plans: Array<CoreInstructionFactPlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		const kinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
			scope: "function",
			function: functionId,
		});
		const proof = { fn, versions: fn.versions, dataVersion: program.versions.data };
		let conditional: CoreConditionalValueKinds | undefined;
		const inputKinds: CoreConditionalValueKinds = {
			kindMask(value, block) {
				const mask = kinds.kindMask(value);
				if ((mask & (mask - 1)) === 0) return mask;
				return (conditional ??= analyses.get(CORE_CONDITIONAL_VALUE_KIND_ANALYSIS, {
					scope: "function",
					function: functionId,
				})).kindMask(value, block);
			},
		};
		let ranges: CoreLoopInductionAnalysis | undefined;
		const range: CoreInstructionRangeQuery = (value, block) =>
			(ranges ??= analyses.get(CORE_LOOP_INDUCTION_ANALYSIS, {
				scope: "function",
				function: functionId,
			})).range(value, block);
		const instructions = new Array<CoreInstructionFacts | undefined>(
			fn.instructionCapacity,
		);
		for (const instruction of fn.instructionIds())
			instructions[instruction] = Object.freeze(
				coreInstructionFacts(program, fn, instruction, kinds, inputKinds, false, range),
			);
		const plan = Object.freeze({
			function: functionId,
			instructions: Object.freeze(instructions),
		});
		kindProofs.set(plan, proof);
		plans.push(plan);
	}
	return Object.freeze(plans);
}

const emptyMasks: ReadonlyArray<number> = Object.freeze([]);
const singleMasks = new Map<number, ReadonlyArray<number>>();
const pairMasks = new Map<number, ReadonlyArray<number>>();
export type CoreInstructionRangeQuery = (
	value: CoreValueId,
	block: CoreBlockId,
) => CompilerIntegerRange | undefined;

const singleInt32Input = Object.freeze([COMPILER_INT32_RANGE]);
const pairInt32Inputs = Object.freeze([
	undefined,
	Object.freeze([COMPILER_INT32_RANGE, undefined]),
	Object.freeze([undefined, COMPILER_INT32_RANGE]),
	Object.freeze([COMPILER_INT32_RANGE, COMPILER_INT32_RANGE]),
]);
const boundBinaryConsumers: ReadonlySet<string> = new Set([
	"%",
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);
const integerBinaryConsumers: ReadonlySet<string> = new Set([
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);
const boundBuiltinConsumers: ReadonlySet<string> = new Set([
	"Object.is",
	"Math.abs",
	"Math.sign",
	"Math.min",
	"Math.max",
]);
const integerBuiltinConsumers: ReadonlySet<string> = new Set([
	"Number.isNaN",
	"Number.isFinite",
	"Number.isInteger",
	"Number.isSafeInteger",
	"Math.imul",
	"Math.clz32",
]);

function instructionIntegerRanges(
	fn: CoreFunctionStore,
	kinds: CoreValueKindAnalysis,
	instruction: CoreInstructionId,
	start: number,
	count: number,
	query?: CoreInstructionRangeQuery,
): ReadonlyArray<CompilerIntegerRange | undefined> | undefined {
	if (count === 0) return undefined;
	const operation = fn.instructionKind(instruction) === "operation";
	const opcode = operation ? fn.instructionOpcodeName(instruction) : "";
	const attributes = operation ? fn.instructionAttributes(instruction) : {};
	const operator = attributes.operator;
	const builtinOperation =
		opcode === "call"
			? (attributes.knownBuiltinCall as { operation?: string } | undefined)?.operation
			: attributes.operation;
	const bounds =
		coreIntegerPreservedResultInput(fn, instruction) !== undefined ||
		fn.instructionKind(instruction) === "branch" ||
		fn.instructionKind(instruction) === "guard" ||
		fn.instructionKind(instruction) === "switch" ||
		(opcode === "unary" && operator === "!") ||
		(opcode === "binary" && boundBinaryConsumers.has(operator as string)) ||
		((opcode === "call" ||
			opcode === "callKnown" ||
			opcode === "mathUnaryNumber" ||
			opcode === "mathBinaryNumber") &&
			(boundBuiltinConsumers.has(builtinOperation as string) ||
				(typeof builtinOperation === "string" &&
					builtinPreservesIntegerInput(builtinOperation))));
	const integerResult =
		fn.kernel.instructionResultCount(instruction) === 1 &&
		fn.valueRepresentation(
			fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
		) === "i32";
	const integer =
		bounds ||
		(integerResult && (opcode === "unary" || opcode === "binary")) ||
		opcode === "call" ||
		(opcode === "unary" && operator === "~") ||
		(opcode === "binary" && integerBinaryConsumers.has(operator as string)) ||
		(opcode === "callKnown" &&
			integerBuiltinConsumers.has(attributes.operation as string));
	// Branch refinements belong to the observation, not to every later use of the value.
	const block = fn.instructionBlock(instruction);
	const inputRange = (index: number): CompilerIntegerRange | undefined => {
		const value = fn.kernel.operandAt(start + index);
		const scalar = kinds.exactScalar(value);
		if (scalar !== "number" && scalar !== "int32") return undefined;
		if (scalar === "int32" && !bounds) return COMPILER_INT32_RANGE;
		const range = integer ? query?.(value, block) : undefined;
		if (range === undefined) return scalar === "int32" ? COMPILER_INT32_RANGE : undefined;
		if (compilerIntegerRangesEqual(range, COMPILER_INT32_RANGE))
			return COMPILER_INT32_RANGE;
		if (compilerIntegerRangesEqual(range, COMPILER_UINT32_RANGE))
			return COMPILER_UINT32_RANGE;
		return Object.freeze(range);
	};
	const first = inputRange(0);
	if (count === 1)
		return first === COMPILER_INT32_RANGE
			? singleInt32Input
			: first === undefined
				? undefined
				: Object.freeze([first]);
	const second = inputRange(1);
	if (
		count === 2 &&
		(first === undefined || first === COMPILER_INT32_RANGE) &&
		(second === undefined || second === COMPILER_INT32_RANGE)
	)
		return pairInt32Inputs[
			(first === undefined ? 0 : 1) | (second === undefined ? 0 : 2)
		];
	const values = [first, second];
	let any = first !== undefined || second !== undefined;
	for (let index = 2; index < count; index++) {
		const range = inputRange(index);
		values.push(range);
		any ||= range !== undefined;
	}
	return any ? Object.freeze(values) : undefined;
}

function instructionMasks(
	fn: CoreFunctionStore,
	kinds: CoreConditionalValueKinds,
	block: CoreBlockId,
	start: number,
	count: number,
	result: boolean,
): ReadonlyArray<number> {
	if (count === 0) return emptyMasks;
	const kernel = fn.kernel;
	const first =
		kinds.kindMask(result ? kernel.resultAt(start) : kernel.operandAt(start), block) ||
		COMPILER_VALUE_KIND_TOP;
	if (count === 1) {
		let masks = singleMasks.get(first);
		if (masks === undefined) {
			masks = Object.freeze([first]);
			singleMasks.set(first, masks);
		}
		return masks;
	}
	const second =
		kinds.kindMask(
			result ? kernel.resultAt(start + 1) : kernel.operandAt(start + 1),
			block,
		) || COMPILER_VALUE_KIND_TOP;
	if (count === 2) {
		const key = first * 256 + second;
		let masks = pairMasks.get(key);
		if (masks === undefined) {
			masks = Object.freeze([first, second]);
			pairMasks.set(key, masks);
		}
		return masks;
	}
	const values = [first, second];
	for (let index = 2; index < count; index++)
		values.push(
			kinds.kindMask(
				result ? kernel.resultAt(start + index) : kernel.operandAt(start + index),
				block,
			) || COMPILER_VALUE_KIND_TOP,
		);
	return Object.freeze(values);
}

export function coreInstructionFacts(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kinds: CoreValueKindAnalysis,
	conditional: CoreConditionalValueKinds,
	refineEffects = true,
	range?: CoreInstructionRangeQuery,
): CoreInstructionFacts {
	const kernel = fn.kernel;
	const input = kernel.instructionOperandStart(instruction);
	const output = kernel.instructionResultStart(instruction);
	const block = fn.instructionBlock(instruction);
	const masks = instructionMasks(
		fn,
		conditional,
		block,
		input,
		kernel.instructionOperandCount(instruction),
		false,
	);
	const inputIntegerRanges = instructionIntegerRanges(
		fn,
		kinds,
		instruction,
		input,
		kernel.instructionOperandCount(instruction),
		range,
	);
	const results = instructionMasks(
		fn,
		kinds,
		block,
		output,
		kernel.instructionResultCount(instruction),
		true,
	);
	const resultRange =
		results.length === 1 && results[0] === COMPILER_VALUE_KIND_NUMBER
			? (coreInstructionResultIntegerRange(fn, instruction) ??
				coreInstructionLengthIntegerRange(program, fn, instruction, kinds) ??
				(coreIntegerPreservedResultInput(fn, instruction) === undefined
					? undefined
					: range?.(kernel.resultAt(output), fn.instructionBlock(instruction))) ??
				(kinds.exactScalar(kernel.resultAt(output)) === "int32"
					? COMPILER_INT32_RANGE
					: undefined))
			: undefined;
	const resultIntegerRanges =
		resultRange === undefined
			? undefined
			: resultRange === COMPILER_INT32_RANGE
				? singleInt32Input
				: Object.freeze([resultRange]);
	return {
		masks,
		...(inputIntegerRanges === undefined ? {} : { inputIntegerRanges }),
		...(resultIntegerRanges === undefined ? {} : { resultIntegerRanges }),
		effectMask:
			fn.instructionKind(instruction) === "operation"
				? encodeInstructionEffects(
						(refineEffects
							? corePrimitiveEffectRefinement(program, fn, instruction, masks)
							: undefined) ?? coreInstructionEffects(fn, instruction),
					)
				: fn.instructionKind(instruction) === "throw"
					? INSTRUCTION_MAY_THROW
					: 0,
		results,
	};
}
