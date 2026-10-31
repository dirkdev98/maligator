import { hash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ESTree } from "meriyah";
import type { ResolvedBuildConfig } from "../../build-config.ts";
import type { PlatformModule } from "../../platform/catalog.ts";
import { PLATFORM_MODULES, lookupPlatformModule } from "../../platform/catalog.ts";
import type { Execution } from "../../platform/execution.ts";
import { executionData } from "../../platform/execution.ts";
import { moduleCreateRequireDeclarators } from "./create-require.ts";
import { traverseEstree } from "./estree-traversal.ts";
import type { HostModuleSpec } from "./host-modules.ts";
import {
	canonicalNodeBuiltinId,
	canonicalNodeHostModuleId,
	isNodeSpecifier,
	lookupHostModule,
	supportedHostModuleIds,
} from "./host-modules.ts";
import { isImportMetaResolveCall } from "./import-meta.ts";
import { staticModuleClosure } from "./module-closure.ts";
import { parseModule, parseScript } from "./parser.ts";
import type { SemanticFile } from "./semantic-analysis.ts";
import { SyntaxDiagnostic } from "./syntax-diagnostic.ts";
import { discoverWorkerEntries } from "./worker-entries.ts";
import type { WorkerEntryDeclaration } from "./worker-entries.ts";

/** TypeScript source extensions stripped to JS before parsing. */
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

/**
 * The loader/graph phase: the bundler front-end that sits *above* semantic
 * analysis and Core lowering. Starting from an entrypoint it resolves the module
 * graph (goal detection -> specifier extraction -> resolution), recursing into
 * every dependency, and computes a deterministic evaluation order with cycles
 * identified.
 *
 * This phase only builds the graph; it does
 * not lower imports/exports to Core (that is a later milestone). A program with
 * no imports is simply a single-node graph, so the existing single-file path is
 * unchanged.
 */

export type ModuleGoal = "script" | "module" | "cjs";

export type ModuleDependencyKind =
	// `import ... from "x"`
	| "import"
	// `import defer * as ns from "x"`
	| "deferred-import"
	// `export ... from "x"` / `export * from "x"`
	| "export"
	// `import("x")`
	| "dynamic"
	| "worker"
	// `require("x")` in a CommonJS module
	| "require";

export interface ModuleDependency {
	/** The raw specifier as written, or null for a computed `import(expr)`. */
	specifier: string | null;
	kind: ModuleDependencyKind;
	/**
	 * Absolute path the specifier resolved to, or null when it could not be
	 * resolved (a computed dependency or a dynamic import whose literal target
	 * cannot be found). Unresolved static imports/exports and literal `require()`
	 * calls throw during graph construction rather than landing here.
	 */
	resolvedPath: string | null;
	/**
	 * A missing literal CommonJS require whose synchronous resolution error is
	 * caught by a surrounding try/catch in the same execution context.
	 */
	catchableMissing?: true;
}

/** What a literal `import.meta.resolve(specifier)` answers: a file, or any other URL. */
export type ImportMetaResolution =
	| { specifier: string; path: string }
	| { specifier: string; url: string };

export interface ModuleRecord {
	sourcePath?: string;
	/**
	 * Absolute, resolved path — or, for a host virtual module, its canonical
	 * specifier (e.g. `"node:path"`).
	 */
	path: string;
	goal: ModuleGoal;
	source: string;
	parsed: Pick<SemanticFile, "type" | "strict" | "ast">;
	dependencies: Array<ModuleDependency>;
	/** Literal `import.meta.resolve` specifiers that resolve; the rest throw at run time. */
	importMetaResolutions?: ReadonlyArray<ImportMetaResolution>;
	/**
	 * Set for a `node:*` host built-in resolved from the static catalog
	 * (host-modules.ts) rather than read from disk. Carries the planned export
	 * surface the linker will bind once host exports land; until then the record
	 * has no user source (empty parse) and is skipped by semantic analysis.
	 */
	host?: HostModuleSpec;
	/** In-memory source supplied by the embedding toolchain (for example maligator:test). */
	virtual?: true;
	platform?: PlatformModule;
	/**
	 * Owned and already evaluated by an earlier image of a relocatable program. The
	 * record has no source; its interface lets the linker bind imports that the
	 * loader resolves against that image's published exports.
	 */
	external?: ExternalModuleInterface;
	/**
	 * Why the module could not be loaded. Only a module the entry reaches through
	 * `import()` keeps one: importing it rejects with this error at run time, while a
	 * static import of it fails the build.
	 */
	loadError?: SyntaxDiagnostic;
}

/** The linkable surface an earlier image publishes for one of its modules. */
export interface ExternalModuleInterface {
	goal: "module" | "cjs";
	/**
	 * ESM: every resolvable export name, `export *` included. CommonJS: the
	 * statically detected `module.exports` names.
	 */
	exports: ReadonlyArray<string>;
}

export interface ModuleGraph {
	workerEntries?: Array<WorkerEntryDeclaration>;
	dynamicImportCandidates?: ReadonlyArray<string>;
	execution?: Execution;
	/** Absolute path of the entrypoint. */
	entry: string;
	/**
	 * Whether the node host built-in surface (`surface.node`) is on for this
	 * build. Recorded so downstream stages (linker/ir) gate host-module export
	 * binding + `process` retention on it without re-reading the build config.
	 */
	nodeEnabled: boolean;
	modules: Map<string, ModuleRecord>;
	/**
	 * Post-order over the static-import edges: dependencies precede dependents,
	 * so the entry is last. This is the module evaluation order. Dynamic
	 * `import()` edges do not participate in ordering.
	 */
	evaluationOrder: Array<string>;
	/**
	 * Strongly-connected components over the static-import edges that form a
	 * cycle (more than one member, or a self-import). These are where live
	 * bindings + TDZ need care once import lowering lands.
	 */
	cycles: Array<Array<string>>;
}

interface CachedModuleParse {
	source: string;
	goal: ModuleGoal;
	parsed: ModuleRecord["parsed"];
	dependencies: Array<ExtractedDependency>;
}

/** What a graph walk needs from a parse, kept across processes by the parsed source. */
export interface PersistedModuleParse {
	sourceDigest: string;
	type: ModuleRecord["parsed"]["type"];
	strict: boolean;
	dependencies: Array<ExtractedDependency>;
}

/**
 * A memoized load kept across processes. Its source is read again and must match
 * `sourceDigest`; the AST is parsed only if a consumer reads it.
 */
export interface PersistedModuleLoad {
	sourceDigest: string;
	sourcePath?: string;
	type: ModuleRecord["parsed"]["type"];
	strict: boolean;
	dependencies: Array<ModuleDependency>;
	importMetaResolutions?: Array<ImportMetaResolution>;
	observations: Array<[string, string]>;
}

/** A module's analysed load and every filesystem observation its resolution made. */
interface MemoizedModuleLoad {
	source: string;
	/** Undefined for a supplied source, which is compared by value instead. */
	sourceIdentity: string | undefined;
	sourcePath: string | undefined;
	parsed: ModuleRecord["parsed"];
	dependencies: ReadonlyArray<ModuleDependency>;
	importMetaResolutions: ReadonlyArray<ImportMetaResolution>;
	observations: ReadonlyArray<readonly [string, string]>;
}

/**
 * Retained, single-revision parse cache keyed by stable module path and goal. With
 * persisted parses, a module whose parsed source is unchanged skips parsing; its
 * AST is parsed only if a consumer such as semantic analysis reads it. A retained
 * cache also memoizes each module's resolved load, so a later walk only checks the
 * files that load read.
 */
