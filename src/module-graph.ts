import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ESTree } from "meriyah";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { traverseEstree } from "./estree-traversal.ts";
import type { HostModuleSpec } from "./host-modules.ts";
import {
	canonicalNodeBuiltinId,
	canonicalNodeHostModuleId,
	isNodeSpecifier,
	lookupHostModule,
	supportedHostModuleIds,
} from "./host-modules.ts";
import { parseModule, parseScript } from "./parser.ts";
import type { SemanticFile } from "./semantic-analysis.ts";

/** TypeScript source extensions stripped to JS before parsing. */
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

/**
 * The loader/graph phase: the bundler front-end that sits *above* semantic
 * analysis and IR lowering. Starting from an entrypoint it resolves the module
 * graph (goal detection -> specifier extraction -> resolution), recursing into
 * every dependency, and computes a deterministic evaluation order with cycles
 * identified.
 *
 * This phase only builds the graph; it does
 * not lower imports/exports to IR (that is a later milestone). A program with
 * no imports is simply a single-node graph, so the existing single-file path is
 * unchanged.
 */

export type ModuleGoal = "script" | "module" | "cjs";

export type ModuleDependencyKind =
	// `import ... from "x"`
	| "import"
	// `export ... from "x"` / `export * from "x"`
	| "export"
	// `import("x")`
	| "dynamic"
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

export interface ModuleRecord {
	/**
	 * Absolute, resolved path — or, for a host virtual module, its canonical
	 * specifier (e.g. `"node:path"`).
	 */
	path: string;
	goal: ModuleGoal;
	source: string;
	parsed: Pick<SemanticFile, "type" | "strict" | "ast">;
	dependencies: Array<ModuleDependency>;
	/**
	 * Set for a `node:*` host built-in resolved from the static catalog
	 * (host-modules.ts) rather than read from disk. Carries the planned export
	 * surface the linker will bind once host exports land; until then the record
	 * has no user source (empty parse) and is skipped by semantic analysis.
	 */
	host?: HostModuleSpec;
	/** In-memory source supplied by the embedding toolchain (for example maligator:test). */
	virtual?: true;
}

export interface ModuleGraph {
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

export interface BuildModuleGraphOptions {
	/**
	 * Blank TypeScript syntax in place. Required when any `.ts`, `.mts`, or
	 * `.cts` module is loaded; JavaScript-only graphs do not need a callback.
	 */
	stripTypes?: (source: string, filePath: string) => string;

	/** Force the entrypoint's goal, bypassing extension-based detection. */
	entryGoal?: ModuleGoal;

	/**
	 * Use this source for the entrypoint instead of reading it from disk. The
	 * entrypoint's path is still used for resolving its (on-disk) dependencies.
	 * Lets a caller compose an entry module in memory (e.g. test262 prepends its
	 * harness) while sibling imports still resolve from the real directory.
	 */
	entrySource?: string;

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
	 * The resolved build config, which gates surface-dependent resolution: the
	 * `node` package export condition and `node:*` host built-in imports are active
	 * only under `surface.node`. Defaults to the product defaults (node OFF).
	 */
	buildConfig?: ResolvedBuildConfig;

	/**
	 * Toolchain-owned modules that resolve without a package or filesystem entry.
	 * Their public specifier is also their stable graph identity. This is an
	 * embedding seam, not a user alias mechanism.
	 */
	virtualModules?: ReadonlyMap<
		string,
		{ source: string; goal?: Exclude<ModuleGoal, "cjs"> }
	>;
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

/**
 * Surface-dependent resolution inputs threaded through the resolver: the active
 * `exports` conditions and whether `node:*` host built-ins resolve.
 */
interface ResolveContext {
	conditions: ReadonlySet<string>;
	nodeEnabled: boolean;
}

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
	const packageTypeCache = new Map<string, ModuleGoal | undefined>();

