import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type { CoreNumericRange } from "./core-ir-loops.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreUnsignedArithmeticPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
}

const proofs = new WeakMap<
	CoreUnsignedArithmeticPlan,
	{ fn: CoreFunctionStore; versions: string }
>();

export function coreUnsignedArithmeticProofIsCurrent(
	program: CoreProgram,
	plan: CoreUnsignedArithmeticPlan,
): boolean {
	const proof = proofs.get(plan);
	return (
		proof?.fn === program.function(plan.function) &&
		proof.versions === JSON.stringify(proof.fn.versions)
	);
}

export function coreUnsignedArithmeticPlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<CoreUnsignedArithmeticPlan> {
	const plans: Array<CoreUnsignedArithmeticPlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		const consumers = [...fn.instructionIds()].filter(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "binary" &&
				fn.instructionAttributes(instruction).operator === "%",
		);
		if (consumers.length === 0) continue;
		const ranges = analyses.get(CORE_LOOP_INDUCTION_ANALYSIS, {
			scope: "function",
			function: functionId,
		});
		const admitted = new Set<CoreInstructionId>();
		const unsigned = (range: CoreNumericRange | undefined): range is CoreNumericRange =>
			range !== undefined && range.minimum >= 0 && range.maximum <= 0xffff_ffff;
		for (const consumer of consumers) {
			let remaining = 32;
			const visited = new Set<CoreInstructionId>();
			const visit = (instruction: CoreInstructionId): void => {
				if (visited.has(instruction) || remaining-- <= 0) return;
				visited.add(instruction);
				if (
					fn.instructionOpcodeName(instruction) !== "binary" ||
					!["+", "-", "*", "%"].includes(
						fn.instructionAttributes(instruction).operator as string,
					)
				)
					return;
				const start = fn.kernel.instructionOperandStart(instruction);
				const inputs = [fn.kernel.operandAt(start), fn.kernel.operandAt(start + 1)];
				const block = coreBlockId(fn.kernel.instructionBlock(instruction));
				const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
				if (
					!unsigned(ranges.range(output, block)) ||
					!inputs.every((value) => unsigned(ranges.range(value, block)))
				)
					return;
				if (
					fn.instructionAttributes(instruction).operator === "%" &&
					ranges.range(inputs[1]!, block)!.minimum === 0
				)
					return;
				admitted.add(instruction);
				for (const value of inputs)
					if (fn.kernel.valueDefinitionKind(value) === 1)
						visit(coreInstructionId(fn.kernel.valueDefinitionOwner(value)));
			};
			visit(consumer);
		}
		for (const instruction of admitted) {
			const plan = Object.freeze({ function: functionId, instruction });
			proofs.set(plan, { fn, versions: JSON.stringify(fn.versions) });
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
}
