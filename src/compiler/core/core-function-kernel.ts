import type {
	CoreBlockId,
	CoreFactId,
	CoreImmediate,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";

export interface CoreFunctionKernelColumns {
	readonly blockLive: ReadonlyArray<number>;
	readonly blockFirstInstruction: ReadonlyArray<number>;
	readonly blockLastInstruction: ReadonlyArray<number>;
	readonly blockParameterStart: ReadonlyArray<number>;
	readonly blockParameterCount: ReadonlyArray<number>;
	readonly blockParameterValues: ReadonlyArray<CoreValueId>;
	readonly blockParameterRoles: ReadonlyArray<number>;
	readonly blockHandlerBlock: ReadonlyArray<number>;
	readonly blockHandlerArgumentStart: ReadonlyArray<number>;
	readonly blockHandlerArgumentCount: ReadonlyArray<number>;
	readonly handlerArguments: ReadonlyArray<CoreValueId>;
	readonly instructionLive: ReadonlyArray<number>;
	readonly instructionOpcode: ReadonlyArray<number>;
	readonly instructionBlock: ReadonlyArray<number>;
	readonly instructionPrevious: ReadonlyArray<number>;
	readonly instructionNext: ReadonlyArray<number>;
	readonly instructionOperandStart: ReadonlyArray<number>;
	readonly instructionOperandCount: ReadonlyArray<number>;
	readonly instructionResultStart: ReadonlyArray<number>;
	readonly instructionResultCount: ReadonlyArray<number>;
	readonly instructionTerminatorEdgeStart: ReadonlyArray<number>;
	readonly instructionTerminatorEdgeCount: ReadonlyArray<number>;
	readonly instructionTerminatorFact: ReadonlyArray<number>;
	readonly operands: ReadonlyArray<CoreValueId>;
	readonly results: ReadonlyArray<CoreValueId>;
	readonly terminatorEdgeBlock: ReadonlyArray<CoreBlockId>;
	readonly terminatorEdgeArgumentStart: ReadonlyArray<number>;
	readonly terminatorEdgeArgumentCount: ReadonlyArray<number>;
	readonly terminatorEdgeCaseValue: ReadonlyArray<CoreImmediate | undefined>;
	readonly valueLive: ReadonlyArray<number>;
	readonly valueRepresentation: ReadonlyArray<number>;
	readonly valueDefinitionKind: ReadonlyArray<number>;
	readonly valueDefinitionOwner: ReadonlyArray<number>;
	readonly valueDefinitionIndex: ReadonlyArray<number>;
	readonly valueFirstUse: ReadonlyArray<number>;
	readonly valueUseCount: ReadonlyArray<number>;
	readonly useLive: ReadonlyArray<number>;
	readonly useValue: ReadonlyArray<CoreValueId>;
	readonly useInstruction: ReadonlyArray<CoreInstructionId>;
	readonly useOperand: ReadonlyArray<number>;
	readonly usePrevious: ReadonlyArray<number>;
	readonly useNext: ReadonlyArray<number>;
}

export class CoreFunctionKernel {
	readonly #columns: CoreFunctionKernelColumns;

	constructor(columns: CoreFunctionKernelColumns) {
		this.#columns = columns;
	}

	blockLive(block: CoreBlockId): number {
		return this.#columns.blockLive[block] ?? 0;
	}

	blockFirstInstruction(block: CoreBlockId): number {
		return this.#columns.blockFirstInstruction[block] ?? -1;
	}

	blockLastInstruction(block: CoreBlockId): number {
		return this.#columns.blockLastInstruction[block] ?? -1;
	}

	blockParameterStart(block: CoreBlockId): number {
		return this.#columns.blockParameterStart[block] ?? 0;
	}

	blockParameterCount(block: CoreBlockId): number {
		return this.#columns.blockParameterCount[block] ?? 0;
	}

	blockParameterValue(index: number): CoreValueId {
		return this.#columns.blockParameterValues[index]!;
	}

	blockParameterRole(index: number): number {
		return this.#columns.blockParameterRoles[index]!;
	}

	blockHandlerBlock(block: CoreBlockId): CoreBlockId | undefined {
		const handler = this.#columns.blockHandlerBlock[block] ?? -1;
		return handler < 0 ? undefined : (handler as CoreBlockId);
	}

	blockHandlerArgumentStart(block: CoreBlockId): number {
		return this.#columns.blockHandlerArgumentStart[block] ?? 0;
	}

	blockHandlerArgumentCount(block: CoreBlockId): number {
		return this.#columns.blockHandlerArgumentCount[block] ?? 0;
	}

	handlerArgumentAt(index: number): CoreValueId {
		return this.#columns.handlerArguments[index]!;
	}

	instructionLive(instruction: CoreInstructionId): number {
		return this.#columns.instructionLive[instruction] ?? 0;
	}

	instructionOpcode(instruction: CoreInstructionId): number {
		return this.#columns.instructionOpcode[instruction]!;
	}

	instructionBlock(instruction: CoreInstructionId): number {
		return this.#columns.instructionBlock[instruction]!;
	}

	instructionPrevious(instruction: CoreInstructionId): number {
		return this.#columns.instructionPrevious[instruction] ?? -1;
	}

	instructionNext(instruction: CoreInstructionId): number {
		return this.#columns.instructionNext[instruction] ?? -1;
	}

	instructionOperandStart(instruction: CoreInstructionId): number {
		return this.#columns.instructionOperandStart[instruction] ?? 0;
	}

	instructionOperandCount(instruction: CoreInstructionId): number {
		return this.#columns.instructionOperandCount[instruction] ?? 0;
	}

	operandAt(index: number): CoreValueId {
		return this.#columns.operands[index]!;
	}

	instructionResultStart(instruction: CoreInstructionId): number {
		return this.#columns.instructionResultStart[instruction] ?? 0;
	}

	instructionResultCount(instruction: CoreInstructionId): number {
		return this.#columns.instructionResultCount[instruction] ?? 0;
	}

	resultAt(index: number): CoreValueId {
		return this.#columns.results[index]!;
	}

	terminatorEdgeStart(instruction: CoreInstructionId): number {
		return this.#columns.instructionTerminatorEdgeStart[instruction] ?? 0;
	}

	terminatorEdgeCount(instruction: CoreInstructionId): number {
		return this.#columns.instructionTerminatorEdgeCount[instruction] ?? 0;
	}

	terminatorFact(instruction: CoreInstructionId): CoreFactId | undefined {
		const fact = this.#columns.instructionTerminatorFact[instruction] ?? -1;
		return fact < 0 ? undefined : (fact as CoreFactId);
	}

	terminatorEdgeBlock(edge: number): CoreBlockId {
		return this.#columns.terminatorEdgeBlock[edge]!;
	}

	terminatorEdgeArgumentStart(edge: number): number {
		return this.#columns.terminatorEdgeArgumentStart[edge] ?? 0;
	}

	terminatorEdgeArgumentCount(edge: number): number {
		return this.#columns.terminatorEdgeArgumentCount[edge] ?? 0;
	}

	terminatorEdgeCaseValue(edge: number): CoreImmediate | undefined {
		return this.#columns.terminatorEdgeCaseValue[edge];
	}

	valueLive(value: CoreValueId): number {
		return this.#columns.valueLive[value] ?? 0;
	}

	valueRepresentation(value: CoreValueId): number {
		return this.#columns.valueRepresentation[value]!;
	}

	valueDefinitionKind(value: CoreValueId): number {
		return this.#columns.valueDefinitionKind[value]!;
	}

	valueDefinitionOwner(value: CoreValueId): number {
		return this.#columns.valueDefinitionOwner[value]!;
	}

	valueDefinitionIndex(value: CoreValueId): number {
		return this.#columns.valueDefinitionIndex[value]!;
	}

	valueFirstUse(value: CoreValueId): number {
		return this.#columns.valueFirstUse[value] ?? -1;
	}

	valueUseCount(value: CoreValueId): number {
		return this.#columns.valueUseCount[value] ?? 0;
	}

	useLive(use: number): number {
		return this.#columns.useLive[use] ?? 0;
	}

	useValue(use: number): CoreValueId {
		return this.#columns.useValue[use]!;
	}

	useInstruction(use: number): CoreInstructionId {
		return this.#columns.useInstruction[use]!;
	}

	useOperand(use: number): number {
		return this.#columns.useOperand[use]!;
	}

	usePrevious(use: number): number {
		return this.#columns.usePrevious[use] ?? -1;
	}

	useNext(use: number): number {
		return this.#columns.useNext[use] ?? -1;
	}
}
