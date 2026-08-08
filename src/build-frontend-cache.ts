import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import type { CompileCorePhase } from "./compile-core.ts";
import type { IntermediateProgram } from "./ir.ts";
import {
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	FrontendCompilationSession,
	frontendWirePath,
} from "./frontend-cache.ts";
import type { FrontendDependencyIdentity } from "./frontend-cache.ts";
import type { VmDefinition } from "./lower-vm.ts";
import type { BuildModuleGraphOptions, ModuleGraph } from "./module-graph.ts";
import { buildModuleGraph } from "./module-graph.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "./semantic-program.ts";
import {
	deserializeVmDefinition,
	serializeVmDefinition,
	WIRE_VERSION,
} from "./serialize-vm.ts";
import { MALIGATOR_VERSION } from "./version.ts";

const BUILD_FRONTEND_CACHE_SCHEMA = 1;
const BUILD_FRONTEND_PIPELINE_VERSION = 1;
const BUILD_FRONTEND_CACHE_DIRECTORY = ".cache/mal-cache/build-frontend";

export type BuildDependencyIdentity = FrontendDependencyIdentity;

interface BuildFrontendManifest {
	schema: 1;
	identity: string;
	contentKey: string;
	wireDigest: string;
	entrypoint: string;
	dependencies: Array<BuildDependencyIdentity>;
}

export interface BuildFrontendPhases {
	validationMs: number;
	graphMs: number;
	semanticMs: number;
	compileMs: number;
	serializeMs: number;
}

export interface CompiledBuildFrontend {
	definition: VmDefinition;
	wire: Uint8Array;
	cache: "hit" | "miss";
	frontendMs: number;
	phases: BuildFrontendPhases;
	dependencies: Array<string>;
}

export interface CompileBuildFrontendOptions {
	entrypoint: string;
	config: ResolvedBuildConfig;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	optimization?: "development" | "full";
	cacheDirectory?: string;
	session?: FrontendCompilationSession;
	/** Apply build-time eval/RegExp policy checks. Defaults to true. */
	enforcePolicies?: boolean;
	/**
	 * Recompile even if the content-addressed artifact is valid. Used by
	 * compiler diagnostics that need the live semantic/IR objects.
	 */
	forceCompile?: boolean;
	afterOptimization?: (program: IntermediateProgram) => void;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
}

function digest(value: string | Uint8Array): string {
	return hash("sha256", value, "hex");
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
	return digest(
		JSON.stringify({
			schema: BUILD_FRONTEND_CACHE_SCHEMA,
			pipeline: BUILD_FRONTEND_PIPELINE_VERSION,
			version: MALIGATOR_VERSION,
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			optimization: options.optimization ?? "full",
			enforcePolicies: options.enforcePolicies !== false,
			engine: options.config.engine,
			host: options.config.host,
			surface: options.config.surface,
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
			dependencies: Array<BuildDependencyIdentity>;
	  }
	| undefined {
	const manifest = readManifest(manifestPath(root, entrypoint, identity));
	if (
		manifest?.schema !== BUILD_FRONTEND_CACHE_SCHEMA ||
		manifest.entrypoint !== entrypoint ||
		manifest.identity !== identity ||
		!dependenciesUnchanged(manifest.dependencies, session)
	) {
		return undefined;
	}
	try {
		const wire = new Uint8Array(
			readFileSync(frontendWirePath(manifest.wireDigest, artifactRoot)),
		);
		if (digest(wire) !== manifest.wireDigest) return undefined;
		return {
			definition: deserializeVmDefinition(wire),
			wire,
			dependencies: manifest.dependencies,
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
 * graph construction, semantic analysis, optimization, register allocation, and
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
	};
	const entrypoint = path.resolve(options.entrypoint);
	const root = cacheRoot(options.cacheDirectory);
	const artifactRoot = frontendArtifactCacheRoot(options.cacheDirectory);
	const identity = cacheIdentity(options);
	const session = options.session ?? new BuildCompilationSession();

	if (!options.forceCompile) {
		const validationStartedAt = Date.now();
		const cached = loadCached(root, artifactRoot, entrypoint, identity, session);
		phases.validationMs = Date.now() - validationStartedAt;
		if (cached !== undefined) {
			return {
				definition: cached.definition,
				wire: cached.wire,
				cache: "hit",
				frontendMs: Date.now() - startedAt,
				phases,
				dependencies: cached.dependencies.map((dependency) => dependency.path),
			};
		}
	}

	const graphStartedAt = Date.now();
	const graph = buildModuleGraph(entrypoint, {
		buildConfig: options.config,
		stripTypes: options.stripTypes,
	});
	phases.graphMs = Date.now() - graphStartedAt;

	const semanticStartedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(graph);
	if (options.enforcePolicies !== false) {
		assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
		assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	}
	phases.semanticMs = Date.now() - semanticStartedAt;

	const definition = compileSemanticProgramToVmDefinition(semantic, {
		optimization: options.optimization,
		afterOptimization: options.afterOptimization,
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

	const serializeStartedAt = Date.now();
	const wire = serializeVmDefinition(definition);
	phases.serializeMs = Date.now() - serializeStartedAt;
	const dependencies = graphDependencies(graph, session);
	const key = contentKey(identity, entrypoint, dependencies);
	const wireDigest = digest(wire);
	cacheFrontendWire(wire, artifactRoot);
	publish(
		manifestPath(root, entrypoint, identity),
		`${JSON.stringify({
			schema: BUILD_FRONTEND_CACHE_SCHEMA,
			identity,
			contentKey: key,
			wireDigest,
			entrypoint,
			dependencies,
		} satisfies BuildFrontendManifest)}\n`,
	);

	return {
		definition,
		wire,
		cache: "miss",
		frontendMs: Date.now() - startedAt,
		phases,
		dependencies: dependencies.map((dependency) => dependency.path),
	};
}
