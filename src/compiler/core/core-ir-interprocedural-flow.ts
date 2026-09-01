import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreOpcodeCallTransfer,
	CoreValueId,
} from "./core-ir.ts";
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
): CoreLocalInterproceduralFlow {
	const calls: Array<CoreLocalCallSite> = [];
	let positionalCalls = 0;
	let aggregateCalls = 0;
	let constructs = 0;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const transfer = fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer;
		if (transfer === undefined) continue;
		const operands = fn.instructionOperands(instruction);
		const callee = operands[transfer.calleeOperand];
		if (callee === undefined) continue;
		const receiver =
			transfer.receiverOperand === undefined
				? undefined
				: operands[transfer.receiverOperand];
		if (transfer.invocation === "construct") constructs++;
		if (transfer.arguments.kind === "positional") {
			positionalCalls++;
			calls.push(
				Object.freeze({
					caller: fn.id,
					instruction,
					callee,
					...(receiver === undefined ? {} : { receiver }),
					arguments: Object.freeze(operands.slice(transfer.arguments.firstOperand)),
					transfer,
				}),
			);
		} else {
			aggregateCalls++;
			const aggregateArguments = operands[transfer.arguments.operand];
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
		compute({ program, request }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			return analyzeCoreInterproceduralValueFlow(program.function(request.function));
		},
	};
