import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
import type { ModuleLinkage } from "./linker.ts";
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
import type { Binding, SemanticFile, SemanticProgram } from "./semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "./semantic-program.ts";
import {
	deserializeVmDefinition,
	serializeVmDefinition,
	WIRE_VERSION,
} from "./serialize-vm.ts";
import { MALIGATOR_VERSION } from "./version.ts";

const FRAGMENT_SCHEMA = 4;
const CACHE_DIRECTORY = ".cache/mal-cache/build-fragments";
const LINKED_MODULES_GLOBAL = "__maligatorDevelopmentLinkedModules";
const IDENTIFIER = /^[$A-Z_a-z][$\w]*$/;

interface PlannedImport {
	specifier: string;
	target: string;
	commonjs: boolean;
	names: Array<string>;
}

interface CompiledArtifact {
	wire: Uint8Array;
	definition: ReturnType<typeof compileSemanticProgramToVmDefinition>;
	artifact: BuildFragmentArtifact;
	cache: "hit" | "miss";
}

export interface BuildFragmentArtifact {
	digest: string;
	path: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	dev: number;
}

export interface CompiledBuildFragments {
	wires: Array<Uint8Array>;
	artifacts: Array<BuildFragmentArtifact>;
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
				planned = {
					specifier,
					target: dependency.resolvedPath,
					commonjs: graph.modules.get(dependency.resolvedPath)?.goal === "cjs",
					names: [],
				};
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

function facadeSource(target: string, names: Array<string>, commonjs: boolean): string {
	if (names.length === 0) return "";
	const lines = [
		`const __module = globalThis[${JSON.stringify(LINKED_MODULES_GLOBAL)}][${JSON.stringify(target)}];`,
	];
	for (const [index, name] of names.entries()) {
		const local = `__maligatorImport${index}`;
		const value =
			commonjs && name === "default" ? "__module" : `__module[${JSON.stringify(name)}]`;
		lines.push(`const ${local} = ${value};`);
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
	const targets = [
		...new Map(plans.map((plan) => [plan.target, plan.commonjs])).entries(),
	].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	const imports = targets
		.map(([target, commonjs], index) =>
			commonjs
				? `import __maligatorModule${index} from ${JSON.stringify(target)};`
				: `import * as __maligatorModule${index} from ${JSON.stringify(target)};`,
		)
		.join("\n");
	const publications = targets
		.map(
			([target], index) =>
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
			source: facadeSource(plan.target, plan.names, plan.commonjs),
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

function artifactIdentity(
	digest: string,
	artifactRoot: string,
): BuildFragmentArtifact | undefined {
	try {
		const file = frontendWirePath(digest, artifactRoot);
		const stats = statSync(file);
		if (!stats.isFile()) return undefined;
		return {
			digest,
			path: file,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ctimeMs: stats.ctimeMs,
			ino: stats.ino,
			dev: stats.dev,
		};
	} catch {
		return undefined;
	}
}

function validArtifact(artifact: BuildFragmentArtifact, artifactRoot: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(artifact.digest)) return false;
	const current = artifactIdentity(artifact.digest, artifactRoot);
	return (
		current !== undefined &&
		current.path === artifact.path &&
		current.size === artifact.size &&
		current.mtimeMs === artifact.mtimeMs &&
		current.ctimeMs === artifact.ctimeMs &&
		current.ino === artifact.ino &&
		current.dev === artifact.dev
	);
}

function compileArtifact(
	root: string,
	artifactRoot: string,
	identity: string,
	kind: string,
	graph: ModuleGraph,
	options: CompileBuildFragmentsOptions,
): CompiledArtifact {
	const key = graphKey(identity, kind, graph);
	const mappingPath = path.join(root, "artifacts", `${key}.json`);
	try {
		const reference = JSON.parse(readFileSync(mappingPath, "utf-8")) as {
			schema?: number;
			artifact?: BuildFragmentArtifact;
		};
		if (
			reference.schema !== 1 ||
			reference.artifact === undefined ||
			!validArtifact(reference.artifact, artifactRoot)
		) {
			throw new Error("invalid fragment artifact reference");
		}
		let wire: Uint8Array | undefined;
		let definition: ReturnType<typeof deserializeVmDefinition> | undefined;
		const loadWire = () => {
			if (wire !== undefined) return wire;
			wire = new Uint8Array(readFileSync(reference.artifact!.path));
			if (digest(wire) !== reference.artifact!.digest) {
				throw new Error("corrupt fragment artifact");
			}
			return wire;
		};
		return {
			get wire() {
				return loadWire();
			},
			get definition() {
				return (definition ??= deserializeVmDefinition(loadWire()));
			},
			artifact: reference.artifact,
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
	const artifact = artifactIdentity(wireDigest, artifactRoot);
	if (artifact === undefined) {
		throw new Error(`fragment artifact is missing after publication: ${wireDigest}`);
	}
	publish(mappingPath, `${JSON.stringify({ schema: 1, artifact })}\n`);
	return { wire, definition, artifact, cache: "miss" };
}

function linkageKey(
	identity: string,
	graph: ModuleGraph,
	plans: Array<PlannedImport>,
): string {
	return digest(
		JSON.stringify({
			identity,
			plans,
			modules: [...graph.modules.values()]
				.filter((record) => externalModule(record.path))
				.map((record) => ({
					path: record.path,
					goal: record.goal,
					source: digest(record.source),
				}))
				.sort((left, right) =>
					left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
				),
		}),
	);
}

function addPatternTargets(node: ESTree.Node, targets: Set<ESTree.Node>): void {
	switch (node.type) {
		case "Identifier":
			targets.add(node);
			break;
		case "ArrayPattern":
			for (const element of node.elements) {
				if (element !== null) addPatternTargets(element, targets);
			}
			break;
		case "ObjectPattern":
			for (const property of node.properties) {
				if ("argument" in property) {
					addPatternTargets(property.argument, targets);
				} else if ("value" in property) {
					addPatternTargets(property.value, targets);
				}
			}
			break;
		case "AssignmentPattern":
			addPatternTargets(node.left, targets);
			break;
		case "RestElement":
			addPatternTargets(node.argument, targets);
			break;
	}
}

function lateAssignmentTargets(file: SemanticFile): Set<ESTree.Node> {
	const targets = new Set<ESTree.Node>();
	const parents = new Map<ESTree.Node, ESTree.Node>();
	traverseEstree(file.ast.body, (node, at) => {
		if (at.parent !== null) parents.set(node, at.parent);
		if (node.type === "AssignmentExpression") {
			addPatternTargets(node.left, targets);
		} else if (node.type === "UpdateExpression") {
			addPatternTargets(node.argument, targets);
		} else if (
			(node.type === "ForInStatement" || node.type === "ForOfStatement") &&
			node.left.type !== "VariableDeclaration"
		) {
			addPatternTargets(node.left, targets);
		}
	});
	return new Set(
		[...targets].filter((target) => {
			let ancestor = parents.get(target);
			while (ancestor !== undefined) {
				if (
					ancestor.type === "FunctionDeclaration" ||
					ancestor.type === "FunctionExpression" ||
					ancestor.type === "ArrowFunctionExpression"
				) {
					return true;
				}
				ancestor = parents.get(ancestor);
			}
			return false;
		}),
	);
}

function bindingOwner(
	program: SemanticProgram,
	binding: Binding,
): SemanticFile | undefined {
	return program.files.find((file) =>
		file.scopes.some((scope) => scope.bindings.includes(binding)),
	);
}

function assertSnapshotSafeExports(
	program: SemanticProgram,
	linkage: ModuleLinkage,
	plans: Array<PlannedImport>,
): void {
	const targetsByFile = new Map<SemanticFile, Set<ESTree.Node>>();
	for (const plan of plans) {
		if (program.graph?.modules.get(plan.target)?.goal === "cjs") continue;
		const namespace = linkage.moduleNamespaces.get(plan.target) ?? [];
		for (const name of plan.names) {
			const exporter = namespace.find((candidate) => candidate.name === name)?.exporter;
			if (exporter === undefined) continue; // The linker reports the missing export.
			if (exporter.kind === "const") continue;
			const owner = bindingOwner(program, exporter);
			if (owner === undefined) {
				throw new UnsupportedBuildFragmentsError(
					`export '${name}' from '${plan.specifier}' has no stable owner`,
				);
			}
			if (owner.hasDirectEval.has(owner.ast)) {
				throw new UnsupportedBuildFragmentsError(
					`mutable export '${name}' from '${plan.specifier}' requires the whole-image fallback`,
				);
			}
			let targets = targetsByFile.get(owner);
			if (targets === undefined) {
				// The dependency image publishes its namespaces only after synchronous
				// module evaluation, so top-level initialization writes are already
				// reflected in the snapshot. Writes enclosed by callable code can occur
				// later and therefore require true live-binding storage.
				targets = lateAssignmentTargets(owner);
				targetsByFile.set(owner, targets);
			}
			if (exporter.usageNodes.some((usage) => targets.has(usage))) {
				throw new UnsupportedBuildFragmentsError(
					`live export '${name}' from '${plan.specifier}' requires the whole-image fallback`,
				);
			}
		}
	}
}

function validateLinkage(
	root: string,
	identity: string,
	options: CompileBuildFragmentsOptions,
	plans: Array<PlannedImport>,
): void {
	const key = linkageKey(identity, options.graph, plans);
	const marker = path.join(root, "linkages", `${key}.valid`);
	if (existsSync(marker)) return;
	const startedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(options.graph);
	const linkage = linkModules(semantic);
	assertSnapshotSafeExports(semantic, linkage, plans);
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
	validateLinkage(root, identity, options, plans);
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
		get wires() {
			return [baseArtifact.wire, applicationArtifact.wire];
		},
		artifacts: [baseArtifact.artifact, applicationArtifact.artifact],
		definition: applicationArtifact.definition,
		artifactHits: hits,
		artifactMisses: 2 - hits,
	};
}
