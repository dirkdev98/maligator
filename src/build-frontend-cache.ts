import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import {
	compileBuildFragments,
	UnsupportedBuildFragmentsError,
} from "./build-fragment-cache.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import {
	compilerConfigurationIdentity,
	compilerProducerIdentity,
} from "./compiler-cache-identity.ts";
import type { CoreVerificationProfile } from "./compiler/core/core-ir-verifier.ts";
import type { CoreProgram } from "./compiler/core/core-ir.ts";
import { certifyProgramClosure } from "./compiler/frontend/certify-closure.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
} from "./compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import { collectPrimordialMutationDiagnostics } from "./compiler/frontend/primordial-diagnostics.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./compiler/frontend/semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToVmDefinition } from "./compiler/pipeline/compile-core.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import type {
	CompilerDiagnostic,
	OptimizationAblation,
} from "./compiler/shared/compiler-diagnostics.ts";
import {
	compilerProgramFactsFromConfig,
	unanalyzedProgramClosure,
	withProgramClosure,
} from "./compiler/shared/compiler-facts.ts";
import type {
	CompilerProgramFacts,
	ProgramClosureCertificate,
} from "./compiler/shared/compiler-facts.ts";
import type { VmDefinition } from "./compiler/target/lower-vm.ts";
import { vmDefinitionStats } from "./compiler/target/lower-vm.ts";
import type { VmDefinitionStats } from "./compiler/target/lower-vm.ts";
import {
	deserializeVmDefinition,
	serializeVmDefinition,
	WIRE_VERSION,
} from "./compiler/target/serialize-vm.ts";
import type { DependencyFragmentWorker } from "./dependency-fragment-cache.ts";
import {
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendDigest as digest,
	FrontendCompilationSession,
	frontendWirePath,
} from "./frontend-cache.ts";
import type { FrontendDependencyIdentity } from "./frontend-cache.ts";

const BUILD_FRONTEND_CACHE_SCHEMA = 1;
const BUILD_FRONTEND_PIPELINE_VERSION = 1;
const BUILD_FRONTEND_CACHE_DIRECTORY = path.join(
	maligatorCacheDirectory(),
	"build-frontend",
);
const NODE_GLOBALS_MODULE_ID = "maligator:node-globals";

export type BuildDependencyIdentity = FrontendDependencyIdentity;

interface BuildFrontendManifest {
	schema: 1;
	identity: string;
	contentKey: string;
	artifacts: Array<BuildFrontendArtifactIdentity>;
	definitionStats: VmDefinitionStats;
	entrypoint: string;
	dependencies: Array<BuildDependencyIdentity>;
	diagnostics: Array<CompilerDiagnostic>;
}

interface BuildFrontendArtifactIdentity {
	digest: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	dev: number;
}

export interface BuildFrontendArtifact {
	digest: string;
	path: string;
	size: number;
}

export interface BuildFrontendPhases {
	validationMs: number;
	graphMs: number;
	semanticMs: number;
	compileMs: number;
	serializeMs: number;
	workerMs: number;
}

export interface CompiledBuildFrontend {
	definition: VmDefinition;
	wire: Uint8Array;
	cache: "hit" | "miss";
	frontendMs: number;
	phases: BuildFrontendPhases;
	dependencies: Array<string>;
	moduleParses: { hits: number; misses: number };
	fileDigests: { hits: number; misses: number };
	artifacts: Array<BuildFrontendArtifact>;
	definitionStats: VmDefinitionStats;
	diagnostics: Array<CompilerDiagnostic>;
	/** Open on a cache hit: a restored definition is returned without a graph. */
	closure: ProgramClosureCertificate;
	wires?: Array<Uint8Array>;
	fragmentArtifacts?: { hits: number; misses: number };
	fragmentFallback?: string;
}

export interface CompileBuildFrontendOptions {
	entrypoint: string;
	config: ResolvedBuildConfig;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	/** Node compatibility globals evaluated before a Node-surface application. */
	nodeGlobalsSource?: string;
	optimization?: "development" | "full";
	optimizationAblations?: ReadonlySet<OptimizationAblation>;
	/**
	 * Core verification depth. Not part of cache identity: verification observes
	 * the compilation without changing the artifact it produces.
	 */
	coreVerification?: CoreVerificationProfile;
	/** Include source-site identities and compiler remarks in the live definition. */
	profile?: boolean;
	cacheDirectory?: string;
	session?: FrontendCompilationSession;
	/** Apply build-time eval/RegExp policy checks. Defaults to true. */
	enforcePolicies?: boolean;
	/**
	 * Recompile even if the content-addressed artifact is valid. Used by
	 * compiler diagnostics that need the live semantic/IR objects.
	 */
	forceCompile?: boolean;
	/** Split stable package dependencies into a separately cached development image. */
	relocatable?: boolean;
	afterCoreOptimization?: (program: CoreProgram) => void;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
	/** Optional self-hosted worker command for independent dependency islands. */
	dependencyWorker?: DependencyFragmentWorker;
}

