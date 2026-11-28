import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "../atomic-file.ts";
import {
	assertDependenciesPrecedeImporters,
	dependencyTargets,
} from "../build-fragment-cache.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
} from "../compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "../compiler/frontend/module-graph.ts";
import { compilerProgramFactsFromConfig } from "../compiler/shared/compiler-facts.ts";
import {
	compileDependencyFragments,
	isExternalModule,
} from "../dependency-fragment-cache.ts";
import {
	frontendArtifactUnchanged,
	frontendArtifactCacheRoot,
	frontendDigest as digest,
} from "../frontend-cache.ts";
import type { FrontendArtifactIdentity } from "../frontend-cache.ts";
import {
	assertStaticImageBoundary,
	compiledByWorker,
	compileLinkedImage,
	externalModulesOf,
	findLinkedImage,
	graphReadsExecution,
	watchProxyCommand,
	linkedImageEnvironment,
	moduleImageComponents,
	UnsupportedLinkedImagesError,
} from "../linked-images.ts";
import type { LinkedImageArtifact, LinkedImageEnvironment } from "../linked-images.ts";
import { executionIdentity } from "../platform/execution.ts";
import type { Execution } from "../platform/execution.ts";
import type {
	CompileTestImageOptions,
	DependencyIdentity,
	TestFrontendPhases,
} from "./cache.ts";
import {
	dependenciesUnchanged,
	resolvedEntries,
	TEST_BOOTSTRAP_MODULE_ID,
	TEST_MODULE_ID,
	TestCompilationSession,
	testRunnerSource,
	testVirtualModules,
	wrapTestEntry,
} from "./cache.ts";

const MANIFEST_SCHEMA = 4;
const TEST_IMAGE_FAMILY = "test";

type TestImageKind = "runtime" | "dependency" | "application" | "entry" | "runner";

export interface LinkedTestWire {
	kind: TestImageKind;
	/** The test file an entry image evaluates. */
	file?: string;
	path: string;
	digest: string;
	size: number;
	readonly wire: Uint8Array;
}

export interface CompiledLinkedTestImage {
	/** Images in evaluation order. */
	wires: Array<LinkedTestWire>;
	cache: "hit" | "miss";
	frontendMs: number;
	phases: TestFrontendPhases;
	entries: Array<string>;
	dependencies: Array<string>;
	artifactHits: number;
	artifactMisses: number;
}

interface ImageReference extends FrontendArtifactIdentity {
	kind: TestImageKind;
	file?: string;
}

interface TestImageManifest {
	schema: typeof MANIFEST_SCHEMA;
	identity: string;
	entries: Array<string>;
	dependencies: Array<DependencyIdentity>;
	/** The execution snapshot when a module reads it; test options are otherwise runtime data. */
	execution: string | null;
	watchProxyCommand?: Execution["command"] | null;
	images: Array<ImageReference>;
}

function emptyPhases(): TestFrontendPhases {
	return {
		validationMs: 0,
		graphMs: 0,
		semanticMs: 0,
		compileMs: 0,
		serializeMs: 0,
		workerMs: 0,
	};
}

function manifestPath(
	root: string,
	selection: string,
	identity: string,
	extension: "json" | "suite" = "json",
): string {
	return path.join(root, "manifests", selection, `${identity}.${extension}`);
}

function readManifest(file: string): TestImageManifest | undefined {
	try {
		const manifest = JSON.parse(readFileSync(file, "utf-8")) as TestImageManifest | null;
		return manifest?.schema === MANIFEST_SCHEMA ? manifest : undefined;
	} catch {
		return undefined;
	}
}

function readSuiteSelection(file: string): string | undefined {
	try {
		const selection = readFileSync(file, "utf-8");
		return /^[0-9a-f]{64}$/.test(selection) ? selection : undefined;
	} catch {
		return undefined;
	}
}

