import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import { lowerCoreCompilationToExecution } from "../target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../target/lower-native-program-image.ts";
import type { ProgramImage } from "../target/program-image.ts";
import type { CompileCoreOptions, CompileCorePhase } from "./compile-core-common.ts";
import { optimizeSemanticProgramToCore } from "./compile-core-common.ts";

export type { CompileCoreOptions, CompileCorePhase } from "./compile-core-common.ts";

/** Pure semantic-program pipeline for native products and compiler artifacts. */
export function compileSemanticProgramToProgramImage(
	semantic: SemanticProgram,
	options: CompileCoreOptions = {},
): ProgramImage {
	const runPhase =
		options.runPhase ?? (<T>(_phase: CompileCorePhase, run: () => T): T => run());
	const optimized = optimizeSemanticProgramToCore(semantic, options, runPhase);
	const lowered = runPhase("core to execution", () =>
		lowerCoreCompilationToExecution(optimized, {
			reuseRegisters: options.optimization !== "development",
		}),
	);
	return runPhase("execution to image", () =>
		lowerExecutionToProgramImage(lowered, options.profile === true),
	);
}
