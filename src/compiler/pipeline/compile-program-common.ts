import { runSemanticAnalysisForGraph } from "../frontend/analyze-module-graph.ts";
import { validateSemanticBuildPolicy } from "../frontend/build-policy.ts";
import { certifyProgramClosure } from "../frontend/certify-closure.ts";
import type { BuildModuleGraphOptions } from "../frontend/module-graph.ts";
import { buildModuleGraph } from "../frontend/module-graph.ts";
import type { CompilerDiagnostic } from "../shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../shared/compiler-facts.ts";
import type { CompileCoreOptions, CompileCorePhase } from "./compile-core-common.ts";

export type CompileEntrypointPhase = "graph" | "semantic" | CompileCorePhase;
export type CompileEntrypointToBufferPhase = CompileEntrypointPhase | "serialize";

export interface CompileEntrypointOptions extends BuildModuleGraphOptions {
	/** Only for embedded engine code; user programs must resolve mutable realm globals. */
	intrinsicGlobalReads?: boolean;
	optimization?: CompileCoreOptions["optimization"];
	coreVerification?: CompileCoreOptions["coreVerification"];
	coreInstrumentation?: CompileCoreOptions["coreInstrumentation"];
	coreOptimizationBenchmarkAblation?: CompileCoreOptions["coreOptimizationBenchmarkAblation"];
	afterCoreOptimization?: CompileCoreOptions["afterCoreOptimization"];
	runPhase?: <T>(phase: CompileEntrypointPhase, run: () => T) => T;
	onDiagnostic?: (diagnostic: CompilerDiagnostic) => void;
	/** Observe the facts this compilation ran under, including its closure certificate. */
	onProgramFacts?: (facts: CompilerProgramFacts) => void;
}

export interface CompileEntrypointToBufferOptions extends Omit<
	CompileEntrypointOptions,
	"runPhase"
> {
	runPhase?: <T>(phase: CompileEntrypointToBufferPhase, run: () => T) => T;
}

export function analyzeEntrypoint(
	entrypointPath: string,
	options: CompileEntrypointOptions,
	runPhase: <T>(phase: CompileEntrypointPhase, run: () => T) => T,
): {
	semantic: ReturnType<typeof runSemanticAnalysisForGraph>;
	facts: CompilerProgramFacts | undefined;
} {
	const graph = runPhase("graph", () => buildModuleGraph(entrypointPath, options));
	const buildConfig = options.buildConfig;
	const facts =
		buildConfig === undefined
			? undefined
			: withProgramClosure(
					compilerProgramFactsFromConfig(buildConfig),
					certifyProgramClosure(graph, buildConfig, {
						relocatableArtifact: false,
						hostWireSplicing: false,
					}),
				);
	if (facts !== undefined) options.onProgramFacts?.(facts);
	const semantic = runPhase("semantic", () => {
		const result = runSemanticAnalysisForGraph(graph);
		if (options.buildConfig !== undefined) {
			for (const diagnostic of validateSemanticBuildPolicy(
				result,
				options.buildConfig,
				facts!.world,
			)) {
				options.onDiagnostic?.(diagnostic);
			}
		}
		return result;
	});
	return { semantic, facts };
}
