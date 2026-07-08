import type { ESTree } from "meriyah";
import { detectCjsExports } from "./cjs-exports.ts";
import type { CjsExportInfo } from "./cjs-exports.ts";
import type { Binding, SemanticFile, SemanticProgram } from "./semantic-analysis.ts";

/**
 * The linker: cross-module binding resolution for ES modules.
 *
 * Each module is analyzed independently (its own scopes + bindings). The linker
 * connects them: it builds every module's export table, resolves each import to
 * the binding it ultimately refers to (following re-exports and `export *`), and
 * then ALIASES the import — every usage of an imported local name is rewritten,
 * in the importing file's `nodeToBinding`, to point at the *exporting* module's
 * binding.
 *
 * Because IR storage is keyed by `Binding` identity and module-top-level
 * bindings are global slots (the shared arena), aliasing means an import and its
 * export share one slot: this is Rollup-style scope hoisting, and live bindings
 * fall out for free (a reassignment in the exporter is observed by importers).
 *
 * ESM → CommonJS interop is also resolved
 * here: an `import` from a CJS module is recorded in `cjsImports` (not aliased)
 * for ir.ts to initialize from `require(...)`. Deferred: re-exporting from CJS
 * (`export … from "cjs"`), `export * as ns`, `export *` ambiguity de-dup, and
 * cycle TDZ.
 */

export interface ModuleLinkage {
	/**
	 * Synthetic bindings created to hold a module's anonymous `export default`
	 * value, keyed by module path. ir.ts stores the compiled default value into
	 * these. Named default exports resolve to the named binding instead and do
	 * not appear here.
	 */
	moduleDefaultBinding: Map<string, Binding>;

	/**
	 * `import * as ns` namespace objects to build, keyed by the importing
	 * module's path. Each carries the local binding to store the object into and
	 * the (sorted) exported names with the exporter binding each reads live.
	 */
	namespaceImports: Map<
		string,
		Array<{ binding: Binding; exports: Array<{ name: string; exporter: Binding }> }>
	>;

	/** Export tables for module namespace objects keyed by exported module path. */
	moduleNamespaces: Map<string, Array<{ name: string; exporter: Binding }>>;

	/**
	 * ESM → CommonJS interop. An `import` whose specifier resolves to a CommonJS
	 * module cannot alias an exporter binding (the CJS module has none); instead
	 * the importing module initializes the local binding from `require(cjsPath)`:
	 * default = `module.exports`, named = `module.exports[name]`, namespace =
	 * `module.exports` itself. Keyed by importing module path.
	 */
	cjsImports: Map<
		string,
		Array<{
			binding: Binding;
			cjsPath: string;
			kind: "default" | "named" | "namespace";
			name?: string;
			/** For `namespace`: the statically-detected member names to expose. */
			names?: Array<string>;
		}>
	>;
}

type ExportEntry =
	// A binding declared in this module.
	| { kind: "local"; binding: Binding }
	// `export { x as y } from "m"` — y resolves to m's export x.
	| { kind: "indirect"; module: string; name: string };

interface ModuleExports {
	named: Map<string, ExportEntry>;
	/** Modules star-re-exported via `export * from "m"`. */
	stars: Array<string>;
}

/**
 * Link the modules of a (multi-module) program. Mutates each file's
 * `nodeToBinding` to alias imported names to their exporter bindings. A
 * single-module program needs no linking.
 */
