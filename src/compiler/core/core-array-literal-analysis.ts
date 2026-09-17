import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "./core-ir-provenance.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreFunctionVersions,
	CoreProgram,
} from "./core-store.ts";

export interface CoreFreshArrayLiteralElementPlan {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly index: number;
}

const proofs = new WeakMap<
	CoreFreshArrayLiteralElementPlan,
	{
		fn: CoreFunctionStore;
		versions: CoreFunctionVersions;
		context: CoreCompilationContext;
	}
>();

export function coreFreshArrayLiteralElementProofIsCurrent(
	program: CoreProgram,
	plan: CoreFreshArrayLiteralElementPlan,
	context: CoreCompilationContext | undefined,
): boolean {
	const proof = proofs.get(plan);
	return (
		context !== undefined &&
		proof?.context === context &&
		proof.fn === program.function(plan.function) &&
		coreFunctionVersionsAreCurrent(proof.fn, proof.versions)
	);
}

export function coreFreshArrayLiteralElementPlans(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	functions: ReadonlyArray<CoreFunctionId>,
	context: CoreCompilationContext,
): ReadonlyArray<CoreFreshArrayLiteralElementPlan> {
	const plans: Array<CoreFreshArrayLiteralElementPlan> = [];
	for (const functionId of functions) {
		const fn = program.function(functionId);
		const provenance = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, {
			scope: "function",
			function: functionId,
		}).provenance;
		for (const layout of provenance.layouts) {
			if (
				layout.kind !== "indexed" ||
				layout.length < 1 ||
				layout.length > 32 ||
				layout.elements.size !== layout.length ||
				fn.instructionOpcodeName(layout.instruction) !== "createArray"
			) {
				continue;
			}
			const elements = [...layout.elements.values()].sort(
				(left, right) => left.index - right.index,
			);
			if (elements.some((element, index) => element.index !== index)) continue;
			const block = fn.instructionBlock(layout.instruction);
			const blockInstructions = [...fn.bodyInstructionIds(block)];
			const allocationIndex = blockInstructions.indexOf(layout.instruction);
			const finalDefinitionIndex = blockInstructions.indexOf(elements.at(-1)!.definition);
			const definitionIndices = new Map(
				elements.map((element) => [element.definition, element.index] as const),
			);
			let nextIndex = 0;
			if (
				allocationIndex < 0 ||
				finalDefinitionIndex <= allocationIndex ||
				blockInstructions
					.slice(allocationIndex + 1, finalDefinitionIndex + 1)
					.some((instruction) => {
						if (definitionIndices.has(instruction)) {
							return definitionIndices.get(instruction) !== nextIndex++;
						}
						return !["createNumber", "createF64", "move", "throwIfTdz"].includes(
							fn.instructionOpcodeName(instruction),
						);
					}) ||
				nextIndex !== layout.length
			) {
				continue;
			}
			const admitted: Array<CoreFreshArrayLiteralElementPlan> = [];
			for (const element of elements) {
				const attributes = fn.instructionAttributes(element.definition);
				if (
					fn.instructionOpcodeName(element.definition) !== "defineProperty" ||
					attributes.enumerable !== true ||
					(attributes.writable ?? true) !== true ||
					(attributes.configurable ?? true) !== true
				) {
					admitted.length = 0;
					break;
				}
				const plan = Object.freeze({
					function: functionId,
					instruction: element.definition,
					index: element.index,
				});
				proofs.set(plan, { fn, versions: fn.versions, context });
				admitted.push(plan);
			}
			plans.push(...admitted);
		}
	}
	return Object.freeze(plans);
}
