import * as path from "node:path";
import type { ResolvedBuildConfig } from "./build-config.ts";
import type { BuildFrontendPhases } from "./build-frontend-cache.ts";
import {
	ESTREE_SKIP,
	ESTREE_STOP,
	traverseEstree,
} from "./compiler/frontend/estree-traversal.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
	ModuleRecord,
} from "./compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import { compareCompilerDiagnostics } from "./compiler/shared/compiler-diagnostics.ts";
import type { CompilerDiagnostic } from "./compiler/shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";
import type { ProgramImage, ProgramImageStats } from "./compiler/target/program-image.ts";
import {
	compileDependencyFragments,
	isExternalModule,
} from "./dependency-fragment-cache.ts";
import type { DependencyFragmentWorker } from "./dependency-fragment-cache.ts";
import { frontendDigest as digest } from "./frontend-cache.ts";
import type {
	FrontendArtifactIdentity,
	FrontendCompilationSession,
} from "./frontend-cache.ts";
import {
	assertStaticImageBoundary,
	compileLinkedImage,
	externalModulesOf,
	linkedImageEnvironment,
	moduleImageComponents,
	UnsupportedLinkedImagesError,
} from "./linked-images.ts";
import type {
	LinkedImageArtifact,
	LinkedImageTarget,
	LinkedNativeImage,
} from "./linked-images.ts";
import type { Execution } from "./platform/execution.ts";

const BUILD_FRAGMENT_FAMILY = "build-fragments";

export interface CompiledBuildFragments {
	wires: Array<Uint8Array>;
	runtimeArtifacts: Array<FrontendArtifactIdentity>;
	/** The application images' combined statistics. */
	imageStats: ProgramImageStats;
	/** Present for the `native` target. */
	native?: {
		/** Each image's compiler artifact, parallel to `runtimeArtifacts`. */
		fragmentCompilerArtifacts: Array<FrontendArtifactIdentity>;
		compilerArtifact: FrontendArtifactIdentity;
		programImage: ProgramImage;
	};
	diagnostics: Array<CompilerDiagnostic>;
	artifactHits: number;
	artifactMisses: number;
}

export interface CompileBuildFragmentsOptions {
	target: LinkedImageTarget;
	graph: ModuleGraph;
	config: ResolvedBuildConfig;
	execution?: Execution;
	facts: CompilerProgramFacts;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	cacheDirectory?: string;
	session: FrontendCompilationSession;
	phases: BuildFrontendPhases;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
	dependencyWorker?: DependencyFragmentWorker;
}

/** Dependency modules imported from outside `node_modules`: the roots of their islands. */
export function dependencyTargets(graph: ModuleGraph): Array<string> {
	const targets = new Set<string>();
	for (const record of graph.modules.values()) {
		if (record.host || record.external || isExternalModule(record.path)) continue;
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath !== null && isExternalModule(dependency.resolvedPath))
				targets.add(dependency.resolvedPath);
		}
	}
	return [...targets].sort();
}

/** Dependency images evaluate before the modules that import them, so they may not import those back. */
export function assertDependenciesPrecedeImporters(graph: ModuleGraph): void {
	for (const record of graph.modules.values()) {
		if (!isExternalModule(record.path) || record.external !== undefined) continue;
		if (
			record.dependencies.some(
				(dependency) =>
					dependency.resolvedPath !== null &&
					!isExternalModule(dependency.resolvedPath) &&
					!graph.modules.get(dependency.resolvedPath)?.host,
			)
		) {
			throw new UnsupportedLinkedImagesError(
				"an application/dependency cycle requires the whole-image fallback",
			);
		}
	}
}

function nativeImage(artifact: LinkedImageArtifact): LinkedNativeImage {
	if (artifact.native === undefined)
		throw new Error(
			"a native development build linked an image compiled for the runtime",
		);
	return artifact.native;
}

