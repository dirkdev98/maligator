import { readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
} from "./compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "./compiler/shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";
import { frontendDigest } from "./frontend-cache.ts";
import { FrontendCompilationSession } from "./frontend-cache.ts";
import {
	compileLinkedImage,
	findLinkedImage,
	linkedImageEnvironment,
} from "./linked-images.ts";
import type { LinkedImageArtifact, LinkedImageEnvironment } from "./linked-images.ts";
import { nativeBuildJobs, runIndependentCommands } from "./native-command.ts";
import type { Execution } from "./platform/execution.ts";

const DEPENDENCY_FRAGMENT_FAMILY = "dependency-fragments";
const ISLAND_KIND = "dependency-island";

export interface DependencyFragmentPhases {
	graphMs: number;
	semanticMs: number;
	compileMs: number;
	serializeMs: number;
	workerMs: number;
}

export interface DependencyFragmentWorker {
	tool: string;
	args: Array<string>;
}

export interface DependencyFragmentArtifact extends LinkedImageArtifact {
	/** The dependency modules the island's image publishes. */
	readonly targets: ReadonlyArray<string>;
}

export interface CompileDependencyFragmentsOptions {
	graph: ModuleGraph;
	/** Dependency modules imported from outside `node_modules`. */
	targets: ReadonlyArray<string>;
	config: ResolvedBuildConfig;
	execution?: Execution;
	facts: CompilerProgramFacts;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	cacheDirectory?: string;
	session: FrontendCompilationSession;
	phases: DependencyFragmentPhases;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
	worker?: DependencyFragmentWorker;
}

interface DependencyFragmentRequest {
	schema: 2;
	targets: Array<string>;
	config: ResolvedBuildConfig;
	execution?: Execution;
	stripperIdentity: string;
	cacheDirectory?: string;
}

export function isExternalModule(file: string): boolean {
	return file.split(path.sep).includes("node_modules");
}

function islandEnvironment(
	options: Pick<
		CompileDependencyFragmentsOptions,
		| "config"
		| "execution"
		| "facts"
		| "stripperIdentity"
		| "cacheDirectory"
		| "phases"
		| "onCompilePhase"
	>,
): LinkedImageEnvironment {
	return linkedImageEnvironment({
		producer: "dependency-fragment",
		family: DEPENDENCY_FRAGMENT_FAMILY,
		config: options.config,
		execution: options.execution,
		facts: options.facts,
		stripperIdentity: options.stripperIdentity,
		cacheDirectory: options.cacheDirectory,
		phases: options.phases,
		onCompilePhase: options.onCompilePhase,
	});
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
	targets: Array<string>;
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
	targets: ReadonlyArray<string>,
): Array<DependencyIsland> {
	const islands: Array<DependencyIsland> = [];
	for (const target of [...targets].sort()) {
		const modules = reachableExternalModules(graph, target);
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
	for (const island of islands) island.targets.sort();
	return islands.sort((left, right) =>
		left.targets[0]! < right.targets[0]!
			? -1
			: left.targets[0]! > right.targets[0]!
				? 1
				: 0,
	);
}

/** An island image evaluates its roots and publishes them to the images after it. */
function islandGraph(
	targets: ReadonlyArray<string>,
	options: Pick<
		CompileDependencyFragmentsOptions,
		"config" | "execution" | "stripTypes" | "session"
	>,
): ModuleGraph {
	const targetKey = frontendDigest(JSON.stringify(targets));
	const entry = path.join(
		path.dirname(targets[0]!),
		`.maligator-dependency-island-${targetKey.slice(0, 24)}.mts`,
	);
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: targets.map((target) => `import ${JSON.stringify(target)};\n`).join(""),
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		execution: options.execution,
		parseCache: options.session.moduleParses,
	});
}

function compileWithWorkers(
	root: string,
	requests: Array<DependencyFragmentRequest>,
	worker: DependencyFragmentWorker,
): number {
	const startedAt = Date.now();
	const commands = requests.map((request) => {
		const file = path.join(
			root,
			"requests",
			`${frontendDigest(JSON.stringify(request))}.json`,
		);
		writeFileAtomically(file, `${JSON.stringify(request)}\n`);
		return {
			tool: worker.tool,
			args: [...worker.args, "--maligator-internal-dependency-fragment", file],
		};
	});
	runIndependentCommands(commands, {
		cwd: process.cwd(),
		env: process.env,
		verbose: false,
		jobs: nativeBuildJobs(process.env),
	});
	return Date.now() - startedAt;
}

/** Internal worker entry used by the self-hosted CLI's synchronous coordinator. */
export function compileDependencyFragmentRequest(
	file: string,
	stripTypes: BuildModuleGraphOptions["stripTypes"],
): void {
	const request = JSON.parse(readFileSync(path.resolve(file), "utf-8")) as
		| DependencyFragmentRequest
		| undefined;
	if (
		request?.schema !== 2 ||
		!Array.isArray(request.targets) ||
		request.targets.length === 0
	) {
		throw new Error("invalid dependency fragment worker request");
	}
	const session = new FrontendCompilationSession();
	session.useCacheDirectory(request.cacheDirectory);
	const environment = islandEnvironment({
		config: request.config,
		execution: request.execution,
		facts: compilerProgramFactsFromConfig(request.config),
		stripperIdentity: request.stripperIdentity,
		cacheDirectory: request.cacheDirectory,
		phases: { graphMs: 0, semanticMs: 0, compileMs: 0, serializeMs: 0, workerMs: 0 },
	});
	const graph = islandGraph(request.targets, {
		config: request.config,
		execution: request.execution,
		stripTypes,
		session,
	});
	compileLinkedImage(environment, ISLAND_KIND, graph, new Set(request.targets));
	session.flush();
}

/** Compile independently reusable, module-singleton-safe dependency images. */
export function compileDependencyFragments(
	options: CompileDependencyFragmentsOptions,
): Array<DependencyFragmentArtifact> {
	const environment = islandEnvironment(options);
	const graphStartedAt = Date.now();
	const islands = dependencyIslands(options.graph, options.targets).map(
		({ targets }) => ({
			targets,
			graph: islandGraph(targets, options),
		}),
	);
	options.phases.graphMs += Date.now() - graphStartedAt;
	const missing = islands.filter(
		({ targets, graph }) =>
			findLinkedImage(environment, ISLAND_KIND, graph, new Set(targets)) === undefined,
	);
	if (options.worker !== undefined && missing.length > 1) {
		options.phases.workerMs += compileWithWorkers(
			environment.root,
			missing.map(({ targets }) => ({
				schema: 2,
				targets,
				config: options.config,
				execution: options.execution,
				stripperIdentity: options.stripperIdentity,
				...(options.cacheDirectory === undefined
					? {}
					: { cacheDirectory: options.cacheDirectory }),
			})),
			options.worker,
		);
	}
	const compiledByWorkers = new Set(
		options.worker !== undefined && missing.length > 1 ? missing : [],
	);
	return islands.map((island) => {
		const artifact = compileLinkedImage(
			environment,
			ISLAND_KIND,
			island.graph,
			new Set(island.targets),
		);
		return {
			get wire() {
				return artifact.wire;
			},
			get programImage() {
				return artifact.programImage;
			},
			runtimeArtifact: artifact.runtimeArtifact,
			compilerArtifact: artifact.compilerArtifact,
			diagnostics: artifact.diagnostics,
			interfaces: artifact.interfaces,
			// The workers' compilations are this build's misses even though the
			// coordinator reads them back from the cache.
			cache: compiledByWorkers.has(island) ? "miss" : artifact.cache,
			targets: island.targets,
		};
	});
}
