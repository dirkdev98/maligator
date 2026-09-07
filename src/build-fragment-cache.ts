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
import { maligatorCacheDirectory } from "./cache-root.ts";
import {
	compilerConfigurationIdentity,
	compilerProducerIdentity,
} from "./compiler-cache-identity.ts";
import { runSemanticAnalysisForGraph } from "./compiler/frontend/analyze-module-graph.ts";
import {
	ESTREE_SKIP,
	ESTREE_STOP,
	traverseEstree,
} from "./compiler/frontend/estree-traversal.ts";
import { linkModules } from "./compiler/frontend/linker.ts";
import type { ModuleLinkage } from "./compiler/frontend/linker.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
	ModuleParseCache,
} from "./compiler/frontend/module-graph.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import { collectPrimordialMutationDiagnostics } from "./compiler/frontend/primordial-diagnostics.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "./compiler/frontend/semantic-analysis.ts";
import type {
	Binding,
	SemanticFile,
	SemanticProgram,
} from "./compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "./compiler/pipeline/compile-core.ts";
import type { CompileCorePhase } from "./compiler/pipeline/compile-core.ts";
import { compareCompilerDiagnostics } from "./compiler/shared/compiler-diagnostics.ts";
import type { CompilerDiagnostic } from "./compiler/shared/compiler-diagnostics.ts";
import { compilerProgramFactsFromConfig } from "./compiler/shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "./compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
	COMPILER_ARTIFACT_VERSION,
} from "./compiler/target/compiler-artifact-codec.ts";
import { serializeRuntimeImage } from "./compiler/target/program-image-codec.ts";
import {
	compileDependencyFragments,
	DEVELOPMENT_LINKED_MODULES_GLOBAL,
	isExternalModule,
} from "./dependency-fragment-cache.ts";
import type { DependencyFragmentWorker } from "./dependency-fragment-cache.ts";
import {
	cacheFrontendCompilerArtifact,
	cacheFrontendWire,
	frontendArtifactCacheRoot,
	frontendCompilerArtifactIdentity,
	frontendCompilerArtifactUnchanged,
	frontendDigest as digest,
	frontendWirePath,
	FrontendCompilationSession,
} from "./frontend-cache.ts";

const FRAGMENT_SCHEMA = 2;
const CACHE_DIRECTORY = path.join(maligatorCacheDirectory(), "build-fragments");
const IDENTIFIER = /^[$A-Z_a-z][$\w]*$/;

interface PlannedImport {
	specifier: string;
	target: string;
	commonjs: boolean;
	names: Array<string>;
}

interface CompiledArtifact {
	wire: Uint8Array;
	programImage: ReturnType<typeof compileSemanticProgramToProgramImage>;
	runtimeArtifact: BuildFragmentArtifact;
	compilerArtifact: BuildFragmentArtifact;
	diagnostics: Array<CompilerDiagnostic>;
	cache: "hit" | "miss";
}

interface LinkageValidationRequest {
	schema: 1;
	entrypoint: string;
	entryPrelude?: NonNullable<BuildModuleGraphOptions["entryPrelude"]>;
	config: ResolvedBuildConfig;
	stripperIdentity: string;
	cacheDirectory?: string;
	resultPath: string;
}

interface LinkageValidationResult {
	schema: 1;
	ok: boolean;
	error?: string;
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
	runtimeArtifacts: Array<BuildFragmentArtifact>;
	compilerArtifact: BuildFragmentArtifact;
	programImage: ReturnType<typeof compileSemanticProgramToProgramImage>;
	diagnostics: Array<CompilerDiagnostic>;
	artifactHits: number;
	artifactMisses: number;
}

export class UnsupportedBuildFragmentsError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", {
			value: "UnsupportedBuildFragmentsError",
			configurable: true,
		});
	}
}

