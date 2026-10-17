import type { ResolvedBuildConfig } from "./build-config.ts";
import type { BuildFrontendPhases } from "./build-frontend-cache.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
} from "./compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import { compareCompilerDiagnostics } from "./compiler/shared/compiler-diagnostics.ts";
import type { CompilerDiagnostic } from "./compiler/shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
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
	UnsupportedLinkedImagesError,
} from "./linked-images.ts";
import type { LinkedImageArtifact } from "./linked-images.ts";
import type { Execution } from "./platform/execution.ts";

const BUILD_FRAGMENT_FAMILY = "build-fragments";

export interface CompiledBuildFragments {
	wires: Array<Uint8Array>;
	runtimeArtifacts: Array<FrontendArtifactIdentity>;
	/** Each image's compiler artifact, parallel to `runtimeArtifacts`. */
	fragmentCompilerArtifacts: Array<FrontendArtifactIdentity>;
	compilerArtifact: FrontendArtifactIdentity;
	programImage: ProgramImage;
	diagnostics: Array<CompilerDiagnostic>;
	artifactHits: number;
	artifactMisses: number;
}

export interface CompileBuildFragmentsOptions {
	graph: ModuleGraph;
	entryPrelude?: BuildModuleGraphOptions["entryPrelude"];
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

/**
 * The toolchain prelude's own subgraph. The development runner evaluates images
 * in order, so a separately cached prelude keeps its before-application contract
 * without re-running semantic analysis and Core optimization after every edit.
 */
export function preludeGraph(
	graph: ModuleGraph,
	specifier: string,
	execution: Execution | undefined,
): ModuleGraph {
	const reachable = new Set<string>();
	const pending = [specifier];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (reachable.has(current)) continue;
		const record = graph.modules.get(current);
		if (record === undefined) {
			throw new UnsupportedLinkedImagesError(
				`toolchain prelude module '${current}' is missing from the graph`,
			);
		}
		if (current !== specifier && record.host === undefined) {
			throw new UnsupportedLinkedImagesError(
				"a toolchain prelude with source dependencies requires the whole-image fallback",
			);
		}
		reachable.add(current);
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath === null) {
				throw new UnsupportedLinkedImagesError(
					"a toolchain prelude with a computed dependency requires the whole-image fallback",
				);
			}
			pending.push(dependency.resolvedPath);
		}
	}
	for (const cycle of graph.cycles) {
		if (
			cycle.some((module) => reachable.has(module)) &&
			cycle.some((module) => !reachable.has(module))
		) {
			throw new UnsupportedLinkedImagesError(
				"a toolchain prelude cycle requires the whole-image fallback",
			);
		}
	}
	return {
		entry: specifier,
		nodeEnabled: graph.nodeEnabled,
		execution,
		modules: new Map([...graph.modules].filter(([module]) => reachable.has(module))),
		evaluationOrder: graph.evaluationOrder.filter((module) => reachable.has(module)),
		cycles: graph.cycles.filter((cycle) =>
			cycle.every((module) => reachable.has(module)),
		),
	};
}

/** Split stable dependencies from project code into independently cached VM images. */
export function compileBuildFragments(
	options: CompileBuildFragmentsOptions,
): CompiledBuildFragments {
	assertDependenciesPrecedeImporters(options.graph);
	assertStaticImageBoundary(options.graph, (modulePath) => !isExternalModule(modulePath));
	const targets = dependencyTargets(options.graph);
	if (targets.length === 0) {
		throw new UnsupportedLinkedImagesError("the graph has no dependency boundary");
	}
	const environment = linkedImageEnvironment({
		producer: "build-fragment",
		family: BUILD_FRAGMENT_FAMILY,
		config: options.config,
		facts: options.facts,
		stripperIdentity: options.stripperIdentity,
		cacheDirectory: options.cacheDirectory,
		phases: options.phases,
		onCompilePhase: options.onCompilePhase,
		inputs:
			options.entryPrelude === undefined
				? undefined
				: {
						specifier: options.entryPrelude.specifier,
						source: digest(options.entryPrelude.source),
					},
	});
	const dependencyArtifacts = compileDependencyFragments({
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
	});
	const preludeArtifact =
		options.entryPrelude === undefined
			? undefined
			: compileLinkedImage(
					environment,
					"toolchain-prelude",
					preludeGraph(options.graph, options.entryPrelude.specifier, options.execution),
					undefined,
				);
	const graphStartedAt = Date.now();
	const application = buildModuleGraph(options.graph.entry, {
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		execution: options.execution,
		parseCache: options.session.moduleParses,
		externalModules: externalModulesOf(dependencyArtifacts),
	});
	options.phases.graphMs += Date.now() - graphStartedAt;
	const applicationArtifact = compileLinkedImage(
		environment,
		"application",
		application,
		undefined,
	);
	const images: Array<LinkedImageArtifact> = [
		...(preludeArtifact === undefined ? [] : [preludeArtifact]),
		...dependencyArtifacts,
		applicationArtifact,
	];
	const hits = images.filter((artifact) => artifact.cache === "hit").length;
	return {
		get wires() {
			return images.map((artifact) => artifact.wire);
		},
		runtimeArtifacts: images.map((artifact) => artifact.runtimeArtifact),
		fragmentCompilerArtifacts: images.map((artifact) => artifact.compilerArtifact),
		compilerArtifact: applicationArtifact.compilerArtifact,
		get programImage() {
			return applicationArtifact.programImage;
		},
		diagnostics: images
			.flatMap((artifact) => artifact.diagnostics)
			.sort(compareCompilerDiagnostics),
		artifactHits: hits,
		artifactMisses: images.length - hits,
	};
}
