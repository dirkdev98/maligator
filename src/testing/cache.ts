import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "../build-config.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import { compileSemanticProgramToVmDefinition } from "../compile-core.ts";
import {
	compilerConfigurationIdentity,
	compilerProducerIdentity,
} from "../compiler-cache-identity.ts";
import type { DependencyFragmentWorker } from "../dependency-fragment-cache.ts";
import {
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	FrontendCompilationSession,
	frontendDigest as digest,
	frontendWirePath,
} from "../frontend-cache.ts";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";
import type { VmDefinition } from "../lower-vm.ts";
import type { BuildModuleGraphOptions, ModuleGraph } from "../module-graph.ts";
import { buildModuleGraph } from "../module-graph.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "../semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "../semantic-program.ts";
import { serializeVmDefinition, WIRE_VERSION } from "../serialize-vm.ts";

const TEST_CACHE_SCHEMA = 1;
const TEST_CACHE_DIRECTORY = path.join(maligatorCacheDirectory(), "test");
const TEST_MODULE_ID = "maligator:test";
const TEST_IMAGE_TRANSFORM = 1;

export type DependencyIdentity = FrontendDependencyIdentity;

interface TestCacheManifest {
	schema: 1;
	identity: string;
	contentKey: string;
	wireDigest: string;
	entries: Array<string>;
	dependencies: Array<DependencyIdentity>;
}

interface CompileTestOptions {
	config: ResolvedBuildConfig;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	testModuleSource: string;
	nodeGlobalsSource?: string;
	cacheDirectory?: string;
	session?: FrontendCompilationSession;
	/** Require an artifact with exactly these entries during failure containment. */
	allowSupersetCache?: boolean;
	dependencyWorker?: DependencyFragmentWorker;
}

export interface CompileTestFileOptions extends CompileTestOptions {
	file: string;
}

export interface CompileTestImageOptions extends CompileTestOptions {
	files: Array<string>;
}

export interface TestFrontendPhases {
	validationMs: number;
	graphMs: number;
	semanticMs: number;
	compileMs: number;
	serializeMs: number;
	workerMs: number;
}

export interface CompiledTestImage {
	wire: Uint8Array;
	cache: "hit" | "miss";
	frontendMs: number;
	phases: TestFrontendPhases;
	entries: Array<string>;
	dependencies: Array<string>;
}

export type CompiledTestFile = CompiledTestImage;

/**
 * One coherent filesystem view for a test command.
 *
 * A future watcher can retain this object and invalidate changed paths. A
 * one-shot command gets the same benefit—shared dependencies are read and
 * hashed once—even though several fallback compilation groups may inspect them.
 */
export class TestCompilationSession extends FrontendCompilationSession {}

function cacheRoot(override: string | undefined): string {
	return path.resolve(override ?? TEST_CACHE_DIRECTORY);
}

function resolvedEntries(files: Array<string>): Array<string> {
	return [...new Set(files.map((file) => path.resolve(file)))].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
}

function cacheIdentity(options: CompileTestOptions): string {
	return digest(
		JSON.stringify({
			schema: TEST_CACHE_SCHEMA,
			producer: compilerProducerIdentity("test-frontend", TEST_CACHE_SCHEMA),
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			optimization: "development",
			configuration: compilerConfigurationIdentity(options.config),
			testModule: digest(options.testModuleSource),
			nodeGlobals:
				options.config.surface.node === true
					? digest(options.nodeGlobalsSource ?? "")
					: undefined,
			testImageTransform: TEST_IMAGE_TRANSFORM,
		}),
	);
}

function manifestPath(root: string, entries: Array<string>, identity: string): string {
	return path.join(root, "entries", digest(JSON.stringify(entries)), `${identity}.json`);
}

function artifactReferencePath(root: string, contentKey: string): string {
	return path.join(root, "artifacts", `${contentKey}.json`);
}

function readManifest(filePath: string): TestCacheManifest | undefined {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as TestCacheManifest;
	} catch {
		return undefined;
	}
}