export class ModuleParseCache {
	readonly #records = new Map<string, CachedModuleParse>();
	readonly #loads = new Map<string, MemoizedModuleLoad>();
	/** Parsed package.json contents by path, valid while the file keeps its identity. */
	readonly packageJsons = new Map<string, { identity: string; parsed: unknown }>();
	#persisted: Map<string, PersistedModuleParse> | undefined;
	#persistedLoads: Map<string, PersistedModuleLoad> | undefined;
	#persistedChanged = false;
	#hits = 0;
	#misses = 0;

	usePersisted(
		parses: Record<string, PersistedModuleParse>,
		loads: Record<string, PersistedModuleLoad>,
	): void {
		this.#persisted = new Map(Object.entries(parses));
		this.#persistedLoads = new Map(Object.entries(loads));
	}

	/** The persisted parses and loads when this cache learned new ones, else undefined. */
	takePersistedChanges():
		| {
				parses: Record<string, PersistedModuleParse>;
				loads: Record<string, PersistedModuleLoad>;
		  }
		| undefined {
		if (!this.#persistedChanged || this.#persisted === undefined) return undefined;
		this.#persistedChanged = false;
		return {
			parses: Object.fromEntries(this.#persisted),
			loads: Object.fromEntries(this.#persistedLoads ?? []),
		};
	}

	persistedLoad(key: string): PersistedModuleLoad | undefined {
		return this.#persistedLoads?.get(key);
	}

	persistLoad(key: string, load: PersistedModuleLoad): void {
		if (this.#persistedLoads === undefined) return;
		this.#persistedLoads.set(key, load);
		this.#persistedChanged = true;
	}

	invalidate(file?: string): void {
		if (file === undefined) {
			this.#records.clear();
			this.#loads.clear();
			return;
		}
		const resolved = path.resolve(file);
		for (const goal of ["script", "module", "cjs"] as const) {
			for (const strict of [false, true]) {
				this.#records.delete(`${goal}\0${strict}\0${resolved}`);
			}
		}
	}

	statistics(): { hits: number; misses: number } {
		return { hits: this.#hits, misses: this.#misses };
	}

	memoizedLoad(key: string): MemoizedModuleLoad | undefined {
		return this.#loads.get(key);
	}

	/** A reused load also reuses its parse. */
	countReusedLoad(): void {
		this.#hits++;
	}

	memoizeLoad(key: string, load: MemoizedModuleLoad): void {
		this.#loads.set(key, load);
	}

	parse(
		file: string,
		source: string,
		goal: ModuleGoal,
		compute: () => Pick<CachedModuleParse, "parsed" | "dependencies">,
		strict = true,
	): Pick<CachedModuleParse, "parsed" | "dependencies"> {
		const key = `${goal}\0${strict}\0${file}`;
		const cached = this.#records.get(key);
		if (cached !== undefined && cached.source === source) {
			this.#hits++;
			return cached;
		}

		const persistedParses = this.#persisted;
		const sourceDigest =
			persistedParses === undefined ? undefined : hash("sha256", source, "hex");
		const persisted = persistedParses?.get(key);
		if (persisted !== undefined && persisted.sourceDigest === sourceDigest) {
			this.#hits++;
			let ast: ESTree.Program | undefined;
			const record: CachedModuleParse = {
				source,
				goal,
				parsed: {
					type: persisted.type,
					strict: persisted.strict,
					get ast() {
						return (ast ??= compute().parsed.ast);
					},
				},
				dependencies: persisted.dependencies,
			};
			this.#records.set(key, record);
			return record;
		}

		this.#misses++;
		const result = compute();
		this.#records.set(key, {
			source,
			goal,
			...result,
		});
		if (persistedParses !== undefined && sourceDigest !== undefined) {
			persistedParses.set(key, {
				sourceDigest,
				type: result.parsed.type,
				strict: result.parsed.strict,
				dependencies: result.dependencies,
			});
			this.#persistedChanged = true;
		}
		return result;
	}
}

export interface BuildModuleGraphOptions {
	/**
	 * Blank TypeScript syntax in place. Required when any `.ts`, `.mts`, or
	 * `.cts` module is loaded; JavaScript-only graphs do not need a callback.
	 * The callback receives the physical source path for catalog-backed modules.
	 */
	stripTypes?: (source: string, filePath: string) => string;

	/** Force the entrypoint's goal, bypassing extension-based detection. */
	entryGoal?: ModuleGoal;
	/** Initial script strictness; source directives still take effect. Modules are always strict. */
	entryStrict?: boolean;

	/**
	 * Use this source for the entrypoint instead of reading it from disk. The
	 * entrypoint's path is still used for resolving its (on-disk) dependencies.
	 * Sibling imports still resolve from the entrypoint's real directory.
	 */
	entrySource?: string;

	/**
	 * Toolchain-owned module evaluated before the application entrypoint. CommonJS
	 * entries synchronously require it; ESM entries import it. The module remains a
	 * virtual graph record, so it never becomes a runtime filesystem dependency.
	 */
	entryPrelude?: {
		specifier: string;
		source: string;
	};

	/**
	 * Force the goal of *every* module in the graph, bypassing all detection.
	 * Used when the caller knows the whole graph is one goal (e.g. test262 module
	 * tests, where `.js` fixtures are modules despite the extension).
	 */
	goalOverride?: ModuleGoal;

	/**
	 * Force non-entry dependencies to this goal while preserving the entry goal.
	 * Used by Test262 dynamic-import script tests: the test body is a Script, but
	 * sibling `*_FIXTURE.js` dynamic-import targets are Module Records.
	 */
	dependencyGoalOverride?: ModuleGoal;

	/**
	 * Modules the embedding host permits computed import() calls to resolve to.
	 * AOT builds cannot discover these targets from the expression itself, so the
	 * host supplies the finite candidate set that is bundled but not eagerly run.
	 */
	dynamicImportCandidates?: ReadonlyArray<string>;
	platformSourceRoot?: string;

	/**
	 * CommonJS modules that join the graph without the entry evaluating them. They
	 * run when first required, possibly from a later image, exactly as they would
	 * in a graph that reaches them only through `require`.
	 */
	requiredRoots?: ReadonlyArray<string>;

	/**
	 * The resolved build config, which gates surface-dependent resolution: the
	 * `node` package export condition and `node:*` host built-in imports are active
	 * only under `surface.node`. Defaults to the product defaults (node OFF).
	 */
	buildConfig?: ResolvedBuildConfig;
	/** Immutable application context shared by all compilation fragments. */
	execution?: Execution;

	/**
	 * Toolchain-owned modules that resolve without a package or filesystem entry.
	 * Their public specifier is also their stable graph identity. This is an
	 * embedding seam, not a user alias mechanism.
	 */
	virtualModules?: ReadonlyMap<
		string,
		{ source: string; goal?: Exclude<ModuleGoal, "cjs">; platform?: boolean }
	>;

	/**
	 * Transform a module's parse input without changing its source identity.
	 * Toolchain features use this to inject protocol-only evaluation boundaries
	 * while caches and file watchers fingerprint the original source contents.
	 */
	transformSource?: {
		/** The only modules the transform changes; every other module stays reusable. */
		files: ReadonlySet<string>;
		transform(source: string, filePath: string): string;
	};

	/** In-process parse reuse for retained compiler/test sessions. */
	parseCache?: ModuleParseCache;

	/**
	 * Modules owned by earlier images, keyed by graph identity. The walk stops at
	 * them: their records carry only an interface, and the compiled image imports
	 * their bindings through the loader instead of compiling them again.
	 */
	externalModules?: ReadonlyMap<string, ExternalModuleInterface>;
}

/**
 * Package `exports` conditions recognized regardless of surface. The `node`
 * condition is added only under `surface.node` (see {@link exportConditions}),
 * so a package's `node`-specific entry is inert unless the build opts into the
 * node surface.
 */
/** The active `exports` conditions for a dependency edge. */
function exportConditions(
	nodeEnabled: boolean,
	mode: "import" | "require",
): ReadonlySet<string> {
	const conditions = ["maligator", mode, "default"];
	return new Set(nodeEnabled ? [...conditions, "node"] : conditions);
}

interface ResolveContext {
	conditions: ReadonlySet<string>;
	nodeEnabled: boolean;
	/** Host modules of the build's C libraries, keyed by specifier. */
	ffiModules: ReadonlyMap<string, HostModuleSpec>;
	// Metadata and derived goals share one graph's lifetime, including cached misses.
	packageJsonCache: Map<string, PackageJson | null>;
	packageTypeCache: Map<string, ModuleGoal | undefined>;
	observed: Map<string, string>;
	/** The observations of the module whose load is being memoized. */
	recording: Array<[string, string]> | undefined;
	retainedPackageJsons: Map<string, { identity: string; parsed: unknown }> | undefined;
}

const platformCatalogs = new Map<
	string,
	{ owned: ReadonlySet<string>; sources: ReadonlyMap<string, string> }
>();

/**
 * The platform files below a source root: those that may import internal modules,
 * and the catalog identity of each source module a path import reaches.
 */
function platformCatalogFiles(sourceRoot: string): {
	owned: ReadonlySet<string>;
	sources: ReadonlyMap<string, string>;
} {
	let files = platformCatalogs.get(sourceRoot);
	if (files === undefined) {
		const owned = new Set<string>();
		const sources = new Map<string, string>();
		for (const platformModule of PLATFORM_MODULES) {
			if (platformModule.kind === "source") {
				const file = path.resolve(sourceRoot, platformModule.sourceFile);
				owned.add(file);
				if (platformModule.id !== "maligator:test" && !sources.has(file))
					sources.set(file, platformModule.id);
			}
			for (const entry of platformModule.exports) {
				const workerSource = (entry.contract as { workerSource?: string }).workerSource;
				if (workerSource !== undefined) owned.add(path.resolve(sourceRoot, workerSource));
			}
		}
		files = { owned, sources };
		platformCatalogs.set(sourceRoot, files);
	}
	return files;
}

/** Modules of the build's C libraries; the rest of the name is the configured library. */
const FFI_SPECIFIER_PREFIX = "maligator:ffi/";

/** Extensions probed when a specifier omits one. */
const RESOLVE_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts", ".json"];

/**
 * Build the module graph reachable from an entrypoint.
 */
export function buildModuleGraph(
	entryPath: string,
	options: BuildModuleGraphOptions = {},
): ModuleGraph {
	const entry = path.resolve(entryPath);
	const modules = new Map<string, ModuleRecord>();

	const nodeEnabled = options.buildConfig?.surface.node ?? false;
	const ffiModules = options.buildConfig?.ffiModules ?? [];
	const ctx: ResolveContext = {
		nodeEnabled,
		ffiModules: new Map(
			ffiModules.map((library) => [
				library.id,
				{
					id: library.id,
					named: library.exports,
					hasDefault: false,
					installer: library.installer,
					direct: library.direct,
				},
			]),
		),
		conditions: exportConditions(nodeEnabled, "import"),
		packageJsonCache: new Map(),
		packageTypeCache: new Map(),
		observed: new Map(),
		recording: undefined,
		retainedPackageJsons: options.parseCache?.packageJsons,
	};
	const sourceRoot =
		options.platformSourceRoot ?? fileURLToPath(new URL("../../", import.meta.url));
	const catalogFiles = platformCatalogFiles(sourceRoot);
	// A transform may change any module's parse input, so its walks memoize nothing.
	const memoIdentity =
		options.parseCache === undefined
			? undefined
			: hash(
					"sha256",
					JSON.stringify({
						aliases: options.buildConfig?.modules.aliases ?? {},
						nodeEnabled,
						ffiModules,
						sourceRoot,
						goalOverride: options.goalOverride,
						dependencyGoalOverride: options.dependencyGoalOverride,
						stripTypes: options.stripTypes !== undefined,
						entryPrelude: options.entryPrelude,
						virtualModules: [...(options.virtualModules ?? [])],
					}),
					"hex",
				);
	const catalogSources = new Map<
		string,
		{ source: string; goal: "module"; platform: true; sourcePath: string }
	>();
	const virtualModule = (specifier: string) => {
		const supplied = options.virtualModules?.get(specifier);
		if (supplied !== undefined) return supplied;
		if (options.entryPrelude?.specifier === specifier)
			return {
				source: options.entryPrelude.source,
				goal: "module" as const,
				platform: false,
			};
		const module = lookupPlatformModule(specifier);
		if (module?.kind !== "source" || specifier === "maligator:test") return undefined;
		let source = catalogSources.get(specifier);
		if (source === undefined) {
			const sourcePath = path.resolve(sourceRoot, module.sourceFile);
			source = {
				source: readFileSync(sourcePath, "utf-8"),
				goal: "module",
				platform: true,
				sourcePath,
			};
			catalogSources.set(specifier, source);
		}
		return source;
	};

	/** A module's parse input before the entry's prelude and any source transform. */
	const baseParseSource = (
		filePath: string,
		source: string,
		goal: ModuleGoal,
		sourcePath: string | undefined,
	): string => {
		let parseSource = blankHashbang(source);
		if (path.extname(filePath) === ".json") {
			// Validate with the JSON grammar now, then parse a CommonJS wrapper that
			// preserves JSON.parse semantics for keys such as "__proto__".
			try {
				JSON.parse(source);
			} catch (error) {
				if (error instanceof SyntaxError) {
					throw new SyntaxDiagnostic(
						filePath === entry ? "parse" : "resolution",
						error.message,
						{ cause: error },
					);
				}
				throw error;
			}
			parseSource =
				goal === "cjs"
					? `module.exports = JSON.parse(${JSON.stringify(source)});`
					: `export default JSON.parse(${JSON.stringify(source)});`;
		}
		if (TS_EXTENSIONS.has(path.extname(sourcePath ?? filePath))) {
			if (!options.stripTypes) {
				throw new Error(
					`TypeScript module '${filePath}' requires BuildModuleGraphOptions.stripTypes`,
				);
			}
			parseSource = options.stripTypes(parseSource, sourcePath ?? filePath);
		}
		return parseSource;
	};
	let lastObservations: ReadonlyArray<readonly [string, string]> = [];
	const recordObservations = <T>(record: boolean, analyze: () => T): T => {
		if (!record) return analyze();
		const observations: Array<[string, string]> = [];
		ctx.recording = observations;
		try {
			return analyze();
		} finally {
			ctx.recording = undefined;
			lastObservations = observations;
		}
	};
	const load = (
		filePath: string,
		goal: ModuleGoal,
		sourceOverride?: string,
		virtual = false,
	) => {
		if (modules.has(filePath)) {
			return;
		}

		const memoKey =
			memoIdentity === undefined ||
			filePath === entry ||
			options.transformSource?.files.has(filePath) === true
				? undefined
				: `${memoIdentity}\0${goal}\0${filePath}`;
		const memo =
			memoKey === undefined ? undefined : options.parseCache?.memoizedLoad(memoKey);
		const aliased = (specifier: string) =>
			options.buildConfig?.modules.aliases[specifier] ?? specifier;
		const observationsHold = (observations: ReadonlyArray<readonly [string, string]>) =>
			observations.every(
				([key, observation]) =>
					observe(key.startsWith("json") ? "json" : "kind", key.slice(5), ctx) ===
					observation,
			);
		const resolvesLocally = (dependencies: ReadonlyArray<ModuleDependency>) =>
			!dependencies.some(
				({ specifier }) =>
					specifier !== null && options.externalModules?.has(aliased(specifier)) === true,
			);
		// Observed before reading, so a concurrent edit can only make the memo stale.
		const sourceIdentity =
			sourceOverride === undefined ? observe("json", filePath, ctx) : undefined;
		const reusable =
			memo !== undefined &&
			(sourceOverride === undefined
				? memo.sourceIdentity !== undefined && sourceIdentity === memo.sourceIdentity
				: memo.sourceIdentity === undefined && memo.source === sourceOverride) &&
			observationsHold(memo.observations) &&
			resolvesLocally(memo.dependencies);
		const persisted =
			reusable || memoKey === undefined || sourceOverride !== undefined
				? undefined
				: options.parseCache?.persistedLoad(memoKey);
		const source = reusable
			? memo.source
			: (sourceOverride ?? readFileSync(filePath, "utf-8"));
		const sourceDigest =
			memoKey === undefined || reusable ? undefined : hash("sha256", source, "hex");
		// The digest, not the identity, ties a persisted load to the source just read.
		const restored =
			persisted !== undefined &&
			persisted.sourceDigest === sourceDigest &&
			observationsHold(persisted.observations) &&
			resolvesLocally(persisted.dependencies)
				? persisted
				: undefined;
		let analyzed: {
			sourcePath: string | undefined;
			parsed: ModuleRecord["parsed"];
			dependencies: Array<ModuleDependency>;
			importMetaResolutions: ReadonlyArray<ImportMetaResolution>;
		};
		let resolvedThroughExternal = false;
		if (reusable || restored !== undefined) options.parseCache!.countReusedLoad();
		try {
			analyzed = reusable
				? {
						sourcePath: memo.sourcePath,
						parsed: memo.parsed,
						dependencies: memo.dependencies.map((dependency) => ({ ...dependency })),
						importMetaResolutions: memo.importMetaResolutions,
					}
				: restored !== undefined
					? (() => {
							let ast: ESTree.Program | undefined;
							return {
								sourcePath: restored.sourcePath,
								parsed: {
									type: restored.type,
									strict: restored.strict,
									get ast() {
										return (ast ??= parseWithGoal(
											baseParseSource(filePath, source, goal, restored.sourcePath),
											goal,
											true,
										).ast);
									},
								},
								dependencies: restored.dependencies.map((dependency) => ({
									...dependency,
								})),
								importMetaResolutions: restored.importMetaResolutions ?? [],
							};
						})()
					: recordObservations(memoKey !== undefined, () => {
							const sourcePath = catalogSources.get(filePath)?.sourcePath;
							let parseSource = baseParseSource(filePath, source, goal, sourcePath);
							if (filePath === entry && options.entryPrelude !== undefined) {
								const specifier = JSON.stringify(options.entryPrelude.specifier);
								parseSource =
									goal === "cjs"
										? `require(${specifier});\n${parseSource}`
										: `import ${specifier};\n${parseSource}`;
							}
							parseSource =
								options.transformSource?.files.has(filePath) === true
									? options.transformSource.transform(parseSource, filePath)
									: parseSource;
							const strict = filePath === entry ? (options.entryStrict ?? true) : true;
							const parse = () => {
								try {
									const parsed = parseWithGoal(parseSource, goal, strict);
									return { parsed, dependencies: extractDependencies(parsed.ast, goal) };
								} catch (error) {
									if (error instanceof SyntaxError) {
										throw new SyntaxDiagnostic(
											filePath === entry ? "parse" : "resolution",
											error.message,
											{ cause: error },
										);
									}
									throw error;
								}
							};
							const parsedModule =
								options.parseCache?.parse(filePath, parseSource, goal, parse, strict) ??
								parse();
							const parsed = parsedModule.parsed;

							const importMetaResolutions = parsedModule.dependencies.flatMap(
								(dependency) =>
									dependency.kind === "import-meta-resolve"
										? resolveImportMeta(dependency.specifier, sourcePath ?? filePath, ctx)
										: [],
							);
							const dependencies = parsedModule.dependencies.flatMap(
								(dependency): Array<ModuleDependency> => {
									if (dependency.kind === "import-meta-resolve") return [];
									if (dependency.specifier === null) {
										// A computed import/require cannot be resolved while building the
										// graph. Preserve the edge for later lowering/runtime handling.
										return [{ ...dependency, resolvedPath: null }];
									}
									const aliasedSpecifier =
										options.buildConfig?.modules.aliases[dependency.specifier] ??
										dependency.specifier;
									const platform = lookupPlatformModule(aliasedSpecifier);
									if (
										(platform as { internal?: boolean } | undefined)?.internal === true &&
										lookupPlatformModule(filePath)?.kind !== "source" &&
										!catalogFiles.owned.has(filePath)
									) {
										throw new SyntaxDiagnostic(
											"resolution",
											`Internal module '${dependency.specifier}' is reserved for platform sources`,
										);
									}
									// A toolchain module an earlier image owns keeps its specifier identity.
									if (options.externalModules?.has(aliasedSpecifier)) {
										resolvedThroughExternal = true;
										return [{ ...dependency, resolvedPath: aliasedSpecifier }];
									}
									const toolchainModule = virtualModule(aliasedSpecifier);
									if (toolchainModule !== undefined) {
										const entryPreludeRequire =
											dependency.kind === "require" &&
											dependency.specifier === options.entryPrelude?.specifier;
										if (
											(dependency.kind === "dynamic" &&
												!(
													toolchainModule.platform &&
													lookupPlatformModule(aliasedSpecifier)?.kind === "source"
												)) ||
											(dependency.kind === "require" && !entryPreludeRequire)
										) {
											throw new SyntaxDiagnostic(
												"resolution",
												`Toolchain module '${dependency.specifier}' supports static ESM imports only`,
											);
										}
										return [{ ...dependency, resolvedPath: aliasedSpecifier }];
									}
									const canonicalHostId = canonicalNodeHostModuleId(aliasedSpecifier);
									const canonicalBuiltinId = canonicalNodeBuiltinId(aliasedSpecifier);
									const resolved = resolveSpecifier(
										canonicalHostId ?? canonicalBuiltinId ?? aliasedSpecifier,
										sourcePath ?? filePath,
										{
											...ctx,
											conditions: exportConditions(
												ctx.nodeEnabled,
												dependency.kind === "require" ? "require" : "import",
											),
										},
									);
									if ("host" in resolved) {
										// A supported `node:*` built-in: identity is its canonical specifier.
										return [{ ...dependency, resolvedPath: resolved.host.id }];
									}
									if ("error" in resolved) {
										// A `node:*` error (surface disabled / unknown built-in) is `hard`: it
										// rejects even a literal dynamic import rather than silently deferring,
										// so an unsupported host import fails loudly at build time. A plain
										// dynamic resolution failure (missing file) still defers to the graph.
										if (dependency.kind === "dynamic" && !resolved.hard) {
											return [{ ...dependency, resolvedPath: null }];
										}
										if (
											dependency.kind === "require" &&
											dependency.catchableMissing &&
											!resolved.hard
										) {
											return [{ ...dependency, resolvedPath: null }];
										}
										// A static import that cannot resolve fails the graph — the
										// resolution-phase SyntaxError of 16.2.1.6.1.
										throw new SyntaxDiagnostic(
											"resolution",
											`Cannot resolve '${dependency.specifier}' from ${filePath}: ${resolved.error}`,
										);
									}

									const catalogSource = catalogFiles.sources.get(resolved.path);
									if (catalogSource !== undefined) virtualModule(catalogSource);
									return [
										{ ...dependency, resolvedPath: catalogSource ?? resolved.path },
									];
								},
							);
							return { sourcePath, parsed, dependencies, importMetaResolutions };
						});
		} catch (error) {
			// A module the entry reaches only through `import()` fails when that import
			// runs; the check after loading fails the build for one it imports statically.
			if (filePath === entry || !(error instanceof SyntaxDiagnostic)) throw error;
			modules.set(filePath, {
				path: filePath,
				goal,
				source,
				parsed: parseWithGoal("", goal, true),
				dependencies: [],
				loadError: error,
			});
			return;
		}
		const { sourcePath, parsed, dependencies, importMetaResolutions } = analyzed;
		if (
			memoKey !== undefined &&
			!reusable &&
			!resolvedThroughExternal &&
			(sourceOverride !== undefined || sourceIdentity !== "-")
		) {
			const observations = restored?.observations ?? lastObservations;
			options.parseCache!.memoizeLoad(memoKey, {
				source,
				sourceIdentity,
				sourcePath,
				parsed,
				dependencies: dependencies.map((dependency) => ({ ...dependency })),
				importMetaResolutions,
				observations,
			});
			if (
				restored === undefined &&
				sourceOverride === undefined &&
				sourceDigest !== undefined
			) {
				options.parseCache!.persistLoad(memoKey, {
					sourceDigest,
					...(sourcePath === undefined ? {} : { sourcePath }),
					type: parsed.type,
					strict: parsed.strict,
					dependencies: dependencies.map((dependency) => ({ ...dependency })),
					...(importMetaResolutions.length === 0
						? {}
						: { importMetaResolutions: [...importMetaResolutions] }),
					observations: observations.map(([key, value]) => [key, value]),
				});
			}
		}

		// Record before recursing so a cyclic back-import finds this module and
		// stops, rather than looping forever.
		modules.set(filePath, {
			path: filePath,
			...(sourcePath === undefined ? {} : { sourcePath }),
			goal,
			source,
			parsed,
			dependencies,
			...(importMetaResolutions.length === 0 ? {} : { importMetaResolutions }),
			...(virtual ? { virtual: true as const } : {}),
			...(virtual && virtualModule(filePath)?.platform
				? { platform: lookupPlatformModule(filePath) }
				: {}),
		});

		for (const dependency of dependencies) {
			const resolvedPath = dependency.resolvedPath;
			if (!resolvedPath || modules.has(resolvedPath)) {
				continue;
			}
			const external = options.externalModules?.get(resolvedPath);
			if (external !== undefined) {
				modules.set(resolvedPath, externalModuleRecord(resolvedPath, external));
				continue;
			}
			// A `node:*` host built-in resolves to a virtual record from the catalog —
			// no disk read, no recursion (it has no dependencies of its own).
			const host = ctx.ffiModules.get(resolvedPath) ?? lookupHostModule(resolvedPath);
			if (host) {
				modules.set(resolvedPath, hostModuleRecord(host, options.execution));
				continue;
			}
			const toolchainModule = virtualModule(resolvedPath);
			if (toolchainModule !== undefined) {
				load(
					resolvedPath,
					toolchainModule.goal ?? "module",
					toolchainModule.source,
					true,
				);
				continue;
			}
			// A JSON module exports only its parsed value as the default (ParseJSONModule);
			// `require()` reads the same value as `module.exports`.
			load(
				resolvedPath,
				path.extname(resolvedPath) === ".json"
					? dependency.kind === "require"
						? "cjs"
						: "module"
					: (options.goalOverride ??
							options.dependencyGoalOverride ??
							detectDependencyGoal(resolvedPath, ctx)),
			);
		}
	};

	load(
		entry,
		options.goalOverride ?? options.entryGoal ?? detectDependencyGoal(entry, ctx),
		options.entrySource,
	);
	for (const root of options.requiredRoots ?? []) {
		const rootPath = path.resolve(root);
		const goal = detectDependencyGoal(rootPath, ctx);
		if (goal !== "cjs") {
			throw new Error(`a required root must be a CommonJS module: ${rootPath}`);
		}
		load(rootPath, goal);
		const loadError = modules.get(rootPath)?.loadError;
		if (loadError !== undefined) throw loadError;
	}
	for (const candidate of options.dynamicImportCandidates ?? []) {
		const candidatePath = path.resolve(candidate);
		if (!modules.has(candidatePath)) {
			load(
				candidatePath,
				options.goalOverride ??
					options.dependencyGoalOverride ??
					detectDependencyGoal(candidatePath, ctx),
			);
		}
		let specifier = path
			.relative(path.dirname(entry), candidatePath)
			.split(path.sep)
			.join("/");
		if (!specifier.startsWith(".")) specifier = `./${specifier}`;
		const entryRecord = modules.get(entry)!;
		if (
			!entryRecord.dependencies.some(
				(dependency) =>
					dependency.kind === "dynamic" &&
					dependency.specifier === specifier &&
					dependency.resolvedPath === candidatePath,
			)
		) {
			entryRecord.dependencies.push({
				kind: "dynamic",
				specifier,
				resolvedPath: candidatePath,
			});
		}
	}
	const declaredCandidates = new Set(
		options.dynamicImportCandidates?.map((candidate) => path.resolve(candidate)),
	);
	let workerEntries: Array<WorkerEntryDeclaration> = [];
	for (;;) {
		workerEntries = discoverWorkerEntries(modules, sourceRoot);
		let loaded = false;
		for (const declaration of workerEntries) {
			declaredCandidates.add(declaration.path);
			const importer = modules.get(declaration.importer)!;
			if (
				!importer.dependencies.some(
					(dependency) =>
						dependency.kind === "worker" && dependency.resolvedPath === declaration.path,
				)
			) {
				importer.dependencies.push({
					kind: "worker",
					specifier: declaration.href,
					resolvedPath: declaration.path,
				});
			}
			if (modules.has(declaration.path)) continue;
			load(
				declaration.path,
				options.goalOverride ??
					options.dependencyGoalOverride ??
					detectDependencyGoal(declaration.path, ctx),
			);
			loaded = true;
		}
		if (!loaded) break;
	}

	for (const modulePath of staticModuleClosure(modules, entry)) {
		const loadError = modules.get(modulePath)?.loadError;
		if (loadError !== undefined) throw loadError;
	}

	return {
		workerEntries,
		dynamicImportCandidates: [...declaredCandidates].sort(),
		entry,
		execution: options.execution,
		nodeEnabled: ctx.nodeEnabled,
		modules,
		evaluationOrder: computeEvaluationOrder(entry, modules),
		cycles: detectCycles(modules),
	};
}

/**
 * Parse a module's source according to its goal.
 *
 * Scripts and (for now) CommonJS both parse as scripts; CommonJS sloppy-mode
 * parsing arrives with the CJS-consume milestone.
 */
function parseWithGoal(source: string, goal: ModuleGoal, strict: boolean) {
	if (goal === "module") {
		return parseModule(source);
	}
	return parseScript(source, { strict });
}

/**
 * A module's automatic goal follows Node: extension, then the nearest `package.json`
 * "type". A `.js` file under `type: module` is a module; otherwise it is
 * CommonJS.
 */
function detectDependencyGoal(filePath: string, ctx: ResolveContext): ModuleGoal {
	switch (path.extname(filePath)) {
		case ".mjs":
		case ".mts":
			return "module";
		case ".cjs":
		case ".cts":
			return "cjs";
		case ".json":
			return "cjs";
		default:
			// `.ts` follows `.js`: nearest package.json "type" decides.
			break;
	}

	return findNearestPackageType(path.dirname(filePath), ctx) === "module"
		? "module"
		: "cjs";
}

/**
 * Walk up from a directory looking for the nearest `package.json`. That package
 * boundary decides the goal: only `"type": "module"` selects ESM; an absent or
 * unrecognized type defaults to CommonJS and must not inherit from an ancestor.
 */
function findNearestPackageType(
	dir: string,
	ctx: ResolveContext,
): ModuleGoal | undefined {
	const cache = ctx.packageTypeCache;
	if (cache.has(dir)) {
		return cache.get(dir);
	}

	const pkg = readPackageJson(path.join(dir, "package.json"), ctx);
	if (pkg) {
		const goal: ModuleGoal = pkg.type === "module" ? "module" : "cjs";
		cache.set(dir, goal);
		return goal;
	}

	const parent = path.dirname(dir);
	const goal = parent === dir ? undefined : findNearestPackageType(parent, ctx);
	cache.set(dir, goal);
	return goal;
}

type ExtractedDependency =
	| { specifier: string | null; kind: ModuleDependencyKind; catchableMissing?: true }
	// Asks for a resolution only; nothing is loaded for it.
	| { specifier: string; kind: "import-meta-resolve" };

function requireErrorIsCatchable(
	call: ESTree.CallExpression,
	parents: ReadonlyMap<ESTree.Node, ESTree.Node>,
): boolean {
	let current: ESTree.Node = call;
	for (let parent = parents.get(current); parent; parent = parents.get(current)) {
		if (
			parent.type === "FunctionDeclaration" ||
			parent.type === "FunctionExpression" ||
			parent.type === "ArrowFunctionExpression" ||
			(parent.type === "PropertyDefinition" && !parent.static)
		) {
			return false;
		}
		if (
			parent.type === "TryStatement" &&
			parent.block === current &&
			parent.handler !== null
		) {
			return true;
		}
		current = parent;
	}
	return false;
}

/**
 * Collect every static import/export-from and dynamic `import()` in a module —
 * plus, in a CommonJS module, every `require("…")` call (which can be nested
 * anywhere, so the whole-tree walk catches them too).
 *
 * Static import/export only appear at the top level, but we walk the whole tree
 * regardless so dynamic `import()` and `require()` are caught in the same pass.
 * A computed `require(expr)` records a null specifier — unresolvable statically,
 * like a computed `import(expr)`.
 */
function extractDependencies(
	ast: ESTree.Program,
	goal: ModuleGoal,
): Array<ExtractedDependency> {
	const dependencies: Array<ExtractedDependency> = [];
	const parents = new Map<ESTree.Node, ESTree.Node>();
	const requireCallees = goal === "cjs" ? undefined : createRequireCallees(ast);

	traverseEstree(ast.body, (node, { parent }) => {
		if (parent) parents.set(node, parent);
		switch (node.type) {
			case "ImportDeclaration":
				dependencies.push({
					specifier: literalString(node.source),
					kind: node.phase === "defer" ? "deferred-import" : "import",
				});
				break;
			case "ExportNamedDeclaration":
				// Only re-exports carry a source (`export { x } from "y"`).
				if (node.source) {
					dependencies.push({ specifier: literalString(node.source), kind: "export" });
				}
				break;
			case "ExportAllDeclaration":
				dependencies.push({ specifier: literalString(node.source), kind: "export" });
				break;
			case "ImportExpression":
				dependencies.push({ specifier: literalString(node.source), kind: "dynamic" });
				break;
			case "CallExpression": {
				if (goal === "module" && isImportMetaResolveCall(node)) {
					const specifier = literalString(node.arguments[0]);
					if (specifier !== null && node.arguments.length === 1) {
						dependencies.push({ specifier, kind: "import-meta-resolve" });
					}
					break;
				}
				// `require("x")` in a CommonJS module. A naive callee-name match: a
				// shadowed/reassigned `require` is a rare edge case refined later.
				// meriyah types CallExpression.callee as `any`, so narrow explicitly.
				const callee = node.callee as ESTree.Node;
				if (
					goal === "cjs" &&
					callee.type === "Identifier" &&
					callee.name === "require" &&
					node.arguments.length === 1
				) {
					dependencies.push({
						specifier: literalString(node.arguments[0]),
						kind: "require",
						...(requireErrorIsCatchable(node, parents)
							? { catchableMissing: true as const }
							: {}),
					});
				} else if (
					callee.type === "Identifier" &&
					requireCallees?.has(callee.name) === true &&
					node.arguments.length > 0
				) {
					const direct = requireCallees.get(callee.name) === "direct";
					dependencies.push({
						specifier: literalString(node.arguments[0]),
						kind: "require",
						// A forwarder may pass along values that are not specifiers at all, so
						// a missing target there throws at runtime, as Node's lookup would.
						...(!direct || requireErrorIsCatchable(node, parents)
							? { catchableMissing: true as const }
							: {}),
					});
				}
				break;
			}
			default:
				break;
		}
	});
	return dependencies;
}

/**
 * Names that call a module-relative `require`: the createRequire bindings plus
 * forwarders whose initializer or body reads one as a value, such as esbuild's
 * `__require` wrapper. Like the CommonJS match this is name-based; shadowing is
 * not modeled.
 */
function createRequireCallees(ast: ESTree.Program): Map<string, "direct" | "forwarder"> {
	const callees = new Map<string, "direct" | "forwarder">();
	for (const declarator of moduleCreateRequireDeclarators(ast)) {
		callees.set(declarator.id.name, "direct");
	}
	if (callees.size === 0) return callees;
	const declarations: Array<{ name: string; value: ESTree.Node }> = [];
	traverseEstree(ast.body, (node) => {
		if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			node.init
		) {
			declarations.push({ name: node.id.name, value: node.init });
		} else if (node.type === "FunctionDeclaration" && node.id && node.body) {
			declarations.push({ name: node.id.name, value: node.body });
		}
	});
	for (let grew = true; grew;) {
		grew = false;
		for (const declaration of declarations) {
			if (callees.has(declaration.name) || !forwardsCallee(declaration.value, callees))
				continue;
			callees.set(declaration.name, "forwarder");
			grew = true;
		}
	}
	return callees;
}

// A function forwards `require` when it reads the value (`require.apply`, `typeof
// require`) or calls it with a computed specifier; a literal call merely requires.
function forwardsCallee(root: ESTree.Node, names: ReadonlyMap<string, unknown>): boolean {
	const functions: Array<ESTree.Node> = [];
	traverseEstree([root], (node) => {
		if (
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression" ||
			node.type === "FunctionDeclaration" ||
			node.type === "BlockStatement"
		) {
			functions.push(node);
		}
	});
	let found = false;
	for (const fn of functions) {
		if (fn.type === "BlockStatement" && fn !== root) continue;
		traverseEstree([fn], (node, { parent, key }) => {
			if (found || node.type !== "Identifier" || !names.has(node.name)) return;
			if (parent?.type === "MemberExpression" && key === "property" && !parent.computed)
				return;
			if (parent?.type === "CallExpression" && key === "callee") {
				const argument = parent.arguments[0] as ESTree.Node | undefined;
				if (argument?.type === "Literal" && typeof argument.value === "string") return;
			}
			found = true;
		});
		if (found) return true;
	}
	return false;
}

// Node's relative specifiers: "." and "..", or a "./", "../" or "/" prefix.
function isRelativeSpecifier(specifier: string): boolean {
	return (
		specifier === "." ||
		specifier === ".." ||
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier.startsWith("/")
	);
}

// What Node's import.meta.resolve answers. Paths and URLs resolve without touching
// the disk (a missing file still yields its URL), built-ins name their `node:` URL,
// and packages resolve with the import conditions. A package that does not resolve
// is left to the run-time ERR_MODULE_NOT_FOUND.
function resolveImportMeta(
	specifier: string,
	importerPath: string,
	ctx: ResolveContext,
): Array<ImportMetaResolution> {
	if (isRelativeSpecifier(specifier) || URL.canParse(specifier)) {
		const url = new URL(specifier, pathToFileURL(importerPath));
		if (url.protocol === "file:" && url.search === "" && url.hash === "") {
			return [{ specifier, path: fileURLToPath(url) }];
		}
		return [{ specifier, url: url.href }];
	}
	const builtin = canonicalNodeBuiltinId(specifier);
	if (builtin !== undefined) return [{ specifier, url: builtin }];
	const resolved = resolveSpecifier(specifier, importerPath, {
		...ctx,
		conditions: exportConditions(ctx.nodeEnabled, "import"),
	});
	return "path" in resolved ? [{ specifier, path: resolved.path }] : [];
}

/**
 * Read a string value out of a specifier node, or null when it is not a string
 * literal (a computed dynamic import).
 */
function literalString(node: ESTree.Node | null | undefined): string | null {
	if (node && node.type === "Literal" && typeof node.value === "string") {
		return node.value;
	}
	return null;
}

type ResolveResult =
	| { path: string }
	// A supported `node:*` host built-in (from the static catalog).
	| { host: HostModuleSpec }
	// `hard` marks a `node:*` error that must reject even a literal dynamic import
	// (not defer): the surface is off, or the built-in is unknown.
	| { error: string; hard?: boolean };

function externalModuleRecord(
	modulePath: string,
	external: ExternalModuleInterface,
): ModuleRecord {
	return {
		path: modulePath,
		goal: external.goal,
		source: "",
		parsed: parseModule(""),
		dependencies: [],
		external,
	};
}

/**
 * A minimal virtual record for a supported `node:*` host built-in. It carries no
 * user source (empty parse, so it is inert under semantic analysis) — the linker
 * will read {@link HostModuleSpec} to synthesize the host exports later.
 */
function hostModuleRecord(host: HostModuleSpec, execution?: Execution): ModuleRecord {
	if (host.platform !== undefined) {
		const constants = Object.fromEntries(
			host.platform.exports
				.filter(
					(entry) =>
						entry.contract.phase === "preparation" &&
						entry.contract.value === "deep-frozen-data",
				)
				.map((entry) => {
					if (entry.contract.provider === "execution") {
						if (execution === undefined)
							throw new SyntaxDiagnostic(
								"resolution",
								`${host.id} requires an application execution description`,
							);
						return [entry.name, executionData(execution)];
					}
					throw new Error(`Unknown platform provider for ${host.id}/${entry.name}`);
				}),
		);
		host = { ...host, constants };
	}
	return {
		path: host.id,
		goal: "module",
		source: "",
		parsed: parseModule(""),
		dependencies: [],
		host,
	};
}

/**
 * Resolve a specifier to an absolute on-disk path (Node-style) or a `node:*` host
 * built-in. CommonJS bare built-ins are canonicalized before reaching this
 * resolver; ES module bare specifiers still use package resolution.
 */
function resolveSpecifier(
	specifier: string,
	importerPath: string,
	ctx: ResolveContext,
): ResolveResult {
	if (specifier.startsWith(FFI_SPECIFIER_PREFIX)) {
		const host = ctx.ffiModules.get(specifier);
		const configured = [...ctx.ffiModules.keys()].map((id) =>
			id.slice(FFI_SPECIFIER_PREFIX.length),
		);
		return host === undefined
			? {
					error: `unknown C library '${specifier}' (configured: ${configured.join(", ") || "none"})`,
					hard: true,
				}
			: { host };
	}
	if (specifier.startsWith("maligator:")) {
		const host = lookupHostModule(specifier);
		return host === undefined
			? {
					error: `unknown Maligator module '${specifier}' (supported native modules: ${PLATFORM_MODULES.map((module) => module.id).join(", ")})`,
					hard: true,
				}
			: { host };
	}
	if (isNodeSpecifier(specifier)) {
		if (!ctx.nodeEnabled) {
			return {
				error:
					`node built-in modules are disabled — set "surface": { "node": true } in ` +
					`maligator.build.ts to import '${specifier}'`,
				hard: true,
			};
		}
		const host = lookupHostModule(specifier);
		if (host) {
			return { host };
		}
		return {
			error:
				`unknown node built-in module '${specifier}' ` +
				`(supported: ${supportedHostModuleIds().join(", ")})`,
			hard: true,
		};
	}

	const importerDir = path.dirname(importerPath);

	if (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		path.isAbsolute(specifier)
	) {
		const base = path.isAbsolute(specifier)
			? specifier
			: path.resolve(importerDir, specifier);
		const resolved = probePath(base, ctx);
		return resolved ? { path: resolved } : { error: "no such file or directory" };
	}

	return resolveBareSpecifier(specifier, importerDir, ctx);
}

/**
 * Resolve a path-like target: exact file, then extension probing, then as a
 * directory (package.json `exports`/`main` or an index file).
 */
function probePath(target: string, ctx: ResolveContext): string | null {
	if (isFile(target, ctx)) {
		return target;
	}

	for (const extension of RESOLVE_EXTENSIONS) {
		if (isFile(target + extension, ctx)) {
			return target + extension;
		}
	}

	if (isDirectory(target, ctx)) {
		return loadAsDirectory(target, ctx);
	}

	return null;
}

/**
 * Resolve a directory to its entry file: `exports["."]`, then `main`, then an
 * index file.
 */
function loadAsDirectory(dir: string, ctx: ResolveContext): string | null {
	const pkg = readPackageJson(path.join(dir, "package.json"), ctx);

	if (pkg?.exports !== undefined) {
		// The presence of `exports` encapsulates the package. A missing or invalid
		// root target must not fall through to legacy `main`/index resolution.
		return resolveExports(pkg.exports, ".", dir, ctx);
	}

	if (pkg && typeof pkg.main === "string") {
		const resolved = probePath(path.resolve(dir, pkg.main), ctx);
		if (resolved) {
			return resolved;
		}
	}

	for (const extension of RESOLVE_EXTENSIONS) {
		const indexFile = path.join(dir, `index${extension}`);
		if (isFile(indexFile, ctx)) {
			return indexFile;
		}
	}

	return null;
}

/**
 * Resolve a bare specifier (`pkg` or `pkg/subpath`, scoped or not) by walking
 * `node_modules` upward from the importing directory.
 */
function resolveBareSpecifier(
	specifier: string,
	importerDir: string,
	ctx: ResolveContext,
): ResolveResult {
	const { packageName, subpath } = splitBareSpecifier(specifier);

	let dir = importerDir;
	for (;;) {
		const packageDir = path.join(dir, "node_modules", packageName);
		if (isDirectory(packageDir, ctx)) {
			const resolved = resolveInPackage(packageDir, subpath, ctx);
			if (resolved) {
				return { path: resolved };
			}
			return { error: `'${specifier}' is not exported by ${packageName}` };
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			return { error: `cannot find package '${packageName}'` };
		}
		dir = parent;
	}
}

/**
 * Split a bare specifier into its package name and the subpath within it.
 * Scoped packages (`@scope/name`) keep both leading segments as the name.
 */
function splitBareSpecifier(specifier: string): {
	packageName: string;
	subpath: string;
} {
	const segments = specifier.split("/");
	const nameSegmentCount = specifier.startsWith("@") ? 2 : 1;
	return {
		packageName: segments.slice(0, nameSegmentCount).join("/"),
		subpath: segments.slice(nameSegmentCount).join("/"),
	};
}

/**
 * Resolve a (possibly empty) subpath within an already-located package
 * directory.
 */
function resolveInPackage(
	packageDir: string,
	subpath: string,
	ctx: ResolveContext,
): string | null {
	const pkg = readPackageJson(path.join(packageDir, "package.json"), ctx);

	if (subpath === "") {
		if (pkg?.exports !== undefined) {
			return resolveExports(pkg.exports, ".", packageDir, ctx);
		}
		return loadAsDirectory(packageDir, ctx);
	}

	if (pkg?.exports !== undefined) {
		return resolveExports(pkg.exports, `./${subpath}`, packageDir, ctx);
	}

	return probePath(path.resolve(packageDir, subpath), ctx);
}

type ExportsField = string | Array<ExportsField> | { [key: string]: ExportsField };

/**
 * Resolve a subpath against a package's `exports` field.
 *
 * Handles string targets, condition objects (matched against
 * EXPORT_CONDITIONS), and flat subpath maps including wildcard patterns.
 */
function resolveExports(
	exportsField: ExportsField,
	subpath: string,
	packageDir: string,
	ctx: ResolveContext,
	patternMatch?: string,
): string | null {
	if (typeof exportsField === "string") {
		return subpath === "."
			? resolveExportTarget(exportsField, packageDir, ctx, patternMatch)
			: null;
	}

	if (Array.isArray(exportsField)) {
		for (const candidate of exportsField) {
			const resolved = resolveExports(candidate, subpath, packageDir, ctx, patternMatch);
			if (resolved) {
				return resolved;
			}
		}
		return null;
	}

	const keys = Object.keys(exportsField);
	const isSubpathMap = keys.length > 0 && keys.every((key) => key.startsWith("."));

	if (isSubpathMap) {
		const target = exportsField[subpath];
		// Resolve the matched target's conditions/string against the "." root.
		if (target !== undefined) {
			return resolveExports(target, ".", packageDir, ctx);
		}

		const patterns = keys
			.filter((key) => key.includes("*"))
			.map((key) => {
				const star = key.indexOf("*");
				return { key, prefix: key.slice(0, star), suffix: key.slice(star + 1) };
			})
			.filter(
				({ prefix, suffix }) => subpath.startsWith(prefix) && subpath.endsWith(suffix),
			)
			.sort((a, b) => b.prefix.length - a.prefix.length || b.key.length - a.key.length);
		for (const { key, prefix, suffix } of patterns) {
			const match = subpath.slice(prefix.length, subpath.length - suffix.length);
			const resolved = resolveExports(exportsField[key]!, ".", packageDir, ctx, match);
			if (resolved) {
				return resolved;
			}
		}
		return null;
	}

	// A conditions object: object declaration order determines precedence. Skip
	// unknown conditions, as Node does, rather than imposing our own priority. The
	// `node` condition is only in ctx.conditions under surface.node.
	for (const [condition, target] of Object.entries(exportsField)) {
		if (ctx.conditions.has(condition)) {
			const resolved = resolveExports(target, subpath, packageDir, ctx, patternMatch);
			if (resolved) {
				return resolved;
			}
		}
	}

	return null;
}

/**
 * An `exports` target is an exact file reference (no extension probing per the
 * Node spec) and must be relative to the package.
 */
function resolveExportTarget(
	target: string,
	packageDir: string,
	ctx: ResolveContext,
	patternMatch?: string,
): string | null {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted =
		patternMatch === undefined ? target : target.replaceAll("*", patternMatch);
	const resolved = path.resolve(packageDir, substituted);
	return isFile(resolved, ctx) ? resolved : null;
}

/**
 * Post-order DFS over static-import edges: dependencies before dependents, so
 * the entry comes last. Cyclic back-edges are skipped by the visited set.
 */
function computeEvaluationOrder(
	entry: string,
	modules: Map<string, ModuleRecord>,
): Array<string> {
	const visited = new Set<string>();
	const order: Array<string> = [];

	const visit = (modulePath: string) => {
		if (visited.has(modulePath)) {
			return;
		}
		visited.add(modulePath);

		for (const dependency of staticEdges(modulePath, modules)) {
			visit(dependency);
		}
		order.push(modulePath);
	};

	visit(entry);
	return order;
}

/**
 * Tarjan's strongly-connected-components over the static-import edges. Returns
 * only the components that form a cycle.
 */
function detectCycles(modules: Map<string, ModuleRecord>): Array<Array<string>> {
	let counter = 0;
	const index = new Map<string, number>();
	const lowLink = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: Array<string> = [];
	const components: Array<Array<string>> = [];

	const strongConnect = (node: string) => {
		index.set(node, counter);
		lowLink.set(node, counter);
		counter++;
		stack.push(node);
		onStack.add(node);

		for (const next of staticEdges(node, modules)) {
			if (!index.has(next)) {
				strongConnect(next);
				lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!));
			} else if (onStack.has(next)) {
				lowLink.set(node, Math.min(lowLink.get(node)!, index.get(next)!));
			}
		}

		if (lowLink.get(node) === index.get(node)) {
			const component: Array<string> = [];
			let member: string;
			do {
				member = stack.pop()!;
				onStack.delete(member);
				component.push(member);
			} while (member !== node);
			components.push(component);
		}
	};

