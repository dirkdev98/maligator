import { serializeRuntimeImage } from "../target/program-image-codec.ts";
import type {
	CompileEntrypointToBufferOptions,
	CompileEntrypointToBufferPhase,
} from "./compile-program-common.ts";
import { analyzeEntrypoint } from "./compile-program-common.ts";
import { compileSemanticProgramToRuntimeImage } from "./compile-runtime-core.ts";

/** Compile an on-disk entrypoint directly to the portable runtime wire format. */
export function compileEntrypointToBuffer(
	entrypointPath: string,
	options: CompileEntrypointToBufferOptions = {},
): Uint8Array {
	const runPhase =
		options.runPhase ??
		(<T>(_phase: CompileEntrypointToBufferPhase, run: () => T): T => run());
	const { semantic, facts } = analyzeEntrypoint(entrypointPath, options, runPhase);
	const runtime = compileSemanticProgramToRuntimeImage(semantic, {
		semanticLowering: { intrinsicGlobalReads: options.intrinsicGlobalReads },
		facts,
		optimization: options.optimization,
		coreVerification: options.coreVerification,
		runPhase,
	});
	return runPhase("serialize", () => serializeRuntimeImage(runtime));
}
