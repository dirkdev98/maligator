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

const TEST_CACHE_SCHEMA = 1;
const TEST_CACHE_DIRECTORY = ".cache/mal-cache/test";
const TEST_MODULE_ID = "maligator:test";

interface DependencyIdentity {
	path: string;
	size: number;
	mtimeMs: number;
	digest: string;
}

interface TestCacheManifest {
	schema: 1;
	identity: string;
	contentKey: string;
	wireDigest: string;
	dependencies: Array<DependencyIdentity>;
}

export interface CompileTestFileOptions {
	file: string;
	config: ResolvedBuildConfig;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	testModuleSource: string;
	cacheDirectory?: string;
}

export interface CompiledTestFile {
	wire: Uint8Array;
	cache: "hit" | "miss";
	frontendMs: number;
	dependencies: Array<string>;
}

function digest(value: string | Uint8Array): string {
	return hash("sha256", value, "hex");
}

function cacheRoot(override: string | undefined): string {
	return path.resolve(override ?? TEST_CACHE_DIRECTORY);
}

function cacheIdentity(options: CompileTestFileOptions): string {
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
			entry: path.resolve(options.file),
			stripper: options.stripperIdentity,
			flags,
			testModule: digest(options.testModuleSource),
		}),
	);
}

function manifestPath(root: string, file: string): string {
	return path.join(root, "entries", `${digest(path.resolve(file))}.json`);
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

function dependenciesUnchanged(dependencies: Array<DependencyIdentity>): boolean {
	return dependencies.every((dependency) => {
		try {
			const stats = statSync(dependency.path);
			return (
				stats.isFile() &&
				stats.size === dependency.size &&
				stats.mtimeMs === dependency.mtimeMs &&
				digest(new Uint8Array(readFileSync(dependency.path))) === dependency.digest
			);
		} catch {
			return false;
		}
	});
}

function cachedWire(
	root: string,
	identity: string,
	manifest: TestCacheManifest | undefined,
): Uint8Array | undefined {
	if (
		manifest?.schema !== TEST_CACHE_SCHEMA ||
		manifest.identity !== identity ||
		!dependenciesUnchanged(manifest.dependencies)
	) {
		return undefined;
	}
	const artifact = wirePath(root, manifest.contentKey);
	if (!existsSync(artifact)) return undefined;
	const wire = new Uint8Array(readFileSync(artifact));
	return digest(wire) === manifest.wireDigest ? wire : undefined;
}

function syntheticEntry(file: string): string {
	return `import { __run } from ${JSON.stringify(TEST_MODULE_ID)};
import ${JSON.stringify(path.resolve(file))};
globalThis.__maligatorTestResult = await __run(globalThis.__maligatorTestOptions);
`;
}

function buildTestGraph(options: CompileTestFileOptions): ModuleGraph {
	const entry = path.join(
		path.dirname(path.resolve(options.file)),
		".maligator-test-entry.mts",
	);
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: syntheticEntry(options.file),
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		virtualModules: new Map([
			[TEST_MODULE_ID, { source: options.testModuleSource, goal: "module" }],
		]),
	});
}

function dependencyIdentities(graph: ModuleGraph): Array<DependencyIdentity> {
	const dependencies: Array<DependencyIdentity> = [];
	for (const record of graph.modules.values()) {
		if (record.virtual || record.host || record.path === graph.entry) continue;
		const stats = statSync(record.path);
		dependencies.push({
			path: record.path,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			digest: digest(record.source),
		});
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

/** Compile one test graph to interpreted wire, reusing only frontend artifacts. */
export function compileTestFile(options: CompileTestFileOptions): CompiledTestFile {
	const startedAt = Date.now();
	const root = cacheRoot(options.cacheDirectory);
	const identity = cacheIdentity(options);
	const entryManifestPath = manifestPath(root, options.file);
	const manifest = readManifest(entryManifestPath);
	const hit = cachedWire(root, identity, manifest);
	if (hit !== undefined) {
		return {
			wire: hit,
			cache: "hit",
			frontendMs: Date.now() - startedAt,
			dependencies: manifest!.dependencies.map((dependency) => dependency.path),
		};
	}

	const graph = buildTestGraph(options);
	const dependencies = dependencyIdentities(graph);
	const contentKey = digest(
		JSON.stringify({
			identity,
			entrySource: syntheticEntry(options.file),
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
		const semantic = runSemanticAnalysisForGraph(graph);
		assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
		assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
		wire = serializeVmDefinition(compileSemanticProgramToVmDefinition(semantic));
		publish(artifactPath, wire);
	}
	const nextManifest: TestCacheManifest = {
		schema: TEST_CACHE_SCHEMA,
		identity,
		contentKey,
		wireDigest: digest(wire),
		dependencies,
	};
	publish(entryManifestPath, `${JSON.stringify(nextManifest)}\n`);
	return {
		wire,
		cache: "miss",
		frontendMs: Date.now() - startedAt,
		dependencies: dependencies.map((dependency) => dependency.path),
	};
}
