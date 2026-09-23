import * as path from "node:path";
import { maligatorCacheDirectory } from "./cache-root.ts";
import type { CoreFrontendOptions } from "./compiler/core/core-frontend.ts";
import type { SemanticProgram } from "./compiler/frontend/semantic-analysis.ts";
import { loadOrCompileCoreModule } from "./core-module-cache.ts";

export interface CoreModuleReuseStatistics {
	hits: number;
	misses: number;
	unsupported: number;
	budgetLimited: number;
	constructedFunctions: number;
	optimizedFunctions: number;
	importedFunctions: number;
	fallback?: string;
}

export function selectReusableCoreModules(
	semantic: SemanticProgram,
	cacheDirectory: string | undefined,
	stripperIdentity: string,
	statistics: CoreModuleReuseStatistics,
): CoreFrontendOptions["reusableModule"] {
	const graph = semantic.graph;
	if (
		graph === undefined ||
		graph.cycles.length !== 0 ||
		[...graph.modules.values()].some(
			(module) =>
				module.goal !== "module" ||
				module.host !== undefined ||
				module.platform !== undefined ||
				module.dependencies.some(
					(dependency) => dependency.kind !== "import" && dependency.kind !== "export",
				),
		) ||
		semantic.files.some((file) => file.hasDirectEval.size !== 0)
	) {
		statistics.fallback =
			"Core reuse requires a static ESM graph without cycles, host modules or direct eval";
		return undefined;
	}
	const directory = path.join(
		cacheDirectory ?? maligatorCacheDirectory(),
		"core-modules",
	);
	return (sourcePath) => {
		const module = graph.modules.get(sourcePath);
		if (
			module === undefined ||
			module.path === graph.entry ||
			module.dependencies.length !== 0
		)
			return undefined;
		const result = loadOrCompileCoreModule({
			source: module.source,
			sourcePath,
			moduleKey: sourcePath,
			capturePolicy: "optimized-only",
			parsed: { result: module.parsed, producer: stripperIdentity },
			cacheDirectory: directory,
			onWork(phase, functions) {
				if (phase === "construct") statistics.constructedFunctions += functions;
				else statistics.optimizedFunctions += functions;
			},
		});
		if (result.status !== "ready") {
			if (result.status === "budget-limited") statistics.budgetLimited++;
			else statistics.unsupported++;
			return undefined;
		}
		if (result.cache === "hit") statistics.hits++;
		else statistics.misses++;
		statistics.importedFunctions += result.optimized.functions.length;
		return {
			artifact: result.optimized,
			completedRecipe: result.completedRecipe,
		};
	};
}
