import { readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import type {
	BuildModuleGraphOptions,
	ExternalModuleInterface,
	ModuleGraph,
} from "./compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "./compiler/shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";
import {
	chunkMatchesPlan,
	earlierChunkInterfaces,
	planDependencyChunks,
	restoreDependencyChunkPlan,
	storeDependencyChunkPlan,
} from "./dependency-chunks.ts";
import type { DependencyChunk, DependencyChunkPlan } from "./dependency-chunks.ts";
import { frontendDigest } from "./frontend-cache.ts";
import { FrontendCompilationSession } from "./frontend-cache.ts";
import {
	compiledByWorker,
	compileLinkedImage,
	findLinkedImage,
	linkedImageEnvironment,
	linkedImageIdentity,
	packageRootModule,
	packageRootSource,
	UnsupportedLinkedImagesError,
} from "./linked-images.ts";
import type {
	LinkedImageArtifact,
	LinkedImageEnvironment,
	LinkedImageTarget,
} from "./linked-images.ts";
import { nativeBuildJobs, runIndependentCommands } from "./native-command.ts";
import type { Execution } from "./platform/execution.ts";

const DEPENDENCY_FRAGMENT_FAMILY = "dependency-fragments";
const ISLAND_KIND = "dependency-island";
const CHUNK_KIND = "dependency-chunk";
const PACKAGE_ROOT_KIND = "package-root";
const CHUNK_PLAN_SCHEMA = 1;

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
	/** The island targets this image publishes; none for a package root. */
	readonly targets: ReadonlyArray<string>;
}

export interface CompileDependencyFragmentsOptions {
	target: LinkedImageTarget;
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
	/** Hidden CLI tasks for other missing images, run beside the islands' workers. */
	parallelTasks?: ReadonlyArray<ReadonlyArray<string>>;
}

interface DependencyFragmentRequest {
	schema: 4;
	target: LinkedImageTarget;
	targets: Array<string>;
	config: ResolvedBuildConfig;
	execution?: Execution;
	stripperIdentity: string;
	cacheDirectory?: string;
	/** Present when the request compiles one chunk of the island of `targets`. */
	chunk?: SerializedChunk;
}

interface SerializedChunk {
	/** The island's package root, which a chunk's own modules may not determine. */
	packageRoot: string | null;
	members: Array<string>;
	imports: Array<string>;
	requiredRoots: Array<string>;
	external: Array<[string, ExternalModuleInterface]>;
}

/** One image to compile: a whole island, or one chunk of a split island. */
interface DependencyUnit {
	kind: typeof ISLAND_KIND | typeof CHUNK_KIND;
	graph: ModuleGraph;
	exports: "all" | ReadonlySet<string>;
	packageRoot: string | undefined;
	/** The island targets the unit's image publishes. */
	targets: Array<string>;
	islandTargets: Array<string>;
	chunk?: SerializedChunk;
	plan?: DependencyChunkPlan;
}

export function isExternalModule(file: string): boolean {
	return file.split(path.sep).includes("node_modules");
}

function islandEnvironment(
	options: Pick<
		CompileDependencyFragmentsOptions,
		| "target"
		| "config"
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
		target: options.target,
		config: options.config,
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

/**
 * An island image evaluates its roots and publishes them to the images after it.
 * Its entry names the roots relative to itself, so the same packages at another
 * location produce the same entry.
 */
function islandGraph(
	targets: ReadonlyArray<string>,
	options: Pick<
		CompileDependencyFragmentsOptions,
		"config" | "execution" | "stripTypes" | "session"
	>,
): ModuleGraph {
	const directory = path.dirname(targets[0]!);
	const specifiers = targets.map((target) => {
		const relative = path.relative(directory, target).split(path.sep).join("/");
		return relative.startsWith("../") ? relative : `./${relative}`;
	});
	const entry = path.join(
		directory,
		`.maligator-dependency-island-${frontendDigest(JSON.stringify(specifiers)).slice(0, 24)}.mts`,
	);
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: specifiers
			.map((specifier) => `import ${JSON.stringify(specifier)};\n`)
			.join(""),
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		execution: options.execution,
		parseCache: options.session.moduleParses,
	});
}

/**
 * The `node_modules` directory holding every module of an interpreted island. The
 * island then compiles against that root, so the same packages installed at another
 * location reuse its image.
 */
function islandPackageRoot(
	target: LinkedImageTarget,
	graph: ModuleGraph,
): string | undefined {
	if (target !== "runtime") return undefined;
	let root: string | undefined;
	for (const record of graph.modules.values()) {
		if (record.host !== undefined) continue;
		const segments = record.path.split(path.sep);
		const index = segments.indexOf("node_modules");
		if (index < 0) return undefined;
		const directory = segments.slice(0, index + 1).join(path.sep);
		if (root !== undefined && root !== directory) return undefined;
		root = directory;
	}
	return root;
}

