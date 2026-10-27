import { builtinNormalResultProjection } from "../shared/builtin-registry.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreBuiltinResultProjection {
	// An absent input denotes an omitted positional argument, whose value is undefined.
	readonly input: CoreValueId | undefined;
	readonly identityKinds?: CompilerValueKindMask;
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
	const count = fn.kernel.instructionOperandCount(instruction);
	// List arguments follow the positional prefix; the list itself is never its first value.
	if (
		projection.kind === "argument" &&
		attributes.argumentMode !== undefined &&
		index >= count - 1
	)
		return undefined;
	return {
		input:
			index >= count
				? undefined
				: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
		identityKinds: projection.identityKinds,
	};
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
