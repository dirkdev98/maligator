import type { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import {
	coreBlockHandler,
	coreBlockParameters,
	coreEffectRefinementLayout,
	coreFunctionParameters,
	coreInstructionOperands,
	coreInstructionLayout,
	coreInstructionResults,
	coreTerminatorPayload,
	coreUses,
	coreValueDefinition,
} from "../../src/compiler/core/core-debug-view.ts";
import type {
	CoreBlockId,
	CoreExceptionHandler,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreTerminatorPayload,
	CoreValueDefinition,
	CoreValueId,
} from "../../src/compiler/core/core-ir.ts";
import type {
	CoreFunctionStore,
	CoreEffectRefinementLayout,
	CoreInstructionLayout,
	CoreProgram,
	CoreUse,
} from "../../src/compiler/core/core-store.ts";

type CoreInspectableFunction = CoreFunctionStore | Pick<CoreFunctionBuilder, "editor">;

function inspectedFunction(fn: CoreInspectableFunction): CoreFunctionStore {
	return "editor" in fn ? fn.editor.function : fn;
}

export function inspectCoreFunctionParameters(
	fn: CoreInspectableFunction,
): ReadonlyArray<CoreValueId> {
	return coreFunctionParameters(inspectedFunction(fn));
}

export function inspectCoreBlockParameters(
	fn: CoreInspectableFunction,
	block: CoreBlockId,
): ReturnType<typeof coreBlockParameters> {
	return coreBlockParameters(inspectedFunction(fn), block);
}

export function inspectCoreBlockHandler(
	fn: CoreInspectableFunction,
	block: CoreBlockId,
): CoreExceptionHandler | undefined {
	return coreBlockHandler(inspectedFunction(fn), block);
}

export function inspectCoreEffectRefinementLayout(
	fn: CoreInspectableFunction,
	refinement: number,
): CoreEffectRefinementLayout {
	return coreEffectRefinementLayout(inspectedFunction(fn), refinement);
}

export function inspectCoreInstructionOperands(
	fn: CoreInspectableFunction,
	instruction: CoreInstructionId,
): ReadonlyArray<CoreValueId> {
	return coreInstructionOperands(inspectedFunction(fn), instruction);
}

export function inspectCoreInstructionLayout(
	fn: CoreInspectableFunction,
	instruction: number,
): CoreInstructionLayout {
	return coreInstructionLayout(inspectedFunction(fn), instruction);
}

export function inspectCoreInstructionResults(
	fn: CoreInspectableFunction,
	instruction: CoreInstructionId,
): ReadonlyArray<CoreValueId> {
	return coreInstructionResults(inspectedFunction(fn), instruction);
}

export function inspectCoreTerminatorPayload(
	fn: CoreInspectableFunction,
	instruction: CoreInstructionId,
): CoreTerminatorPayload {
	return coreTerminatorPayload(inspectedFunction(fn), instruction);
}

export function inspectCoreValueDefinition(
	fn: CoreInspectableFunction,
	value: CoreValueId,
): CoreValueDefinition {
	return coreValueDefinition(inspectedFunction(fn), value);
}

export function inspectCoreUses(
	fn: CoreInspectableFunction,
	value: CoreValueId,
): ReadonlyArray<CoreUse> {
	return coreUses(inspectedFunction(fn), value);
}

export interface CoreOperationInspection {
	readonly id: CoreInstructionId;
	readonly block: CoreBlockId;
	readonly opcode: string;
	readonly inputs: ReadonlyArray<CoreValueId>;
	readonly outputs: ReadonlyArray<CoreValueId>;
	readonly attributes: CoreInstructionAttributes;
}

export interface CoreBlockInspection {
	readonly id: CoreBlockId;
	readonly instructions: ReadonlyArray<CoreOperationInspection>;
	readonly terminator: CoreTerminatorPayload;
}

export function coreFunctions(program: CoreProgram): ReadonlyArray<CoreFunctionStore> {
	return [...program.functionIds()].map((functionId) => program.function(functionId));
}

export function coreOperations(
	fn: CoreFunctionStore,
): ReadonlyArray<CoreOperationInspection> {
	return [...fn.blockIds()].flatMap((block) =>
		[...fn.bodyInstructionIds(block)].map((instruction) => ({
			id: instruction,
			block,
			opcode: fn.instructionOpcodeName(instruction),
			inputs: coreInstructionOperands(fn, instruction),
			outputs: coreInstructionResults(fn, instruction),
			attributes: fn.instructionAttributes(instruction),
		})),
	);
}

export function coreBlocks(fn: CoreFunctionStore): ReadonlyArray<CoreBlockInspection> {
	return [...fn.blockIds()].map((block) => ({
		id: block,
		instructions: coreOperations(fn).filter((instruction) => instruction.block === block),
		terminator: coreTerminatorPayload(fn, fn.blockTerminator(block)),
	}));
}

export function coreFunctionNamed(
	program: CoreProgram,
	name: string,
): CoreFunctionStore | undefined {
	return coreFunctions(program).find(
		(fn) =>
			String.fromCodePoint(
				...(program.stringConstants[fn.metadata.nameStringIndex] ?? []),
			) === name,
	);
}
