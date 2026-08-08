import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ESTree } from "meriyah";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { assertEvalPolicy, assertRegexpPolicy } from "./build-config.ts";
import type { BuildFrontendPhases } from "./build-frontend-cache.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import type { CompileCorePhase } from "./compile-core.ts";
import { ESTREE_SKIP, ESTREE_STOP, traverseEstree } from "./estree-traversal.ts";
import {
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendDigest,
	frontendWirePath,
} from "./frontend-cache.ts";
import type { FrontendCompilationSession } from "./frontend-cache.ts";
import { linkModules } from "./linker.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
	ModuleParseCache,
} from "./module-graph.ts";
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

const FRAGMENT_SCHEMA = 1;
const CACHE_DIRECTORY = ".cache/mal-cache/build-fragments";
const LINKED_MODULES_GLOBAL = "__maligatorDevelopmentLinkedModules";
const IDENTIFIER = /^[$A-Z_a-z][$\w]*$/;

interface PlannedImport {
	specifier: string;
	target: string;
	names: Array<string>;
}

interface CompiledArtifact {
	wire: Uint8Array;
	cache: "hit" | "miss";
}

export interface CompiledBuildFragments {
	wires: Array<Uint8Array>;
	definition: ReturnType<typeof compileSemanticProgramToVmDefinition>;
	artifactHits: number;
	artifactMisses: number;
}

export class UnsupportedBuildFragmentsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedBuildFragmentsError";
	}
}

export interface CompileBuildFragmentsOptions {
	graph: ModuleGraph;
	config: ResolvedBuildConfig;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	cacheDirectory?: string;
	session: FrontendCompilationSession;
	phases: BuildFrontendPhases;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
}

function digest(value: string | Uint8Array): string {
	return frontendDigest(value);
}

function cacheRoot(override: string | undefined): string {
	return path.resolve(override ?? CACHE_DIRECTORY);
}

function publish(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, contents);
	renameSync(temporary, file);
}

function externalModule(file: string): boolean {
	return file.split(path.sep).includes("node_modules");
}

function importedName(specifier: ESTree.ImportSpecifier): string {
	const imported = specifier.imported;
	if (imported.type === "Identifier") return imported.name;
	if (typeof imported.value === "string" && IDENTIFIER.test(imported.value)) {
		return imported.value;
	}
	throw new UnsupportedBuildFragmentsError(
		"string-named imports are not relocatable yet",
	);
}

function planBoundary(graph: ModuleGraph): Array<PlannedImport> {
	const imports = new Map<string, PlannedImport>();
	for (const record of graph.modules.values()) {
		if (record.host || record.virtual || externalModule(record.path)) continue;
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath === null || !externalModule(dependency.resolvedPath)) {
				continue;
			}
			if (dependency.kind !== "import") {
				throw new UnsupportedBuildFragmentsError(
					`${dependency.kind} across the application/dependency boundary requires the whole-image fallback`,
				);
			}
		}
		for (const statement of record.parsed.ast.body) {
			if (statement.type !== "ImportDeclaration") continue;
			const specifier = String(statement.source.value);
			const dependency = record.dependencies.find(
				(candidate) => candidate.kind === "import" && candidate.specifier === specifier,
			);
			if (
				dependency?.resolvedPath === null ||
				dependency === undefined ||
				!externalModule(dependency.resolvedPath)
			) {
				continue;
			}
			let planned = imports.get(specifier);
			if (planned !== undefined && planned.target !== dependency.resolvedPath) {
				throw new UnsupportedBuildFragmentsError(
					`'${specifier}' resolves to several dependency roots`,
				);
			}
			if (planned === undefined) {
				planned = { specifier, target: dependency.resolvedPath, names: [] };
				imports.set(specifier, planned);
			}
			for (const imported of statement.specifiers) {
				if (imported.type === "ImportNamespaceSpecifier") {
					throw new UnsupportedBuildFragmentsError(
						`namespace import '${specifier}' requires the whole-image fallback`,
					);
				}
				const name =
					imported.type === "ImportDefaultSpecifier" ? "default" : importedName(imported);
				if (!planned.names.includes(name)) planned.names.push(name);
			}
		}
	}
	if (imports.size === 0) {
		throw new UnsupportedBuildFragmentsError("the graph has no dependency boundary");
	}
	return [...imports.values()].sort((left, right) =>
		left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0,
	);
}

