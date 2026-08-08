import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ESTree } from "meriyah";
import type { ResolvedBuildConfig } from "../build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "../build-config.ts";
import { compileSemanticProgramToVmDefinition } from "../compile-core.ts";
import {
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendDigest,
	frontendWirePath,
} from "../frontend-cache.ts";
import type { FrontendCompilationSession } from "../frontend-cache.ts";
import { linkModules } from "../linker.ts";
import type { ModuleGraph, ModuleParseCache } from "../module-graph.ts";
import { buildModuleGraph } from "../module-graph.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "../semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "../semantic-program.ts";
import { serializeVmDefinition, WIRE_VERSION } from "../serialize-vm.ts";
import { MALIGATOR_VERSION } from "../version.ts";
import type {
	CompileTestImageOptions,
	DependencyIdentity,
	TestFrontendPhases,
} from "./cache.ts";
import { TestCompilationSession } from "./cache.ts";

const FRAGMENT_SCHEMA = 3;
const TEST_MODULE_ID = "maligator:test";
const CACHE_DIRECTORY = ".cache/mal-cache/test";
const IDENTIFIER = /^[$A-Z_a-z][$\w]*$/;

interface ArtifactReference {
	key: string;
	digest: string;
}

interface FragmentReference extends ArtifactReference {
	file: string;
}

interface FragmentManifest {
	schema: 3;
	identity: string;
	entries: Array<string>;
	dependencies: Array<DependencyIdentity>;
	base: ArtifactReference;
	fragments: Array<FragmentReference>;
	runner: ArtifactReference;
}

interface PlannedImport {
	specifier: string;
	target: string;
	names: Array<string>;
}

interface EntryPlan {
	file: string;
	graph: ModuleGraph;
	imports: Array<PlannedImport>;
}

interface CompiledArtifact extends ArtifactReference {
	wire: Uint8Array;
	cache: "hit" | "miss";
}

export interface RelocatableTestWire {
	kind: "base" | "entry" | "runner";
	file?: string;
	wire: Uint8Array;
}

export interface CompiledRelocatableTestImage {
	wires: Array<RelocatableTestWire>;
	cache: "hit" | "miss";
	frontendMs: number;
	phases: TestFrontendPhases;
	entries: Array<string>;
	dependencies: Array<string>;
	artifactHits: number;
	artifactMisses: number;
}

export class UnsupportedRelocatableTestImageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedRelocatableTestImageError";
	}
}

function digest(value: string | Uint8Array): string {
	return frontendDigest(value);
}

function cacheRoot(override: string | undefined): string {
	return path.resolve(override ?? CACHE_DIRECTORY);
}

function resolvedEntries(files: Array<string>): Array<string> {
	return [...new Set(files.map((file) => path.resolve(file)))].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
}

function manifestPath(root: string, entries: Array<string>, identity: string): string {
	return path.join(
		root,
		"fragment-entries",
		digest(JSON.stringify(entries)),
		`${identity}.json`,
	);
}

function artifactPath(root: string, key: string): string {
	return path.join(root, "fragment-artifacts", `${key}.json`);
}

function readManifest(file: string): FragmentManifest | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as FragmentManifest;
	} catch {
		return undefined;
	}
}

function publish(file: string, contents: string | Uint8Array): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, contents);
	renameSync(temporary, file);
}

function sameEntries(left: Array<string>, right: Array<string>): boolean {
	return (
		left.length === right.length && left.every((entry, index) => entry === right[index])
	);
}

