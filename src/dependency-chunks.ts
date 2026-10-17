import * as path from "node:path";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/analyze-module-graph.ts";
import { linkModules } from "./compiler/frontend/linker.ts";
import type {
	ExternalModuleInterface,
	ModuleGraph,
} from "./compiler/frontend/module-graph.ts";
import { isWithinDirectory } from "./compiler/shared/module-path-values.ts";

/** One image of a dependency island that is compiled beside the others. */
export interface DependencyChunk {
	/** Every module the chunk's image owns. */
	readonly members: ReadonlyArray<string>;
	/** Members the chunk evaluates when it loads, in the island's evaluation order. */
	readonly imports: ReadonlyArray<string>;
	/** CommonJS members that run only when first required, possibly by a later chunk. */
	readonly requiredRoots: ReadonlyArray<string>;
}

export interface DependencyChunkPlan {
	readonly chunks: ReadonlyArray<DependencyChunk>;
	/** What every member publishes, planned so that no chunk waits for another. */
	readonly interfaces: ReadonlyMap<string, ExternalModuleInterface>;
}

/** Source bytes one chunk aims for, roughly a second of compile work per worker. */
const CHUNK_COST = 96 * 1024;
/** Each module costs at least this much; a JSON module compiles to little more. */
const MODULE_COST = 2 * 1024;

/**
 * Split an island into chunks that compile in parallel. Each chunk is a run of the
 * island's dependency post-order, so it only links to earlier chunks, and no
 * boundary separates a cycle or a `require` of an ES module, which a loaded image
 * cannot resolve. A chunk evaluates what the island evaluates eagerly, in the
 * island's order; its other modules run when first required. Undefined when the
 * island is small or uses `import()`, workers or deferred imports internally.
 */
export function planDependencyChunks(
	graph: ModuleGraph,
	targets: ReadonlySet<string>,
): DependencyChunkPlan | undefined {
	const members = graph.evaluationOrder.filter(
		(module) => module !== graph.entry && graph.modules.get(module)?.host === undefined,
	);
	const memberSet = new Set(members);
	const position = new Map(members.map((module, index) => [module, index]));
	const together: Array<ReadonlyArray<number>> = graph.cycles.map((cycle) =>
		cycle.map((module) => position.get(module)!),
	);
	for (const record of graph.modules.values()) {
		if (record.path === graph.entry || record.host !== undefined) continue;
		if (
			!memberSet.has(record.path) ||
			record.external !== undefined ||
			record.virtual === true ||
			record.loadError !== undefined
		) {
			return undefined;
		}
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath === null || !memberSet.has(dependency.resolvedPath))
				continue;
			if (
				dependency.kind === "dynamic" ||
				dependency.kind === "worker" ||
				dependency.kind === "deferred-import"
			) {
				return undefined;
			}
			if (
				dependency.kind === "require" &&
				graph.modules.get(dependency.resolvedPath)?.goal !== "cjs"
			) {
				together.push([
					position.get(record.path)!,
					position.get(dependency.resolvedPath)!,
				]);
			}
		}
	}
	// The island's entry evaluates ES modules through their static imports, and the
	// CommonJS modules those import; everything else waits for its first `require`.
	const eager = new Set<string>();
	const pending = [graph.entry];
	while (pending.length > 0) {
		const record = graph.modules.get(pending.pop()!)!;
		if (record.goal === "cjs") continue;
		for (const dependency of record.dependencies) {
			const target = dependency.resolvedPath;
			if (
				target === null ||
				!memberSet.has(target) ||
				eager.has(target) ||
				(dependency.kind !== "import" && dependency.kind !== "export")
			)
				continue;
			eager.add(target);
			pending.push(target);
		}
	}
	const costs = members.map((module) =>
		path.extname(module) === ".json"
			? MODULE_COST
			: Math.max(graph.modules.get(module)!.source.length, MODULE_COST),
	);
	const total = costs.reduce((sum, cost) => sum + cost, 0);
	const chunkCount = Math.round(total / CHUNK_COST);
	if (chunkCount < 2) return undefined;

	// A boundary after position i must not separate modules that stay together.
	const crossed = new Array<number>(members.length + 1).fill(0);
	for (const positions of together) {
		crossed[Math.min(...positions)]!++;
		crossed[Math.max(...positions)]!--;
	}
	const chunks: Array<DependencyChunk> = [];
	let start = 0;
	let open = 0;
	let accumulated = 0;
	for (let index = 0; index < members.length; index++) {
		open += crossed[index]!;
		accumulated += costs[index]!;
		const last = index === members.length - 1;
		const due = accumulated >= ((chunks.length + 1) * total) / chunkCount;
		if (last || (due && open === 0)) {
			const segment = members.slice(start, index + 1);
			// An ES module that is only required joins through its requirer's edge.
			chunks.push({
				members: segment,
				imports: segment.filter((module) => eager.has(module) || targets.has(module)),
				requiredRoots: segment.filter(
					(module) =>
						graph.modules.get(module)!.goal === "cjs" &&
						!eager.has(module) &&
						!targets.has(module),
				),
			});
			start = index + 1;
		}
	}
	if (chunks.length < 2) return undefined;
	return { chunks, interfaces: plannedInterfaces(graph, memberSet) };
}