function readSelectionManifest(
	root: string,
	entries: Array<string>,
	identity: string,
	allowSuperset: boolean,
): TestImageManifest | undefined {
	const selection = digest(JSON.stringify(entries));
	const exact = readManifest(manifestPath(root, selection, identity));
	if (exact !== undefined || entries.length !== 1 || !allowSuperset) return exact;
	const suite = readSuiteSelection(manifestPath(root, selection, identity, "suite"));
	return suite === undefined
		? undefined
		: readManifest(manifestPath(root, suite, identity));
}

function referencedWire(reference: ImageReference): LinkedTestWire {
	let wire: Uint8Array | undefined;
	return {
		kind: reference.kind,
		...(reference.file === undefined ? {} : { file: reference.file }),
		path: reference.path,
		digest: reference.digest,
		size: reference.size,
		get wire() {
			if (wire !== undefined) return wire;
			wire = new Uint8Array(readFileSync(reference.path));
			if (digest(wire) !== reference.digest) {
				throw new Error(`test image digest mismatch: ${reference.path}`);
			}
			return wire;
		},
	};
}

/**
 * A manifest compiled for these entries, or for a superset of them: the shared
 * images do not depend on which entries run, so the superset's serve the subset.
 */
function manifestHit(
	artifactRoot: string,
	identity: string,
	execution: string,
	command: Execution["command"] | null,
	requested: Array<string>,
	allowSuperset: boolean,
	manifest: TestImageManifest | undefined,
	session: TestCompilationSession,
): { wires: Array<LinkedTestWire>; dependencies: Array<string> } | undefined {
	if (
		manifest === undefined ||
		manifest.identity !== identity ||
		(manifest.execution !== null && manifest.execution !== execution) ||
		(manifest.watchProxyCommand !== undefined &&
			manifest.watchProxyCommand !== command) ||
		!requested.every((entry) => manifest.entries.includes(entry)) ||
		(!allowSuperset && manifest.entries.length !== requested.length) ||
		!dependenciesUnchanged(manifest.dependencies, session)
	) {
		return undefined;
	}
	const images = manifest.images.filter(
		(image) => image.kind !== "entry" || requested.includes(image.file!),
	);
	if (!images.every((image) => frontendArtifactUnchanged(image, artifactRoot))) {
		return undefined;
	}
	return {
		wires: images.map(referencedWire),
		dependencies: manifest.dependencies.map((dependency) => dependency.path),
	};
}

function publishManifest(root: string, manifest: TestImageManifest): void {
	const { entries, identity } = manifest;
	const selection = digest(JSON.stringify(entries));
	writeFileAtomically(
		manifestPath(root, selection, identity),
		`${JSON.stringify(manifest)}\n`,
	);
	if (entries.length === 1) return;
	// A suite update keeps its selection key, so the entry references need no rewrite.
	for (const entry of entries) {
		const alias = manifestPath(root, digest(JSON.stringify([entry])), identity, "suite");
		if (readSuiteSelection(alias) !== selection) writeFileAtomically(alias, selection);
	}
}

function imageWire(
	kind: TestImageKind,
	artifact: LinkedImageArtifact,
	file?: string,
): LinkedTestWire {
	return {
		kind,
		...(file === undefined ? {} : { file }),
		path: artifact.runtimeArtifact.path,
		digest: artifact.runtimeArtifact.digest,
		size: artifact.runtimeArtifact.size,
		get wire() {
			return artifact.wire;
		},
	};
}

function graphOptions(
	options: CompileTestImageOptions,
	session: TestCompilationSession,
): BuildModuleGraphOptions {
	return {
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		platformSourceRoot: options.platformSourceRoot,
		execution: options.execution,
		parseCache: session.moduleParses,
	};
}

function importsOf(specifiers: ReadonlyArray<string>): string {
	return specifiers.map((specifier) => `import ${JSON.stringify(specifier)};\n`).join("");
}