export interface CompileBuildFragmentsOptions {
	graph: ModuleGraph;
	entryPrelude?: BuildModuleGraphOptions["entryPrelude"];
	config: ResolvedBuildConfig;
	facts: CompilerProgramFacts;
	/** Reuse whole-graph analysis already required by locked-world diagnostics. */
	semantic?: SemanticProgram;
	stripTypes: BuildModuleGraphOptions["stripTypes"];
	stripperIdentity: string;
	cacheDirectory?: string;
	session: FrontendCompilationSession;
	phases: BuildFrontendPhases;
	onCompilePhase?: (phase: CompileCorePhase, durationMs: number) => void;
	dependencyWorker?: DependencyFragmentWorker;
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
		if (record.host || record.virtual || isExternalModule(record.path)) continue;
		for (const dependency of record.dependencies) {
			if (
				dependency.resolvedPath === null ||
				!isExternalModule(dependency.resolvedPath)
			) {
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
				!isExternalModule(dependency.resolvedPath)
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
		if (!isExternalModule(record.path)) continue;
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
					!isExternalModule(dependency.resolvedPath) &&
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
		`const __module = globalThis[${JSON.stringify(DEVELOPMENT_LINKED_MODULES_GLOBAL)}][${JSON.stringify(target)}];`,
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

/**
 * Keep a stable toolchain prelude out of the edited application fragment. The
 * development runner evaluates runtime wires in order, so a separately cached
 * prelude preserves its before-application contract without re-running semantic
 * analysis and Core optimization after every project edit.
 */
function preludeGraph(options: CompileBuildFragmentsOptions): ModuleGraph | undefined {
	const specifier = options.entryPrelude?.specifier;
	if (specifier === undefined) return undefined;
	const reachable = new Set<string>();
	const pending = [specifier];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (reachable.has(current)) continue;
		const record = options.graph.modules.get(current);
		if (record === undefined) {
			throw new UnsupportedBuildFragmentsError(
				`toolchain prelude module '${current}' is missing from the graph`,
			);
		}
		if (current !== specifier && record.host === undefined) {
			throw new UnsupportedBuildFragmentsError(
				"a toolchain prelude with source dependencies requires the whole-image fallback",
			);
		}
		reachable.add(current);
		for (const dependency of record.dependencies) {
			if (dependency.resolvedPath === null) {
				throw new UnsupportedBuildFragmentsError(
					"a toolchain prelude with a computed dependency requires the whole-image fallback",
				);
			}
			pending.push(dependency.resolvedPath);
		}
	}
	for (const cycle of options.graph.cycles) {
		if (
			cycle.some((module) => reachable.has(module)) &&
			cycle.some((module) => !reachable.has(module))
		) {
			throw new UnsupportedBuildFragmentsError(
				"a toolchain prelude cycle requires the whole-image fallback",
			);
		}
	}
	return {
		entry: specifier,
		nodeEnabled: options.graph.nodeEnabled,
		modules: new Map(
			[...options.graph.modules].filter(([module]) => reachable.has(module)),
		),
		evaluationOrder: options.graph.evaluationOrder.filter((module) =>
			reachable.has(module),
		),
		cycles: options.graph.cycles.filter((cycle) =>
			cycle.every((module) => reachable.has(module)),
		),
	};
}

function environmentIdentity(options: CompileBuildFragmentsOptions): string {
	return digest(
		JSON.stringify({
			schema: FRAGMENT_SCHEMA,
			producer: compilerProducerIdentity("build-fragment", FRAGMENT_SCHEMA),
			compilerArtifactVersion: COMPILER_ARTIFACT_VERSION,
			stripper: options.stripperIdentity,
			optimization: "development",
			configuration: compilerConfigurationIdentity(options.config),
			entryPrelude:
				options.entryPrelude === undefined
					? undefined
					: {
							specifier: options.entryPrelude.specifier,
							source: digest(options.entryPrelude.source),
						},
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
			runtimeArtifact?: BuildFragmentArtifact;
			compilerArtifact?: BuildFragmentArtifact;
			diagnostics?: Array<CompilerDiagnostic>;
		};
		if (
			reference.schema !== 3 ||
			reference.runtimeArtifact === undefined ||
			reference.compilerArtifact === undefined ||
			!Array.isArray(reference.diagnostics) ||
			!validArtifact(reference.runtimeArtifact, artifactRoot) ||
			!frontendCompilerArtifactUnchanged(reference.compilerArtifact, artifactRoot)
		) {
			throw new Error("invalid fragment artifact reference");
		}
		let compilerWire: Uint8Array | undefined;
		let runtimeWire: Uint8Array | undefined;
		let programImage: ReturnType<typeof deserializeCompilerArtifact> | undefined;
		const loadCompilerArtifact = () => {
			if (compilerWire !== undefined) return compilerWire;
			compilerWire = new Uint8Array(readFileSync(reference.compilerArtifact!.path));
			if (digest(compilerWire) !== reference.compilerArtifact!.digest) {
				throw new Error("corrupt fragment artifact");
			}
			return compilerWire;
		};
		const loadProgramImage = () =>
			(programImage ??= deserializeCompilerArtifact(loadCompilerArtifact()));
		return {
			get wire() {
				if (runtimeWire !== undefined) return runtimeWire;
				runtimeWire = new Uint8Array(readFileSync(reference.runtimeArtifact!.path));
				if (digest(runtimeWire) !== reference.runtimeArtifact!.digest) {
					throw new Error("corrupt runtime fragment artifact");
				}
				return runtimeWire;
			},
			get programImage() {
				return loadProgramImage();
			},
			runtimeArtifact: reference.runtimeArtifact,
			compilerArtifact: reference.compilerArtifact,
			diagnostics: reference.diagnostics,
			cache: "hit",
		};
	} catch {
		// Compile below when either the mapping or shared wire is absent.
	}
	const semanticStartedAt = Date.now();
	const semantic = runSemanticAnalysisForGraph(graph);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	const diagnostics =
		options.facts.world.primordialPolicy === "locked"
			? collectPrimordialMutationDiagnostics(semantic, options.facts.world, {
					nodeEnabled: options.config.surface.node,
				})
			: [];
	options.phases.semanticMs += Date.now() - semanticStartedAt;
	const programImage = compileSemanticProgramToProgramImage(semantic, {
		facts: options.facts,
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
	const artifactWire = serializeCompilerArtifact(programImage);
	const wire = serializeRuntimeImage(programImage.runtime);
	options.phases.serializeMs += Date.now() - serializeStartedAt;
	const runtimeDigest = digest(wire);
	const compilerDigest = digest(artifactWire);
	cacheFrontendWire(wire, artifactRoot);
	cacheFrontendCompilerArtifact(artifactWire, artifactRoot);
	const runtimeArtifact = artifactIdentity(runtimeDigest, artifactRoot);
	const compilerArtifact = frontendCompilerArtifactIdentity(compilerDigest, artifactRoot);
	if (runtimeArtifact === undefined || compilerArtifact === undefined) {
		throw new Error("fragment artifacts are missing after publication");
	}
	publish(
		mappingPath,
		`${JSON.stringify({ schema: 3, runtimeArtifact, compilerArtifact, diagnostics })}\n`,
	);
	return {
		wire,
		programImage,
		runtimeArtifact,
		compilerArtifact,
		diagnostics,
		cache: "miss",
	};
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
				.filter((record) => isExternalModule(record.path))
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
	const semantic = options.semantic ?? runSemanticAnalysisForGraph(options.graph);
	const linkage = linkModules(semantic);
	assertSnapshotSafeExports(semantic, linkage, plans);
	assertEvalPolicy(options.config, collectDisallowedEvalUsage(semantic));
	assertRegexpPolicy(options.config, collectDisallowedRegexpUsage(semantic));
	options.phases.semanticMs += Date.now() - startedAt;
	publish(marker, `${key}\n`);
}

function prepareParallelLinkageValidation(
	root: string,
	identity: string,
	options: CompileBuildFragmentsOptions,
	plans: Array<PlannedImport>,
): { task: Array<string>; resultPath: string } | undefined {
	const key = linkageKey(identity, options.graph, plans);
	const marker = path.join(root, "linkages", `${key}.valid`);
	if (existsSync(marker)) return undefined;
	const resultPath = path.join(root, "requests", `${key}.linkage-result.json`);
	const request: LinkageValidationRequest = {
		schema: 1,
		entrypoint: options.graph.entry,
		...(options.entryPrelude === undefined ? {} : { entryPrelude: options.entryPrelude }),
		config: options.config,
		stripperIdentity: options.stripperIdentity,
		...(options.cacheDirectory === undefined
			? {}
			: { cacheDirectory: options.cacheDirectory }),
		resultPath,
	};
	const requestPath = path.join(root, "requests", `${key}.linkage-request.json`);
	publish(requestPath, `${JSON.stringify(request)}\n`);
	return {
		task: ["--maligator-internal-linkage-validation", requestPath],
		resultPath,
	};
}

function finishParallelLinkageValidation(resultPath: string): void {
	const result = JSON.parse(readFileSync(resultPath, "utf-8")) as
		| LinkageValidationResult
		| undefined;
	if (result?.schema !== 1 || typeof result.ok !== "boolean") {
		throw new Error("invalid dependency linkage worker result");
	}
	if (!result.ok) {
		throw new UnsupportedBuildFragmentsError(
			result.error ?? "dependency linkage validation failed",
		);
	}
}

/** Internal worker entry for linkage validation overlapped with island compilation. */
export function validateBuildFragmentRequest(
	file: string,
	stripTypes: BuildModuleGraphOptions["stripTypes"],
): void {
	const request = JSON.parse(readFileSync(path.resolve(file), "utf-8")) as
		| LinkageValidationRequest
		| undefined;
	if (
		request?.schema !== 1 ||
		typeof request.entrypoint !== "string" ||
		typeof request.resultPath !== "string"
	) {
		throw new Error("invalid dependency linkage worker request");
	}
	try {
		const graph = buildModuleGraph(request.entrypoint, {
			buildConfig: request.config,
			stripTypes,
			entryPrelude: request.entryPrelude,
		});
		assertNoBoundaryCycle(graph);
		const plans = planBoundary(graph);
		const phases: BuildFrontendPhases = {
			validationMs: 0,
			graphMs: 0,
			semanticMs: 0,
			compileMs: 0,
			serializeMs: 0,
			workerMs: 0,
		};
		const session = new FrontendCompilationSession();
		const options: CompileBuildFragmentsOptions = {
			graph,
			entryPrelude: request.entryPrelude,
			config: request.config,
			facts: compilerProgramFactsFromConfig(request.config),
			stripTypes,
			stripperIdentity: request.stripperIdentity,
			cacheDirectory: request.cacheDirectory,
			session,
			phases,
		};
		validateLinkage(
			cacheRoot(request.cacheDirectory),
			environmentIdentity(options),
			options,
			plans,
		);
		publish(
			request.resultPath,
			`${JSON.stringify({ schema: 1, ok: true } satisfies LinkageValidationResult)}\n`,
		);
	} catch (error) {
		if (!(error instanceof UnsupportedBuildFragmentsError)) throw error;
		publish(
			request.resultPath,
			`${JSON.stringify({ schema: 1, ok: false, error: error.message } satisfies LinkageValidationResult)}\n`,
		);
	}
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
	const parallelValidation =
		options.dependencyWorker === undefined || options.semantic !== undefined
			? undefined
			: prepareParallelLinkageValidation(root, identity, options, plans);
	if (options.dependencyWorker === undefined || options.semantic !== undefined) {
		validateLinkage(root, identity, options, plans);
	}
	const dependencyArtifacts = compileDependencyFragments({
		graph: options.graph,
		targets: plans.map(({ target, commonjs }) => ({ target, commonjs })),
		config: options.config,
		facts: options.facts,
		stripTypes: options.stripTypes,
		stripperIdentity: options.stripperIdentity,
		cacheDirectory: options.cacheDirectory,
		session: options.session,
		phases: options.phases,
		onCompilePhase: options.onCompilePhase,
		worker: options.dependencyWorker,
		parallelWorkerTasks:
			parallelValidation === undefined ? [] : [parallelValidation.task],
	});
	if (parallelValidation !== undefined) {
		finishParallelLinkageValidation(parallelValidation.resultPath);
	}
	const prelude = preludeGraph(options);
	const preludeArtifact =
		prelude === undefined
			? undefined
			: compileArtifact(
					root,
					artifactRoot,
					identity,
					"toolchain-prelude",
					prelude,
					options,
				);
	const graphStartedAt = Date.now();
	const application = applicationGraph(plans, options, options.session.moduleParses);
	options.phases.graphMs += Date.now() - graphStartedAt;
	const applicationArtifact = compileArtifact(
		root,
		artifactRoot,
		identity,
		"application",
		application,
		options,
	);
	const hits =
		(preludeArtifact?.cache === "hit" ? 1 : 0) +
		dependencyArtifacts.filter((artifact) => artifact.cache === "hit").length +
		(applicationArtifact.cache === "hit" ? 1 : 0);
	const compiledArtifacts = [
		...(preludeArtifact === undefined ? [] : [preludeArtifact]),
		...dependencyArtifacts,
		applicationArtifact,
	];
	return {
		get wires() {
			return compiledArtifacts.map((artifact) => artifact.wire);
		},
		runtimeArtifacts: compiledArtifacts.map((artifact) =>
			"runtimeArtifact" in artifact ? artifact.runtimeArtifact : artifact,
		),
		compilerArtifact: applicationArtifact.compilerArtifact,
		programImage: applicationArtifact.programImage,
		diagnostics: compiledArtifacts
			.flatMap((artifact) => artifact.diagnostics)
			.sort(compareCompilerDiagnostics),
		artifactHits: hits,
		artifactMisses: compiledArtifacts.length - hits,
	};
}