function environmentIdentity(options: CompileTestImageOptions): string {
	return digest(
		JSON.stringify({
			schema: FRAGMENT_SCHEMA,
			version: MALIGATOR_VERSION,
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			optimization: "development",
			flags: {
				engine: options.config.engine,
				host: options.config.host,
				surface: options.config.surface,
			},
			runtime: digest(options.testModuleSource),
		}),
	);
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

function readArtifact(
	root: string,
	artifactRoot: string,
	reference: ArtifactReference,
): Uint8Array | undefined {
	try {
		const mapping = JSON.parse(
			readFileSync(artifactPath(root, reference.key), "utf-8"),
		) as {
			digest?: string;
		};
		if (mapping.digest !== reference.digest) return undefined;
		const wire = new Uint8Array(
			readFileSync(frontendWirePath(reference.digest, artifactRoot)),
		);
		return digest(wire) === reference.digest ? wire : undefined;
	} catch {
		return undefined;
	}
}

function manifestHit(
	root: string,
	artifactRoot: string,
	identity: string,
	requested: Array<string>,
	allowSuperset: boolean,
	manifest: FragmentManifest | undefined,
	session: FrontendCompilationSession,
): CompiledRelocatableTestImage | undefined {
	if (
		manifest?.schema !== FRAGMENT_SCHEMA ||
		manifest.identity !== identity ||
		!requested.every((entry) => manifest.entries.includes(entry)) ||
		(!allowSuperset && !sameEntries(requested, manifest.entries)) ||
		!dependenciesUnchanged(manifest.dependencies, session)
	) {
		return undefined;
	}
	const base = readArtifact(root, artifactRoot, manifest.base);
	const runner = readArtifact(root, artifactRoot, manifest.runner);
	if (base === undefined || runner === undefined) return undefined;
	const fragments: Array<RelocatableTestWire> = [];
	for (const file of requested) {
		const reference = manifest.fragments.find((fragment) => fragment.file === file);
		if (reference === undefined) return undefined;
		const wire = readArtifact(root, artifactRoot, reference);
		if (wire === undefined) return undefined;
		fragments.push({ kind: "entry", file, wire });
	}
	return {
		wires: [{ kind: "base", wire: base }, ...fragments, { kind: "runner", wire: runner }],
		cache: "hit",
		frontendMs: 0,
		phases: emptyPhases(),
		entries: manifest.entries,
		dependencies: manifest.dependencies.map((dependency) => dependency.path),
		artifactHits: fragments.length + 2,
		artifactMisses: 0,
	};
}

function emptyPhases(): TestFrontendPhases {
	return {
		validationMs: 0,
		graphMs: 0,
		semanticMs: 0,
		compileMs: 0,
		serializeMs: 0,
	};
}

function dependencyIdentities(
	graphs: Array<ModuleGraph>,
	session: FrontendCompilationSession,
): Array<DependencyIdentity> {
	const byPath = new Map<string, DependencyIdentity>();
	for (const graph of graphs) {
		for (const record of graph.modules.values()) {
			if (record.virtual || record.host || !existsSync(record.path)) continue;
			byPath.set(record.path, session.snapshot(record.path, record.source));
		}
	}
	return [...byPath.values()].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
}

function graphKey(identity: string, kind: string, graph: ModuleGraph): string {
	const modules = [...graph.modules.values()]
		.map((record) => ({
			path: record.path,
			goal: record.goal,
			source: digest(record.source),
			host: record.host?.id,
			virtual: record.virtual === true,
		}))
		.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		);
	return digest(
		JSON.stringify({
			identity,
			kind,
			entry: graph.entry,
			evaluationOrder: graph.evaluationOrder,
			modules,
		}),
	);
}