export function linkModules(program: SemanticProgram): ModuleLinkage {
	const linkage: ModuleLinkage = {
		moduleDefaultBinding: new Map(),
		namespaceImports: new Map(),
		moduleNamespaces: new Map(),
		cjsImports: new Map(),
	};

	const graph = program.graph;
	if (!graph) {
		return linkage;
	}
	// Note: we link even a single-module graph — a module can import itself
	// (`export default x; import d from "./self"`), which still needs aliasing
	// and default-binding synthesis.

	// specifier -> resolved module path, per module.
	const specifierToPath = new Map<string, Map<string, string>>();
	for (const [path, record] of graph.modules) {
		const map = new Map<string, string>();
		for (const dependency of record.dependencies) {
			if (dependency.specifier !== null && dependency.resolvedPath !== null) {
				map.set(dependency.specifier, dependency.resolvedPath);
			}
		}
		specifierToPath.set(path, map);
	}

	const goalOf = (path: string) => graph.modules.get(path)?.goal;

	const resolveDependency = (
		file: SemanticFile,
		specifier: string,
		allowCommonJs = false,
	): string => {
		const path = specifierToPath.get(file.path)?.get(specifier);
		if (!path) {
			throw new Error(`Linker: '${specifier}' is not a dependency of ${file.path}`);
		}
		// `import` from CommonJS is interop (handled by the caller); re-exporting
		// from CommonJS is not supported yet.
		if (!allowCommonJs && goalOf(path) === "cjs") {
			throw new Error(
				`Linker: '${specifier}' resolves to a CommonJS module (${path}); ` +
					`re-exporting from CommonJS is not supported yet`,
			);
		}
		return path;
	};

	const recordCjsImport = (
		file: SemanticFile,
		binding: Binding,
		cjsPath: string,
		entry: {
			kind: "default" | "named" | "namespace";
			name?: string;
			names?: Array<string>;
		},
	) => {
		const list = linkage.cjsImports.get(file.path) ?? [];
		list.push({ binding, cjsPath, ...entry });
		linkage.cjsImports.set(file.path, list);
	};

	// `export … from "cjs"` has no exporter binding to alias, so synthesize one
	// the re-exporting module initializes from `require(cjs)[localName]` (default
	// = module.exports). Importers then alias to this synthetic binding normally.
	const cjsReexportBinding = (
		file: SemanticFile,
		cjsPath: string,
		localName: string,
	): Binding => {
		const binding: Binding = {
			kind: "const",
			name: `*cjs-reexport:${localName}*`,
			usageNodes: [],
			scopedTo: "global",
		};
		recordCjsImport(
			file,
			binding,
			cjsPath,
			localName === "default" ? { kind: "default" } : { kind: "named", name: localName },
		);
		return binding;
	};

	// Memoized static export-name detection for a CommonJS module.
	const fileByPath = new Map(program.files.map((file) => [file.path, file]));
	const exportInfoCache = new Map<string, CjsExportInfo>();
	const cjsExportInfo = (cjsPath: string): CjsExportInfo => {
		let info = exportInfoCache.get(cjsPath);
		if (!info) {
			const ast = fileByPath.get(cjsPath)?.ast;
			info = ast
				? detectCjsExports(ast)
				: { names: new Set<string>(), complete: false, reassignsModuleExports: false };
			exportInfoCache.set(cjsPath, info);
		}
		return info;
	};

	// import binding -> where it imports from. Lets resolveExport follow a
	// re-exported import (`import {x} from "a"; export {x};`).
	const importInfo = new Map<Binding, { module: string; name: string }>();
	// Collected for the aliasing pass: importing file, local import binding,
	// and the (source module, imported name) it points at.
	const importsToAlias: Array<{
		file: SemanticFile;
		binding: Binding;
		module: string;
		name: string;
	}> = [];
	// `import * as ns` to resolve once all export tables exist.
	const namespaceToResolve: Array<{
		file: SemanticFile;
		binding: Binding;
		module: string;
	}> = [];

	const exportsByModule = new Map<string, ModuleExports>();

	// --- Phase A: scan exports + imports of every module ---
	for (const file of program.files) {
		const moduleExports: ModuleExports = { named: new Map(), stars: [] };
		exportsByModule.set(file.path, moduleExports);

		const topBinding = (name: string) => lookupTopLevelBinding(file, name);

		for (const statement of file.ast.body) {
			switch (statement.type) {
				case "ImportDeclaration": {
					const module = resolveDependency(file, literalValue(statement.source), true);
					const moduleIsCommonJs = goalOf(module) === "cjs";
					for (const specifier of statement.specifiers) {
						const binding = file.nodeToBinding.get(specifier.local);
						if (specifier.type === "ImportNamespaceSpecifier") {
							// `import * as ns` — a namespace object, built once all
							// export tables exist (Phase B). Not aliased.
							if (binding) {
								if (moduleIsCommonJs) {
									recordCjsImport(file, binding, module, {
										kind: "namespace",
										names: [...cjsExportInfo(module).names],
									});
								} else {
									namespaceToResolve.push({ file, binding, module });
								}
							}
							continue;
						}
						const isDefault = specifier.type === "ImportDefaultSpecifier";
						const name = isDefault ? "default" : specifierName(specifier.imported);
						if (!binding) {
							continue;
						}
						if (moduleIsCommonJs) {
							// ESM → CJS: default = module.exports, named = module.exports[name].
							recordCjsImport(
								file,
								binding,
								module,
								isDefault ? { kind: "default" } : { kind: "named", name },
							);
						} else {
							importInfo.set(binding, { module, name });
							importsToAlias.push({ file, binding, module, name });
						}
					}
					break;
				}
				case "ExportNamedDeclaration": {
					if (statement.declaration) {
						for (const name of boundNames(statement.declaration)) {
							const binding = topBinding(name);
							if (binding) {
								moduleExports.named.set(name, { kind: "local", binding });
							}
						}
					} else if (statement.source) {
						const module = resolveDependency(file, literalValue(statement.source), true);
						const moduleIsCommonJs = goalOf(module) === "cjs";
						for (const specifier of statement.specifiers) {
							const localName = specifierName(specifier.local);
							if (moduleIsCommonJs) {
								moduleExports.named.set(specifierName(specifier.exported), {
									kind: "local",
									binding: cjsReexportBinding(file, module, localName),
								});
							} else {
								moduleExports.named.set(specifierName(specifier.exported), {
									kind: "indirect",
									module,
									name: localName,
								});
							}
						}
					} else {
						for (const specifier of statement.specifiers) {
							const binding = topBinding(specifierName(specifier.local));
							if (binding) {
								moduleExports.named.set(specifierName(specifier.exported), {
									kind: "local",
									binding,
								});
							}
						}
					}
					break;
				}
				case "ExportDefaultDeclaration": {
					moduleExports.named.set(
						"default",
						resolveDefaultExport(statement, file, linkage),
					);
					break;
				}
				case "ExportAllDeclaration": {
					if (statement.exported) {
						throw new Error(
							`Linker: \`export * as ${specifierName(statement.exported)}\` ` +
								`is not supported yet (${file.path})`,
						);
					}
					const module = resolveDependency(file, literalValue(statement.source), true);
					if (goalOf(module) === "cjs") {
						// `export * from "cjs"`: re-export each statically-detected name
						// (default is excluded, as for ESM `export *`).
						for (const name of cjsExportInfo(module).names) {
							moduleExports.named.set(name, {
								kind: "local",
								binding: cjsReexportBinding(file, module, name),
							});
						}
					} else {
						moduleExports.stars.push(module);
					}
					break;
				}
				default:
					break;
			}
		}
	}

	// --- resolveExport: follow named/indirect/re-exported-import/star to a binding ---
	const resolveExport = (
		modulePath: string,
		name: string,
		visited = new Set<string>(),
	): Binding | null => {
		const key = `${modulePath}\0${name}`;
		if (visited.has(key)) {
			return null;
		}
		visited.add(key);

		const moduleExports = exportsByModule.get(modulePath);
		if (!moduleExports) {
			return null;
		}

		const entry = moduleExports.named.get(name);
		if (entry) {
			if (entry.kind === "indirect") {
				return resolveExport(entry.module, entry.name, visited);
			}
			// A local export whose binding is itself imported re-exports the source.
			const imported = importInfo.get(entry.binding);
			return imported
				? resolveExport(imported.module, imported.name, visited)
				: entry.binding;
		}

		// `export *` re-exports every name except default. First match wins;
		// proper ambiguity handling is deferred.
		if (name !== "default") {
			for (const starModule of moduleExports.stars) {
				const resolved = resolveExport(starModule, name, visited);
				if (resolved) {
					return resolved;
				}
			}
		}

		return null;
	};

	// --- Phase B: resolve every import and alias its usages to the exporter ---
	const writeTargetsByFile = new Map<SemanticFile, Set<ESTree.Node>>();
	const writeTargetsFor = (file: SemanticFile) => {
		let set = writeTargetsByFile.get(file);
		if (!set) {
			set = collectAssignmentTargets(file.ast);
			writeTargetsByFile.set(file, set);
		}
		return set;
	};

	for (const { file, binding, module, name } of importsToAlias) {
		const exporter = resolveExport(module, name);
		if (!exporter) {
			throw new Error(
				`Linker: ${module} does not export '${name}' (imported by ${file.path})`,
			);
		}
		const writeTargets = writeTargetsFor(file);
		for (const usage of binding.usageNodes) {
			// An assignment/update target stays on the (immutable) import binding so
			// the write throws a TypeError; reads alias to the exporter's slot.
			if (writeTargets.has(usage)) {
				continue;
			}
			file.nodeToBinding.set(usage, exporter);
			// The exporter is used cross-module: record the usage on it so the
			// exporting module's own dead-code elimination does not drop an
			// exported-but-locally-unused declaration. A truly unimported export
			// still has no usages and is shaken.
			exporter.usageNodes.push(usage);
		}
	}

	// Every exported name of a module, following `export *` transitively
	// (excluding re-exported defaults). Sorted by code unit, as a module
	// namespace object's keys are. `visited` guards against `export *` cycles.
	const exportNamesOf = (
		modulePath: string,
		visited = new Set<string>(),
	): Array<string> => {
		if (visited.has(modulePath)) {
			return [];
		}
		visited.add(modulePath);

		const names = new Set<string>();
		const moduleExports = exportsByModule.get(modulePath);
		if (moduleExports) {
			for (const name of moduleExports.named.keys()) {
				names.add(name);
			}
			for (const starModule of moduleExports.stars) {
				for (const name of exportNamesOf(starModule, visited)) {
					if (name !== "default") {
						names.add(name);
					}
				}
			}
		}
		return [...names].sort();
	};

	// --- Phase C: resolve `import * as ns` namespaces ---
	for (const file of program.files) {
		if (goalOf(file.path) === "cjs") {
			continue;
		}
		const nsExports: Array<{ name: string; exporter: Binding }> = [];
		for (const name of exportNamesOf(file.path)) {
			const exporter = resolveExport(file.path, name);
			if (exporter) {
				nsExports.push({ name, exporter });
				exporter.usageNodes.push(file.ast);
			}
		}
		linkage.moduleNamespaces.set(file.path, nsExports);
	}

	for (const { file, binding, module } of namespaceToResolve) {
		const nsExports: Array<{ name: string; exporter: Binding }> = [];
		for (const name of exportNamesOf(module)) {
			const exporter = resolveExport(module, name);
			if (exporter) {
				nsExports.push({ name, exporter });
				// The namespace's getters read each exporter's slot directly (no
				// usage node), so mark the exporter used or the exporting module's
				// dead-code elimination would drop an exported-but-otherwise-unused
				// function.
				if (binding.declarationNode) {
					exporter.usageNodes.push(binding.declarationNode);
				}
			}
		}
		const list = linkage.namespaceImports.get(file.path) ?? [];
		list.push({ binding, exports: nsExports });
		linkage.namespaceImports.set(file.path, list);
	}

	return linkage;
}

