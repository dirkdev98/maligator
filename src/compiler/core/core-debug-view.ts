import { coreBlockId, coreInstructionId, coreValueId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreBlockParameter,
	CoreEdge,
	CoreExceptionHandler,
	CoreInstructionId,
	CoreTerminatorPayload,
	CoreValueDefinition,
	CoreValueId,
} from "./core-ir.ts";
import type {
	CoreBlockLayout,
	CoreFunctionStore,
	CoreInstructionLayout,
	CoreUse,
	CoreUseLayout,
	CoreValueLayout,
} from "./core-store.ts";

function immutableArray<T>(values: Array<T>): ReadonlyArray<T> {
	return Object.freeze(values);
}

export function coreFunctionParameters(
	fn: CoreFunctionStore,
): ReadonlyArray<CoreValueId> {
	return immutableArray(
		Array.from({ length: fn.parameterCount }, (_, index) =>
			fn.kernel.functionParameter(index),
		),
	);
}

export function coreBlockParameters(
	fn: CoreFunctionStore,
	block: CoreBlockId,
): ReadonlyArray<CoreBlockParameter> {
	const start = fn.kernel.blockParameterStart(block);
	const count = fn.kernel.blockParameterCount(block);
	return immutableArray(
		Array.from({ length: count }, (_, index) => {
			const row = start + index;
			const value = fn.kernel.blockParameterValue(row);
			return Object.freeze({
				value,
				representation: fn.valueRepresentation(value),
				role: fn.kernel.blockParameterRole(row) === 1 ? "exception" : "value",
			});
		}),
	);
}

export function coreBlockHandler(
	fn: CoreFunctionStore,
	block: CoreBlockId,
): CoreExceptionHandler | undefined {
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler === undefined) return undefined;
	const start = fn.kernel.blockHandlerArgumentStart(block);
	const count = fn.kernel.blockHandlerArgumentCount(block);
	return Object.freeze({
		block: handler,
		arguments: immutableArray(
			Array.from({ length: count }, (_, index) =>
				fn.kernel.handlerArgumentAt(start + index),
			),
		),
	});
}

export function coreInstructionOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): ReadonlyArray<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	return immutableArray(
		Array.from({ length: count }, (_, index) => fn.kernel.operandAt(start + index)),
	);
}

export function coreInstructionResults(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): ReadonlyArray<CoreValueId> {
	const start = fn.kernel.instructionResultStart(instruction);
	const count = fn.kernel.instructionResultCount(instruction);
	return immutableArray(
		Array.from({ length: count }, (_, index) => fn.kernel.resultAt(start + index)),
	);
}