function compileArtifact(
	root: string,
	artifactRoot: string,
	identity: string,
	kind: string,
	graph: ModuleGraph,
	config: ResolvedBuildConfig,
	phases: TestFrontendPhases,
): CompiledArtifact {
	const key = graphKey(identity, kind, graph);
	const file = artifactPath(root, key);
	try {
		const reference = JSON.parse(readFileSync(file, "utf-8")) as {
			digest?: string;
		};
		if (reference.digest === undefined) throw new Error("missing artifact digest");
		const wire = new Uint8Array(
			readFileSync(frontendWirePath(reference.digest, artifactRoot)),
		);
		if (digest(wire) !== reference.digest) throw new Error("corrupt artifact");
		return { key, digest: reference.digest, wire, cache: "hit" };
	} catch {
		// Compile below when either the graph mapping or shared artifact is absent.
	}
	const semanticStartedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(graph);
	phases.semanticMs += Date.now() - semanticStartedAt;
	const compileStartedAt = Date.now();
	assertEvalPolicy(config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(config, collectDisallowedRegexpUsage(semantic));
	const definition = compileSemanticProgramToVmDefinition(semantic, {
		optimization: "development",
	});
	phases.compileMs += Date.now() - compileStartedAt;
	const serializeStartedAt = Date.now();
	const wire = serializeVmDefinition(definition);
	phases.serializeMs += Date.now() - serializeStartedAt;
	const wireDigest = digest(wire);
	cacheFrontendWire(wire, artifactRoot);
	publish(file, `${JSON.stringify({ digest: wireDigest })}\n`);
	return { key, digest: wireDigest, wire, cache: "miss" };
}

function importedName(specifier: ESTree.ImportSpecifier): string {
	const imported = specifier.imported;
	if (imported.type === "Identifier") return imported.name;
	if (typeof imported.value === "string" && IDENTIFIER.test(imported.value)) {
		return imported.value;
	}
	throw new UnsupportedRelocatableTestImageError(
		"string-named imports are not relocatable yet",
	);
}

function planEntry(
	file: string,
	graph: ModuleGraph,
	selectedFiles: Set<string>,
): EntryPlan {
	const record = graph.modules.get(path.resolve(file))!;
	if (record.goal !== "module") {
		throw new UnsupportedRelocatableTestImageError(
			`CommonJS test entry '${file}' requires the whole-image fallback`,
		);
	}
	if (
		record.dependencies.some(
			(dependency) => dependency.kind === "dynamic" || dependency.kind === "require",
		)
	) {
		throw new UnsupportedRelocatableTestImageError(
			`dynamic import/require in '${file}' requires the whole-image fallback`,
		);
	}
	const imports = new Map<string, PlannedImport>();
	for (const statement of record.parsed.ast.body) {
		if (
			(statement.type === "ExportNamedDeclaration" ||
				statement.type === "ExportAllDeclaration") &&
			statement.source !== null
		) {
			throw new UnsupportedRelocatableTestImageError(
				`re-exports in '${file}' require the whole-image fallback`,
			);
		}
		if (statement.type !== "ImportDeclaration") continue;
		const specifier = String(statement.source.value);
		const dependency = record.dependencies.find(
			(candidate) => candidate.kind === "import" && candidate.specifier === specifier,
		);
		if (dependency?.resolvedPath === null || dependency === undefined) {
			throw new UnsupportedRelocatableTestImageError(
				`unresolved import '${specifier}' in '${file}'`,
			);
		}
		if (selectedFiles.has(dependency.resolvedPath)) {
			throw new UnsupportedRelocatableTestImageError(
				`test-to-test import '${specifier}' in '${file}' requires the whole-image fallback`,
			);
		}
		let planned = imports.get(specifier);
		if (planned === undefined) {
			planned = {
				specifier,
				// Keep the virtual test runtime's public identity. Publishing the
				// resolver's backing file path as a second base target would instantiate
				// runtime.mjs twice: file-boundary globals would update one suite tree
				// while imported test() registered into the other.
				target: specifier === TEST_MODULE_ID ? TEST_MODULE_ID : dependency.resolvedPath,
				names: [],
			};
			imports.set(specifier, planned);
		}
		for (const importSpecifier of statement.specifiers) {
			if (importSpecifier.type === "ImportNamespaceSpecifier") {
				throw new UnsupportedRelocatableTestImageError(
					`namespace import '${specifier}' in '${file}' requires the whole-image fallback`,
				);
			}
			const name =
				importSpecifier.type === "ImportDefaultSpecifier"
					? "default"
					: importedName(importSpecifier);
			if (!planned.names.includes(name)) planned.names.push(name);
		}
	}
	return { file: path.resolve(file), graph, imports: [...imports.values()] };
}

function planningGraph(
	entries: Array<string>,
	options: CompileTestImageOptions,
	parseCache: ModuleParseCache,
): ModuleGraph {
	const entry = path.join(path.dirname(entries[0]!), ".maligator-test-fragment-plan.mts");
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: `${entries
			.map((file) => `import ${JSON.stringify(file)};`)
			.join("\n")}\n`,
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache,
		virtualModules: new Map([
			[TEST_MODULE_ID, { source: options.testModuleSource, goal: "module" }],
		]),
	});
}

