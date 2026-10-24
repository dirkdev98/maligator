import { COMPILER_VALUE_KIND_TOP } from "../shared/compiler-value-kinds.ts";
import {
	encodeInstructionEffects,
	INSTRUCTION_MAY_THROW,
} from "../shared/instruction-facts.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { corePrimitiveOperatorEffectRefinement } from "./core-ir-value-kinds.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreFunctionVersions,
	CoreProgram,
} from "./core-store.ts";

export interface CoreInstructionFactPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly masks: ReadonlyArray<number>;
	readonly results: ReadonlyArray<number>;
	readonly effectMask: number;
}

const kindProofs = new WeakMap<
	CoreInstructionFactPlan,
	{ fn: CoreFunctionStore; versions: CoreFunctionVersions }
>();

export function coreInstructionFactProofIsCurrent(
	program: CoreProgram,
	plan: CoreInstructionFactPlan,
): boolean {
	const proof = kindProofs.get(plan);
	return (
		proof?.fn === program.function(plan.function) &&
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
		const proof = { fn, versions: fn.versions };
		for (const instruction of fn.instructionIds()) {
			const plan = Object.freeze({
				function: functionId,
				instruction,
				...coreInstructionFacts(fn, instruction, kinds, false),
			});
			kindProofs.set(plan, proof);
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
}

const emptyMasks: ReadonlyArray<number> = Object.freeze([]);
const singleMasks = new Map<number, ReadonlyArray<number>>();
const pairMasks = new Map<number, ReadonlyArray<number>>();

function instructionMasks(
	fn: CoreFunctionStore,
	kinds: CoreValueKindAnalysis,
	start: number,
	count: number,
	result: boolean,
): ReadonlyArray<number> {
	if (count === 0) return emptyMasks;
	const kernel = fn.kernel;
	const first =
		kinds.kindMask(result ? kernel.resultAt(start) : kernel.operandAt(start)) ||
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
		kinds.kindMask(result ? kernel.resultAt(start + 1) : kernel.operandAt(start + 1)) ||
		COMPILER_VALUE_KIND_TOP;
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
			) || COMPILER_VALUE_KIND_TOP,
		);
	return Object.freeze(values);
}

export function coreInstructionFacts(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kinds: CoreValueKindAnalysis,
	refineEffects = true,
): {
	readonly masks: ReadonlyArray<number>;
	readonly results: ReadonlyArray<number>;
	readonly effectMask: number;
} {
	const kernel = fn.kernel;
	const input = kernel.instructionOperandStart(instruction);
	const output = kernel.instructionResultStart(instruction);
	const masks = instructionMasks(
		fn,
		kinds,
		input,
		kernel.instructionOperandCount(instruction),
		false,
	);
	return {
		masks,
		effectMask:
			fn.instructionKind(instruction) === "operation"
				? encodeInstructionEffects(
						(refineEffects
							? corePrimitiveOperatorEffectRefinement(fn, instruction, masks)
							: undefined) ?? coreInstructionEffects(fn, instruction),
					)
				: fn.instructionKind(instruction) === "throw"
					? INSTRUCTION_MAY_THROW
					: 0,
		results: instructionMasks(
			fn,
			kinds,
			output,
			kernel.instructionResultCount(instruction),
			true,
		),
	};
}
