import type { ExecutionProgram } from "./execution-ir.ts";
import type { ProgramImage } from "./program-image.ts";
import { lowerVerifiedExecutionToProgramImage } from "./program-image.ts";
import { verifyNativeExecutionProgram } from "./verify-native-execution.ts";

/** Lower a structurally mutable execution target to the complete native product contract. */
export function lowerExecutionToProgramImage(
	program: ExecutionProgram,
	profile = false,
	pgoTraining = false,
): ProgramImage {
	verifyNativeExecutionProgram(program);
	return lowerVerifiedExecutionToProgramImage(program, profile, pgoTraining);
}
