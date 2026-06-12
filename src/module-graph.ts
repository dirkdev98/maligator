import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ESTree } from "meriyah";
import { parseModule, parseScript } from "./parser.ts";
import type { SemanticFile } from "./semantic-analysis.ts";

/**
 * The loader/graph phase: the bundler front-end that sits *above* semantic
 * analysis and IR lowering. Starting from an entrypoint it resolves the module
 * graph (goal detection -> specifier extraction -> resolution), recursing into
 * every dependency, and computes a deterministic evaluation order with cycles
 * identified.
 *
 * See docs/decisions/04-bundler.md. This phase only builds the graph; it does
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
	 * resolved (a computed dynamic import). Unresolved *static* specifiers throw
	 * during graph construction rather than landing here.
	 */
	resolvedPath: string | null;
}

export interface ModuleRecord {
	/** Absolute, resolved path. */
	path: string;
	goal: ModuleGoal;
	source: string;
	parsed: Pick<SemanticFile, "type" | "strict" | "ast">;
	dependencies: Array<ModuleDependency>;
}

export interface ModuleGraph {
	/** Absolute path of the entrypoint. */
	entry: string;
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
}

/** Conditions used when resolving a package's `exports` field. ESM-preferring. */
const EXPORT_CONDITIONS = ["maligator", "import", "node", "default"];

/** Extensions probed when a specifier omits one. */
const RESOLVE_EXTENSIONS = [".js", ".mjs", ".cjs", ".json"];

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

	const load = (filePath: string, goal: ModuleGoal, sourceOverride?: string) => {
		if (modules.has(filePath)) {
			return;
		}

		const source = sourceOverride ?? readFileSync(filePath, "utf-8");
		const parsed = parseWithGoal(blankHashbang(source), goal);

		const dependencies = extractDependencies(parsed.ast, goal).map(
			(dependency): ModuleDependency => {
				if (dependency.specifier === null) {
					// A computed `import(expr)` — unresolvable statically. Per the
					// design this is a build error, surfaced by a later validation
					// step; the graph just records it as unresolved for now.
					return { ...dependency, resolvedPath: null };
				}

				const resolved = resolveSpecifier(dependency.specifier, filePath);
				if ("error" in resolved) {
					throw new Error(
						`Cannot resolve '${dependency.specifier}' from ${filePath}: ${resolved.error}`,
					);
				}

				return { ...dependency, resolvedPath: resolved.path };
			},
		);

		// Record before recursing so a cyclic back-import finds this module and
		// stops, rather than looping forever.
		modules.set(filePath, { path: filePath, goal, source, parsed, dependencies });

		for (const dependency of dependencies) {
			if (dependency.resolvedPath && !modules.has(dependency.resolvedPath)) {
				load(
					dependency.resolvedPath,
					options.goalOverride ??
						detectDependencyGoal(dependency.resolvedPath, packageTypeCache),
				);
			}
		}
	};

	load(
		entry,
		options.goalOverride ?? detectEntryGoal(entry, options.entryGoal),
		options.entrySource,
	);

	return {
		entry,
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
 * The entrypoint's goal: extension first, then a `script` default.
 *
 * We intentionally do NOT consult `package.json` "type" for the entrypoint
 * here: this repository is itself `type: module`, and walking up would
 * reclassify every script fixture under tests/ as a module. Dependencies
 * reached through `import` get full detection (detectDependencyGoal); no
 * current fixture exercises that path.
 *
 * TODO(bundler): apply full Node entry detection once fixtures declare their
 * goal and the CJS milestone gives `.js`-as-CommonJS a real lowering.
 */
function detectEntryGoal(filePath: string, explicit?: ModuleGoal): ModuleGoal {
	if (explicit) {
		return explicit;
	}

	switch (path.extname(filePath)) {
		case ".mjs":
			return "module";
		case ".cjs":
			return "cjs";
		default:
			return "script";
	}
}

/**
 * A dependency's goal follows Node: extension, then the nearest `package.json`
 * "type". A `.js` file under `type: module` is a module; otherwise it is
 * CommonJS (which lowering rejects loudly until the CJS milestone).
 */
function detectDependencyGoal(
	filePath: string,
	packageTypeCache: Map<string, ModuleGoal | undefined>,
): ModuleGoal {
	switch (path.extname(filePath)) {
		case ".mjs":
			return "module";
		case ".cjs":
			return "cjs";
		case ".json":
			throw new Error(`JSON imports are not supported yet: ${filePath}`);
		default:
			break;
	}

	return findNearestPackageType(path.dirname(filePath), packageTypeCache) === "module"
		? "module"
		: "cjs";
}

/**
 * Walk up from a directory looking for the nearest `package.json` with a "type"
 * field, returning the goal it implies (module vs commonjs).
 */
function findNearestPackageType(
	dir: string,
	cache: Map<string, ModuleGoal | undefined>,
): ModuleGoal | undefined {
	if (cache.has(dir)) {
		return cache.get(dir);
	}

	const pkg = readPackageJson(path.join(dir, "package.json"));
	if (pkg && typeof pkg.type === "string") {
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

	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) {
				visit(item);
			}
			return;
		}

		if (!node || typeof node !== "object" || !("type" in node)) {
			return;
		}

		const typed = node as ESTree.Node;

		switch (typed.type) {
			case "ImportDeclaration":
				dependencies.push({ specifier: literalString(typed.source), kind: "import" });
				break;
			case "ExportNamedDeclaration":
				// Only re-exports carry a source (`export { x } from "y"`).
				if (typed.source) {
					dependencies.push({ specifier: literalString(typed.source), kind: "export" });
				}
				break;
			case "ExportAllDeclaration":
				dependencies.push({ specifier: literalString(typed.source), kind: "export" });
				break;
			case "ImportExpression":
				dependencies.push({ specifier: literalString(typed.source), kind: "dynamic" });
				break;
			case "CallExpression": {
				// `require("x")` in a CommonJS module. A naive callee-name match: a
				// shadowed/reassigned `require` is a rare edge case refined later.
				// meriyah types CallExpression.callee as `any`, so narrow explicitly.
				const callee = typed.callee as ESTree.Node;
				if (
					goal === "cjs" &&
					callee.type === "Identifier" &&
					callee.name === "require" &&
					typed.arguments.length === 1
				) {
					dependencies.push({
						specifier: literalString(typed.arguments[0]),
						kind: "require",
					});
				}
				break;
			}
			default:
				break;
		}

		for (const key of Object.keys(typed)) {
			visit((typed as unknown as Record<string, unknown>)[key]);
		}
	};

	visit(ast.body);
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