/** The image every test program evaluates first: the test runtime. */
function testRuntimeGraph(
	options: Pick<
		CompileTestImageOptions,
		"config" | "execution" | "stripTypes" | "platformSourceRoot" | "testModuleSource"
	>,
	session: TestCompilationSession,
): ModuleGraph {
	return buildModuleGraph(
		path.resolve(options.platformSourceRoot ?? ".", ".maligator-test-runtime.mts"),
		{
			stripTypes: options.stripTypes,
			buildConfig: options.config,
			platformSourceRoot: options.platformSourceRoot,
			execution: options.execution,
			parseCache: session.moduleParses,
			entryGoal: "module",
			entrySource: importsOf([TEST_BOOTSTRAP_MODULE_ID]),
			virtualModules: testVirtualModules(options),
		},
	);
}

interface TestRuntimeRequest {
	schema: 1;
	config: CompileTestImageOptions["config"];
	execution?: CompileTestImageOptions["execution"];
	stripperIdentity: string;
	cacheDirectory?: string;
	platformSourceRoot?: string;
	testModuleSource: string;
}

function testRuntimeTask(root: string, options: CompileTestImageOptions): Array<string> {
	const request: TestRuntimeRequest = {
		schema: 1,
		config: options.config,
		...(options.execution === undefined ? {} : { execution: options.execution }),
		stripperIdentity: options.stripperIdentity,
		...(options.cacheDirectory === undefined
			? {}
			: { cacheDirectory: options.cacheDirectory }),
		...(options.platformSourceRoot === undefined
			? {}
			: { platformSourceRoot: options.platformSourceRoot }),
		testModuleSource: options.testModuleSource,
	};
	const file = path.join(root, "requests", `${digest(JSON.stringify(request))}.json`);
	writeFileAtomically(file, `${JSON.stringify(request)}\n`);
	return ["--maligator-internal-test-runtime-image", file];
}

/** Internal worker entry that compiles a cold test runtime image into the shared cache. */
export function compileTestRuntimeRequest(
	file: string,
	stripTypes: CompileTestImageOptions["stripTypes"],
): void {
	const request = JSON.parse(readFileSync(path.resolve(file), "utf-8")) as
		| TestRuntimeRequest
		| undefined;
	if (request?.schema !== 1 || typeof request.testModuleSource !== "string") {
		throw new Error("invalid test runtime worker request");
	}
	const options = { ...request, stripTypes };
	const session = new TestCompilationSession();
	session.useCacheDirectory(request.cacheDirectory);
	compileImage(
		testImageEnvironment(options, emptyPhases()),
		"runtime",
		testRuntimeGraph(options, session),
		"all",
	);
	session.flush();
}

function testImageEnvironment(
	options: Pick<
		CompileTestImageOptions,
		"config" | "stripperIdentity" | "cacheDirectory"
	>,
	phases: TestFrontendPhases,
): LinkedImageEnvironment {
	return linkedImageEnvironment({
		producer: "test-fragment",
		family: TEST_IMAGE_FAMILY,
		target: "runtime",
		config: options.config,
		facts: compilerProgramFactsFromConfig(options.config),
		stripperIdentity: options.stripperIdentity,
		cacheDirectory: options.cacheDirectory,
		phases,
	});
}

/** Every module of the test program, parsed as its images compile them. */
export function testProgramGraph(
	entries: Array<string>,
	options: CompileTestImageOptions,
	session: TestCompilationSession,
): ModuleGraph {
	return buildModuleGraph(
		path.join(path.dirname(entries[0]!), ".maligator-test-plan.mts"),
		{
			...graphOptions(options, session),
			entryGoal: "module",
			entrySource: importsOf([TEST_BOOTSTRAP_MODULE_ID, ...entries]),
			virtualModules: testVirtualModules(options),
			transformSource: { files: new Set(entries), transform: wrapTestEntry },
		},
	);
}

