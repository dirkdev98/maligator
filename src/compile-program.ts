import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import { executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import { lowerIrProgramToVmDefinition } from "./lower-vm.ts";
import type { VmDefinition } from "./lower-vm.ts";
import type { BuildModuleGraphOptions } from "./module-graph.ts";
import { allocateRegisters } from "./register-alloc.ts";
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
	const ir = compileSemanticProgramToIr(semantic);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	return lowerIrProgramToVmDefinition(ir);
}

/** Compile an on-disk entrypoint and its module graph to the portable wire format. */
export function compileEntrypointToBuffer(
	entrypointPath: string,
	options: BuildModuleGraphOptions = {},
): Uint8Array {
	return serializeVmDefinition(compileEntrypoint(entrypointPath, options));
}
