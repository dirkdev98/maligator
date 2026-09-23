import * as path from "node:path";
import { maligatorCacheDirectory } from "./cache-root.ts";
import type { CoreFrontendOptions } from "./compiler/core/core-frontend.ts";
import { ESTREE_STOP, traverseEstree } from "./compiler/frontend/estree-traversal.ts";
import type { SemanticProgram } from "./compiler/frontend/semantic-analysis.ts";
import { loadOrCompileCoreModule } from "./core-module-cache.ts";

const NODE_HOST_GLOBALS = new Set([
	"process",
	"global",
	"TextEncoder",
	"TextDecoder",
	"Buffer",
]);

function dependsOnNodeContext(file: SemanticProgram["files"][number]): boolean {
	for (const binding of file.nodeToBinding.values())
		if (binding.undeclared && NODE_HOST_GLOBALS.has(binding.name)) return true;
	return (
		traverseEstree(file.ast, (node) =>
			node.type === "MetaProperty" &&
			node.meta.name === "import" &&
			node.property.name === "meta"
				? ESTREE_STOP
				: undefined,
		) === ESTREE_STOP
	);
}

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
		[...graph.modules.values()].some(
			(module) =>
				module.goal !== "module" ||
				module.platform !== undefined ||
				module.dependencies.some(
					(dependency) => dependency.kind !== "import" && dependency.kind !== "export",
				),
		) ||
		semantic.files.some((file) => file.hasDirectEval.size !== 0)
	) {
		statistics.fallback =
			"Core reuse requires a static ESM graph without platform modules or direct eval";
		return undefined;
	}
	const files = new Map(semantic.files.map((file) => [file.path, file]));
	const directory = path.join(
		cacheDirectory ?? maligatorCacheDirectory(),
		"core-modules",
	);
	return (sourcePath) => {
		const module = graph.modules.get(sourcePath);
		// A dependency-free leaf cannot join a cycle; cyclic consumers still lower normally.
		if (
			module === undefined ||
			module.path === graph.entry ||
			module.dependencies.length !== 0 ||
			module.host !== undefined ||
			module.platform !== undefined ||
			module.virtual === true
		)
			return undefined;
		const file = files.get(sourcePath);
		// Standalone leaf lowering cannot supply Node import.meta fields or retain host globals.
		if (graph.nodeEnabled && (file === undefined || dependsOnNodeContext(file)))
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