/** Whether evaluating the module can suspend, which lets later sibling modules start first. */
function hasTopLevelAwait(record: ModuleRecord): boolean {
	if (record.goal !== "module" || record.external !== undefined) return false;
	return (
		traverseEstree(record.parsed.ast.body, (node) => {
			if (node.type === "AwaitExpression") return ESTREE_STOP;
			if (node.type === "ForOfStatement" && node.await) return ESTREE_STOP;
			if (node.type === "VariableDeclaration" && node.kind === "await using")
				return ESTREE_STOP;
			if (
				node.type === "FunctionDeclaration" ||
				node.type === "FunctionExpression" ||
				node.type === "ArrowFunctionExpression"
			)
				return ESTREE_SKIP;
		}) === ESTREE_STOP
	);
}

/**
 * Application images a program aims to stay within. Every image adds a fixed compile
 * and publication cost, so one image per module makes clean builds of large
 * applications several times slower, while an edit recompiles every module of its
 * image.
 */
const APPLICATION_IMAGES = 16;

interface ApplicationImageGroup {
	readonly modules: ReadonlyArray<string>;
	/**
	 * The last module of each component in the group. Importing them in turn
	 * evaluates the group in graph order: every other module is reached through one
	 * of them, after the modules of earlier images and roots.
	 */
	readonly roots: ReadonlyArray<string>;
}

/**
 * Project modules grouped into the images an interpreted program loads, in
 * evaluation order; the last group holds the entry. An edit recompiles only its own
 * group, and the groups that import it only when its exported names change.
 *
 * A group ends after a component whose root hashes to a boundary, so adding or
 * removing a module moves only the boundaries next to it. Each image settles before
 * the next one starts, while the whole graph starts a module's later siblings as
 * soon as it suspends, so everything from the first top-level await on shares one
 * image. Undefined when the modules must share one image; see
 * `moduleImageComponents`.
 */
function applicationImageGroups(
	graph: ModuleGraph,
): Array<ApplicationImageGroup> | undefined {
	const members = new Set(
		[...graph.modules.values()]
			.filter(
				(record) =>
					record.host === undefined &&
					record.external === undefined &&
					!isExternalModule(record.path),
			)
			.map((record) => record.path),
	);
	const components = moduleImageComponents(graph, members);
	if (components === undefined) return undefined;
	const suspends = components.findIndex((component) =>
		component.some((module) => hasTopLevelAwait(graph.modules.get(module)!)),
	);
	// A power of two changes only when the application doubles, and then keeps half
	// of the boundaries in place.
	const perImage =
		2 ** Math.ceil(Math.log2(Math.max(1, components.length / APPLICATION_IMAGES)));
	const groups: Array<ApplicationImageGroup> = [];
	let modules: Array<string> = [];
	let roots: Array<string> = [];
	for (const [index, component] of components.entries()) {
		const root = component.at(-1)!;
		modules.push(...component);
		roots.push(root);
		const splittable = suspends === -1 || index < suspends;
		const boundary =
			Number.parseInt(digest(root).slice(0, 8), 16) % perImage === 0 ||
			roots.length >= 2 * perImage;
		if (index === components.length - 1 || (splittable && boundary)) {
			groups.push({ modules, roots });
			modules = [];
			roots = [];
		}
	}
	return groups;
}

function combinedStats(images: ReadonlyArray<LinkedImageArtifact>): ProgramImageStats {
	let functionCount = 0;
	let instructionCount = 0;
	for (const image of images) {
		functionCount += image.stats.functionCount;
		instructionCount += image.stats.instructionCount;
	}
	return { functionCount, instructionCount };
}