/**
 * Resolve the `default` export of a module to an entry, synthesizing a binding
 * for anonymous default values.
 */
function resolveDefaultExport(
	statement: ESTree.ExportDefaultDeclaration,
	file: SemanticFile,
	linkage: ModuleLinkage,
): ExportEntry {
	const declaration = statement.declaration;

	if (
		(declaration.type === "FunctionDeclaration" ||
			declaration.type === "ClassDeclaration") &&
		declaration.id
	) {
		const binding = lookupTopLevelBinding(file, declaration.id.name);
		if (binding) {
			return { kind: "local", binding };
		}
	}

	// Anonymous function/class or an arbitrary expression: a fresh module-scoped
	// binding holds the value, which ir.ts stores via linkage.moduleDefaultBinding.
	const binding: Binding = {
		kind: "const",
		name: "*default*",
		declarationNode: statement,
		usageNodes: [],
		scopedTo: "global",
	};
	linkage.moduleDefaultBinding.set(file.path, binding);
	return { kind: "local", binding };
}

/** The top-level (module/program scope) declared binding for a name, if any. */
function lookupTopLevelBinding(file: SemanticFile, name: string): Binding | undefined {
	return file.scopes[0]?.bindings.find(
		(binding) => binding.name === name && !binding.undeclared,
	);
}

