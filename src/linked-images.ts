import { readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import {
	compilerConfigurationIdentity,
	compilerProducerIdentity,
} from "./compiler-cache-identity.ts";
import type { CompilerProducerStage } from "./compiler-cache-identity.ts";
import type { CoreModuleInterface } from "./compiler/core/core-compilation.ts";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/analyze-module-graph.ts";
import type {
	ExternalModuleInterface,
	ModuleGraph,
} from "./compiler/frontend/module-graph.ts";
import { collectPrimordialMutationDiagnostics } from "./compiler/frontend/primordial-diagnostics.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./compiler/frontend/semantic-analysis.ts";
import type { CompileCoreOptions } from "./compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "./compiler/pipeline/compile-core.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import { compileSemanticProgramToLinkedRuntimeImage } from "./compiler/pipeline/compile-runtime-core.ts";
import type { CompilerDiagnostic } from "./compiler/shared/compiler-diagnostics.ts";
import type {
	CompilerProgramFacts,
	SourceSiteId,
} from "./compiler/shared/compiler-facts.ts";
import {
	isWithinDirectory,
	moduleFileUrl,
} from "./compiler/shared/module-path-values.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
	COMPILER_ARTIFACT_VERSION,
} from "./compiler/target/compiler-artifact-codec.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
	WIRE_VERSION,
} from "./compiler/target/program-image-codec.ts";
import { runtimeImageStats } from "./compiler/target/program-image.ts";
import type { ProgramImage, ProgramImageStats } from "./compiler/target/program-image.ts";
import type { RuntimeImage, RuntimeModuleLink } from "./compiler/target/runtime-image.ts";
import {
	cacheFrontendCompilerArtifact,
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendArtifactIdentity,
	frontendArtifactUnchanged,
	frontendCompilerArtifactIdentity,
	frontendCompilerArtifactUnchanged,
	frontendDigest as digest,
} from "./frontend-cache.ts";
import type { FrontendArtifactIdentity } from "./frontend-cache.ts";

const LINKED_IMAGE_SCHEMA = 3;

/**
 * What an image is compiled for. Interpreted images take the canonical runtime
 * pipeline; native development builds also need the native plans of each image.
 */
export type LinkedImageTarget = "runtime" | "native";

/** One compiled image of a relocatable program; later images link against it. */
export interface LinkedImageArtifact {
	readonly wire: Uint8Array;
	readonly runtimeArtifact: FrontendArtifactIdentity;
	/** Present for the `native` target. */
	readonly native?: LinkedNativeImage;
	readonly diagnostics: ReadonlyArray<CompilerDiagnostic>;
	/** What later images compile against for each module this image publishes. */
	readonly interfaces: ReadonlyArray<CoreModuleInterface>;
	readonly stats: ProgramImageStats;
	readonly cache: "hit" | "miss";
}

export interface LinkedNativeImage {
	readonly compilerArtifact: FrontendArtifactIdentity;
	readonly programImage: ProgramImage;
}

/** A program shape a linked image cannot express; callers compile one whole image. */
export class UnsupportedLinkedImagesError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", {
			value: "UnsupportedLinkedImagesError",
			configurable: true,
		});
	}
}

export interface LinkedImagePhases {
	semanticMs: number;
	compileMs: number;
	serializeMs: number;
}

/** Shared inputs of every image one relocatable program compiles. */
export interface LinkedImageEnvironment {
	readonly target: LinkedImageTarget;
	readonly identity: string;
	readonly root: string;
	readonly artifactRoot: string;
	readonly config: ResolvedBuildConfig;
	readonly facts: CompilerProgramFacts;
	readonly phases: LinkedImagePhases;
	readonly onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
}

export interface LinkedImageEnvironmentOptions {
	/** The compiler layer whose sources decide how this program is split into images. */
	producer: CompilerProducerStage;
	/** Cache family directory under the Maligator cache. */
	family: string;
	target: LinkedImageTarget;
	config: ResolvedBuildConfig;
	facts: CompilerProgramFacts;
	stripperIdentity: string;
	cacheDirectory?: string;
	phases: LinkedImagePhases;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
	/** Inputs every image of the program depends on beyond its own graph. */
	inputs?: unknown;
}

