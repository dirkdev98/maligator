import type { ProgramImage } from "../target/program-image.ts";
import { compileSemanticProgramToProgramImage } from "./compile-core.ts";
import type {
	CompileEntrypointOptions,
	CompileEntrypointPhase,
} from "./compile-program-common.ts";
import { analyzeEntrypoint } from "./compile-program-common.ts";

export type {
	CompileEntrypointOptions,
	CompileEntrypointPhase,
	CompileEntrypointToBufferOptions,
	CompileEntrypointToBufferPhase,
} from "./compile-program-common.ts";
export { compileEntrypointToBuffer } from "./compile-runtime-program.ts";

/** Compile an on-disk entrypoint and its module graph to a full Program Image. */
export function compileEntrypoint(
	entrypointPath: string,
	options: CompileEntrypointOptions = {},
): ProgramImage {
	const runPhase =
		options.runPhase ?? (<T>(_phase: CompileEntrypointPhase, run: () => T): T => run());
	const { semantic, facts } = analyzeEntrypoint(entrypointPath, options, runPhase);
	return compileSemanticProgramToProgramImage(semantic, {
		facts,
		coreInstrumentation: options.coreInstrumentation,
		afterCoreOptimization: options.afterCoreOptimization,
		runPhase,
	});
}
