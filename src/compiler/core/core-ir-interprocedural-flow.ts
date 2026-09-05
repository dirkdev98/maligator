import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreOpcodeCallTransfer,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreProgramFlowLocalTransfers } from "./core-program-flow.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreLocalCallSite {
	readonly caller: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly callee: CoreValueId;
	readonly receiver?: CoreValueId;
	readonly arguments?: ReadonlyArray<CoreValueId>;
	readonly aggregateArguments?: CoreValueId;
	readonly transfer: CoreOpcodeCallTransfer;
}

export interface CoreLocalInterproceduralFlow {
	readonly calls: ReadonlyArray<CoreLocalCallSite>;
	readonly statistics: {
		readonly calls: number;
		readonly positionalCalls: number;
		readonly aggregateCalls: number;
		readonly constructs: number;
	};
}

export type CoreInterproceduralCallSite = CoreLocalCallSite;
export type CoreInterproceduralValueFlow = CoreLocalInterproceduralFlow;

export function corePositionalCallArguments(
	call: CoreLocalCallSite,
): ReadonlyArray<CoreValueId> | undefined {
	return call.arguments;
}

export function coreCallReceiver(call: CoreLocalCallSite): CoreValueId | undefined {
	return call.receiver;
}

export function analyzeCoreInterproceduralValueFlow(
	fn: CoreFunctionStore,
	localTransfers?: CoreProgramFlowLocalTransfers,
): CoreLocalInterproceduralFlow {
	const calls: Array<CoreLocalCallSite> = [];
	let positionalCalls = 0;
	let aggregateCalls = 0;
	let constructs = 0;
	const candidateCount = localTransfers?.callCount ?? fn.instructionCapacity;
	for (let index = 0; index < candidateCount; index++) {
		const instruction = localTransfers?.callAt(index) ?? coreInstructionId(index);
		if (
			localTransfers === undefined &&
			(fn.kernel.instructionLive(instruction) === 0 ||
				fn.kernel.instructionOpcode(instruction) < 0)
		)
			continue;
		const transfer = fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer;
		if (transfer === undefined) continue;
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		const operand = (index: number): CoreValueId | undefined =>
			index < operandCount ? fn.kernel.operandAt(operandStart + index) : undefined;
		const callee = operand(transfer.calleeOperand);
		if (callee === undefined) continue;
		const receiver =
			transfer.receiverOperand === undefined
				? undefined
				: operand(transfer.receiverOperand);
		if (transfer.invocation === "construct") constructs++;
		if (transfer.arguments.kind === "positional") {
			positionalCalls++;
			const firstOperand = transfer.arguments.firstOperand;
			calls.push(
				Object.freeze({
					caller: fn.id,
					instruction,
					callee,
					...(receiver === undefined ? {} : { receiver }),
					arguments: Object.freeze(
						Array.from({ length: operandCount - firstOperand }, (_, index) =>
							fn.kernel.operandAt(operandStart + firstOperand + index),
						),
					),
					transfer,
				}),
			);
		} else {
			aggregateCalls++;
			const aggregateArguments =
				transfer.arguments.kind === "aggregate"
					? operand(transfer.arguments.operand)
					: undefined;
			calls.push(
				Object.freeze({
					caller: fn.id,
					instruction,
					callee,
					...(receiver === undefined ? {} : { receiver }),
					...(aggregateArguments === undefined ? {} : { aggregateArguments }),
					transfer,
				}),
			);
		}
	}
	return Object.freeze({
		calls: Object.freeze(calls),
		statistics: Object.freeze({
			calls: calls.length,
			positionalCalls,
			aggregateCalls,
			constructs,
		}),
	});
}

export const CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS: CoreAnalysisDefinition<CoreLocalInterproceduralFlow> =
	{
		key: "local-interprocedural-flow",
		scope: "function",
		functionDependencies: ["body", "calls"],
		compute({ program, request, programFlow }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			return analyzeCoreInterproceduralValueFlow(
				program.function(request.function),
				programFlow.local(request.function),
			);
		},
	};