	for (const modulePath of modules.keys()) {
		if (!index.has(modulePath)) {
			strongConnect(modulePath);
		}
	}

	return components.filter(
		(component) =>
			component.length > 1 ||
			(component.length === 1 &&
				staticEdges(component[0]!, modules).includes(component[0]!)),
	);
}

/**
 * The resolved static-import dependencies of a module (excludes dynamic
 * `import()`, which does not affect evaluation order).
 */
function staticEdges(
	modulePath: string,
	modules: Map<string, ModuleRecord>,
): Array<string> {
	const record = modules.get(modulePath);
	if (!record) {
		return [];
	}

	const edges: Array<string> = [];
	for (const dependency of record.dependencies) {
		if (
			dependency.kind !== "dynamic" &&
			dependency.kind !== "worker" &&
			dependency.kind !== "deferred-import" &&
			dependency.resolvedPath
		) {
			edges.push(dependency.resolvedPath);
		}
	}
	return edges;
}

interface PackageJson {
	type?: string;
	main?: string;
	exports?: ExportsField;
}

function readPackageJson(
	packageJsonPath: string,
	ctx: ResolveContext,
): PackageJson | null {
	// The identity observation makes a memoized load depend on this file's contents.
	if (!isFile(packageJsonPath, ctx)) return null;
	const identity = observe("json", packageJsonPath, ctx);
	if (identity === "-") return null;
	const cache = ctx.packageJsonCache;
	if (cache.has(packageJsonPath)) {
		return cache.get(packageJsonPath)!;
	}

	const retained = ctx.retainedPackageJsons?.get(packageJsonPath);
	let parsed: PackageJson | null = null;
	if (retained?.identity === identity) {
		parsed = retained.parsed as PackageJson | null;
	} else {
		try {
			parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
		} catch {
			parsed = null;
		}
		ctx.retainedPackageJsons?.set(packageJsonPath, { identity, parsed });
	}

	cache.set(packageJsonPath, parsed);
	return parsed;
}