export function coreTerminatorPayload(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreTerminatorPayload {
	const kind = fn.instructionKind(instruction);
	if (kind === "operation")
		throw new Error(`Core instruction ${instruction} is not a terminator`);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
	const edge = (offset: number): CoreEdge => {
		const row = edgeStart + offset;
		const argumentStart = fn.kernel.terminatorEdgeArgumentStart(row);
		const argumentCount = fn.kernel.terminatorEdgeArgumentCount(row);
		return Object.freeze({
			block: fn.kernel.terminatorEdgeBlock(row),
			arguments: immutableArray(
				Array.from({ length: argumentCount }, (_, index) =>
					fn.kernel.operandAt(argumentStart + index),
				),
			),
		});
	};
	switch (kind) {
		case "jump":
			return Object.freeze({ kind, edge: edge(0) });
		case "branch":
			return Object.freeze({
				kind,
				condition: fn.kernel.operandAt(operandStart),
				consequent: edge(0),
				alternate: edge(1),
			});
		case "guard": {
			const fact = fn.kernel.terminatorFact(instruction);
			if (fact === undefined) throw new Error(`Core guard ${instruction} has no fact`);
			return Object.freeze({
				kind,
				condition: fn.kernel.operandAt(operandStart),
				fact,
				success: edge(0),
				fallback: edge(1),
			});
		}
		case "switch": {
			const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
			return Object.freeze({
				kind,
				discriminant: fn.kernel.operandAt(operandStart),
				cases: immutableArray(
					Array.from({ length: edgeCount - 1 }, (_, index) => {
						const value = fn.kernel.terminatorEdgeCaseValue(edgeStart + index);
						if (value === undefined)
							throw new Error(`Core switch ${instruction} has no case`);
						return Object.freeze({
							value: Object.freeze({ ...value }),
							edge: edge(index),
						});
					}),
				),
				default: edge(edgeCount - 1),
			});
		}
		case "return":
		case "throw":
			return Object.freeze({ kind, value: fn.kernel.operandAt(operandStart) });
		case "unreachable":
			return Object.freeze({ kind });
	}
}

export function coreValueDefinition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreValueDefinition {
	const owner = fn.kernel.valueDefinitionOwner(value);
	const index = fn.kernel.valueDefinitionIndex(value);
	return Object.freeze(
		fn.kernel.valueDefinitionKind(value) === 0
			? { kind: "block-parameter", block: coreBlockId(owner), index }
			: { kind: "instruction", instruction: coreInstructionId(owner), index },
	);
}

export function coreUses(
	fn: CoreFunctionStore,
	value: CoreValueId,
): ReadonlyArray<CoreUse> {
	const uses: Array<CoreUse> = [];
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		uses.push(
			Object.freeze({
				instruction: fn.kernel.useInstruction(use),
				operand: fn.kernel.useOperand(use),
			}),
		);
	}
	return immutableArray(uses);
}

export function coreBlockLayout(fn: CoreFunctionStore, block: number): CoreBlockLayout {
	const id = coreBlockId(block);
	return Object.freeze({
		live: fn.kernel.blockLive(id) !== 0,
		firstInstruction: fn.kernel.blockFirstInstruction(id),
		lastInstruction: fn.kernel.blockLastInstruction(id),
		parameterStart: fn.kernel.blockParameterStart(id),
		parameterCount: fn.kernel.blockParameterCount(id),
	});
}

export function coreInstructionLayout(
	fn: CoreFunctionStore,
	instruction: number,
): CoreInstructionLayout {
	const id = coreInstructionId(instruction);
	return Object.freeze({
		live: fn.kernel.instructionLive(id) !== 0,
		opcode: fn.kernel.instructionOpcode(id),
		block: fn.kernel.instructionBlock(id),
		previous: fn.kernel.instructionPrevious(id),
		next: fn.kernel.instructionNext(id),
		operandStart: fn.kernel.instructionOperandStart(id),
		operandCount: fn.kernel.instructionOperandCount(id),
		resultStart: fn.kernel.instructionResultStart(id),
		resultCount: fn.kernel.instructionResultCount(id),
		sourcePosition: fn.kernel.instructionSourcePosition(id),
		effectRefinementRef: fn.kernel.instructionEffectRefinementRef(id),
	});
}

export function coreValueLayout(fn: CoreFunctionStore, value: number): CoreValueLayout {
	const id = coreValueId(value);
	return Object.freeze({
		live: fn.kernel.valueLive(id) !== 0,
		definitionKind:
			fn.kernel.valueDefinitionKind(id) === 0 ? "block-parameter" : "instruction",
		definitionOwner: fn.kernel.valueDefinitionOwner(id),
		definitionIndex: fn.kernel.valueDefinitionIndex(id),
		firstUse: fn.kernel.valueFirstUse(id),
		useCount: fn.kernel.valueUseCount(id),
	});
}

export function coreUseLayout(fn: CoreFunctionStore, use: number): CoreUseLayout {
	return Object.freeze({
		live: fn.kernel.useLive(use) !== 0,
		value: fn.kernel.useValue(use),
		instruction: fn.kernel.useInstruction(use),
		operand: fn.kernel.useOperand(use),
		previous: fn.kernel.usePrevious(use),
		next: fn.kernel.useNext(use),
	});
}
