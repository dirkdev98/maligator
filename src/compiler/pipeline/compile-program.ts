import { lowerSemanticProgramToCore } from "../core/core-frontend.ts";
import type { ProgramImage } from "../target/program-image.ts";
import { compileConstructedCoreToProgramImage } from "./compile-core.ts";
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
	let analysis: ReturnType<typeof analyzeEntrypoint> | undefined = analyzeEntrypoint(
		entrypointPath,
		options,
		runPhase,
	);
	const facts = analysis.facts;
	const core = lowerSemanticProgramToCore(analysis.semantic, {
		intrinsicGlobalReads: options.intrinsicGlobalReads,
		facts,
		runPhase,
	});
	// The module graph and AST must not share the Core optimizer's peak lifetime.
	analysis = undefined;
	return compileConstructedCoreToProgramImage(
		core,
		{
			facts,
			optimization: options.optimization,
			coreVerification: options.coreVerification,
			coreInstrumentation: options.coreInstrumentation,
			coreOptimizationBenchmarkAblation: options.coreOptimizationBenchmarkAblation,
			afterCoreOptimization: options.afterCoreOptimization,
			runPhase,
		},
		runPhase,
	);
}