/**
 * Coherent filesystem snapshot retained by future build/watch coordinators.
 *
 * A watcher invalidates the changed path; unchanged dependency digests are then
 * reused without coupling filesystem observation to compilation scheduling.
 */
export class BuildCompilationSession extends FrontendCompilationSession {}

function cacheRoot(override: string | undefined): string {
	return path.resolve(override ?? BUILD_FRONTEND_CACHE_DIRECTORY);
}

function cacheIdentity(options: CompileBuildFrontendOptions): string {
	const nodeGlobalsSource = options.config.surface.node
		? options.nodeGlobalsSource
		: undefined;
	return digest(
		JSON.stringify({
			schema: BUILD_FRONTEND_CACHE_SCHEMA,
			producer: compilerProducerIdentity(
				"build-frontend",
				BUILD_FRONTEND_PIPELINE_VERSION,
			),
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			nodeGlobals:
				nodeGlobalsSource === undefined ? undefined : digest(nodeGlobalsSource),
			optimization: options.optimization ?? "full",
			optimizationAblations: [...(options.optimizationAblations ?? [])].sort(),
			relocatable: options.relocatable === true,
			enforcePolicies: options.enforcePolicies !== false,
			configuration: compilerConfigurationIdentity(options.config),
		}),
	);
}

function manifestPath(root: string, entrypoint: string, identity: string): string {
	return path.join(root, "entries", digest(entrypoint), `${identity}.json`);
}

function readManifest(file: string): BuildFrontendManifest | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as BuildFrontendManifest;
	} catch {
		return undefined;
	}
}

function dependenciesUnchanged(
	dependencies: Array<BuildDependencyIdentity>,
	session: FrontendCompilationSession,
): boolean {
	return dependencies.every((dependency) => {
		try {
			const current = session.snapshot(dependency.path);
			return (
				current.size === dependency.size &&
				current.mtimeMs === dependency.mtimeMs &&
				current.digest === dependency.digest
			);
		} catch {
			return false;
		}
	});
}

function artifactIdentity(
	digest: string,
	artifactRoot: string,
): BuildFrontendArtifactIdentity | undefined {
	try {
		const stats = statSync(frontendWirePath(digest, artifactRoot));
		if (!stats.isFile()) return undefined;
		return {
			digest,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ctimeMs: stats.ctimeMs,
			ino: stats.ino,
			dev: stats.dev,
		};
	} catch {
		return undefined;
	}
}

function artifactsUnchanged(
	artifacts: Array<BuildFrontendArtifactIdentity>,
	artifactRoot: string,
): boolean {
	return artifacts.every((artifact) => {
		const current = artifactIdentity(artifact.digest, artifactRoot);
		return (
			current !== undefined &&
			current.size === artifact.size &&
			current.mtimeMs === artifact.mtimeMs &&
			current.ctimeMs === artifact.ctimeMs &&
			current.ino === artifact.ino &&
			current.dev === artifact.dev
		);
	});
}

function validArtifactIdentity(value: unknown): value is BuildFrontendArtifactIdentity {
	if (typeof value !== "object" || value === null) return false;
	const artifact = value as Partial<BuildFrontendArtifactIdentity>;
	return (
		typeof artifact.digest === "string" &&
		/^[0-9a-f]{64}$/.test(artifact.digest) &&
		[artifact.size, artifact.mtimeMs, artifact.ctimeMs, artifact.ino, artifact.dev].every(
			(field) => typeof field === "number" && Number.isFinite(field),
		)
	);
}

function validDefinitionStats(value: unknown): value is VmDefinitionStats {
	if (typeof value !== "object" || value === null) return false;
	const stats = value as Partial<VmDefinitionStats>;
	return (
		Number.isSafeInteger(stats.functionCount) &&
		stats.functionCount! >= 0 &&
		Number.isSafeInteger(stats.instructionCount) &&
		stats.instructionCount! >= 0
	);
}