type ResolveResult = { path: string } | { error: string };

/**
 * Resolve a specifier to an absolute on-disk path, Node-style.
 */
function resolveSpecifier(specifier: string, importerPath: string): ResolveResult {
	if (specifier.startsWith("node:")) {
		return { error: `host module '${specifier}' is not supported yet` };
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
		const resolved = probePath(base);
		return resolved ? { path: resolved } : { error: "no such file or directory" };
	}

	return resolveBareSpecifier(specifier, importerDir);
}

/**
 * Resolve a path-like target: exact file, then extension probing, then as a
 * directory (package.json `exports`/`main` or an index file).
 */
function probePath(target: string): string | null {
	if (isFile(target)) {
		return target;
	}

	for (const extension of RESOLVE_EXTENSIONS) {
		if (isFile(target + extension)) {
			return target + extension;
		}
	}

	if (isDirectory(target)) {
		return loadAsDirectory(target);
	}

	return null;
}

/**
 * Resolve a directory to its entry file: `exports["."]`, then `main`, then an
 * index file.
 */
function loadAsDirectory(dir: string): string | null {
	const pkg = readPackageJson(path.join(dir, "package.json"));

	if (pkg?.exports !== undefined) {
		const resolved = resolveExports(pkg.exports, ".", dir);
		if (resolved) {
			return resolved;
		}
	}

	if (pkg && typeof pkg.main === "string") {
		const resolved = probePath(path.resolve(dir, pkg.main));
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
function resolveBareSpecifier(specifier: string, importerDir: string): ResolveResult {
	const { packageName, subpath } = splitBareSpecifier(specifier);

	let dir = importerDir;
	for (;;) {
		const packageDir = path.join(dir, "node_modules", packageName);
		if (isDirectory(packageDir)) {
			const resolved = resolveInPackage(packageDir, subpath);
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
function resolveInPackage(packageDir: string, subpath: string): string | null {
	const pkg = readPackageJson(path.join(packageDir, "package.json"));

	if (subpath === "") {
		if (pkg?.exports !== undefined) {
			const resolved = resolveExports(pkg.exports, ".", packageDir);
			if (resolved) {
				return resolved;
			}
		}
		return loadAsDirectory(packageDir);
	}

	if (pkg?.exports !== undefined) {
		return resolveExports(pkg.exports, `./${subpath}`, packageDir);
	}

	return probePath(path.resolve(packageDir, subpath));
}

type ExportsField = string | Array<ExportsField> | { [key: string]: ExportsField };

/**
 * Resolve a subpath against a package's `exports` field.
 *
 * Handles string targets, condition objects (matched against
 * EXPORT_CONDITIONS), and flat subpath maps. Subpath *patterns* (wildcards like
 * `./*`) are not handled yet.
 *
 * TODO(bundler): wildcard/pattern subpaths in `exports`.
 */
function resolveExports(
	exportsField: ExportsField,
	subpath: string,
	packageDir: string,
): string | null {
	if (typeof exportsField === "string") {
		return subpath === "." ? resolveExportTarget(exportsField, packageDir) : null;
	}

	if (Array.isArray(exportsField)) {
		for (const candidate of exportsField) {
			const resolved = resolveExports(candidate, subpath, packageDir);
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
		return target === undefined ? null : resolveExports(target, ".", packageDir);
	}

	// A conditions object: pick the first condition we honor.
	for (const condition of EXPORT_CONDITIONS) {
		if (condition in exportsField) {
			const resolved = resolveExports(exportsField[condition]!, subpath, packageDir);
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