export function linkedImageEnvironment(
	options: LinkedImageEnvironmentOptions,
): LinkedImageEnvironment {
	return {
		target: options.target,
		identity: digest(
			JSON.stringify({
				schema: LINKED_IMAGE_SCHEMA,
				target: options.target,
				producer: compilerProducerIdentity(options.producer, LINKED_IMAGE_SCHEMA),
				wireVersion: WIRE_VERSION,
				compilerArtifactVersion: COMPILER_ARTIFACT_VERSION,
				stripper: options.stripperIdentity,
				optimization: "development",
				configuration: compilerConfigurationIdentity(options.config),
				inputs: options.inputs,
			}),
		),
		root: path.resolve(
			options.cacheDirectory ?? maligatorCacheDirectory(),
			options.family,
		),
		artifactRoot: frontendArtifactCacheRoot(options.cacheDirectory),
		config: options.config,
		facts: options.facts,
		phases: options.phases,
		...(options.onCompilePhase === undefined
			? {}
			: { onCompilePhase: options.onCompilePhase }),
	};
}

/** The artifact as a miss: a worker compiled it for this command, so a reread is no hit. */
export function compiledByWorker(artifact: LinkedImageArtifact): LinkedImageArtifact {
	return {
		get wire() {
			return artifact.wire;
		},
		runtimeArtifact: artifact.runtimeArtifact,
		...(artifact.native === undefined ? {} : { native: artifact.native }),
		diagnostics: artifact.diagnostics,
		interfaces: artifact.interfaces,
		stats: artifact.stats,
		cache: "miss",
	};
}

/** Whether compiling the graph bakes in the execution snapshot (`maligator:process`). */
export function graphReadsExecution(graph: ModuleGraph): boolean {
	for (const record of graph.modules.values()) {
		const constants = record.host?.constants;
		if (constants !== undefined && Object.keys(constants).length > 0) return true;
	}
	return false;
}

/** The interfaces later images import from, keyed by module identity. */
export function externalModulesOf(
	artifacts: Iterable<{ readonly interfaces: ReadonlyArray<CoreModuleInterface> }>,
): Map<string, ExternalModuleInterface> {
	const modules = new Map<string, ExternalModuleInterface>();
	for (const artifact of artifacts) {
		for (const { module, ...surface } of artifact.interfaces) {
			if (modules.has(module))
				throw new Error(`module '${module}' is published by two images`);
			modules.set(module, surface);
		}
	}
	return modules;
}

/**
 * Reject edges from `owned` modules into other images that a loaded image cannot
 * follow: only static imports and re-exports resolve through link tables.
 */
export function assertStaticImageBoundary(
	graph: ModuleGraph,
	owned: (modulePath: string) => boolean,
): void {
	for (const record of graph.modules.values()) {
		if (record.external !== undefined || record.host || !owned(record.path)) continue;
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath === null || owned(dependency.resolvedPath)) continue;
			if (graph.modules.get(dependency.resolvedPath)?.host) continue;
			if (dependency.kind !== "import" && dependency.kind !== "export") {
				throw new UnsupportedLinkedImagesError(
					`${dependency.kind} of '${dependency.specifier}' across an image boundary requires the whole-image fallback`,
				);
			}
		}
	}
}

/**
 * Split `members` into one image per import cycle (or single module), ordered so
 * every image follows the images it imports from. Undefined when one member reaches
 * another through `require`, `import()` or a deferred import: only a single image
 * evaluates those edges at the right time.
 */
export function moduleImageComponents(
	graph: ModuleGraph,
	members: ReadonlySet<string>,
): Array<Array<string>> | undefined {
	for (const member of members) {
		const record = graph.modules.get(member);
		if (record === undefined) return undefined;
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath === null || !members.has(dependency.resolvedPath))
				continue;
			if (dependency.kind !== "import" && dependency.kind !== "export") return undefined;
		}
	}
	const componentOf = new Map<string, Array<string>>();
	for (const cycle of graph.cycles) {
		const component = cycle.filter((module) => members.has(module));
		if (component.length !== cycle.length) return undefined;
		for (const module of component) componentOf.set(module, component);
	}
	// A component's last module in evaluation order completes after all its imports.
	const order = graph.evaluationOrder.filter((module) => members.has(module));
	const position = new Map(order.map((module, index) => [module, index]));
	const components = new Map<Array<string>, number>();
	for (const module of order) {
		const component = componentOf.get(module) ?? [module];
		components.set(
			component,
			Math.max(components.get(component) ?? -1, position.get(module)!),
		);
	}
	return [...components]
		.sort(([, left], [, right]) => left - right)
		.map(([component]) =>
			[...component].sort((left, right) => position.get(left)! - position.get(right)!),
		);
}