function facadeSource(target: string, names: Array<string>): string {
	if (names.length === 0) return "";
	const lines = [
		`const __namespace = globalThis.__maligatorTestLinkedModules[${JSON.stringify(
			target,
		)}];`,
	];
	for (const [index, name] of names.entries()) {
		const local = `__maligatorImport${index}`;
		lines.push(`const ${local} = __namespace[${JSON.stringify(name)}];`);
		lines.push(
			name === "default" ? `export default ${local};` : `export { ${local} as ${name} };`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function wrapTestEntry(source: string, file: string): string {
	return `globalThis.__maligatorTestBeginFile(${JSON.stringify(
		file,
	)});${source}\nglobalThis.__maligatorTestEndFile();`;
}

function fragmentGraph(
	plan: EntryPlan,
	options: CompileTestImageOptions,
	parseCache: ModuleParseCache,
): ModuleGraph {
	const virtualModules = new Map<
		string,
		{ source: string; goal?: "module" | "script" }
	>();
	for (const planned of plan.imports) {
		virtualModules.set(planned.specifier, {
			source: facadeSource(planned.target, planned.names),
			goal: "module",
		});
	}
	return buildModuleGraph(plan.file, {
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache,
		virtualModules,
		transformSource(source, filePath) {
			return filePath === plan.file ? wrapTestEntry(source, plan.file) : source;
		},
	});
}

function baseGraph(
	plans: Array<EntryPlan>,
	options: CompileTestImageOptions,
	parseCache: ModuleParseCache,
): ModuleGraph {
	const targets = new Set<string>([TEST_MODULE_ID]);
	for (const plan of plans) {
		for (const imported of plan.imports) targets.add(imported.target);
	}
	const ordered = [...targets].sort();
	const imports = ordered
		.map(
			(target, index) =>
				`import * as __maligatorModule${index} from ${JSON.stringify(target)};`,
		)
		.join("\n");
	const publications = ordered
		.map(
			(target, index) =>
				`__maligatorModules[${JSON.stringify(target)}] = __maligatorModule${index};`,
		)
		.join("\n");
	const source = `${imports}
const __maligatorModules = Object.create(null);
${publications}
globalThis.__maligatorTestLinkedModules = __maligatorModules;
`;
	const entry = path.join(path.dirname(plans[0]!.file), ".maligator-test-base.mts");
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: source,
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache,
		virtualModules: new Map([
			[TEST_MODULE_ID, { source: options.testModuleSource, goal: "module" }],
		]),
	});
}

function runnerGraph(
	firstFile: string,
	options: CompileTestImageOptions,
	parseCache: ModuleParseCache,
): ModuleGraph {
	const entry = path.join(path.dirname(firstFile), ".maligator-test-runner.mts");
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource:
			"globalThis.__maligatorTestResult = await " +
			"globalThis.__maligatorTestApi.__run(globalThis.__maligatorTestOptions);\n",
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache,
	});
}

function publishManifest(
	root: string,
	manifest: FragmentManifest,
	requested: Array<string>,
): void {
	const contents = `${JSON.stringify(manifest)}\n`;
	publish(manifestPath(root, requested, manifest.identity), contents);
	if (manifest.entries.length === 1) return;
	for (const entry of manifest.entries) {
		const alias = manifestPath(root, [entry], manifest.identity);
		const existing = readManifest(alias);
		if (existing?.schema === FRAGMENT_SCHEMA && existing.entries.length === 1) {
			continue;
		}
		publish(alias, contents);
	}
}

