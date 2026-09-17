import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerOperatorInputKindMasks } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type { CoreNumericRange } from "./core-ir-loops.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	coreExactOperatorInputKindMasks,
} from "./core-ir-value-kinds.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
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

export interface CoreInt32BoxingValuePlan {
	readonly function: CoreFunctionId;
	readonly value: CoreValueId;
}

const int32BoxingProofs = new WeakMap<
	CoreInt32BoxingValuePlan,
	{ fn: CoreFunctionStore; versions: CoreFunctionVersions }
>();

export function coreInt32BoxingValueProofIsCurrent(
	program: CoreProgram,
	plan: CoreInt32BoxingValuePlan,
): boolean {
	const proof = int32BoxingProofs.get(plan);
	return (
		proof?.fn === program.function(plan.function) &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
	);
}

export function coreInt32BoxingValuePlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<CoreInt32BoxingValuePlan> {
	const plans: Array<CoreInt32BoxingValuePlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		const candidates = new Set<CoreValueId>();
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "move" ||
				fn.kernel.instructionOperandCount(instruction) !== 1 ||
				fn.kernel.instructionResultCount(instruction) !== 1
			)
				continue;
			const source = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
			const destination = fn.kernel.resultAt(
				fn.kernel.instructionResultStart(instruction),
			);
			if (
				fn.valueRepresentation(source) === "f64" &&
				fn.valueRepresentation(destination) === "boxed"
			) {
				candidates.add(source);
			}
		}
		for (const block of fn.blockIds()) {
			const terminator = fn.blockTerminator(block);
			const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
			const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
			for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex++) {
				const edge = edgeStart + edgeIndex;
				const target = fn.kernel.terminatorEdgeBlock(edge);
				const parameterStart = fn.kernel.blockParameterStart(target);
				const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
				const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
				for (let index = 0; index < argumentCount; index++) {
					const source = fn.kernel.operandAt(argumentStart + index);
					const destination = fn.kernel.blockParameterValue(parameterStart + index);
					if (
						fn.valueRepresentation(source) !== "f64" ||
						fn.valueRepresentation(destination) !== "boxed"
					)
						continue;
					candidates.add(source);
				}
			}
		}
		if (candidates.size === 0) continue;
		const ranges = analyses.get(CORE_LOOP_INDUCTION_ANALYSIS, {
			scope: "function",
			function: functionId,
		});
		const admitted = [...candidates].filter((value) => {
			const range = ranges.range(value);
			return (
				range !== undefined &&
				range.minimum >= -0x8000_0000 &&
				range.maximum <= 0x7fff_ffff
			);
		});
		for (const value of admitted) {
			const plan = Object.freeze({ function: functionId, value });
			int32BoxingProofs.set(plan, { fn, versions: fn.versions });
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
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

export interface CoreBuiltinInputPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly masks: ReadonlyArray<number>;
}

const builtinProofs = new WeakMap<
	CoreBuiltinInputPlan,
	{ fn: CoreFunctionStore; versions: CoreFunctionVersions }
>();

export function coreBuiltinInputProofIsCurrent(
	program: CoreProgram,
	plan: CoreBuiltinInputPlan,
): boolean {
	const proof = builtinProofs.get(plan);
	return (
		proof?.fn === program.function(plan.function) &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
	);
}

export function coreBuiltinInputPlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<CoreBuiltinInputPlan> {
	const plans: Array<CoreBuiltinInputPlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		if (!fn.isGenerator && !fn.isAsync) continue;
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "callKnown"
			)
				continue;
			const attributes = fn.instructionAttributes(instruction);
			const count = fn.kernel.instructionOperandCount(instruction);
			if (
				attributes.construct ||
				attributes.argumentMode !== undefined ||
				count < 1 ||
				count > 17
			)
				continue;
			const kinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
				scope: "function",
				function: functionId,
			});
			const start = fn.kernel.instructionOperandStart(instruction);
			const masks = Array.from({ length: count }, (_, index) => {
				const mask = kinds.kindMask(fn.kernel.operandAt(start + index));
				return [
					COMPILER_VALUE_KIND_BOOLEAN,
					COMPILER_VALUE_KIND_NUMBER,
					COMPILER_VALUE_KIND_STRING,
				].includes(mask)
					? mask
					: COMPILER_VALUE_KIND_TOP;
			});
			if (masks.every((mask) => mask === COMPILER_VALUE_KIND_TOP)) continue;
			const plan = Object.freeze({
				function: functionId,
				instruction,
				masks: Object.freeze(masks),
			});
			builtinProofs.set(plan, { fn, versions: fn.versions });
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
}