	const nodeEnabled = options.buildConfig?.surface.node ?? false;
	const ctx: ResolveContext = {
		nodeEnabled,
		conditions: exportConditions(nodeEnabled, "import"),
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

		const source = sourceOverride ?? readFileSync(filePath, "utf-8");
		let parseSource = blankHashbang(source);
		if (path.extname(filePath) === ".json") {
			// Validate with the JSON grammar now, then parse a CommonJS wrapper that
			// preserves JSON.parse semantics for keys such as "__proto__".
			JSON.parse(source);
			parseSource = `module.exports = JSON.parse(${JSON.stringify(source)});`;
		}
		if (TS_EXTENSIONS.has(path.extname(filePath))) {
			if (!options.stripTypes) {
				throw new Error(
					`TypeScript module '${filePath}' requires BuildModuleGraphOptions.stripTypes`,
				);
			}
			parseSource = options.stripTypes(parseSource, filePath);
		}
		const parsed = parseWithGoal(parseSource, goal);

		const dependencies = extractDependencies(parsed.ast, goal).map(
			(dependency): ModuleDependency => {
				if (dependency.specifier === null) {
					// A computed import/require cannot be resolved while building the
					// graph. Preserve the edge for later lowering/runtime handling.
					return { ...dependency, resolvedPath: null };
				}
				const virtualModule = options.virtualModules?.get(dependency.specifier);
				if (virtualModule !== undefined) {
					if (dependency.kind === "dynamic" || dependency.kind === "require") {
						throw new SyntaxError(
							`Toolchain module '${dependency.specifier}' supports static ESM imports only`,
						);
					}
					return { ...dependency, resolvedPath: dependency.specifier };
				}
				const canonicalHostId = canonicalNodeHostModuleId(dependency.specifier);
				const canonicalBuiltinId = canonicalNodeBuiltinId(dependency.specifier);
				const resolved = resolveSpecifier(
					canonicalHostId ?? canonicalBuiltinId ?? dependency.specifier,
					filePath,
					{
						...ctx,
						conditions: exportConditions(
							ctx.nodeEnabled,
							dependency.kind === "require" ? "require" : "import",
						),
					},
				);
				if ("host" in resolved) {
					if (dependency.kind === "dynamic") {
						// A host built-in's exports are synthesized into global slots at link
						// time and filled by a native installer before execution — there is
						// no runtime module object for `import()` to resolve to a namespace in
						// this slice. Reject a literal dynamic import rather than resolve it to
						// a namespace that cannot be built; a static import is the supported
						// form.
						throw new SyntaxError(
							`Cannot dynamically import node built-in '${resolved.host.id}' from ${filePath}: ` +
								`node built-ins support static import only`,
						);
					}
					// A supported `node:*` built-in: identity is its canonical specifier.
					return { ...dependency, resolvedPath: resolved.host.id };
				}
				if ("error" in resolved) {
					// A `node:*` error (surface disabled / unknown built-in) is `hard`: it
					// rejects even a literal dynamic import rather than silently deferring,
					// so an unsupported host import fails loudly at build time. A plain
					// dynamic resolution failure (missing file) still defers to the graph.
					if (dependency.kind === "dynamic" && !resolved.hard) {
						return { ...dependency, resolvedPath: null };
					}
					if (
						dependency.kind === "require" &&
						dependency.catchableMissing &&
						!resolved.hard
					) {
						return { ...dependency, resolvedPath: null };
					}
					// A static import that cannot resolve fails the graph — the
					// resolution-phase SyntaxError of 16.2.1.6.1.
					throw new SyntaxError(
						`Cannot resolve '${dependency.specifier}' from ${filePath}: ${resolved.error}`,
					);
				}

				return { ...dependency, resolvedPath: resolved.path };
			},
		);

		// Record before recursing so a cyclic back-import finds this module and
		// stops, rather than looping forever.
		modules.set(filePath, {
			path: filePath,
			goal,
			source,
			parsed,
			dependencies,
			...(virtual ? { virtual: true as const } : {}),
		});

		for (const dependency of dependencies) {
			const resolvedPath = dependency.resolvedPath;
			if (!resolvedPath || modules.has(resolvedPath)) {
				continue;
			}
			// A `node:*` host built-in resolves to a virtual record from the catalog —
			// no disk read, no recursion (it has no dependencies of its own).
			const host = lookupHostModule(resolvedPath);
			if (host) {
				modules.set(resolvedPath, hostModuleRecord(host));
				continue;
			}
			const virtualModule = options.virtualModules?.get(resolvedPath);
			if (virtualModule !== undefined) {
				load(resolvedPath, virtualModule.goal ?? "module", virtualModule.source, true);
				continue;
			}
			load(
				resolvedPath,
				options.goalOverride ??
					options.dependencyGoalOverride ??
					detectDependencyGoal(resolvedPath, packageTypeCache),
			);
		}
	};

	load(
		entry,
		options.goalOverride ??
			options.entryGoal ??
			detectDependencyGoal(entry, packageTypeCache),
		options.entrySource,
	);