/** Compile independently cached test registration fragments and link them at load time. */
export function compileRelocatableTestImage(
	options: CompileTestImageOptions,
): CompiledRelocatableTestImage {
	const startedAt = Date.now();
	const entries = resolvedEntries(options.files);
	if (entries.length === 0) throw new Error("a test image requires at least one entry");
	const root = cacheRoot(options.cacheDirectory);
	const artifactRoot = frontendArtifactCacheRoot(options.cacheDirectory);
	const identity = environmentIdentity(options);
	const session = options.session ?? new TestCompilationSession();
	const phases = emptyPhases();
	const validationStartedAt = Date.now();
	const existing = readManifest(manifestPath(root, entries, identity));
	const hit = manifestHit(
		root,
		artifactRoot,
		identity,
		entries,
		options.allowSupersetCache !== false,
		existing,
		session,
	);
	phases.validationMs = Date.now() - validationStartedAt;
	if (hit !== undefined) {
		hit.frontendMs = Date.now() - startedAt;
		hit.phases = phases;
		return hit;
	}

	const graphStartedAt = Date.now();
	const selectedFiles = new Set(entries);
	const planning = planningGraph(entries, options, session.moduleParses);
	phases.graphMs = Date.now() - graphStartedAt;
	const planningSemanticStartedAt = Date.now();
	const planningSemantic = runSemanticAnalysisForGraph(planning);
	linkModules(planningSemantic);
	phases.semanticMs = Date.now() - planningSemanticStartedAt;
	const fragmentGraphsStartedAt = Date.now();
	const plans = entries.map((file) => planEntry(file, planning, selectedFiles));
	const base = baseGraph(plans, options, session.moduleParses);
	const fragments = plans.map((plan) => ({
		plan,
		graph: fragmentGraph(plan, options, session.moduleParses),
	}));
	const runner = runnerGraph(entries[0]!, options, session.moduleParses);
	phases.graphMs += Date.now() - fragmentGraphsStartedAt;

	const baseArtifact = compileArtifact(
		root,
		artifactRoot,
		identity,
		"base",
		base,
		options.config,
		phases,
	);
	const fragmentArtifacts = fragments.map(({ plan, graph }) => ({
		file: plan.file,
		...compileArtifact(
			root,
			artifactRoot,
			identity,
			`entry:${plan.file}`,
			graph,
			options.config,
			phases,
		),
	}));
	const runnerArtifact = compileArtifact(
		root,
		artifactRoot,
		identity,
		"runner",
		runner,
		options.config,
		phases,
	);
	const dependencies = dependencyIdentities([planning, base], session);
	const manifest: FragmentManifest = {
		schema: FRAGMENT_SCHEMA,
		identity,
		entries,
		dependencies,
		base: { key: baseArtifact.key, digest: baseArtifact.digest },
		fragments: fragmentArtifacts.map((artifact) => ({
			file: artifact.file,
			key: artifact.key,
			digest: artifact.digest,
		})),
		runner: { key: runnerArtifact.key, digest: runnerArtifact.digest },
	};
	publishManifest(root, manifest, entries);
	const artifactHits = [baseArtifact, ...fragmentArtifacts, runnerArtifact].filter(
		(artifact) => artifact.cache === "hit",
	).length;
	return {
		wires: [
			{ kind: "base", wire: baseArtifact.wire },
			...fragmentArtifacts.map(
				(artifact): RelocatableTestWire => ({
					kind: "entry",
					file: artifact.file,
					wire: artifact.wire,
				}),
			),
			{ kind: "runner", wire: runnerArtifact.wire },
		],
		cache: "miss",
		frontendMs: Date.now() - startedAt,
		phases,
		entries,
		dependencies: dependencies.map((dependency) => dependency.path),
		artifactHits,
		artifactMisses: fragmentArtifacts.length + 2 - artifactHits,
	};
}