/** The module a package-root image publishes for the packages under `directory`. */
export function packageRootModule(directory: string): string {
	return path.join(directory, ".maligator-package-root.mjs");
}

export function packageRootSource(directory: string): string {
	return (
		`export const path = ${JSON.stringify(directory)};\n` +
		`export const url = ${JSON.stringify(moduleFileUrl(directory))};\n`
	);
}

/** The identity an image of this graph is cached under, for data derived from it. */
export function linkedImageIdentity(
	environment: LinkedImageEnvironment,
	kind: string,
	graph: ModuleGraph,
	exports: "all" | ReadonlySet<string> | undefined,
	packageRoot: string | undefined,
): string {
	const located = (file: string) =>
		packageRoot !== undefined && isWithinDirectory(file, packageRoot)
			? `\0package-root${file.slice(packageRoot.length)}`
			: file;
	return digest(
		JSON.stringify({
			identity: environment.identity,
			kind,
			packageRoot: packageRoot !== undefined,
			exports:
				exports === undefined || exports === "all"
					? exports
					: [...exports].map(located).sort(),
			entry: located(graph.entry),
			evaluationOrder: graph.evaluationOrder.map(located),
			modules: [...graph.modules.values()]
				.map((record) => ({
					path: located(record.path),
					goal: record.goal,
					source: digest(record.source),
					// The execution snapshot reaches an image only through these constants.
					host:
						record.host === undefined
							? undefined
							: { id: record.host.id, constants: record.host.constants },
					virtual: record.virtual === true,
					external: record.external,
				}))
				.sort((left, right) =>
					left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
				),
		}),
	);
}

function storedNativeImage(
	compilerArtifact: FrontendArtifactIdentity,
): LinkedNativeImage {
	let programImage: ProgramImage | undefined;
	return {
		compilerArtifact,
		get programImage() {
			if (programImage !== undefined) return programImage;
			const compilerWire = new Uint8Array(readFileSync(compilerArtifact.path));
			if (digest(compilerWire) !== compilerArtifact.digest) {
				throw new Error(`corrupt linked image: ${compilerArtifact.path}`);
			}
			programImage = deserializeCompilerArtifact(compilerWire);
			return programImage;
		},
	};
}

interface LinkedImageReference {
	readonly runtimeArtifact: FrontendArtifactIdentity;
	readonly compilerArtifact?: FrontendArtifactIdentity;
	readonly diagnostics: Array<CompilerDiagnostic>;
	readonly interfaces: Array<CoreModuleInterface>;
	readonly stats: ProgramImageStats;
	/** Where an image shared across locations was compiled; others rebase it. */
	readonly packageRoot?: string;
}

/**
 * An image compiled against a package root is stored once for every location; a
 * location's own reference holds either its rebased copy or an image that embeds
 * the location and so cannot be shared.
 */
function referencePath(
	environment: LinkedImageEnvironment,
	key: string,
	location: string | undefined,
): string {
	return path.join(
		environment.root,
		"artifacts",
		location === undefined
			? `${key}.json`
			: `${key}-${digest(location).slice(0, 16)}.json`,
	);
}

function readReference(
	environment: LinkedImageEnvironment,
	file: string,
): LinkedImageReference | undefined {
	try {
		const reference = JSON.parse(readFileSync(file, "utf-8")) as Partial<
			LinkedImageReference & { schema: number }
		>;
		const compilerArtifact = reference.compilerArtifact;
		if (
			reference.schema !== LINKED_IMAGE_SCHEMA ||
			reference.runtimeArtifact === undefined ||
			(environment.target === "native") !== (compilerArtifact !== undefined) ||
			!Array.isArray(reference.diagnostics) ||
			!Array.isArray(reference.interfaces) ||
			reference.stats === undefined ||
			!frontendArtifactUnchanged(reference.runtimeArtifact, environment.artifactRoot) ||
			(compilerArtifact !== undefined &&
				!frontendCompilerArtifactUnchanged(compilerArtifact, environment.artifactRoot))
		) {
			return undefined;
		}
		return reference as LinkedImageReference;
	} catch {
		return undefined;
	}
}

function storedWire(artifact: FrontendArtifactIdentity): Uint8Array {
	const wire = new Uint8Array(readFileSync(artifact.path));
	if (digest(wire) !== artifact.digest) {
		throw new Error(`corrupt linked image: ${artifact.path}`);
	}
	return wire;
}