/** Split stable dependencies from project code into independently cached VM images. */
export function compileBuildFragments(
	options: CompileBuildFragmentsOptions,
): CompiledBuildFragments {
	assertDependenciesPrecedeImporters(options.graph);
	assertStaticImageBoundary(options.graph, (modulePath) => !isExternalModule(modulePath));
	const targets = dependencyTargets(options.graph);
	// Native development builds give every image its own overlay translation units,
	// so they keep one application image until per-module units pay off cold.
	const groups =
		options.target === "runtime" ? applicationImageGroups(options.graph) : undefined;
	if (targets.length === 0 && (groups === undefined || groups.length < 2)) {
		throw new UnsupportedLinkedImagesError("the graph has no image boundary");
	}
	const environment = linkedImageEnvironment({
		producer: "build-fragment",
		family: BUILD_FRAGMENT_FAMILY,
		target: options.target,
		config: options.config,
		facts: options.facts,
		stripperIdentity: options.stripperIdentity,
		cacheDirectory: options.cacheDirectory,
		phases: options.phases,
		onCompilePhase: options.onCompilePhase,
	});
	const dependencyArtifacts =
		targets.length === 0
			? []
			: compileDependencyFragments({
					target: options.target,
					graph: options.graph,
					targets,
					config: options.config,
					execution: options.execution,
					facts: options.facts,
					stripTypes: options.stripTypes,
					stripperIdentity: options.stripperIdentity,
					cacheDirectory: options.cacheDirectory,
					session: options.session,
					phases: options.phases,
					onCompilePhase: options.onCompilePhase,
					worker: options.dependencyWorker,
					reuseOnRebuild: options.target === "runtime",
				});
	const external = externalModulesOf(dependencyArtifacts);
	const applicationArtifacts: Array<LinkedImageArtifact> = [];
	const leadingGroups = groups?.slice(0, -1) ?? [];
	for (const group of leadingGroups) {
		const graphStartedAt = Date.now();
		const graph = buildModuleGraph(
			path.join(
				environment.root,
				"roots",
				`${digest(JSON.stringify(group.modules))}.mjs`,
			),
			{
				stripTypes: options.stripTypes,
				buildConfig: options.config,
				execution: options.execution,
				parseCache: options.session.moduleParses,
				entryGoal: "module",
				entrySource: group.roots
					.map((root) => `import ${JSON.stringify(root)};\n`)
					.join(""),
				externalModules: external,
			},
		);
		options.phases.graphMs += Date.now() - graphStartedAt;
		const artifact = compileLinkedImage(environment, "application", graph, "all");
		for (const [module, surface] of externalModulesOf([artifact])) {
			if (external.has(module))
				throw new Error(`module '${module}' is published by two images`);
			external.set(module, surface);
		}
		applicationArtifacts.push(artifact);
	}
	const graphStartedAt = Date.now();
	const entryGraph = buildModuleGraph(options.graph.entry, {
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		execution: options.execution,
		parseCache: options.session.moduleParses,
		externalModules: external,
	});
	options.phases.graphMs += Date.now() - graphStartedAt;
	const applicationArtifact = compileLinkedImage(
		environment,
		"application",
		entryGraph,
		undefined,
	);
	applicationArtifacts.push(applicationArtifact);
	const images: Array<LinkedImageArtifact> = [
		...dependencyArtifacts,
		...applicationArtifacts,
	];
	const hits = images.filter((artifact) => artifact.cache === "hit").length;
	return {
		get wires() {
			return images.map((artifact) => artifact.wire);
		},
		runtimeArtifacts: images.map((artifact) => artifact.runtimeArtifact),
		imageStats: combinedStats(applicationArtifacts),
		...(applicationArtifact.native === undefined
			? {}
			: {
					native: {
						fragmentCompilerArtifacts: images.map(
							(artifact) => nativeImage(artifact).compilerArtifact,
						),
						compilerArtifact: applicationArtifact.native.compilerArtifact,
						get programImage() {
							return nativeImage(applicationArtifact).programImage;
						},
					},
				}),
		diagnostics: images
			.flatMap((artifact) => artifact.diagnostics)
			.sort(compareCompilerDiagnostics),
		artifactHits: hits,
		artifactMisses: images.length - hits,
	};
}
