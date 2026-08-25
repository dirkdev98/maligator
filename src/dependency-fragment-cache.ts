import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import {
	compilerConfigurationIdentity,
	compilerProducerIdentity,
} from "./compiler-cache-identity.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
} from "./compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./compiler/frontend/semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "./compiler/pipeline/compile-core.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "./compiler/shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";
import { serializeRuntimeImage, WIRE_VERSION } from "./compiler/target/serialize-vm.ts";
import {
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendArtifactIdentity,
	frontendArtifactUnchanged,
	frontendDigest,
} from "./frontend-cache.ts";
import type { FrontendArtifactIdentity } from "./frontend-cache.ts";
import { FrontendCompilationSession } from "./frontend-cache.ts";
import { nativeBuildJobs, runIndependentCommands } from "./native-command.ts";

const DEPENDENCY_FRAGMENT_SCHEMA = 1;
const CACHE_DIRECTORY = path.join(maligatorCacheDirectory(), "dependency-fragments");

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
	workerMs: number;
}

export interface DependencyFragmentWorker {
	tool: string;
	args: Array<string>;
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
	facts: CompilerProgramFacts;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	cacheDirectory?: string;
	session: FrontendCompilationSession;
	phases: DependencyFragmentPhases;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
	worker?: DependencyFragmentWorker;
	/** Additional hidden CLI tasks that can overlap independent island misses. */
	parallelWorkerTasks?: Array<Array<string>>;
}

interface DependencyFragmentRequest {
	schema: 1;
	targets: Array<DependencyFragmentTarget>;
	config: ResolvedBuildConfig;
	stripperIdentity: string;
	cacheDirectory?: string;
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
			producer: compilerProducerIdentity(
				"dependency-fragment",
				DEPENDENCY_FRAGMENT_SCHEMA,
			),
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			optimization: "development",
			configuration: compilerConfigurationIdentity(options.config),
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
	targetsInput: Array<DependencyFragmentTarget>,
	options: Pick<CompileDependencyFragmentsOptions, "config" | "stripTypes" | "session">,
): ModuleGraph {
	const targets = [...targetsInput].sort((left, right) =>
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

function loadIsland(
	root: string,
	artifactRoot: string,
	identity: string,
	targets: Array<string>,
	graph: ModuleGraph,
): DependencyFragmentArtifact | undefined {
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
		return undefined;
	}
}

function compileIsland(
	root: string,
	artifactRoot: string,
	identity: string,
	targets: Array<string>,
	graph: ModuleGraph,
	options: CompileDependencyFragmentsOptions,
): DependencyFragmentArtifact {
	const cached = loadIsland(root, artifactRoot, identity, targets, graph);
	if (cached !== undefined) return cached;
	const key = graphKey(identity, targets, graph);
	const mappingPath = path.join(root, "artifacts", `${key}.json`);
	const semanticStartedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(graph);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	options.phases.semanticMs += Date.now() - semanticStartedAt;
	const definition = compileSemanticProgramToProgramImage(semantic, {
		facts: options.facts,
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
	const wire = serializeRuntimeImage(definition);
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

function requestPath(root: string, request: DependencyFragmentRequest): string {
	return path.join(root, "requests", `${frontendDigest(JSON.stringify(request))}.json`);
}

function compileWithWorkers(
	root: string,
	requests: Array<DependencyFragmentRequest>,
	worker: DependencyFragmentWorker,
	additionalTasks: Array<Array<string>>,
): number {
	const startedAt = Date.now();
	const commands = requests.map((request) => {
		const file = requestPath(root, request);
		publish(file, `${JSON.stringify(request)}\n`);
		return {
			tool: worker.tool,
			args: [...worker.args, "--maligator-internal-dependency-fragment", file],
		};
	});
	for (const task of additionalTasks) {
		commands.push({ tool: worker.tool, args: [...worker.args, ...task] });
	}
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
		request?.schema !== 1 ||
		!Array.isArray(request.targets) ||
		request.targets.length === 0
	) {
		throw new Error("invalid dependency fragment worker request");
	}
	const phases: DependencyFragmentPhases = {
		graphMs: 0,
		semanticMs: 0,
		compileMs: 0,
		serializeMs: 0,
		workerMs: 0,
	};
	const session = new FrontendCompilationSession();
	session.useCacheDirectory(request.cacheDirectory);
	const graph = islandGraph(request.targets, {
		config: request.config,
		stripTypes,
		session,
	});
	const options: CompileDependencyFragmentsOptions = {
		graph,
		targets: request.targets,
		config: request.config,
		facts: compilerProgramFactsFromConfig(request.config),
		stripTypes,
		stripperIdentity: request.stripperIdentity,
		cacheDirectory: request.cacheDirectory,
		session,
		phases,
	};
	compileIsland(
		cacheRoot(request.cacheDirectory),
		frontendArtifactCacheRoot(request.cacheDirectory),
		environmentIdentity(options),
		request.targets.map(({ target }) => target).sort(),
		graph,
		options,
	);
	session.flush();
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
		plans: island.targets,
		targets: island.targets.map(({ target }) => target).sort(),
		graph: islandGraph(island.targets, options),
	}));
	options.phases.graphMs += Date.now() - graphStartedAt;
	const missing = graphs.filter(
		({ targets, graph }) =>
			loadIsland(root, artifactRoot, identity, targets, graph) === undefined,
	);
	const workerCompiledKeys = new Set<string>();
	if (
		options.worker !== undefined &&
		(missing.length > 1 || (options.parallelWorkerTasks?.length ?? 0) > 0)
	) {
		const requests = missing.map(
			({ plans }): DependencyFragmentRequest => ({
				schema: 1,
				targets: plans,
				config: options.config,
				stripperIdentity: options.stripperIdentity,
				...(options.cacheDirectory === undefined
					? {}
					: { cacheDirectory: options.cacheDirectory }),
			}),
		);
		options.phases.workerMs += compileWithWorkers(
			root,
			requests,
			options.worker,
			options.parallelWorkerTasks ?? [],
		);
		for (const { targets, graph } of missing) {
			workerCompiledKeys.add(graphKey(identity, targets, graph));
		}
	}
	return graphs.map(({ targets, graph }) => {
		const artifact = compileIsland(root, artifactRoot, identity, targets, graph, options);
		if (workerCompiledKeys.has(artifact.key)) artifact.cache = "miss";
		return artifact;
	});
}