function storedImage(reference: LinkedImageReference): LinkedImageArtifact {
	const { runtimeArtifact, compilerArtifact, diagnostics, interfaces, stats } = reference;
	let wire: Uint8Array | undefined;
	return {
		get wire() {
			return (wire ??= storedWire(runtimeArtifact));
		},
		runtimeArtifact,
		...(compilerArtifact === undefined
			? {}
			: { native: storedNativeImage(compilerArtifact) }),
		diagnostics,
		interfaces,
		stats,
		cache: "hit",
	};
}

/** Whether a program string still names the root, which then cannot move. */
function embedsLocation(runtime: RuntimeImage, directory: string): boolean {
	const forms = [directory, moduleFileUrl(directory)];
	return runtime.stringConstants.some((codeUnits) => {
		let text = "";
		for (let offset = 0; offset < codeUnits.length; offset += 1024)
			text += String.fromCharCode(...codeUnits.slice(offset, offset + 1024));
		return forms.some((form) => text.includes(form));
	});
}

/**
 * Move a shared image to another package root. Program values reach the root only
 * through the package-root image, so only the image's own data names it.
 */
function rebasedImage(
	environment: LinkedImageEnvironment,
	reference: LinkedImageReference,
	from: string,
	to: string,
	file: string,
): LinkedImageArtifact {
	const rebase = (modulePath: string) =>
		isWithinDirectory(modulePath, from) ? to + modulePath.slice(from.length) : modulePath;
	const rebaseLinks = (links: ReadonlyArray<RuntimeModuleLink>) =>
		links.map((link) => ({ ...link, module: rebase(link.module) }));
	const runtime = deserializeRuntimeImage(storedWire(reference.runtimeArtifact));
	const wire = serializeRuntimeImage({
		...runtime,
		entrypointPath: rebase(runtime.entrypointPath),
		files: runtime.files.map(rebase),
		...(runtime.moduleLinks === undefined
			? {}
			: {
					moduleLinks: {
						imports: rebaseLinks(runtime.moduleLinks.imports),
						exports: rebaseLinks(runtime.moduleLinks.exports),
					},
				}),
	});
	cacheFrontendWire(wire, environment.artifactRoot);
	const runtimeArtifact = frontendArtifactIdentity(
		digest(wire),
		environment.artifactRoot,
	);
	if (runtimeArtifact === undefined) {
		throw new Error("rebased linked image is missing after publication");
	}
	const diagnostics = reference.diagnostics.map((diagnostic) => {
		const separator = diagnostic.siteId.indexOf(":");
		const site = rebase(decodeURIComponent(diagnostic.siteId.slice(0, separator)));
		return {
			...diagnostic,
			path: rebase(diagnostic.path),
			siteId:
				`${encodeURIComponent(site)}${diagnostic.siteId.slice(separator)}` as SourceSiteId,
		};
	});
	const interfaces = reference.interfaces.map((surface) => ({
		...surface,
		module: rebase(surface.module),
	}));
	const { stats } = reference;
	writeFileAtomically(
		file,
		`${JSON.stringify({
			schema: LINKED_IMAGE_SCHEMA,
			runtimeArtifact,
			diagnostics,
			interfaces,
			stats,
		})}\n`,
	);
	return { wire, runtimeArtifact, diagnostics, interfaces, stats, cache: "hit" };
}

/**
 * The cached image for this graph, without compiling on a miss. With a package root
 * the image may come from another location, rebased onto this one.
 */
export function findLinkedImage(
	environment: LinkedImageEnvironment,
	kind: string,
	graph: ModuleGraph,
	exports: "all" | ReadonlySet<string> | undefined,
	packageRoot?: string,
): LinkedImageArtifact | undefined {
	const key = linkedImageIdentity(environment, kind, graph, exports, packageRoot);
	if (packageRoot === undefined) {
		const reference = readReference(
			environment,
			referencePath(environment, key, undefined),
		);
		return reference === undefined ? undefined : storedImage(reference);
	}
	const local = readReference(environment, referencePath(environment, key, packageRoot));
	if (local !== undefined) return storedImage(local);
	const shared = readReference(environment, referencePath(environment, key, undefined));
	if (shared?.packageRoot === undefined) return undefined;
	if (shared.packageRoot === packageRoot) return storedImage(shared);
	try {
		return rebasedImage(
			environment,
			shared,
			shared.packageRoot,
			packageRoot,
			referencePath(environment, key, packageRoot),
		);
	} catch {
		return undefined;
	}
}

