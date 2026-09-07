import { runSemanticAnalysisForGraph } from "./analyze-module-graph.ts";
import type { BuildModuleGraphOptions } from "./module-graph.ts";
import { buildModuleGraph } from "./module-graph.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";

export function loadEntrypointAndRunSemanticAnalysis(
	entrypointPath: string,
	options: BuildModuleGraphOptions = {},
): SemanticProgram {
	return runSemanticAnalysisForGraph(buildModuleGraph(entrypointPath, options));
}
