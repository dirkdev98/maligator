import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import type { CompileCorePhase } from "./compile-core.ts";
import {
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendArtifactIdentity,
	frontendArtifactUnchanged,
	frontendDigest,
} from "./frontend-cache.ts";
import type {
	FrontendArtifactIdentity,
	FrontendCompilationSession,
} from "./frontend-cache.ts";
import type { BuildModuleGraphOptions, ModuleGraph } from "./module-graph.ts";
import { buildModuleGraph } from "./module-graph.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "./semantic-program.ts";
import { serializeVmDefinition, WIRE_VERSION } from "./serialize-vm.ts";
import { MALIGATOR_VERSION } from "./version.ts";

const DEPENDENCY_FRAGMENT_SCHEMA = 1;
const CACHE_DIRECTORY = ".cache/mal-cache/dependency-fragments";

/** Stable runtime registry populated before application and test fragments execute. */
export const DEVELOPMENT_LINKED_MODULES_GLOBAL = "__maligatorDevelopmentLinkedModules";

export interface DependencyFragmentTarget {
	target: string;
	commonjs: boolean;
}

export interface DependencyFragmentPhases {
	graphMs: number;
	semanticMs: number;
	compileMs: number;
	serializeMs: number;
}

export interface DependencyFragmentArtifact extends FrontendArtifactIdentity {
	key: string;
	targets: Array<string>;
	wire: Uint8Array;
	cache: "hit" | "miss";
}

export interface CompileDependencyFragmentsOptions {
	graph: ModuleGraph;
	targets: Array<DependencyFragmentTarget>;
	config: ResolvedBuildConfig;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	cacheDirectory?: string;
	session: FrontendCompilationSession;
	phases: DependencyFragmentPhases;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
}

function cacheRoot(override: string | undefined): string {
	return override === undefined
		? path.resolve(CACHE_DIRECTORY)
		: path.resolve(override, "dependency-fragments");
}

function publish(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, contents);
	renameSync(temporary, file);
}

export function isExternalModule(file: string): boolean {
	return file.split(path.sep).includes("node_modules");
}

function environmentIdentity(options: CompileDependencyFragmentsOptions): string {
	return frontendDigest(
		JSON.stringify({
			schema: DEPENDENCY_FRAGMENT_SCHEMA,
			version: MALIGATOR_VERSION,
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			optimization: "development",
			engine: options.config.engine,
			host: options.config.host,
			surface: options.config.surface,
		}),
	);
}

function reachableExternalModules(graph: ModuleGraph, target: string): Set<string> {
	const reachable = new Set<string>();
	const pending = [target];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (reachable.has(current) || !isExternalModule(current)) continue;
		reachable.add(current);
		const record = graph.modules.get(current);
		if (record === undefined) continue;
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath !== null && isExternalModule(dependency.resolvedPath)) {
				pending.push(dependency.resolvedPath);
			}
		}
	}
	return reachable;
}

interface DependencyIsland {
	targets: Array<DependencyFragmentTarget>;
	modules: Set<string>;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
	for (const value of left) if (right.has(value)) return true;
	return false;
}

/**
 * Group roots by overlapping transitive closures. Disjoint roots may safely run
 * as separate VM images; overlapping roots must remain together so every module
 * is instantiated exactly once. Package cycles naturally stay in one closure.
 */
function dependencyIslands(
	graph: ModuleGraph,
	targets: Array<DependencyFragmentTarget>,
): Array<DependencyIsland> {
	const islands: Array<DependencyIsland> = [];
	for (const target of [...targets].sort((left, right) =>
		left.target < right.target ? -1 : left.target > right.target ? 1 : 0,
	)) {
		const modules = reachableExternalModules(graph, target.target);
		const overlapping = islands.filter((island) => intersects(island.modules, modules));
		if (overlapping.length === 0) {
			islands.push({ targets: [target], modules });
			continue;
		}
		const merged = overlapping[0]!;
		merged.targets.push(target);
		for (const module of modules) merged.modules.add(module);
		for (const other of overlapping.slice(1)) {
			merged.targets.push(...other.targets);
			for (const module of other.modules) merged.modules.add(module);
			islands.splice(islands.indexOf(other), 1);
		}
	}
	return islands.sort((left, right) =>
		left.targets[0]!.target < right.targets[0]!.target
			? -1
			: left.targets[0]!.target > right.targets[0]!.target
				? 1
				: 0,
	);
}