/**
 * Compile one image of a relocatable program, cached by its graph. Modules owned by
 * earlier images must already be external records of `graph`; `exports` selects
 * the modules later images may link against. Modules under `packageRoot` read
 * their location from its package-root image, which must load before this one.
 */
export function compileLinkedImage(
	environment: LinkedImageEnvironment,
	kind: string,
	graph: ModuleGraph,
	exports: "all" | ReadonlySet<string> | undefined,
	packageRoot?: string,
): LinkedImageArtifact {
	const cached = findLinkedImage(environment, kind, graph, exports, packageRoot);
	if (cached !== undefined) return cached;
	if (packageRoot !== undefined && environment.target !== "runtime") {
		throw new Error("only interpreted images compile against a package root");
	}
	const { config, facts, phases } = environment;
	const semanticStartedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(graph);
	assertEvalPolicy(config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(config, collectDisallowedRegexpUsage(semantic));
	const diagnostics =
		facts.world.primordialPolicy === "locked"
			? collectPrimordialMutationDiagnostics(semantic, facts.world, {
					nodeEnabled: config.surface.node,
				})
			: [];
	phases.semanticMs += Date.now() - semanticStartedAt;
	const compileOptions: CompileCoreOptions = {
		facts,
		optimization: "development",
		semanticLowering: {
			...(exports === undefined ? {} : { moduleExports: exports }),
			...(packageRoot === undefined
				? {}
				: {
						packageRoot: {
							directory: packageRoot,
							module: packageRootModule(packageRoot),
						},
					}),
		},
		runPhase(phase, run) {
			const startedAt = Date.now();
			try {
				return run();
			} finally {
				const durationMs = Date.now() - startedAt;
				phases.compileMs += durationMs;
				environment.onCompilePhase?.(phase, durationMs);
			}
		},
	};
	let wire: Uint8Array;
	let interfaces: ReadonlyArray<CoreModuleInterface>;
	let stats: ProgramImageStats;
	let native: LinkedNativeImage | undefined;
	let shared = false;
	if (environment.target === "runtime") {
		const compiled = compileSemanticProgramToLinkedRuntimeImage(semantic, compileOptions);
		shared = packageRoot !== undefined && !embedsLocation(compiled.runtime, packageRoot);
		interfaces = compiled.interfaces;
		stats = runtimeImageStats(compiled.runtime);
		const serializeStartedAt = Date.now();
		wire = serializeRuntimeImage(compiled.runtime);
		phases.serializeMs += Date.now() - serializeStartedAt;
	} else {
		const programImage = compileSemanticProgramToProgramImage(semantic, compileOptions);
		interfaces = programImage.moduleInterfaces ?? [];
		stats = runtimeImageStats(programImage.runtime);
		const serializeStartedAt = Date.now();
		const compilerWire = serializeCompilerArtifact(programImage);
		wire = serializeRuntimeImage(programImage.runtime);
		phases.serializeMs += Date.now() - serializeStartedAt;
		cacheFrontendCompilerArtifact(compilerWire, environment.artifactRoot);
		const compilerArtifact = frontendCompilerArtifactIdentity(
			digest(compilerWire),
			environment.artifactRoot,
		);
		if (compilerArtifact === undefined) {
			throw new Error("linked image compiler artifact is missing after publication");
		}
		native = { compilerArtifact, programImage };
	}
	cacheFrontendWire(wire, environment.artifactRoot);
	const runtimeArtifact = frontendArtifactIdentity(
		digest(wire),
		environment.artifactRoot,
	);
	if (runtimeArtifact === undefined) {
		throw new Error("linked image runtime artifact is missing after publication");
	}
	writeFileAtomically(
		referencePath(
			environment,
			linkedImageIdentity(environment, kind, graph, exports, packageRoot),
			shared ? undefined : packageRoot,
		),
		`${JSON.stringify({
			schema: LINKED_IMAGE_SCHEMA,
			runtimeArtifact,
			...(native === undefined ? {} : { compilerArtifact: native.compilerArtifact }),
			diagnostics,
			interfaces,
			stats,
			...(shared ? { packageRoot } : {}),
		})}\n`,
	);
	return {
		wire,
		runtimeArtifact,
		...(native === undefined ? {} : { native }),
		diagnostics,
		interfaces,
		stats,
		cache: "miss",
	};
}
