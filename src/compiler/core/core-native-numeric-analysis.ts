import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	corePrivatePackedRestArrays,
	corePrivateNumericArrayLoads,
} from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
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

export interface CorePrivateNumericArrayElementPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
}

export interface CorePrivatePackedRestArrayElementPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly allocation: CoreInstructionId;
	readonly lengthLoads: ReadonlyArray<CoreInstructionId>;
	readonly startIndex: number;
}

const privateNumericArrayProofs = new WeakMap<
	CorePrivateNumericArrayElementPlan,
	{
		fn: CoreFunctionStore;
		versions: CoreFunctionVersions;
		context: CoreCompilationContext;
	}
>();

const privatePackedRestArrayProofs = new WeakMap<
	CorePrivatePackedRestArrayElementPlan,
	{
		fn: CoreFunctionStore;
		versions: CoreFunctionVersions;
		context: CoreCompilationContext;
	}
>();

export function corePrivateNumericArrayElementProofIsCurrent(
	program: CoreProgram,
	plan: CorePrivateNumericArrayElementPlan,
	context: CoreCompilationContext | undefined,
): boolean {
	const proof = privateNumericArrayProofs.get(plan);
	return (
		context !== undefined &&
		proof?.context === context &&
		proof.fn === program.function(plan.function) &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
	);
}

export function corePrivatePackedRestArrayElementProofIsCurrent(
	program: CoreProgram,
	plan: CorePrivatePackedRestArrayElementPlan,
	context: CoreCompilationContext | undefined,
): boolean {
	const proof = privatePackedRestArrayProofs.get(plan);
	return (
		context !== undefined &&
		proof?.context === context &&
		proof.fn === program.function(plan.function) &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
	);
}

function packedRestKeyIsNumber(
	fn: CoreFunctionStore,
	kinds: CoreValueKindAnalysis,
	value: CoreValueId,
): boolean {
	if (kinds.kindMask(value) === COMPILER_VALUE_KIND_NUMBER) return true;
	if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const header = fn.instructionHeader(definition);
	if (typeof header === "string") return false;
	const opcode = header.opcode;
	const operator = fn.instructionAttributes(definition).operator;
	if (opcode === "unary") return operator === "+";
	if (
		opcode !== "binary" ||
		typeof operator !== "string" ||
		!["-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>"].includes(operator)
	)
		return false;
	const start = fn.kernel.instructionOperandStart(definition);
	return [fn.kernel.operandAt(start), fn.kernel.operandAt(start + 1)].some(
		(operand) => kinds.kindMask(operand) === COMPILER_VALUE_KIND_NUMBER,
	);
}

export function corePrivateNumericArrayElementPlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
	context: CoreCompilationContext | undefined,
): ReadonlyArray<CorePrivateNumericArrayElementPlan> {
	if (context === undefined) return Object.freeze([]);
	const plans: Array<CorePrivateNumericArrayElementPlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		const cfg = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: functionId,
			})
			.exceptional();
		for (const instruction of corePrivateNumericArrayLoads(program, fn, cfg, context)) {
			const plan = Object.freeze({ function: functionId, instruction });
			privateNumericArrayProofs.set(plan, { fn, versions: fn.versions, context });
			plans.push(plan);
		}
	}
	return Object.freeze(plans);
}

export function corePrivatePackedRestArrayElementPlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
	context: CoreCompilationContext | undefined,
): ReadonlyArray<CorePrivatePackedRestArrayElementPlan> {
	if (context === undefined) return Object.freeze([]);
	const plans: Array<CorePrivatePackedRestArrayElementPlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		const request = { scope: "function" as const, function: functionId };
		let kinds: CoreValueKindAnalysis | undefined;
		for (const array of corePrivatePackedRestArrays(
			program,
			fn,
			() => analyses.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
			context,
			(value) =>
				packedRestKeyIsNumber(
					fn,
					(kinds ??= analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request)),
					value,
				),
		)) {
			const startIndex = fn.instructionAttributes(array.allocation).startIndex;
			if (typeof startIndex !== "number") continue;
			for (const instruction of array.elementLoads) {
				const plan = Object.freeze({
					function: functionId,
					instruction,
					allocation: array.allocation,
					lengthLoads: array.lengthLoads,
					startIndex,
				});
				privatePackedRestArrayProofs.set(plan, {
					fn,
					versions: fn.versions,
					context,
				});
				plans.push(plan);
			}
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
		const unsigned = (
			range: CompilerIntegerRange | undefined,
		): range is CompilerIntegerRange =>
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
