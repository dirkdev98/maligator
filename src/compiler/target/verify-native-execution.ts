import type { ExecutionProgram } from "./execution-ir.ts";
import { ExecutionVerificationError, verifyExecutionProgram } from "./verify-execution.ts";

const verifiedNativeExecutionPrograms = new WeakSet<ExecutionProgram>();

/** Verify the generic target before native image planning consumes it. */
export function verifyNativeExecutionProgram(program: ExecutionProgram): void {
	if (verifiedNativeExecutionPrograms.has(program)) return;
	verifyExecutionProgram(program);
	for (const [functionIndex, fn] of program.functions.entries()) {
		if (fn.directEntries.length !== 0 || fn.specializations.length !== 0) {
			throw new ExecutionVerificationError(
				"generic native execution must not contain specialized variants",
				{ functionIndex },
			);
		}
	}
	verifiedNativeExecutionPrograms.add(program);
}