/** Names introduced by an exported declaration (handles destructuring). */
function boundNames(declaration: ESTree.Node): Array<string> {
	if (
		declaration.type === "FunctionDeclaration" ||
		declaration.type === "ClassDeclaration"
	) {
		return declaration.id ? [declaration.id.name] : [];
	}
	if (declaration.type === "VariableDeclaration") {
		return declaration.declarations.flatMap((declarator) => patternNames(declarator.id));
	}
	return [];
}

/**
 * Identifier nodes that are the target of an assignment or update — i.e. writes.
 * Used to keep writes to imported names on the (immutable) import binding so
 * they throw, while reads alias to the exporter.
 */
function collectAssignmentTargets(ast: ESTree.Program): Set<ESTree.Node> {
	const targets = new Set<ESTree.Node>();

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
		if (typed.type === "AssignmentExpression" && typed.left.type === "Identifier") {
			targets.add(typed.left);
		}
		if (typed.type === "UpdateExpression" && typed.argument.type === "Identifier") {
			targets.add(typed.argument);
		}
		for (const key of Object.keys(typed)) {
			visit((typed as unknown as Record<string, unknown>)[key]);
		}
	};

	visit(ast.body);
	return targets;
}

/** Bound names within a binding pattern. */
function patternNames(node: ESTree.Node | null | undefined): Array<string> {
	if (!node) {
		return [];
	}
	switch (node.type) {
		case "Identifier":
			return [node.name];
		case "ArrayPattern":
			return node.elements.flatMap(patternNames);
		case "ObjectPattern":
			return node.properties.flatMap(patternNames);
		case "RestElement":
			return patternNames(node.argument);
		case "AssignmentPattern":
			return patternNames(node.left);
		case "Property":
			return patternNames(node.value);
		default:
			return [];
	}
}

/** The string value of a module-specifier literal. */
function literalValue(node: ESTree.Literal): string {
	return String(node.value);
}

/** The name of an `import`/`export` specifier side (Identifier or string literal). */
function specifierName(node: ESTree.Node): string {
	if ("name" in node && typeof node.name === "string") {
		return node.name;
	}
	if ("value" in node) {
		return String(node.value);
	}
	return "";
}