/**
 * The interfaces the compiled chunks will publish. Linking the whole island derives
 * them from the same namespaces and CommonJS export names a chunk's own lowering uses.
 */
function plannedInterfaces(
	graph: ModuleGraph,
	members: ReadonlySet<string>,
): Map<string, ExternalModuleInterface> {
	const semantic = runSemanticAnalysisForGraph(graph);
	const linkage = linkModules(semantic);
	const interfaces = new Map<string, ExternalModuleInterface>();
	for (const file of semantic.files) {
		if (!members.has(file.path)) continue;
		interfaces.set(
			file.path,
			file.commonjs
				? { goal: "cjs", exports: [...linkage.commonJsExportNames(file.path)] }
				: {
						goal: "module",
						exports: (linkage.moduleNamespaces.get(file.path) ?? []).map(
							({ name }) => name,
						),
					},
		);
	}
	return interfaces;
}

interface StoredDependencyChunkPlan {
	chunks: Array<{
		members: Array<string>;
		imports: Array<string>;
		requiredRoots: Array<string>;
	}>;
	interfaces: Array<[string, ExternalModuleInterface]>;
}

/** A plan with paths below `packageRoot` stored relative to it, for every location. */
export function storeDependencyChunkPlan(
	plan: DependencyChunkPlan,
	packageRoot: string | undefined,
): StoredDependencyChunkPlan {
	const store = (module: string) =>
		packageRoot !== undefined && isWithinDirectory(module, packageRoot)
			? `\0package-root${module.slice(packageRoot.length)}`
			: module;
	return {
		chunks: plan.chunks.map((chunk) => ({
			members: chunk.members.map(store),
			imports: chunk.imports.map(store),
			requiredRoots: chunk.requiredRoots.map(store),
		})),
		interfaces: [...plan.interfaces].map(([module, surface]) => [store(module), surface]),
	};
}

export function restoreDependencyChunkPlan(
	stored: StoredDependencyChunkPlan,
	packageRoot: string | undefined,
): DependencyChunkPlan {
	const restore = (module: string) =>
		module.startsWith("\0package-root")
			? `${packageRoot!}${module.slice("\0package-root".length)}`
			: module;
	return {
		chunks: stored.chunks.map((chunk) => ({
			members: chunk.members.map(restore),
			imports: chunk.imports.map(restore),
			requiredRoots: chunk.requiredRoots.map(restore),
		})),
		interfaces: new Map(
			stored.interfaces.map(([module, surface]): [string, ExternalModuleInterface] => [
				restore(module),
				surface,
			]),
		),
	};
}

/** The modules a chunk's graph treats as published by the chunks before it. */
export function earlierChunkInterfaces(
	plan: DependencyChunkPlan,
	index: number,
): Map<string, ExternalModuleInterface> {
	const external = new Map<string, ExternalModuleInterface>();
	for (const chunk of plan.chunks.slice(0, index)) {
		for (const module of chunk.members) {
			external.set(module, plan.interfaces.get(module)!);
		}
	}
	return external;
}

/** Whether a compiled chunk publishes exactly what the plan promised later chunks. */
export function chunkMatchesPlan(
	plan: DependencyChunkPlan,
	published: ReadonlyArray<{ readonly module: string } & ExternalModuleInterface>,
): boolean {
	return published.every((surface) => {
		const planned = plan.interfaces.get(surface.module);
		return (
			planned !== undefined &&
			planned.goal === surface.goal &&
			planned.exports.length === surface.exports.length &&
			planned.exports.every((name, index) => name === surface.exports[index])
		);
	});
}