function packageRootGraph(
	directory: string,
	options: Pick<
		CompileDependencyFragmentsOptions,
		"config" | "execution" | "stripTypes" | "session"
	>,
): ModuleGraph {
	return buildModuleGraph(packageRootModule(directory), {
		entryGoal: "module",
		entrySource: packageRootSource(directory),
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		execution: options.execution,
		parseCache: options.session.moduleParses,
	});
}

/**
 * A chunk's graph: its entry imports the members it evaluates, its other CommonJS
 * members join as required roots, and earlier chunks' members are external.
 */
function chunkGraph(
	chunk: DependencyChunk,
	external: ReadonlyMap<string, ExternalModuleInterface>,
	options: Pick<
		CompileDependencyFragmentsOptions,
		"config" | "execution" | "stripTypes" | "session"
	>,
): ModuleGraph {
	const members = chunk.members;
	const directory = path.dirname(members[0]!);
	const relative = (module: string) => {
		const specifier = path.relative(directory, module).split(path.sep).join("/");
		return specifier.startsWith("../") ? specifier : `./${specifier}`;
	};
	const specifiers = chunk.imports.map(relative);
	const entry = path.join(
		directory,
		`.maligator-dependency-chunk-${frontendDigest(JSON.stringify([specifiers, chunk.requiredRoots.map(relative)])).slice(0, 24)}.mts`,
	);
	const graph = buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: specifiers
			.map((specifier) => `import ${JSON.stringify(specifier)};\n`)
			.join(""),
		requiredRoots: chunk.requiredRoots,
		externalModules: external,
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		execution: options.execution,
		parseCache: options.session.moduleParses,
	});
	const memberSet = new Set(members);
	const own = [...graph.modules.values()].filter(
		(record) =>
			record.path !== entry && record.host === undefined && record.external === undefined,
	);
	if (
		own.length !== memberSet.size ||
		!own.every((record) => memberSet.has(record.path))
	) {
		throw new UnsupportedLinkedImagesError(
			"a dependency chunk reached modules outside its plan",
		);
	}
	return graph;
}

interface Island {
	targets: Array<string>;
	graph: ModuleGraph;
	packageRoot: string | undefined;
}

function chunkPlanFile(environment: LinkedImageEnvironment, island: Island): string {
	return path.join(
		environment.root,
		"chunk-plans",
		`${linkedImageIdentity(environment, ISLAND_KIND, island.graph, new Set(island.targets), island.packageRoot)}.json`,
	);
}

/** Record the island's plan; none keeps it whole until its identity changes. */
function storeChunkPlan(
	environment: LinkedImageEnvironment,
	island: Island,
	plan: DependencyChunkPlan | undefined,
): void {
	writeFileAtomically(
		chunkPlanFile(environment, island),
		`${JSON.stringify({
			schema: CHUNK_PLAN_SCHEMA,
			plan:
				plan === undefined ? null : storeDependencyChunkPlan(plan, island.packageRoot),
		})}\n`,
	);
}

/** The island's chunk plan, derived once per island identity. */
function islandChunkPlan(
	environment: LinkedImageEnvironment,
	island: Island,
	phases: DependencyFragmentPhases,
): DependencyChunkPlan | undefined {
	try {
		const stored = JSON.parse(
			readFileSync(chunkPlanFile(environment, island), "utf-8"),
		) as {
			schema?: number;
			plan?: Parameters<typeof restoreDependencyChunkPlan>[0] | null;
		};
		if (stored.schema === CHUNK_PLAN_SCHEMA && stored.plan !== undefined) {
			return stored.plan === null
				? undefined
				: restoreDependencyChunkPlan(stored.plan, island.packageRoot);
		}
	} catch {
		// A missing or damaged plan is derived again.
	}
	const startedAt = Date.now();
	const plan = planDependencyChunks(island.graph, new Set(island.targets));
	phases.semanticMs += Date.now() - startedAt;
	storeChunkPlan(environment, island, plan);
	return plan;
}

function compileWithWorkers(
	root: string,
	requests: Array<DependencyFragmentRequest>,
	worker: DependencyFragmentWorker,
	tasks: ReadonlyArray<ReadonlyArray<string>>,
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
	for (const task of tasks)
		commands.push({ tool: worker.tool, args: [...worker.args, ...task] });
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
		request?.schema !== 4 ||
		!Array.isArray(request.targets) ||
		request.targets.length === 0
	) {
		throw new Error("invalid dependency fragment worker request");
	}
	const session = new FrontendCompilationSession();
	session.useCacheDirectory(request.cacheDirectory);
	const environment = islandEnvironment({
		target: request.target,
		config: request.config,
		facts: compilerProgramFactsFromConfig(request.config),
		stripperIdentity: request.stripperIdentity,
		cacheDirectory: request.cacheDirectory,
		phases: { graphMs: 0, semanticMs: 0, compileMs: 0, serializeMs: 0, workerMs: 0 },
	});
	const graphOptions = {
		config: request.config,
		execution: request.execution,
		stripTypes,
		session,
	};
	if (request.chunk === undefined) {
		const graph = islandGraph(request.targets, graphOptions);
		compileLinkedImage(
			environment,
			ISLAND_KIND,
			graph,
			new Set(request.targets),
			islandPackageRoot(request.target, graph),
		);
	} else {
		const graph = chunkGraph(
			request.chunk,
			new Map(request.chunk.external),
			graphOptions,
		);
		compileLinkedImage(
			environment,
			CHUNK_KIND,
			graph,
			new Set(request.chunk.members),
			request.chunk.packageRoot ?? undefined,
		);
	}
	session.flush();
}

