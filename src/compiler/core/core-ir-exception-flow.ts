import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreBlockId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

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
	fn: CoreFunctionStore,
	block: CoreBlockId,
): CoreLocalThrowCatchFlow | undefined {
	const handler = fn.kernel.blockHandlerBlock(block);
	const terminator = fn.blockTerminator(block);
	if (
		handler === undefined ||
		fn.instructionKind(terminator) !== "throw" ||
		handler === block
	) {
		return undefined;
	}
	for (const instruction of fn.bodyInstructionIds(block)) {
		const effects =
			fn.instructionEffectRefinement(instruction)?.effects ??
			fn.registry.byId(fn.instructionOpcode(instruction)).effects;
		if (effects.mayThrow || effects.maySuspend) return undefined;
	}
	const thrownValue = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
	const parameterStart = fn.kernel.blockParameterStart(handler);
	if (
		fn.kernel.blockParameterCount(handler) === 0 ||
		fn.kernel.blockParameterRole(parameterStart) !== 1 ||
		fn.kernel.valueRepresentation(thrownValue) !==
			fn.kernel.valueRepresentation(fn.kernel.blockParameterValue(parameterStart))
	) {
		return undefined;
	}
	const handlerArgumentStart = fn.kernel.blockHandlerArgumentStart(block);
	const handlerArgumentCount = fn.kernel.blockHandlerArgumentCount(block);
	return Object.freeze({
		source: block,
		handler,
		thrownValue,
		handlerArguments: Object.freeze(
			Array.from({ length: handlerArgumentCount }, (_, index) =>
				fn.kernel.handlerArgumentAt(handlerArgumentStart + index),
			),
		),
		completionOrder: "immediate-handler",
		stackObservation: "same-thrown-value",
		prefixEffects: "non-throwing-non-suspending",
	});
}

export function analyzeCoreLocalExceptionFlows(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): ReadonlyArray<CoreLocalThrowCatchFlow> {
	const candidates: Array<CoreLocalThrowCatchFlow> = [];
	for (const block of fn.blockIds()) {
		const flow = localThrowCatchFlow(fn, block);
		if (flow !== undefined) candidates.push(flow);
	}
	const candidateSources = new Map(candidates.map((flow) => [flow.source, flow.handler]));
	return Object.freeze(
		candidates.filter(({ handler }) =>
			(cfg.predecessors[handler] ?? []).every(
				(edge) =>
					edge.kind === "exceptional" && candidateSources.get(edge.from) === handler,
			),
		),
	);
}

export const CORE_LOCAL_EXCEPTION_FLOW_ANALYSIS: CoreAnalysisDefinition<
	ReadonlyArray<CoreLocalThrowCatchFlow>
> = {
	key: "local-exception-flow",
	scope: "function",
	functionDependencies: [
		"body",
		"cfg",
		"exceptionFlow",
		"memoryEffects",
		"representations",
	],
	compute({ program, request, get }) {
		if (request.scope !== "function") throw new Error("Expected function analysis");
		const fn = program.function(request.function);
		return analyzeCoreLocalExceptionFlows(
			fn,
			get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
		);
	},
};
