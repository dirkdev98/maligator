import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "../build-config.ts";
import { compileSemanticProgramToVmDefinition } from "../compile-core.ts";
import type { BuildModuleGraphOptions, ModuleGraph } from "../module-graph.ts";
import { buildModuleGraph } from "../module-graph.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "../semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "../semantic-program.ts";
import { serializeVmDefinition, WIRE_VERSION } from "../serialize-vm.ts";
import { MALIGATOR_VERSION } from "../version.ts";

const TEST_CACHE_SCHEMA = 3;
const TEST_CACHE_DIRECTORY = ".cache/mal-cache/test";
const TEST_MODULE_ID = "maligator:test";
const TEST_IMAGE_TRANSFORM = 1;

interface DependencyIdentity {
	path: string;
	size: number;
	mtimeMs: number;
	digest: string;
}

interface TestCacheManifest {
	schema: 3;
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
	cacheDirectory?: string;
	session?: TestCompilationSession;
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

function digest(value: string | Uint8Array): string {
	return hash("sha256", value, "hex");
}

/**
 * One coherent filesystem view for a test command.
 *
 * A future watcher can retain this object and invalidate changed paths. A
 * one-shot command gets the same benefit—shared dependencies are read and
 * hashed once—even though several fallback compilation groups may inspect them.
 */
export class TestCompilationSession {
	readonly #snapshots = new Map<string, DependencyIdentity>();

	invalidate(file?: string): void {
		if (file === undefined) {
			this.#snapshots.clear();
		} else {
			this.#snapshots.delete(path.resolve(file));
		}
	}

	snapshot(file: string, knownSource?: string): DependencyIdentity {
		const resolved = path.resolve(file);
		const cached = this.#snapshots.get(resolved);
		if (cached !== undefined) return cached;
		const stats = statSync(resolved);
		if (!stats.isFile()) throw new Error(`test dependency is not a file: ${resolved}`);
		const value = {
			path: resolved,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			digest:
				knownSource === undefined
					? digest(new Uint8Array(readFileSync(resolved)))
					: digest(knownSource),
		};
		this.#snapshots.set(resolved, value);
		return value;
	}
}

function cacheRoot(override: string | undefined): string {
	return path.resolve(override ?? TEST_CACHE_DIRECTORY);
}

function resolvedEntries(files: Array<string>): Array<string> {
	return [...new Set(files.map((file) => path.resolve(file)))].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
}

function cacheIdentity(options: CompileTestOptions): string {
	const flags = {
		engine: options.config.engine,
		host: options.config.host,
		surface: options.config.surface,
	};
	return digest(
		JSON.stringify({
			schema: TEST_CACHE_SCHEMA,
			version: MALIGATOR_VERSION,
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			flags,
			testModule: digest(options.testModuleSource),
			testImageTransform: TEST_IMAGE_TRANSFORM,
		}),
	);
}

function manifestPath(root: string, entries: Array<string>): string {
	return path.join(root, "entries", `${digest(JSON.stringify(entries))}.json`);
}

function wirePath(root: string, contentKey: string): string {
	return path.join(root, "artifacts", `${contentKey}.malw`);
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
	session: TestCompilationSession,
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
	root: string,
	identity: string,
	requestedEntries: Array<string>,
	manifest: TestCacheManifest | undefined,
	session: TestCompilationSession,
): Uint8Array | undefined {
	if (
		manifest?.schema !== TEST_CACHE_SCHEMA ||
		manifest.identity !== identity ||
		!requestedEntries.every((entry) => manifest.entries.includes(entry)) ||
		!dependenciesUnchanged(manifest.dependencies, session)
	) {
		return undefined;
	}
	const artifact = wirePath(root, manifest.contentKey);
	if (!existsSync(artifact)) return undefined;
	const wire = new Uint8Array(readFileSync(artifact));
	return digest(wire) === manifest.wireDigest ? wire : undefined;
}

function syntheticEntry(entries: Array<string>): string {
	const imports = entries.map((file) => `import ${JSON.stringify(file)};`).join("\n");
	return `import { __run } from ${JSON.stringify(TEST_MODULE_ID)};
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
): ModuleGraph {
	const entrySet = new Set(entries);
	const entry = path.join(path.dirname(entries[0]!), ".maligator-test-image-entry.mts");
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: syntheticEntry(entries),
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		virtualModules: new Map([
			[TEST_MODULE_ID, { source: options.testModuleSource, goal: "module" }],
		]),
		transformSource(source, filePath) {
			return entrySet.has(filePath) ? wrapTestEntry(source, filePath) : source;
		},
	});
}

function dependencyIdentities(
	graph: ModuleGraph,
	session: TestCompilationSession,
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
	publish(manifestPath(root, requestedEntries), contents);
	if (manifest.entries.length === 1) return;
	for (const entry of manifest.entries) {
		const aliasPath = manifestPath(root, [entry]);
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
	};
	const session = options.session ?? new TestCompilationSession();
	const root = cacheRoot(options.cacheDirectory);
	const identity = cacheIdentity(options);
	const entryManifestPath = manifestPath(root, entries);
	const validationStartedAt = Date.now();
	const manifest = readManifest(entryManifestPath);
	const hit = cachedWire(root, identity, entries, manifest, session);
	phases.validationMs = Date.now() - validationStartedAt;
	if (hit !== undefined) {
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
	const graph = buildTestGraph(options, entries);
	phases.graphMs = Date.now() - graphStartedAt;
	const dependencies = dependencyIdentities(graph, session);
	const contentKey = digest(
		JSON.stringify({
			identity,
			entrySource: syntheticEntry(entries),
			dependencies: dependencies.map(({ path: file, digest: contentDigest }) => ({
				file,
				digest: contentDigest,
			})),
		}),
	);
	const artifactPath = wirePath(root, contentKey);
	let wire: Uint8Array;
	if (existsSync(artifactPath)) {
		wire = new Uint8Array(readFileSync(artifactPath));
	} else {
		const semanticStartedAt = Date.now();
		const semantic = runSemanticAnalysisForGraph(graph);
		phases.semanticMs = Date.now() - semanticStartedAt;
		const compileStartedAt = Date.now();
		assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
		assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
		const definition = compileSemanticProgramToVmDefinition(semantic);
		phases.compileMs = Date.now() - compileStartedAt;
		const serializeStartedAt = Date.now();
		wire = serializeVmDefinition(definition);
		phases.serializeMs = Date.now() - serializeStartedAt;
		publish(artifactPath, wire);
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
