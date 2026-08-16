import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import type { CompileCorePhase } from "./compile-core.ts";
import type { CompilerDiagnostic } from "./compiler-diagnostics.ts";
import { compilerProgramFactsFromConfig } from "./compiler-facts.ts";
import type { VmDefinition } from "./lower-vm.ts";
import type { BuildModuleGraphOptions } from "./module-graph.ts";
import { buildModuleGraph } from "./module-graph.ts";
import { collectPrimordialMutationDiagnostics } from "./primordial-diagnostics.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "./semantic-program.ts";
import { serializeVmDefinition } from "./serialize-vm.ts";

export type CompileEntrypointPhase = "graph" | "semantic" | CompileCorePhase;
export type CompileEntrypointToBufferPhase = CompileEntrypointPhase | "serialize";

export interface CompileEntrypointOptions extends BuildModuleGraphOptions {
	runPhase?: <T>(phase: CompileEntrypointPhase, run: () => T) => T;
	onDiagnostic?: (diagnostic: CompilerDiagnostic) => void;
}

export interface CompileEntrypointToBufferOptions extends Omit<
	CompileEntrypointOptions,
	"runPhase"
> {
	runPhase?: <T>(phase: CompileEntrypointToBufferPhase, run: () => T) => T;
}

/** Compile an on-disk entrypoint and its module graph to the portable wire format. */
export function compileEntrypoint(
	entrypointPath: string,
	options: CompileEntrypointOptions = {},
): VmDefinition {
	const runPhase =
		options.runPhase ?? (<T>(_phase: CompileEntrypointPhase, run: () => T): T => run());
	const facts =
		options.buildConfig === undefined
			? undefined
			: compilerProgramFactsFromConfig(options.buildConfig);
	const graph = runPhase("graph", () => buildModuleGraph(entrypointPath, options));
	const semantic = runPhase("semantic", () => {
		const result = runSemanticAnalysisForGraph(graph);
		if (options.buildConfig !== undefined) {
			assertEvalPolicy(options.buildConfig, collectDisallowedEvalUsage(result));
			assertRegexpPolicy(options.buildConfig, collectDisallowedRegexpUsage(result));
			for (const diagnostic of collectPrimordialMutationDiagnostics(
				result,
				facts!.world,
			)) {
				options.onDiagnostic?.(diagnostic);
			}
		}
		return result;
	});
	return compileSemanticProgramToVmDefinition(semantic, {
		facts,
		runPhase,
	});
}

/** Compile an on-disk entrypoint and its module graph to the portable wire format. */
export function compileEntrypointToBuffer(
	entrypointPath: string,
	options: CompileEntrypointToBufferOptions = {},
): Uint8Array {
	const definition = compileEntrypoint(entrypointPath, options);
	const runPhase =
		options.runPhase ??
		(<T>(_phase: CompileEntrypointToBufferPhase, run: () => T): T => run());
	return runPhase("serialize", () => serializeVmDefinition(definition));
}