	return {
		entry,
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
function parseWithGoal(source: string, goal: ModuleGoal) {
	if (goal === "module") {
		return parseModule(source);
	}
	return parseScript(source, { strict: true });
}

/**
 * A module's automatic goal follows Node: extension, then the nearest `package.json`
 * "type". A `.js` file under `type: module` is a module; otherwise it is
 * CommonJS.
 */
function detectDependencyGoal(
	filePath: string,
	packageTypeCache: Map<string, ModuleGoal | undefined>,
): ModuleGoal {
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

	return findNearestPackageType(path.dirname(filePath), packageTypeCache) === "module"
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
	cache: Map<string, ModuleGoal | undefined>,
): ModuleGoal | undefined {
	if (cache.has(dir)) {
		return cache.get(dir);
	}

	const pkg = readPackageJson(path.join(dir, "package.json"));
	if (pkg) {
		const goal: ModuleGoal = pkg.type === "module" ? "module" : "cjs";
		cache.set(dir, goal);
		return goal;
	}

	const parent = path.dirname(dir);
	const goal = parent === dir ? undefined : findNearestPackageType(parent, cache);
	cache.set(dir, goal);
	return goal;
}

interface ExtractedDependency {
	specifier: string | null;
	kind: ModuleDependencyKind;
	catchableMissing?: true;
}

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

	traverseEstree(ast.body, (node, { parent }) => {
		if (parent) parents.set(node, parent);
		switch (node.type) {
			case "ImportDeclaration":
				dependencies.push({ specifier: literalString(node.source), kind: "import" });
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

/**
 * A minimal virtual record for a supported `node:*` host built-in. It carries no
 * user source (empty parse, so it is inert under semantic analysis) — the linker
 * will read {@link HostModuleSpec} to synthesize the host exports later.
 */
function hostModuleRecord(host: HostModuleSpec): ModuleRecord {
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
	if (isFile(target)) {
		return target;
	}

	for (const extension of RESOLVE_EXTENSIONS) {
		if (isFile(target + extension)) {
			return target + extension;
		}
	}

	if (isDirectory(target)) {
		return loadAsDirectory(target, ctx);
	}

	return null;
}

/**
 * Resolve a directory to its entry file: `exports["."]`, then `main`, then an
 * index file.
 */
function loadAsDirectory(dir: string, ctx: ResolveContext): string | null {
	const pkg = readPackageJson(path.join(dir, "package.json"));

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
		if (isFile(indexFile)) {
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
		if (isDirectory(packageDir)) {
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
function splitBareSpecifier(specifier: string): { packageName: string; subpath: string } {
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
	const pkg = readPackageJson(path.join(packageDir, "package.json"));

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
 * EXPORT_CONDITIONS), and flat subpath maps. Subpath *patterns* (wildcards like
 * `./*`) are not handled yet.
 *
 * Wildcard/pattern subpaths in `exports` remain unsupported.
 */
function resolveExports(
	exportsField: ExportsField,
	subpath: string,
	packageDir: string,
	ctx: ResolveContext,
): string | null {
	if (typeof exportsField === "string") {
		return subpath === "." ? resolveExportTarget(exportsField, packageDir) : null;
	}

	if (Array.isArray(exportsField)) {
		for (const candidate of exportsField) {
			const resolved = resolveExports(candidate, subpath, packageDir, ctx);
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
		return target === undefined ? null : resolveExports(target, ".", packageDir, ctx);
	}

	// A conditions object: object declaration order determines precedence. Skip
	// unknown conditions, as Node does, rather than imposing our own priority. The
	// `node` condition is only in ctx.conditions under surface.node.
	for (const [condition, target] of Object.entries(exportsField)) {
		if (ctx.conditions.has(condition)) {
			const resolved = resolveExports(target, subpath, packageDir, ctx);
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
function resolveExportTarget(target: string, packageDir: string): string | null {
	if (!target.startsWith("./")) {
		return null;
	}
	const resolved = path.resolve(packageDir, target);
	return isFile(resolved) ? resolved : null;
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
		if (dependency.kind !== "dynamic" && dependency.resolvedPath) {
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

const packageJsonCache = new Map<string, PackageJson | null>();

/** Read and cache a package.json, returning null when absent or unparseable. */
function readPackageJson(packageJsonPath: string): PackageJson | null {
	if (packageJsonCache.has(packageJsonPath)) {
		return packageJsonCache.get(packageJsonPath)!;
	}

	let parsed: PackageJson | null = null;
	if (isFile(packageJsonPath)) {
		try {
			parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
		} catch {
			parsed = null;
		}
	}

	packageJsonCache.set(packageJsonPath, parsed);
	return parsed;
}

function isFile(target: string): boolean {
	try {
		return statSync(target).isFile();
	} catch {
		return false;
	}
}

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
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