function dependenciesUnchanged(
	dependencies: Array<DependencyIdentity>,
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

function cachedWire(
	artifactRoot: string,
	identity: string,
	requestedEntries: Array<string>,
	allowSuperset: boolean,
	manifest: TestCacheManifest | undefined,
	session: FrontendCompilationSession,
): Uint8Array | undefined {
	if (
		manifest?.schema !== TEST_CACHE_SCHEMA ||
		manifest.identity !== identity ||
		!requestedEntries.every((entry) => manifest.entries.includes(entry)) ||
		(!allowSuperset && manifest.entries.length !== requestedEntries.length) ||
		!dependenciesUnchanged(manifest.dependencies, session)
	) {
		return undefined;
	}
	try {
		const wire = new Uint8Array(
			readFileSync(frontendWirePath(manifest.wireDigest, artifactRoot)),
		);
		return digest(wire) === manifest.wireDigest ? wire : undefined;
	} catch {
		return undefined;
	}
}

function syntheticEntry(entries: Array<string>, node: boolean): string {
	const imports = entries.map((file) => `import ${JSON.stringify(file)};`).join("\n");
	return `${node ? 'import "maligator:node-globals";\n' : ""}import { __run } from ${JSON.stringify(TEST_MODULE_ID)};
${imports}
globalThis.__maligatorTestResult = await __run(globalThis.__maligatorTestOptions);
`;
}

function wrapTestEntry(source: string, file: string): string {
	return `globalThis.__maligatorTestBeginFile(${JSON.stringify(
		file,
	)});${source}\nglobalThis.__maligatorTestEndFile();`;
}

function buildTestGraph(
	options: CompileTestImageOptions,
	entries: Array<string>,
	session: FrontendCompilationSession,
	entrySource = syntheticEntry(entries, options.config.surface.node),
): ModuleGraph {
	const entrySet = new Set(entries);
	const entry = path.join(path.dirname(entries[0]!), ".maligator-test-image-entry.mts");
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource,
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache: session.moduleParses,
		virtualModules: new Map([
			[TEST_MODULE_ID, { source: options.testModuleSource, goal: "module" }],
			...(options.config.surface.node
				? [
						[
							"maligator:node-globals",
							{ source: options.nodeGlobalsSource ?? "", goal: "module" },
						] as const,
					]
				: []),
		]),
		transformSource(source, filePath) {
			return entrySet.has(filePath) ? wrapTestEntry(source, filePath) : source;
		},
	});
}

export interface CompiledProfiledTestImage {
	definition: VmDefinition;
	entries: Array<string>;
	dependencies: Array<string>;
}

export interface CompiledIsolatedTestImage {
	wire: Uint8Array;
	entries: Array<string>;
	dependencies: Array<string>;
}

function testProcessEntrySource(
	entries: Array<string>,
	node: boolean,
	runOptions: object,
	resultPrefix: string,
): string {
	const imports = entries.map((file) => `import ${JSON.stringify(file)};`).join("\n");
	return `${node ? 'import "maligator:node-globals";\n' : ""}import { __run } from ${JSON.stringify(TEST_MODULE_ID)};
${imports}
const __result = await __run(${JSON.stringify({ ...runOptions, files: entries })});
console.log(${JSON.stringify(resultPrefix)} + JSON.stringify(__result));
`;
}

/** Cold, production-optimized test image used only by `test --profile`. Ordinary
 * test execution retains its relocatable interpreted cache path. */
export function compileProfiledTestImage(
	options: CompileTestImageOptions,
	runOptions: object,
): CompiledProfiledTestImage {
	const entries = resolvedEntries(options.files);
	if (entries.length === 0)
		throw new Error("a profiled test image requires at least one entry");
	const session = options.session ?? new TestCompilationSession();
	const entrySource = testProcessEntrySource(
		entries,
		options.config.surface.node,
		runOptions,
		"__MALIGATOR_TEST_RESULT__",
	);
	const graph = buildTestGraph(options, entries, session, entrySource);
	const dependencies = dependencyIdentities(graph, session).map((entry) => entry.path);
	const semantic = runSemanticAnalysisForGraph(graph);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	return {
		definition: compileSemanticProgramToVmDefinition(semantic, {
			optimization: "full",
			profile: true,
		}),
		entries,
		dependencies,
	};
}

/** Development-optimized test wire for a configuration-compatible child runtime. */
export function compileIsolatedTestImage(
	options: CompileTestImageOptions,
	runOptions: object,
	resultPrefix: string,
): CompiledIsolatedTestImage {
	const entries = resolvedEntries(options.files);
	if (entries.length === 0)
		throw new Error("an isolated test image requires at least one entry");
	const session = options.session ?? new TestCompilationSession();
	const graph = buildTestGraph(
		options,
		entries,
		session,
		testProcessEntrySource(
			entries,
			options.config.surface.node,
			runOptions,
			resultPrefix,
		),
	);
	const dependencies = dependencyIdentities(graph, session).map((entry) => entry.path);
	const semantic = runSemanticAnalysisForGraph(graph);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	return {
		wire: serializeVmDefinition(
			compileSemanticProgramToVmDefinition(semantic, { optimization: "development" }),
		),
		entries,
		dependencies,
	};
}

function dependencyIdentities(
	graph: ModuleGraph,
	session: FrontendCompilationSession,
): Array<DependencyIdentity> {
	const dependencies: Array<DependencyIdentity> = [];
	for (const record of graph.modules.values()) {
		if (record.virtual || record.host || record.path === graph.entry) continue;
		dependencies.push(session.snapshot(record.path, record.source));
	}
	dependencies.sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	return dependencies;
}

