import type {
	CoreBlockId,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreTerminatorPayload,
	CoreValueId,
} from "../../src/compiler/core/core-ir.ts";
import type {
	CoreFunctionStore,
	CoreProgram,
} from "../../src/compiler/core/core-store.ts";

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
			inputs: fn.instructionOperands(instruction),
			outputs: fn.instructionResults(instruction),
			attributes: fn.instructionAttributes(instruction),
		})),
	);
}

export function coreBlocks(fn: CoreFunctionStore): ReadonlyArray<CoreBlockInspection> {
	return [...fn.blockIds()].map((block) => ({
		id: block,
		instructions: coreOperations(fn).filter((instruction) => instruction.block === block),
		terminator: fn.terminatorPayload(fn.blockTerminator(block)),
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