function materializedArtifacts(
	artifacts: Array<BuildFrontendArtifactIdentity>,
	artifactRoot: string,
): Array<Uint8Array> {
	return artifacts.map((artifact) => {
		const wire = new Uint8Array(
			readFileSync(frontendWirePath(artifact.digest, artifactRoot)),
		);
		if (digest(wire) !== artifact.digest) {
			throw new Error(`frontend artifact digest mismatch: ${artifact.digest}`);
		}
		return wire;
	});
}

function loadCached(
	root: string,
	artifactRoot: string,
	entrypoint: string,
	identity: string,
	session: FrontendCompilationSession,
):
	| {
			definition: VmDefinition;
			wire: Uint8Array;
			wires: Array<Uint8Array>;
			artifacts: Array<BuildFrontendArtifact>;
			definitionStats: VmDefinitionStats;
			dependencies: Array<BuildDependencyIdentity>;
			diagnostics: Array<CompilerDiagnostic>;
	  }
	| undefined {
	const manifest = readManifest(manifestPath(root, entrypoint, identity));
	if (
		manifest?.schema !== BUILD_FRONTEND_CACHE_SCHEMA ||
		manifest.entrypoint !== entrypoint ||
		manifest.identity !== identity ||
		!Array.isArray(manifest.artifacts) ||
		manifest.artifacts.length === 0 ||
		!manifest.artifacts.every(validArtifactIdentity) ||
		!validDefinitionStats(manifest.definitionStats) ||
		!Array.isArray(manifest.diagnostics) ||
		!Array.isArray(manifest.dependencies) ||
		!artifactsUnchanged(manifest.artifacts, artifactRoot) ||
		!dependenciesUnchanged(manifest.dependencies, session)
	) {
		return undefined;
	}
	try {
		let wires: Array<Uint8Array> | undefined;
		let definition: VmDefinition | undefined;
		const loadWires = () =>
			(wires ??= materializedArtifacts(manifest.artifacts, artifactRoot));
		const loadDefinition = () =>
			(definition ??= deserializeVmDefinition(loadWires().at(-1)!));
		return {
			get definition() {
				return loadDefinition();
			},
			get wire() {
				return loadWires().at(-1)!;
			},
			get wires() {
				return loadWires();
			},
			artifacts: manifest.artifacts.map((artifact) => ({
				digest: artifact.digest,
				path: frontendWirePath(artifact.digest, artifactRoot),
				size: artifact.size,
			})),
			definitionStats: manifest.definitionStats,
			dependencies: manifest.dependencies,
			diagnostics: manifest.diagnostics,
		};
	} catch {
		return undefined;
	}
}