function assertNoBoundaryCycle(graph: ModuleGraph): void {
	for (const record of graph.modules.values()) {
		if (!externalModule(record.path)) continue;
		const topLevelAwait =
			traverseEstree(record.parsed.ast.body, (node) => {
				if (node.type === "AwaitExpression") return ESTREE_STOP;
				if (
					node.type === "FunctionDeclaration" ||
					node.type === "FunctionExpression" ||
					node.type === "ArrowFunctionExpression" ||
					node.type === "ClassDeclaration" ||
					node.type === "ClassExpression"
				) {
					return ESTREE_SKIP;
				}
			}) === ESTREE_STOP;
		if (topLevelAwait) {
			throw new UnsupportedBuildFragmentsError(
				"top-level await in a dependency requires the whole-image fallback",
			);
		}
		if (
			record.dependencies.some(
				(dependency) =>
					dependency.resolvedPath !== null &&
					!externalModule(dependency.resolvedPath) &&
					!graph.modules.get(dependency.resolvedPath)?.host,
			)
		) {
			throw new UnsupportedBuildFragmentsError(
				"an application/dependency cycle requires the whole-image fallback",
			);
		}
	}
}

function facadeSource(target: string, names: Array<string>): string {
	if (names.length === 0) return "";
	const lines = [
		`const __namespace = globalThis[${JSON.stringify(LINKED_MODULES_GLOBAL)}][${JSON.stringify(target)}];`,
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

function baseGraph(
	plans: Array<PlannedImport>,
	options: CompileBuildFragmentsOptions,
	parseCache: ModuleParseCache,
): ModuleGraph {
	const targets = [...new Set(plans.map((plan) => plan.target))].sort();
	const imports = targets
		.map(
			(target, index) =>
				`import * as __maligatorModule${index} from ${JSON.stringify(target)};`,
		)
		.join("\n");
	const publications = targets
		.map(
			(target, index) =>
				`__maligatorModules[${JSON.stringify(target)}] = __maligatorModule${index};`,
		)
		.join("\n");
	const source = `${imports}
const __maligatorModules = Object.create(null);
${publications}
globalThis[${JSON.stringify(LINKED_MODULES_GLOBAL)}] = __maligatorModules;
`;
	const entry = path.join(
		path.dirname(options.graph.entry),
		".maligator-dependency-base.mts",
	);
	return buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: source,
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache,
	});
}

function applicationGraph(
	plans: Array<PlannedImport>,
	options: CompileBuildFragmentsOptions,
	parseCache: ModuleParseCache,
): ModuleGraph {
	const virtualModules = new Map<string, { source: string; goal: "module" }>();
	for (const plan of plans) {
		virtualModules.set(plan.specifier, {
			source: facadeSource(plan.target, plan.names),
			goal: "module",
		});
	}
	return buildModuleGraph(options.graph.entry, {
		stripTypes: options.stripTypes,
		buildConfig: options.config,
		parseCache,
		virtualModules,
	});
}

function environmentIdentity(options: CompileBuildFragmentsOptions): string {
	return digest(
		JSON.stringify({
			schema: FRAGMENT_SCHEMA,
			version: MALIGATOR_VERSION,
			wireVersion: WIRE_VERSION,
			stripper: options.stripperIdentity,
			optimization: "development",
			engine: options.config.engine,
			host: options.config.host,
			surface: options.config.surface,
		}),
	);
}

function graphKey(identity: string, kind: string, graph: ModuleGraph): string {
	return digest(
		JSON.stringify({
			identity,
			kind,
			entry: graph.entry,
			evaluationOrder: graph.evaluationOrder,
			modules: [...graph.modules.values()]
				.map((record) => ({
					path: record.path,
					goal: record.goal,
					source: digest(record.source),
					host: record.host?.id,
					virtual: record.virtual === true,
				}))
				.sort((left, right) =>
					left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
				),
		}),
	);
}