/** Every module of the test program, from which the images are planned. */
function planningGraph(
	entries: Array<string>,
	options: CompileTestImageOptions,
	session: TestCompilationSession,
): ModuleGraph {
	const selected = new Set(entries);
	const graph = testProgramGraph(entries, options, session);
	if (graph.workerEntries?.length)
		throw new UnsupportedLinkedImagesError(
			"worker roots require whole-program test images",
		);
	for (const record of graph.modules.values()) {
		if (record.path === graph.entry) continue;
		const imported = record.dependencies.find(
			(dependency) =>
				dependency.resolvedPath !== null && selected.has(dependency.resolvedPath),
		);
		if (imported !== undefined)
			throw new UnsupportedLinkedImagesError(
				`'${record.path}' imports the test file '${imported.specifier}', which requires the whole-image fallback`,
			);
	}
	return graph;
}

/** A `require` or `import()` into another image throws, and the caller compiles one whole image. */
function compileImage(
	environment: LinkedImageEnvironment,
	kind: TestImageKind,
	graph: ModuleGraph,
	exports: "all" | undefined,
): LinkedImageArtifact {
	assertStaticImageBoundary(
		graph,
		(modulePath) => graph.modules.get(modulePath)?.external === undefined,
	);
	return compileLinkedImage(environment, kind, graph, exports);
}

/**
 * Compile a test program as linked images in evaluation order: the test runtime,
 * dependency islands, one image per application module (or import cycle; see
 * `moduleImageComponents`), one per test file, and the runner. An edit recompiles
 * only the images whose own modules changed, and imports across images keep live
 * bindings.
 */
