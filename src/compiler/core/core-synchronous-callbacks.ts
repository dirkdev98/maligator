import {
	coreDirectCreatedFunction,
	coreCalleeTargetsAreOpen,
} from "./core-ir-call-targets.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreSynchronousCallbackConsumer {
	readonly function: CoreFunctionStore;
	readonly bodyVersion: number;
	readonly parameter: number;
	readonly callback: CoreFunctionId;
	readonly argument: CoreValueId;
	readonly invocations: number;
}

/** A fresh callback can disappear only when the consumer cannot observe or retain its identity. */
export function coreSynchronousCallbackConsumer(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	caller: CoreFunctionStore,
	site: CoreInstructionId,
	target: CoreFunctionId,
): CoreSynchronousCallbackConsumer | undefined {
	const call = summaries.targets.site(caller.id, site);
	if (
		!summaries.targets.sourceClosed ||
		call === undefined ||
		coreCalleeTargetsAreOpen(call.targets) ||
		call.targets.functions.length !== 1 ||
		call.targets.functions[0] !== target ||
		caller.instructionOpcodeName(site) !== "call"
	)
		return undefined;
	const consumer = program.function(target);
	if (!consumer.metadata.strict || consumer.isAsync || consumer.isGenerator)
		return undefined;
	const escapes = summaries.summary(target)?.parameterEscape;
	for (const [parameter, argument] of (call.arguments ?? []).entries()) {
		if (parameter >= consumer.parameterCount || escapes?.[parameter] !== "invoked")
			continue;
		const callback = coreDirectCreatedFunction(caller, argument);
		if (callback === undefined) continue;
		const closure = program.function(callback);
		if (!closure.metadata.strict || closure.isAsync || closure.isGenerator) continue;
		const value = consumer.kernel.functionParameter(parameter);
		if (consumer.kernel.valueHandlerUseCount(value) !== 0) continue;
		let calls = 0;
		let onlyInvoked = true;
		for (
			let use = consumer.kernel.valueFirstUse(value);
			use >= 0;
			use = consumer.kernel.useNext(use)
		) {
			if (consumer.kernel.useLive(use) === 0) continue;
			const instruction = coreInstructionId(consumer.kernel.useInstruction(use));
			if (
				consumer.instructionKind(instruction) !== "operation" ||
				consumer.instructionOpcodeName(instruction) !== "call" ||
				consumer.kernel.useOperand(use) !== 0
			) {
				onlyInvoked = false;
				break;
			}
			calls++;
		}
		if (onlyInvoked && calls > 0)
			return {
				function: consumer,
				bodyVersion: consumer.version("body"),
				parameter,
				callback,
				argument,
				invocations: calls,
			};
	}
	return undefined;
}
