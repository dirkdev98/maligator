import { builtinNormalResultProjection } from "../shared/builtin-registry.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreBuiltinCallInput {
	// An absent input denotes an omitted positional argument, whose value is undefined.
	readonly input: CoreValueId | undefined;
}

export interface CoreBuiltinResultProjection extends CoreBuiltinCallInput {
	readonly identityKinds?: CompilerValueKindMask;
}

// An unknown list element has no carrier; a present carrier may denote an omitted argument.
export function coreBuiltinCallInput(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreBuiltinCallInput | undefined {
	const count = fn.kernel.instructionOperandCount(instruction);
	if (
		index > 0 &&
		fn.instructionAttributes(instruction).argumentMode !== undefined &&
		index >= count - 1
	)
		return undefined;
	return {
		input:
			index >= count
				? undefined
				: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
	};
}

export function coreBuiltinResultProjection(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreBuiltinResultProjection | undefined {
	if (
		fn.instructionOpcodeName(instruction) !== "callKnown" ||
		fn.kernel.instructionResultCount(instruction) !== 1
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (attributes.construct || typeof attributes.operation !== "string") return undefined;
	const projection = builtinNormalResultProjection(attributes.operation);
	if (projection === undefined) return undefined;
	const index = projection.kind === "receiver" ? 0 : projection.index + 1;
	const input = coreBuiltinCallInput(fn, instruction, index);
	return input === undefined || projection.identityKinds === undefined
		? input
		: { ...input, identityKinds: projection.identityKinds };
}

export const CORE_BUILTIN_RESULT_PROJECTIONS_ANALYSIS: CoreAnalysisDefinition<
	ReadonlyMap<CoreInstructionId, CoreBuiltinResultProjection>
> = {
	key: "builtin-result-projections",
	scope: "function",
	functionDependencies: ["body", "calls"],
	compute({ program, request, programFlow }) {
		if (request.scope !== "function") throw new Error("Expected function analysis");
		const fn = program.function(request.function);
		const transfers = programFlow.local(request.function);
		const projections = new Map<CoreInstructionId, CoreBuiltinResultProjection>();
		for (let index = 0; index < transfers.operationCount; index++) {
			const instruction = transfers.operationAt(index);
			const projection = coreBuiltinResultProjection(fn, instruction);
			if (projection !== undefined) projections.set(instruction, projection);
		}
		return projections;
	},
};
