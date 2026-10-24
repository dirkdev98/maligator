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
		for (const instruction of fn.instructionIds()) {
			const plan = Object.freeze({
				function: functionId,
				instruction,
				...coreInstructionFacts(fn, instruction, kinds),
			});
			kindProofs.set(plan, { fn, versions: fn.versions });
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
}

export function coreInstructionFacts(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kinds: CoreValueKindAnalysis,
): {
	readonly masks: ReadonlyArray<number>;
	readonly results: ReadonlyArray<number>;
	readonly effectMask: number;
} {
	const kernel = fn.kernel;
	const input = kernel.instructionOperandStart(instruction);
	const output = kernel.instructionResultStart(instruction);
	const masks = Object.freeze(
		Array.from(
			{ length: kernel.instructionOperandCount(instruction) },
			(_, index) =>
				kinds.kindMask(kernel.operandAt(input + index)) || COMPILER_VALUE_KIND_TOP,
		),
	);
	return {
		masks,
		effectMask:
			fn.instructionKind(instruction) === "operation"
				? encodeInstructionEffects(
						corePrimitiveOperatorEffectRefinement(fn, instruction, masks) ??
							coreInstructionEffects(fn, instruction),
					)
				: fn.instructionKind(instruction) === "throw"
					? INSTRUCTION_MAY_THROW
					: 0,
		results: Object.freeze(
			Array.from(
				{ length: kernel.instructionResultCount(instruction) },
				(_, index) =>
					kinds.kindMask(kernel.resultAt(output + index)) || COMPILER_VALUE_KIND_TOP,
			),
		),
	};
}
