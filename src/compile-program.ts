import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import type { VmDefinition } from "./lower-vm.ts";
import type { BuildModuleGraphOptions } from "./module-graph.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-program.ts";
import { serializeVmDefinition } from "./serialize-vm.ts";

/** Compile an on-disk entrypoint and its module graph to the portable wire format. */
export function compileEntrypoint(
	entrypointPath: string,
	options: BuildModuleGraphOptions = {},
): VmDefinition {
	const semantic = loadEntrypointAndRunSemanticAnalysis(entrypointPath, options);
	if (options.buildConfig !== undefined) {
		assertEvalPolicy(options.buildConfig, collectDisallowedEvalUsage(semantic));
		assertRegexpPolicy(options.buildConfig, collectDisallowedRegexpUsage(semantic));
	}
	return compileSemanticProgramToVmDefinition(semantic);
}

/** Compile an on-disk entrypoint and its module graph to the portable wire format. */
export function compileEntrypointToBuffer(
	entrypointPath: string,
	options: BuildModuleGraphOptions = {},
): Uint8Array {
	return serializeVmDefinition(compileEntrypoint(entrypointPath, options));
}
