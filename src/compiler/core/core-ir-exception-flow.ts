import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type {
	CoreBlockId,
	CoreExceptionHandler,
	CoreFunction,
	CoreValueId,
} from "./core-ir.ts";

export interface CoreLocalThrowCatchFlow {
	readonly source: CoreBlockId;
	readonly handler: CoreBlockId;
	readonly thrownValue: CoreValueId;
	readonly handlerArguments: ReadonlyArray<CoreValueId>;
	readonly completionOrder: "immediate-handler";
	readonly stackObservation: "same-thrown-value";
	readonly prefixEffects: "non-throwing-non-suspending";
}

function localThrowCatchFlow(
	fn: CoreFunction,
	blockId: CoreBlockId,
	handler: CoreExceptionHandler,
): CoreLocalThrowCatchFlow | undefined {
	const block = fn.blocks[blockId]!;
	if (block.terminator.kind !== "throw" || handler.block === blockId) return undefined;
	if (
		block.instructions.some((instruction) => {
			const effects = coreInstructionEffects(instruction);
			return effects.mayThrow || effects.maySuspend;
		})
	) {
		return undefined;
	}
	const target = fn.blocks[handler.block];
	const exception = target?.parameters[0];
	if (exception?.role !== "exception") return undefined;
	const thrown = fn.values[block.terminator.value];
	if (thrown?.representation !== exception.representation) return undefined;
	return {
		source: blockId,
		handler: handler.block,
		thrownValue: block.terminator.value,
		handlerArguments: handler.arguments,
		completionOrder: "immediate-handler",
		stackObservation: "same-thrown-value",
		prefixEffects: "non-throwing-non-suspending",
	};
}

/** Explicit throws whose handler is reached only by equivalent local transfers. */
export function analyzeCoreLocalExceptionFlows(
	fn: CoreFunction,
	cfg: CoreControlFlow,
): ReadonlyArray<CoreLocalThrowCatchFlow> {
	const candidates: Array<CoreLocalThrowCatchFlow> = [];
	for (const block of fn.blocks) {
		if (block.handler === undefined) continue;
		const flow = localThrowCatchFlow(fn, block.id, block.handler);
		if (flow !== undefined) candidates.push(flow);
	}
	const candidateSources = new Map(candidates.map((flow) => [flow.source, flow.handler]));
	const mixedHandlers = new Set<CoreBlockId>();
	for (const { handler } of candidates) {
		if (
			!cfg.predecessors[handler]!.every(
				(edge) =>
					edge.kind === "exceptional" && candidateSources.get(edge.from) === handler,
			)
		) {
			mixedHandlers.add(handler);
		}
	}
	return candidates.filter(({ handler }) => !mixedHandlers.has(handler));
}
