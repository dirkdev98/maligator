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
import type { CompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
	COMPILER_ARTIFACT_VERSION,
} from "./compiler/target/compiler-artifact-codec.ts";
import {
	serializeRuntimeImage,
	WIRE_VERSION,
} from "./compiler/target/program-image-codec.ts";
import { runtimeImageStats } from "./compiler/target/program-image.ts";
import type { ProgramImage, ProgramImageStats } from "./compiler/target/program-image.ts";
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

const LINKED_IMAGE_SCHEMA = 2;

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

function imageKey(
	environment: LinkedImageEnvironment,
	kind: string,
	graph: ModuleGraph,
	exports: "all" | ReadonlySet<string> | undefined,
): string {
	return digest(
		JSON.stringify({
			identity: environment.identity,
			kind,
			exports: exports === undefined || exports === "all" ? exports : [...exports].sort(),
			entry: graph.entry,
			evaluationOrder: graph.evaluationOrder,
			modules: [...graph.modules.values()]
				.map((record) => ({
					path: record.path,
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

/** The cached image for this graph, without compiling on a miss. */
export function findLinkedImage(
	environment: LinkedImageEnvironment,
	kind: string,
	graph: ModuleGraph,
	exports: "all" | ReadonlySet<string> | undefined,
): LinkedImageArtifact | undefined {
	const mappingPath = path.join(
		environment.root,
		"artifacts",
		`${imageKey(environment, kind, graph, exports)}.json`,
	);
	try {
		const reference = JSON.parse(readFileSync(mappingPath, "utf-8")) as {
			schema?: number;
			runtimeArtifact?: FrontendArtifactIdentity;
			compilerArtifact?: FrontendArtifactIdentity;
			diagnostics?: Array<CompilerDiagnostic>;
			interfaces?: Array<CoreModuleInterface>;
			stats?: ProgramImageStats;
		};
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
		const { runtimeArtifact, diagnostics, interfaces, stats } = reference;
		let wire: Uint8Array | undefined;
		return {
			get wire() {
				if (wire !== undefined) return wire;
				wire = new Uint8Array(readFileSync(runtimeArtifact.path));
				if (digest(wire) !== runtimeArtifact.digest) {
					throw new Error(`corrupt linked image: ${runtimeArtifact.path}`);
				}
				return wire;
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
	} catch {
		return undefined;
	}
}

/**
 * Compile one image of a relocatable program, cached by its graph. Modules owned by
 * earlier images must already be external records of `graph`; `exports` selects
 * the modules later images may link against.
 */
export function compileLinkedImage(
	environment: LinkedImageEnvironment,
	kind: string,
	graph: ModuleGraph,
	exports: "all" | ReadonlySet<string> | undefined,
): LinkedImageArtifact {
	const cached = findLinkedImage(environment, kind, graph, exports);
	if (cached !== undefined) return cached;
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
		...(exports === undefined ? {} : { semanticLowering: { moduleExports: exports } }),
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
	if (environment.target === "runtime") {
		const compiled = compileSemanticProgramToLinkedRuntimeImage(semantic, compileOptions);
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
		path.join(
			environment.root,
			"artifacts",
			`${imageKey(environment, kind, graph, exports)}.json`,
		),
		`${JSON.stringify({
			schema: LINKED_IMAGE_SCHEMA,
			runtimeArtifact,
			...(native === undefined ? {} : { compilerArtifact: native.compilerArtifact }),
			diagnostics,
			interfaces,
			stats,
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