function statObservation(kind: "kind" | "json", target: string): string {
	const stats = statSync(target, { throwIfNoEntry: false });
	if (stats === undefined) return "-";
	if (kind === "json") {
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
	}
	return stats.isFile() ? "f" : stats.isDirectory() ? "d" : "o";
}

/**
 * What resolution sees of a path, observed once per walk. A module being analysed
 * records every observation, cached or not, so its memoized load stays valid
 * exactly while they all repeat.
 */
function observe(kind: "kind" | "json", target: string, ctx: ResolveContext): string {
	const key = `${kind}\0${target}`;
	let observation = ctx.observed.get(key);
	if (observation === undefined) {
		try {
			observation = statObservation(kind, target);
		} catch {
			observation = "-";
		}
		ctx.observed.set(key, observation);
	}
	ctx.recording?.push([key, observation]);
	return observation;
}

function isFile(target: string, ctx: ResolveContext): boolean {
	return observe("kind", target, ctx) === "f";
}

function isDirectory(target: string, ctx: ResolveContext): boolean {
	return observe("kind", target, ctx) === "d";
}

/**
 * Blank out a leading hashbang line (`#!...`) with spaces, preserving source
 * length so AST offsets stay accurate.
 */
function blankHashbang(source: string): string {
	if (!source.startsWith("#!")) {
		return source;
	}
	const newline = source.indexOf("\n");
	const end = newline === -1 ? source.length : newline;
	return " ".repeat(end) + source.slice(end);
}
