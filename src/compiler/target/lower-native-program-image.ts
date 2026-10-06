import { analyzeClosureCaptureValues } from "./analyze-closure-capture-values.ts";
import { analyzeClosureCaptures } from "./analyze-closure-captures.ts";
import { compactCaptureStorage } from "./compact-capture-storage.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import { lowerNativeStorage } from "./lower-native-storage.ts";
import type { NativeProgram } from "./native-ir.ts";
import type { ProgramImage } from "./program-image.ts";
import { lowerVerifiedExecutionToProgramImage } from "./program-image.ts";
import { verifyNativeExecutionProgram } from "./verify-native-execution.ts";

/** Lower a structurally mutable execution target to the complete native product contract. */
export function lowerExecutionToProgramImage(
	program: ExecutionProgram,
	nativeProgram: NativeProgram,
	profile = false,
): ProgramImage {
	if (nativeProgram.kind !== "native" || nativeProgram.core !== program.core)
		throw new Error(
			"Native image requires independent lowering of the same Core program",
		);
	verifyNativeExecutionProgram(program);
	verifyNativeExecutionProgram(nativeProgram);
	return lowerNativeStorage(
		analyzeClosureCaptures(
			compactCaptureStorage(
				analyzeClosureCaptureValues(
					lowerVerifiedExecutionToProgramImage(program, nativeProgram, profile),
					program,
				),
				program.context,
			),
			program.context,
		),
	);
}
