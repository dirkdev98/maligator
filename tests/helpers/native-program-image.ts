import { analyzeClosureCaptureValues } from "../../src/compiler/target/analyze-closure-capture-values.ts";
import { analyzeClosureCaptures } from "../../src/compiler/target/analyze-closure-captures.ts";
import { compactCaptureStorage } from "../../src/compiler/target/compact-capture-storage.ts";
import type { ExecutionProgram } from "../../src/compiler/target/execution-ir.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import { lowerVerifiedExecutionToProgramImage } from "../../src/compiler/target/program-image.ts";
import { verifyNativeExecutionProgram } from "../../src/compiler/target/verify-native-execution.ts";

// These fixtures exercise allocated target contracts, including deliberately malformed ones.
export function lowerExecutionFixtureToProgramImage(
	program: ExecutionProgram,
	profile = false,
) {
	verifyNativeExecutionProgram(program);
	return lowerNativeStorage(
		analyzeClosureCaptures(
			compactCaptureStorage(
				analyzeClosureCaptureValues(
					lowerVerifiedExecutionToProgramImage(program, program, profile),
					program,
				),
				program.context,
			),
			program.context,
		),
	);
}
