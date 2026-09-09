import { COMPILER_VALUE_KIND_BOOLEAN } from "../shared/compiler-value-kinds.ts";
import type { CompilerOperatorInputKindMasks } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type { CoreNumericRange } from "./core-ir-loops.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	coreExactOperatorInputKindMasks,
} from "./core-ir-value-kinds.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionVersions,
	CoreFunctionStore,
	CoreProgram,
} from "./core-store.ts";

export interface CoreUnsignedArithmeticPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
}

const proofs = new WeakMap<
	CoreUnsignedArithmeticPlan,
	{ fn: CoreFunctionStore; versions: CoreFunctionVersions }
>();

export function coreUnsignedArithmeticProofIsCurrent(
	program: CoreProgram,
	plan: CoreUnsignedArithmeticPlan,
): boolean {
	const proof = proofs.get(plan);
	return (
		proof?.fn === program.function(plan.function) &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
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
			proofs.set(plan, { fn, versions: fn.versions });
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
}

export interface CoreOperatorInputPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly masks: CompilerOperatorInputKindMasks;
}

const operatorProofs = new WeakMap<
	CoreOperatorInputPlan,
	{ fn: CoreFunctionStore; versions: CoreFunctionVersions }
>();

export function coreOperatorInputProofIsCurrent(
	program: CoreProgram,
	plan: CoreOperatorInputPlan,
): boolean {
	const proof = operatorProofs.get(plan);
	return (
		proof?.fn === program.function(plan.function) &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
	);
}

export function coreOperatorInputPlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<CoreOperatorInputPlan> {
	const plans: Array<CoreOperatorInputPlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "unary" && opcode !== "binary") continue;
			let masks = coreExactOperatorInputKindMasks(fn, instruction);
			if (
				masks === undefined &&
				opcode === "unary" &&
				fn.instructionAttributes(instruction).operator === "tostring"
			) {
				// Memory transforms can introduce conversions after primitive effect refinement.
				const kinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
					scope: "function",
					function: functionId,
				});
				const input = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
				if (kinds.kindMask(input) === COMPILER_VALUE_KIND_BOOLEAN)
					masks = [COMPILER_VALUE_KIND_BOOLEAN];
			}
			if (masks === undefined) continue;
			const plan = Object.freeze({
				function: functionId,
				instruction,
				masks: Object.freeze(masks),
			});
			operatorProofs.set(plan, { fn, versions: fn.versions });
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
}
