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
import { compileSemanticProgramToProgramImage } from "./compiler/pipeline/compile-core.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
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
import type { ProgramImage } from "./compiler/target/program-image.ts";
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
import { executionIdentity } from "./platform/execution.ts";
import type { Execution } from "./platform/execution.ts";

const LINKED_IMAGE_SCHEMA = 1;

/** One compiled image of a relocatable program; later images link against it. */
export interface LinkedImageArtifact {
	readonly wire: Uint8Array;
	readonly programImage: ProgramImage;
	readonly runtimeArtifact: FrontendArtifactIdentity;
	readonly compilerArtifact: FrontendArtifactIdentity;
	readonly diagnostics: ReadonlyArray<CompilerDiagnostic>;
	/** What later images compile against for each module this image publishes. */
	readonly interfaces: ReadonlyArray<CoreModuleInterface>;
	readonly cache: "hit" | "miss";
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
	config: ResolvedBuildConfig;
	execution?: Execution;
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
		identity: digest(
			JSON.stringify({
				schema: LINKED_IMAGE_SCHEMA,
				producer: compilerProducerIdentity(options.producer, LINKED_IMAGE_SCHEMA),
				wireVersion: WIRE_VERSION,
				compilerArtifactVersion: COMPILER_ARTIFACT_VERSION,
				stripper: options.stripperIdentity,
				optimization: "development",
				configuration: compilerConfigurationIdentity(options.config),
				execution: executionIdentity(options.execution),
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
					host: record.host?.id,
					virtual: record.virtual === true,
					external: record.external,
				}))
				.sort((left, right) =>
					left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
				),
		}),
	);
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
		};
		if (
			reference.schema !== LINKED_IMAGE_SCHEMA ||
			reference.runtimeArtifact === undefined ||
			reference.compilerArtifact === undefined ||
			!Array.isArray(reference.diagnostics) ||
			!Array.isArray(reference.interfaces) ||
			!frontendArtifactUnchanged(reference.runtimeArtifact, environment.artifactRoot) ||
			!frontendCompilerArtifactUnchanged(
				reference.compilerArtifact,
				environment.artifactRoot,
			)
		) {
			return undefined;
		}
		const { runtimeArtifact, compilerArtifact, diagnostics, interfaces } = reference;
		let wire: Uint8Array | undefined;
		let programImage: ProgramImage | undefined;
		return {
			get wire() {
				if (wire !== undefined) return wire;
				wire = new Uint8Array(readFileSync(runtimeArtifact.path));
				if (digest(wire) !== runtimeArtifact.digest) {
					throw new Error(`corrupt linked image: ${runtimeArtifact.path}`);
				}
				return wire;
			},
			get programImage() {
				if (programImage !== undefined) return programImage;
				const compilerWire = new Uint8Array(readFileSync(compilerArtifact.path));
				if (digest(compilerWire) !== compilerArtifact.digest) {
					throw new Error(`corrupt linked image: ${compilerArtifact.path}`);
				}
				programImage = deserializeCompilerArtifact(compilerWire);
				return programImage;
			},
			runtimeArtifact,
			compilerArtifact,
			diagnostics,
			interfaces,
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
	const programImage = compileSemanticProgramToProgramImage(semantic, {
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
	});
	const serializeStartedAt = Date.now();
	const compilerWire = serializeCompilerArtifact(programImage);
	const wire = serializeRuntimeImage(programImage.runtime);
	phases.serializeMs += Date.now() - serializeStartedAt;
	cacheFrontendWire(wire, environment.artifactRoot);
	cacheFrontendCompilerArtifact(compilerWire, environment.artifactRoot);
	const runtimeArtifact = frontendArtifactIdentity(
		digest(wire),
		environment.artifactRoot,
	);
	const compilerArtifact = frontendCompilerArtifactIdentity(
		digest(compilerWire),
		environment.artifactRoot,
	);
	if (runtimeArtifact === undefined || compilerArtifact === undefined) {
		throw new Error("linked image artifacts are missing after publication");
	}
	const interfaces = programImage.moduleInterfaces ?? [];
	writeFileAtomically(
		path.join(
			environment.root,
			"artifacts",
			`${imageKey(environment, kind, graph, exports)}.json`,
		),
		`${JSON.stringify({
			schema: LINKED_IMAGE_SCHEMA,
			runtimeArtifact,
			compilerArtifact,
			diagnostics,
			interfaces,
		})}\n`,
	);
	return {
		wire,
		programImage,
		runtimeArtifact,
		compilerArtifact,
		diagnostics,
		interfaces,
		cache: "miss",
	};
}
