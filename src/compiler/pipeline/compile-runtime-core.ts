import type { CoreModuleInterface } from "../core/core-compilation.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import { lowerCoreCompilationToRuntimeExecution } from "../target/lower-execution.ts";
import { lowerExecutionToRuntimeImage } from "../target/runtime-image.ts";
import type { RuntimeImage } from "../target/runtime-image.ts";
import type { CompileCoreOptions, CompileCorePhase } from "./compile-core-common.ts";
import { optimizeSemanticProgramToCore } from "./compile-core-common.ts";

/**
 * Pure semantic-program pipeline for portable runtime wire consumers.
 *
 * It deliberately omits native-only call ABI variants. The resulting bytecode is
 * the canonical runtime contract, while eval and other wire-only compilers do not
 * reserve registers or retain planning code for an absent NativePlan consumer.
 */
export function compileSemanticProgramToRuntimeImage(
	semantic: SemanticProgram,
	options: CompileCoreOptions = {},
): RuntimeImage {
	return compileSemanticProgramToLinkedRuntimeImage(semantic, options).runtime;
}

/** The runtime pipeline for an image of a relocatable program that is only interpreted. */
export function compileSemanticProgramToLinkedRuntimeImage(
	semantic: SemanticProgram,
	options: CompileCoreOptions = {},
): { runtime: RuntimeImage; interfaces: ReadonlyArray<CoreModuleInterface> } {
	const runPhase =
		options.runPhase ?? (<T>(_phase: CompileCorePhase, run: () => T): T => run());
	const optimized = optimizeSemanticProgramToCore(semantic, options, runPhase);
	const lowered = runPhase("core to execution", () =>
		lowerCoreCompilationToRuntimeExecution(optimized, {
			reuseRegisters: options.optimization !== "development",
		}),
	);
	return {
		runtime: runPhase("execution to image", () => lowerExecutionToRuntimeImage(lowered)),
		interfaces: optimized.context.data.moduleLinks?.interfaces ?? [],
	};
}
