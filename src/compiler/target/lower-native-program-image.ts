import { analyzeClosureCaptureValues } from "./analyze-closure-capture-values.ts";
import { analyzeClosureCaptures } from "./analyze-closure-captures.ts";
import { compactCaptureStorage } from "./compact-capture-storage.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import type { ProgramImage } from "./program-image.ts";
import { lowerVerifiedExecutionToProgramImage } from "./program-image.ts";
import { verifyNativeExecutionProgram } from "./verify-native-execution.ts";

/** Lower a structurally mutable execution target to the complete native product contract. */
export function lowerExecutionToProgramImage(
	program: ExecutionProgram,
	profile = false,
): ProgramImage {
	verifyNativeExecutionProgram(program);
	return analyzeClosureCaptures(
		compactCaptureStorage(
			analyzeClosureCaptureValues(
				lowerVerifiedExecutionToProgramImage(program, profile),
				program,
			),
			program.context,
		),
		program.context,
	);
}