function compileArtifact(
	root: string,
	artifactRoot: string,
	identity: string,
	kind: string,
	graph: ModuleGraph,
	options: CompileBuildFragmentsOptions,
): CompiledArtifact & {
	definition: ReturnType<typeof compileSemanticProgramToVmDefinition>;
} {
	const key = graphKey(identity, kind, graph);
	const mappingPath = path.join(root, "artifacts", `${key}.json`);
	try {
		const reference = JSON.parse(readFileSync(mappingPath, "utf-8")) as {
			digest?: string;
		};
		if (reference.digest === undefined) throw new Error("missing artifact digest");
		const wire = new Uint8Array(
			readFileSync(frontendWirePath(reference.digest, artifactRoot)),
		);
		if (digest(wire) !== reference.digest) throw new Error("corrupt artifact");
		return {
			wire,
			definition: deserializeVmDefinition(wire),
			cache: "hit",
		};
	} catch {
		// Compile below when either the mapping or shared wire is absent.
	}
	const semanticStartedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(graph);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	options.phases.semanticMs += Date.now() - semanticStartedAt;
	const definition = compileSemanticProgramToVmDefinition(semantic, {
		optimization: "development",
		runPhase(phase, run) {
			const startedAt = Date.now();
			try {
				return run();
			} finally {
				const durationMs = Date.now() - startedAt;
				options.phases.compileMs += durationMs;
				options.onCompilePhase?.(phase, durationMs);
			}
		},
	});
	const serializeStartedAt = Date.now();
	const wire = serializeVmDefinition(definition);
	options.phases.serializeMs += Date.now() - serializeStartedAt;
	const wireDigest = digest(wire);
	cacheFrontendWire(wire, artifactRoot);
	publish(mappingPath, `${JSON.stringify({ digest: wireDigest })}\n`);
	return { wire, definition, cache: "miss" };
}

function statementShape(statement: ESTree.Statement): unknown {
	return JSON.parse(
		JSON.stringify(statement, (key, value: unknown) =>
			key === "loc" ? undefined : value,
		),
	) as unknown;
}

function linkageKey(identity: string, graph: ModuleGraph): string {
	return digest(
		JSON.stringify({
			identity,
			modules: [...graph.modules.values()]
				.map((record) => ({
					path: record.path,
					goal: record.goal,
					externalSource: externalModule(record.path) ? digest(record.source) : undefined,
					boundary: record.parsed.ast.body
						.filter(
							(statement) =>
								statement.type === "ImportDeclaration" ||
								statement.type === "ExportNamedDeclaration" ||
								statement.type === "ExportDefaultDeclaration" ||
								statement.type === "ExportAllDeclaration",
						)
						.map(statementShape),
				}))
				.sort((left, right) =>
					left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
				),
		}),
	);
}

function validateLinkage(
	root: string,
	identity: string,
	options: CompileBuildFragmentsOptions,
): void {
	const key = linkageKey(identity, options.graph);
	const marker = path.join(root, "linkages", `${key}.valid`);
	if (existsSync(marker)) return;
	const startedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(options.graph);
	linkModules(semantic);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	options.phases.semanticMs += Date.now() - startedAt;
	publish(marker, `${key}\n`);
}

/** Split stable dependencies from project code into independently cached VM images. */
export function compileBuildFragments(
	options: CompileBuildFragmentsOptions,
): CompiledBuildFragments {
	assertNoBoundaryCycle(options.graph);
	const plans = planBoundary(options.graph);
	const identity = environmentIdentity(options);
	const root = cacheRoot(options.cacheDirectory);
	const artifactRoot = frontendArtifactCacheRoot(options.cacheDirectory);
	validateLinkage(root, identity, options);
	const graphStartedAt = Date.now();
	const base = baseGraph(plans, options, options.session.moduleParses);
	const application = applicationGraph(plans, options, options.session.moduleParses);
	options.phases.graphMs += Date.now() - graphStartedAt;
	const baseArtifact = compileArtifact(
		root,
		artifactRoot,
		identity,
		"dependency-base",
		base,
		options,
	);
	const applicationArtifact = compileArtifact(
		root,
		artifactRoot,
		identity,
		"application",
		application,
		options,
	);
	const hits = [baseArtifact, applicationArtifact].filter(
		(artifact) => artifact.cache === "hit",
	).length;
	return {
		wires: [baseArtifact.wire, applicationArtifact.wire],
		definition: applicationArtifact.definition,
		artifactHits: hits,
		artifactMisses: 2 - hits,
	};
}
