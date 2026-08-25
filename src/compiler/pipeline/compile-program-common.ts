import { assertEvalPolicy, assertRegexpPolicy } from "../../build-config.ts";
import { certifyProgramClosure } from "../frontend/certify-closure.ts";
import type { BuildModuleGraphOptions } from "../frontend/module-graph.ts";
import { buildModuleGraph } from "../frontend/module-graph.ts";
import { collectPrimordialMutationDiagnostics } from "../frontend/primordial-diagnostics.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "../frontend/semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "../frontend/semantic-program.ts";
import type { CompilerDiagnostic } from "../shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../shared/compiler-facts.ts";
import type { CompileCorePhase } from "./compile-core-common.ts";

export type CompileEntrypointPhase = "graph" | "semantic" | CompileCorePhase;
export type CompileEntrypointToBufferPhase = CompileEntrypointPhase | "serialize";

export interface CompileEntrypointOptions extends BuildModuleGraphOptions {
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
			assertEvalPolicy(options.buildConfig, collectDisallowedEvalUsage(result));
			assertRegexpPolicy(options.buildConfig, collectDisallowedRegexpUsage(result));
			for (const diagnostic of collectPrimordialMutationDiagnostics(
				result,
				facts!.world,
				{ nodeEnabled: options.buildConfig.surface.node },
			)) {
				options.onDiagnostic?.(diagnostic);
			}
		}
		return result;
	});
	return { semantic, facts };
}