function publish(filePath: string, contents: string | Uint8Array): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${process.pid}`;
	writeFileSync(temporary, contents);
	renameSync(temporary, filePath);
}

function publishManifest(
	root: string,
	manifest: TestCacheManifest,
	requestedEntries: Array<string>,
): void {
	const contents = `${JSON.stringify(manifest)}\n`;
	publish(manifestPath(root, requestedEntries, manifest.identity), contents);
	if (manifest.entries.length === 1) return;
	for (const entry of manifest.entries) {
		const aliasPath = manifestPath(root, [entry], manifest.identity);
		const existing = readManifest(aliasPath);
		if (existing?.schema === TEST_CACHE_SCHEMA && existing.entries.length === 1) {
			continue;
		}
		publish(aliasPath, contents);
	}
}

/** Compile a stable set of test entrypoints into one interpreted test image. */
export function compileTestImage(options: CompileTestImageOptions): CompiledTestImage {
	const startedAt = Date.now();
	const entries = resolvedEntries(options.files);
	if (entries.length === 0) throw new Error("a test image requires at least one entry");
	const phases: TestFrontendPhases = {
		validationMs: 0,
		graphMs: 0,
		semanticMs: 0,
		compileMs: 0,
		serializeMs: 0,
		workerMs: 0,
	};
	const session = options.session ?? new TestCompilationSession();
	session.useCacheDirectory(options.cacheDirectory);
	const root = cacheRoot(options.cacheDirectory);
	const artifactRoot = frontendArtifactCacheRoot(options.cacheDirectory);
	const identity = cacheIdentity(options);
	const entryManifestPath = manifestPath(root, entries, identity);
	const validationStartedAt = Date.now();
	const manifest = readManifest(entryManifestPath);
	const hit = cachedWire(
		artifactRoot,
		identity,
		entries,
		options.allowSupersetCache !== false,
		manifest,
		session,
	);
	phases.validationMs = Date.now() - validationStartedAt;
	if (hit !== undefined) {
		session.flush();
		return {
			wire: hit,
			cache: "hit",
			frontendMs: Date.now() - startedAt,
			phases,
			entries: manifest!.entries,
			dependencies: manifest!.dependencies.map((dependency) => dependency.path),
		};
	}

	const graphStartedAt = Date.now();
	const graph = buildTestGraph(options, entries, session);
	phases.graphMs = Date.now() - graphStartedAt;
	const dependencies = dependencyIdentities(graph, session);
	session.flush();
	const contentKey = digest(
		JSON.stringify({
			identity,
			entrySource: syntheticEntry(entries, options.config.surface.node),
			dependencies: dependencies.map(({ path: file, digest: contentDigest }) => ({
				file,
				digest: contentDigest,
			})),
		}),
	);
	let wire: Uint8Array;
	const referencePath = artifactReferencePath(root, contentKey);
	let referencedDigest: string | undefined;
	try {
		referencedDigest = (
			JSON.parse(readFileSync(referencePath, "utf-8")) as {
				digest?: string;
			}
		).digest;
	} catch {
		// A missing content mapping is a normal cold-cache path.
	}
	try {
		if (referencedDigest === undefined) throw new Error("missing artifact reference");
		wire = new Uint8Array(readFileSync(frontendWirePath(referencedDigest, artifactRoot)));
		if (digest(wire) !== referencedDigest) throw new Error("corrupt artifact");
	} catch {
		const semanticStartedAt = Date.now();
		const semantic = runSemanticAnalysisForGraph(graph);
		phases.semanticMs = Date.now() - semanticStartedAt;
		const compileStartedAt = Date.now();
		assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
		assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			optimization: "development",
		});
		phases.compileMs = Date.now() - compileStartedAt;
		const serializeStartedAt = Date.now();
		wire = serializeVmDefinition(definition);
		phases.serializeMs = Date.now() - serializeStartedAt;
		const cachedPath = cacheFrontendWire(wire, artifactRoot);
		publish(
			referencePath,
			`${JSON.stringify({ digest: path.basename(cachedPath, ".malw") })}\n`,
		);
	}
	const nextManifest: TestCacheManifest = {
		schema: TEST_CACHE_SCHEMA,
		identity,
		contentKey,
		wireDigest: digest(wire),
		entries,
		dependencies,
	};
	publishManifest(root, nextManifest, entries);
	return {
		wire,
		cache: "miss",
		frontendMs: Date.now() - startedAt,
		phases,
		entries,
		dependencies: dependencies.map((dependency) => dependency.path),
	};
}

/** Compatibility helper for callers that intentionally compile one test entry. */
export function compileTestFile(options: CompileTestFileOptions): CompiledTestFile {
	const { file, ...shared } = options;
	return compileTestImage({ ...shared, files: [file] });
}
