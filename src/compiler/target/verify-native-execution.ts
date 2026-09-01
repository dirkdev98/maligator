import type { ExecutionProgram } from "./execution-ir.ts";
import {
	ExecutionVerificationError,
	verifyExecutionFunctionRepresentationVariant,
	verifyExecutionProgram,
} from "./verify-execution.ts";

const verifiedNativeExecutionPrograms = new WeakSet<ExecutionProgram>();

/** Verify the generic target before native image planning consumes it. */
export function verifyNativeExecutionProgram(program: ExecutionProgram): void {
	if (verifiedNativeExecutionPrograms.has(program)) return;
	verifyExecutionProgram(program);
	for (const [functionIndex, fn] of program.functions.entries()) {
		if (fn.directEntries.length > 4) {
			throw new ExecutionVerificationError(
				"native function has too many direct entries",
				{
					functionIndex,
				},
			);
		}
		for (const [entryIndex, entry] of fn.directEntries.entries()) {
			if (
				entry.id !== entryIndex ||
				entry.parameterRepresentations.length !== fn.parameterCount ||
				entry.registerRepresentations.length !== fn.registerCount ||
				entry.parameterRepresentations.some(
					(representation, parameter) =>
						entry.registerRepresentations[parameter] !== representation,
				)
			) {
				throw new ExecutionVerificationError("native direct entry has an invalid ABI", {
					functionIndex,
				});
			}
			verifyExecutionFunctionRepresentationVariant(
				{
					...fn,
					registerRepresentations: entry.registerRepresentations,
					gc: entry.gc,
				},
				program.core.function(program.functionMap.executionToCore[functionIndex]!),
				functionIndex,
			);
		}
	}
	verifiedNativeExecutionPrograms.add(program);
}