function packageResolutionInputs(graph: ModuleGraph): Array<string> {
	const inputs = new Set<string>();
	for (const record of graph.modules.values()) {
		if (record.host || record.virtual) continue;
		let directory = path.dirname(record.path);
		for (;;) {
			const packagePath = path.join(directory, "package.json");
			if (existsSync(packagePath)) inputs.add(packagePath);
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	return [...inputs];
}

function graphDependencies(
	graph: ModuleGraph,
	session: FrontendCompilationSession,
): Array<BuildDependencyIdentity> {
	const dependencies = new Map<string, BuildDependencyIdentity>();
	for (const record of graph.modules.values()) {
		if (record.host || record.virtual) continue;
		const snapshot = session.snapshot(record.path, record.source);
		dependencies.set(snapshot.path, snapshot);
	}
	for (const packagePath of packageResolutionInputs(graph)) {
		const snapshot = session.snapshot(packagePath);
		dependencies.set(snapshot.path, snapshot);
	}
	return [...dependencies.values()].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
}

function contentKey(
	identity: string,
	entrypoint: string,
	dependencies: Array<BuildDependencyIdentity>,
): string {
	return digest(
		JSON.stringify({
			identity,
			entrypoint,
			dependencies: dependencies.map(({ path: file, digest: contentDigest }) => ({
				path: file,
				digest: contentDigest,
			})),
		}),
	);
}

function publish(file: string, contents: string | Uint8Array): void {
	const directory = path.dirname(file);
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	const temporaryPath = path.join(temporaryDirectory, path.basename(file));
	try {
		writeFileSync(temporaryPath, contents);
		renameSync(temporaryPath, file);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

/**
 * Compile or restore the normal-build frontend definition.
 *
 * The artifact is the same relocatable VM wire consumed by the interpreter, now
 * including native-code generation metadata. Cache hits therefore skip parsing,
 * graph construction, semantic analysis, Core optimization/allocation, and
 * lowering without changing the generated C contract.
 */
export function compileBuildFrontend(
	options: CompileBuildFrontendOptions,
): CompiledBuildFrontend {
	const startedAt = Date.now();
	const phases: BuildFrontendPhases = {
		validationMs: 0,
		graphMs: 0,
		semanticMs: 0,
		compileMs: 0,
		serializeMs: 0,
		workerMs: 0,
	};
	const entrypoint = path.resolve(options.entrypoint);
	const root = cacheRoot(options.cacheDirectory);
	const artifactRoot = frontendArtifactCacheRoot(options.cacheDirectory);
	const identity = cacheIdentity(options);
	const entryPrelude: BuildModuleGraphOptions["entryPrelude"] =
		options.config.surface.node && options.nodeGlobalsSource !== undefined
			? { specifier: NODE_GLOBALS_MODULE_ID, source: options.nodeGlobalsSource }
			: undefined;
	const session = options.session ?? new BuildCompilationSession();
	session.useCacheDirectory(options.cacheDirectory);
	const parseStatsBefore = session.moduleParses.statistics();
	const digestStatsBefore = session.digestStatistics();
	const moduleParseStats = () => {
		const current = session.moduleParses.statistics();
		return {
			hits: current.hits - parseStatsBefore.hits,
			misses: current.misses - parseStatsBefore.misses,
		};
	};
	const fileDigestStats = () => {
		const current = session.digestStatistics();
		return {
			hits: current.hits - digestStatsBefore.hits,
			misses: current.misses - digestStatsBefore.misses,
		};
	};

	if (!options.forceCompile) {
		const validationStartedAt = Date.now();
		const cached = loadCached(root, artifactRoot, entrypoint, identity, session);
		phases.validationMs = Date.now() - validationStartedAt;
		if (cached !== undefined) {
			session.flush();
			return {
				get definition() {
					return cached.definition;
				},
				get wire() {
					return cached.wire;
				},
				get wires() {
					return cached.artifacts.length > 1 ? cached.wires : undefined;
				},
				cache: "hit",
				closure: unanalyzedProgramClosure(
					"a frontend cache hit restores a definition without inspecting a module graph",
				),
				frontendMs: Date.now() - startedAt,
				phases,
				dependencies: cached.dependencies.map((dependency) => dependency.path),
				moduleParses: moduleParseStats(),
				fileDigests: fileDigestStats(),
				artifacts: cached.artifacts,
				definitionStats: cached.definitionStats,
				diagnostics: cached.diagnostics,
			};
		}
	}

	const graphStartedAt = Date.now();
	const graph = buildModuleGraph(entrypoint, {
		buildConfig: options.config,
		stripTypes: options.stripTypes,
		parseCache: session.moduleParses,
		entryPrelude,
	});
	phases.graphMs = Date.now() - graphStartedAt;
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(options.config),
		// A relocatable request selects the packaged development runner, which both
		// splices fragment islands and exposes `mal._runWire` to the program. It is
		// the request, not the fragment outcome, that decides: a fragment fallback
		// still compiles a whole image that the same runner can extend.
		certifyProgramClosure(graph, options.config, {
			relocatableArtifact: options.relocatable === true,
			hostWireSplicing: options.relocatable === true,
		}),
	);

	let sharedSemantic: ReturnType<typeof runSemanticAnalysisForGraph> | undefined;
	const semanticForGraph = () => {
		if (sharedSemantic !== undefined) return sharedSemantic;
		const semanticStartedAt = Date.now();
		sharedSemantic = runSemanticAnalysisForGraph(graph);
		phases.semanticMs += Date.now() - semanticStartedAt;
		return sharedSemantic;
	};
	const world = facts.world;
	const diagnostics =
		world.primordialPolicy === "locked"
			? collectPrimordialMutationDiagnostics(semanticForGraph(), world)
			: [];
	let definition: VmDefinition;
	let wires: Array<Uint8Array> | undefined;
	let fragmentArtifactIdentities: Array<BuildFrontendArtifactIdentity> | undefined;
	let loadFragmentWires: (() => Array<Uint8Array>) | undefined;
	let fragmentArtifacts: { hits: number; misses: number } | undefined;
	let fragmentFallback: string | undefined;
	if (
		options.relocatable === true &&
		options.forceCompile !== true &&
		options.optimization === "development" &&
		options.enforcePolicies !== false
	) {
		try {
			const fragments = compileBuildFragments({
				graph,
				config: options.config,
				facts,
				semantic: sharedSemantic,
				stripTypes: options.stripTypes,
				stripperIdentity: options.stripperIdentity,
				cacheDirectory: options.cacheDirectory,
				session,
				phases,
				onCompilePhase: options.onCompilePhase,
				dependencyWorker: options.dependencyWorker,
				entryPrelude,
			});
			definition = fragments.definition;
			fragmentArtifactIdentities = fragments.artifacts.map(
				({ digest: artifactDigest, size, mtimeMs, ctimeMs, ino, dev }) => ({
					digest: artifactDigest,
					size,
					mtimeMs,
					ctimeMs,
					ino,
					dev,
				}),
			);
			loadFragmentWires = () => fragments.wires;
			fragmentArtifacts = {
				hits: fragments.artifactHits,
				misses: fragments.artifactMisses,
			};
		} catch (error) {
			if (!(error instanceof UnsupportedBuildFragmentsError)) throw error;
			fragmentFallback = error.message;
			const semantic = semanticForGraph();
			assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
			assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
			definition = compileDefinition(semantic, facts, options, phases);
			const serializeStartedAt = Date.now();
			wires = [serializeVmDefinition(definition)];
			phases.serializeMs += Date.now() - serializeStartedAt;
		}
	} else {
		const semantic = semanticForGraph();
		if (options.enforcePolicies !== false) {
			assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
			assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
		}
		definition = compileDefinition(semantic, facts, options, phases);
		const serializeStartedAt = Date.now();
		wires = [serializeVmDefinition(definition)];
		phases.serializeMs = Date.now() - serializeStartedAt;
	}
	const dependencies = graphDependencies(graph, session);
	session.flush();
	const key = contentKey(identity, entrypoint, dependencies);
	const artifacts =
		fragmentArtifactIdentities ??
		wires!.map((fragmentWire) => {
			const wireDigest = digest(fragmentWire);
			cacheFrontendWire(fragmentWire, artifactRoot);
			const artifact = artifactIdentity(wireDigest, artifactRoot);
			if (artifact === undefined) {
				throw new Error(`frontend artifact is missing after publication: ${wireDigest}`);
			}
			return artifact;
		});
	const definitionStats = vmDefinitionStats(definition);
	publish(
		manifestPath(root, entrypoint, identity),
		`${JSON.stringify({
			schema: BUILD_FRONTEND_CACHE_SCHEMA,
			identity,
			contentKey: key,
			artifacts,
			definitionStats,
			entrypoint,
			dependencies,
			diagnostics,
		} satisfies BuildFrontendManifest)}\n`,
	);

	const materializeWires = () => (wires ??= loadFragmentWires!());
	return {
		definition,
		get wire() {
			return materializeWires().at(-1)!;
		},
		get wires() {
			return artifacts.length > 1 ? materializeWires() : undefined;
		},
		cache: "miss",
		closure: facts.closure,
		frontendMs: Date.now() - startedAt,
		phases,
		dependencies: dependencies.map((dependency) => dependency.path),
		moduleParses: moduleParseStats(),
		fileDigests: fileDigestStats(),
		artifacts: artifacts.map((artifact) => ({
			digest: artifact.digest,
			path: frontendWirePath(artifact.digest, artifactRoot),
			size: artifact.size,
		})),
		definitionStats,
		diagnostics,
		fragmentArtifacts,
		fragmentFallback,
	};
}

function compileDefinition(
	semantic: Parameters<typeof compileSemanticProgramToVmDefinition>[0],
	facts: CompilerProgramFacts,
	options: CompileBuildFrontendOptions,
	phases: BuildFrontendPhases,
): VmDefinition {
	return compileSemanticProgramToVmDefinition(semantic, {
		facts,
		optimization: options.optimization,
		optimizationAblations: options.optimizationAblations,
		coreVerification: options.coreVerification,
		profile: options.profile,
		afterCoreOptimization: options.afterCoreOptimization,
		runPhase(phase, run) {
			const phaseStartedAt = Date.now();
			try {
				return run();
			} finally {
				const durationMs = Date.now() - phaseStartedAt;
				phases.compileMs += durationMs;
				options.onCompilePhase?.(phase, durationMs);
			}
		},
	});
}