function islandGraph(
	island: DependencyIsland,
	options: CompileDependencyFragmentsOptions,
): ModuleGraph {
	const targets = [...island.targets].sort((left, right) =>
		left.target < right.target ? -1 : left.target > right.target ? 1 : 0,
	);
	const imports = targets
		.map((target, index) =>
			target.commonjs
				? `import __maligatorModule${index} from ${JSON.stringify(target.target)};`
				: `import * as __maligatorModule${index} from ${JSON.stringify(target.target)};`,
		)
		.join("\n");
	const publications = targets
		.map(
			(target, index) =>
				`__maligatorModules[${JSON.stringify(target.target)}] = __maligatorModule${index};`,
		)
		.join("\n");
	const source = `${imports}
const __maligatorModules = globalThis[${JSON.stringify(DEVELOPMENT_LINKED_MODULES_GLOBAL)}] || Object.create(null);
${publications}
globalThis[${JSON.stringify(DEVELOPMENT_LINKED_MODULES_GLOBAL)}] = __maligatorModules;
`;
	const targetKey = frontendDigest(JSON.stringify(targets.map(({ target }) => target)));
	const entry = path.join(
		path.dirname(targets[0]!.target),
		`.maligator-dependency-island-${targetKey.slice(0, 24)}.mts`,
	);
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: source,
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache: options.session.moduleParses,
	});
}

function graphKey(identity: string, targets: Array<string>, graph: ModuleGraph): string {
	return frontendDigest(
		JSON.stringify({
			identity,
			targets,
			entry: graph.entry,
			evaluationOrder: graph.evaluationOrder,
			modules: [...graph.modules.values()]
				.map((record) => ({
					path: record.path,
					goal: record.goal,
					source: frontendDigest(record.source),
					host: record.host?.id,
					virtual: record.virtual === true,
				}))
				.sort((left, right) =>
					left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
				),
		}),
	);
}

function compileIsland(
	root: string,
	artifactRoot: string,
	identity: string,
	targets: Array<string>,
	graph: ModuleGraph,
	options: CompileDependencyFragmentsOptions,
): DependencyFragmentArtifact {
	const key = graphKey(identity, targets, graph);
	const mappingPath = path.join(root, "artifacts", `${key}.json`);
	try {
		const reference = JSON.parse(readFileSync(mappingPath, "utf-8")) as {
			schema?: number;
			artifact?: FrontendArtifactIdentity;
		};
		if (
			reference.schema !== 1 ||
			reference.artifact === undefined ||
			!frontendArtifactUnchanged(reference.artifact, artifactRoot)
		) {
			throw new Error("invalid dependency artifact reference");
		}
		let wire: Uint8Array | undefined;
		return {
			key,
			targets,
			...reference.artifact,
			get wire() {
				if (wire !== undefined) return wire;
				wire = new Uint8Array(readFileSync(reference.artifact!.path));
				if (frontendDigest(wire) !== reference.artifact!.digest) {
					throw new Error("corrupt dependency fragment artifact");
				}
				return wire;
			},
			cache: "hit",
		};
	} catch {
		// Compile below when either the mapping or shared wire is absent.
	}
	const semanticStartedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(graph);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	options.phases.semanticMs += Date.now() - semanticStartedAt;
	const definition = compileSemanticProgramToVmDefinition(semantic, {
		optimization: "development",
		runPhase(phase, run) {
			const startedAt = Date.now();
			try {
				return run();
			} finally {
				const durationMs = Date.now() - startedAt;
				options.phases.compileMs += durationMs;
				options.onCompilePhase?.(phase, durationMs);
			}
		},
	});
	const serializeStartedAt = Date.now();
	const wire = serializeVmDefinition(definition);
	options.phases.serializeMs += Date.now() - serializeStartedAt;
	const wireDigest = frontendDigest(wire);
	cacheFrontendWire(wire, artifactRoot);
	const artifact = frontendArtifactIdentity(wireDigest, artifactRoot);
	if (artifact === undefined) {
		throw new Error(`dependency artifact is missing after publication: ${wireDigest}`);
	}
	publish(mappingPath, `${JSON.stringify({ schema: 1, artifact })}\n`);
	return { key, targets, ...artifact, wire, cache: "miss" };
}

/** Compile independently reusable, module-singleton-safe dependency images. */
export function compileDependencyFragments(
	options: CompileDependencyFragmentsOptions,
): Array<DependencyFragmentArtifact> {
	const identity = environmentIdentity(options);
	const root = cacheRoot(options.cacheDirectory);
	const artifactRoot = frontendArtifactCacheRoot(options.cacheDirectory);
	const graphStartedAt = Date.now();
	const graphs = dependencyIslands(options.graph, options.targets).map((island) => ({
		targets: island.targets.map(({ target }) => target).sort(),
		graph: islandGraph(island, options),
	}));
	options.phases.graphMs += Date.now() - graphStartedAt;
	return graphs.map(({ targets, graph }) =>
		compileIsland(root, artifactRoot, identity, targets, graph, options),
	);
}