/** Compile independently reusable, module-singleton-safe dependency images. */
export function compileDependencyFragments(
	options: CompileDependencyFragmentsOptions,
): Array<DependencyFragmentArtifact> {
	const environment = islandEnvironment(options);
	const graphStartedAt = Date.now();
	const islands = dependencyIslands(options.graph, options.targets).map(
		({ targets }): Island => {
			const graph = islandGraph(targets, options);
			return { targets, graph, packageRoot: islandPackageRoot(options.target, graph) };
		},
	);
	const islandUnit = (island: Island): DependencyUnit => ({
		kind: ISLAND_KIND,
		graph: island.graph,
		exports: new Set(island.targets),
		packageRoot: island.packageRoot,
		targets: island.targets,
		islandTargets: island.targets,
	});
	// Chunks only pay off when workers compile them side by side.
	const chunking = options.target === "runtime" && options.worker !== undefined;
	const islandUnits = islands.map((island): Array<DependencyUnit> => {
		const plan = chunking
			? islandChunkPlan(environment, island, options.phases)
			: undefined;
		if (plan === undefined) return [islandUnit(island)];
		try {
			return plan.chunks.map((chunk, index) => {
				const external = earlierChunkInterfaces(plan, index);
				const members = new Set(chunk.members);
				return {
					kind: CHUNK_KIND,
					graph: chunkGraph(chunk, external, options),
					exports: members,
					packageRoot: island.packageRoot,
					targets: island.targets.filter((target) => members.has(target)),
					islandTargets: island.targets,
					chunk: {
						packageRoot: island.packageRoot ?? null,
						members: [...chunk.members],
						imports: [...chunk.imports],
						requiredRoots: [...chunk.requiredRoots],
						external: [...external],
					},
					plan,
				};
			});
		} catch (error) {
			if (!(error instanceof UnsupportedLinkedImagesError)) throw error;
			storeChunkPlan(environment, island, undefined);
			return [islandUnit(island)];
		}
	});
	options.phases.graphMs += Date.now() - graphStartedAt;
	const units = islandUnits.flat();
	const missing = units.filter(
		(unit) =>
			findLinkedImage(
				environment,
				unit.kind,
				unit.graph,
				unit.exports,
				unit.packageRoot,
			) === undefined,
	);
	const tasks = options.parallelTasks ?? [];
	const worker = missing.length + tasks.length > 1 ? options.worker : undefined;
	if (worker !== undefined) {
		options.phases.workerMs += compileWithWorkers(
			environment.root,
			missing.map((unit) => ({
				schema: 4,
				target: options.target,
				targets: unit.islandTargets,
				config: options.config,
				execution: options.execution,
				stripperIdentity: options.stripperIdentity,
				...(options.cacheDirectory === undefined
					? {}
					: { cacheDirectory: options.cacheDirectory }),
				...(unit.chunk === undefined ? {} : { chunk: unit.chunk }),
			})),
			worker,
			tasks,
		);
	}
	const compiledByWorkers = new Set(worker === undefined ? [] : missing);
	const compile = (unit: DependencyUnit): DependencyFragmentArtifact => {
		const artifact = compileLinkedImage(
			environment,
			unit.kind,
			unit.graph,
			unit.exports,
			unit.packageRoot,
		);
		return Object.assign(
			compiledByWorkers.has(unit) ? compiledByWorker(artifact) : artifact,
			{ targets: unit.targets },
		);
	};
	const packageRoots = [
		...new Set(islands.flatMap(({ packageRoot }) => packageRoot ?? [])),
	].sort();
	return [
		...packageRoots.map((directory) => {
			const graphStartedAt = Date.now();
			const graph = packageRootGraph(directory, options);
			options.phases.graphMs += Date.now() - graphStartedAt;
			return Object.assign(
				compileLinkedImage(environment, PACKAGE_ROOT_KIND, graph, "all"),
				{ targets: [] },
			);
		}),
		...islandUnits.flatMap((unitsOfIsland, index) => {
			const artifacts = unitsOfIsland.map(compile);
			// Later chunks compiled against the plan, so a chunk publishing anything else
			// cannot link to them; the island is then compiled whole.
			const planned = unitsOfIsland.every(
				(unit, unitIndex) =>
					unit.plan === undefined ||
					chunkMatchesPlan(unit.plan, artifacts[unitIndex]!.interfaces),
			);
			if (planned) return artifacts;
			storeChunkPlan(environment, islands[index]!, undefined);
			return [compile(islandUnit(islands[index]!))];
		}),
	];
}