export function compileLinkedTestImage(
	options: CompileTestImageOptions,
): CompiledLinkedTestImage {
	const startedAt = Date.now();
	const entries = resolvedEntries(options.files);
	if (entries.length === 0) throw new Error("a test image requires at least one entry");
	const session = options.session ?? new TestCompilationSession();
	session.useCacheDirectory(options.cacheDirectory);
	const phases = emptyPhases();
	const environment = testImageEnvironment(options, phases);
	const facts = environment.facts;
	const identity = digest(
		JSON.stringify({ environment: environment.identity, runner: options.runner ?? null }),
	);
	const artifactRoot = frontendArtifactCacheRoot(options.cacheDirectory);

	const validationStartedAt = Date.now();
	const execution = executionIdentity(options.execution);
	const allowSuperset = options.allowSupersetCache !== false;
	const hit = manifestHit(
		artifactRoot,
		identity,
		execution,
		options.execution?.command ?? null,
		entries,
		allowSuperset,
		readSelectionManifest(environment.root, entries, identity, allowSuperset),
		session,
	);
	phases.validationMs = Date.now() - validationStartedAt;
	if (hit !== undefined) {
		session.flush();
		return {
			wires: hit.wires,
			cache: "hit",
			frontendMs: Date.now() - startedAt,
			phases,
			entries,
			dependencies: hit.dependencies,
			artifactHits: hit.wires.length,
			artifactMisses: 0,
		};
	}

	const graphStartedAt = Date.now();
	const planning = planningGraph(entries, options, session);
	phases.graphMs += Date.now() - graphStartedAt;
	assertDependenciesPrecedeImporters(planning);

	const runtimeStartedAt = Date.now();
	const runtimeGraph = testRuntimeGraph(options, session);
	phases.graphMs += Date.now() - runtimeStartedAt;
	const runtimeOwned = new Set(runtimeGraph.modules.keys());
	// A cold runtime image compiles in a worker beside the dependency islands.
	const runtimeTask =
		options.dependencyWorker === undefined ||
		findLinkedImage(environment, "runtime", runtimeGraph, "all") !== undefined
			? []
			: [testRuntimeTask(environment.root, options)];

	const dependencies = compileDependencyFragments({
		target: "runtime",
		graph: planning,
		targets: dependencyTargets(planning),
		config: options.config,
		execution: options.execution,
		platformSourceRoot: options.platformSourceRoot,
		facts,
		stripTypes: options.stripTypes,
		stripperIdentity: options.stripperIdentity,
		cacheDirectory: options.cacheDirectory,
		session,
		phases,
		worker: options.dependencyWorker,
		parallelTasks: runtimeTask,
	});
	const runtimeImage = compileImage(environment, "runtime", runtimeGraph, "all");
	const runtime = runtimeTask.length > 0 ? compiledByWorker(runtimeImage) : runtimeImage;

	const selected = new Set(entries);
	const applicationModules = new Set(
		[...planning.modules.values()]
			.filter(
				(record) =>
					record.path !== planning.entry &&
					!selected.has(record.path) &&
					!runtimeOwned.has(record.path) &&
					!isExternalModule(record.path) &&
					record.host === undefined,
			)
			.map((record) => record.path),
	);
	const linked: Array<{
		kind: TestImageKind;
		artifact: LinkedImageArtifact;
		file?: string;
	}> = [
		{ kind: "runtime", artifact: runtime },
		...dependencies.map((artifact) => ({ kind: "dependency" as const, artifact })),
	];
	// One image per module keeps an edit to one module, or another test selection,
	// from recompiling the rest of the application.
	const components =
		moduleImageComponents(planning, applicationModules) ??
		(applicationModules.size === 0
			? []
			: [planning.evaluationOrder.filter((module) => applicationModules.has(module))]);
	for (const component of components) {
		const componentStartedAt = Date.now();
		const graph = buildModuleGraph(
			path.join(environment.root, "roots", `${digest(JSON.stringify(component))}.mts`),
			{
				...graphOptions(options, session),
				entryGoal: "module",
				entrySource: importsOf([component.at(-1)!]),
				externalModules: externalModulesOf(linked.map(({ artifact }) => artifact)),
			},
		);
		phases.graphMs += Date.now() - componentStartedAt;
		linked.push({
			kind: "application",
			artifact: compileImage(environment, "application", graph, "all"),
		});
	}

	const external = externalModulesOf(linked.map(({ artifact }) => artifact));
	for (const entry of entries) {
		const entryStartedAt = Date.now();
		const graph = buildModuleGraph(entry, {
			...graphOptions(options, session),
			externalModules: external,
			transformSource: { files: new Set([entry]), transform: wrapTestEntry },
		});
		phases.graphMs += Date.now() - entryStartedAt;
		linked.push({
			kind: "entry",
			artifact: compileImage(environment, "entry", graph, undefined),
			file: entry,
		});
	}
	const runnerStartedAt = Date.now();
	const runnerGraph = buildModuleGraph(
		path.join(environment.root, "roots", "runner.mts"),
		{
			...graphOptions(options, session),
			entryGoal: "module",
			entrySource: `import { __run } from ${JSON.stringify(TEST_MODULE_ID)};\n${testRunnerSource("__run", entries, options.runner)}`,
			externalModules: external,
		},
	);
	phases.graphMs += Date.now() - runnerStartedAt;
	linked.push({
		kind: "runner",
		artifact: compileImage(environment, "runner", runnerGraph, undefined),
	});

	const fileDependencies = [...planning.modules.values()]
		.filter((record) => !record.virtual && !record.host && existsSync(record.path))
		.map((record) => session.snapshot(record.path, record.source))
		.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		);
	session.flush();
	publishManifest(environment.root, {
		schema: MANIFEST_SCHEMA,
		identity,
		entries,
		dependencies: fileDependencies,
		execution: graphReadsExecution(planning) ? execution : null,
		watchProxyCommand: watchProxyCommand(planning, options.execution),
		images: linked.map(({ kind, artifact, file }) => ({
			kind,
			...(file === undefined ? {} : { file }),
			...artifact.runtimeArtifact,
		})),
	});
	const artifactHits = linked.filter(({ artifact }) => artifact.cache === "hit").length;
	return {
		wires: linked.map(({ kind, artifact, file }) => imageWire(kind, artifact, file)),
		cache: "miss",
		frontendMs: Date.now() - startedAt,
		phases,
		entries,
		dependencies: fileDependencies.map((dependency) => dependency.path),
		artifactHits,
		artifactMisses: linked.length - artifactHits,
	};
}
