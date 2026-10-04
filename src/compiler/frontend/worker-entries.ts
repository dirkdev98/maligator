import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ESTree } from "meriyah";
import { lookupPlatformModule } from "../../platform/catalog.ts";
import { traverseEstree } from "./estree-traversal.ts";
import type { ModuleRecord } from "./module-graph.ts";
import { SyntaxDiagnostic } from "./syntax-diagnostic.ts";

export interface WorkerEntryDeclaration {
	readonly importer: string;
	readonly path: string;
	readonly href: string;
	readonly workerSource?: string;
}

interface ExportIdentity {
	module: string;
	name: string;
}

function name(node: ESTree.Node | null | undefined): string | undefined {
	return node?.type === "Identifier"
		? node.name
		: node?.type === "Literal" && typeof node.value === "string"
			? node.value
			: undefined;
}

function dependency(record: ModuleRecord, specifier: string): string | undefined {
	return (
		record.dependencies.find((entry) => entry.specifier === specifier)?.resolvedPath ??
		undefined
	);
}

function exportIdentity(
	modules: ReadonlyMap<string, ModuleRecord>,
	module: string,
	exported: string,
	seen = new Set<string>(),
): ExportIdentity | undefined {
	const key = `${module}\0${exported}`;
	if (seen.has(key)) return undefined;
	seen.add(key);
	if (module.startsWith("node:") || lookupPlatformModule(module)?.kind === "native") {
		return { module, name: exported };
	}
	const record = modules.get(module);
	if (record === undefined) return undefined;
	for (const statement of record.parsed.ast.body) {
		if (statement.type === "ExportNamedDeclaration") {
			if (
				statement.declaration?.type === "VariableDeclaration" &&
				statement.declaration.kind === "const"
			) {
				for (const declaration of statement.declaration.declarations)
					if (
						declaration.id.type === "Identifier" &&
						declaration.id.name === exported &&
						declaration.init
					)
						return calleeIdentity(modules, record, declaration.init, seen);
			}
			for (const entry of statement.specifiers) {
				if (name(entry.exported) !== exported) continue;
				const local = name(entry.local);
				if (local === undefined) continue;
				if (statement.source) {
					const target = dependency(record, String(statement.source.value));
					if (target !== undefined) return exportIdentity(modules, target, local, seen);
				} else {
					const imported = importedIdentity(modules, record, local, seen);
					if (imported !== undefined) return imported;
					return calleeIdentity(modules, record, entry.local, seen);
				}
			}
		}
		if (statement.type === "ExportAllDeclaration") {
			const target = dependency(record, String(statement.source.value));
			if (target !== undefined) {
				const identity = exportIdentity(modules, target, exported, seen);
				if (identity !== undefined) return identity;
			}
		}
	}
	return undefined;
}

function importedIdentity(
	modules: ReadonlyMap<string, ModuleRecord>,
	record: ModuleRecord,
	local: string,
	seen = new Set<string>(),
): ExportIdentity | undefined {
	for (const statement of record.parsed.ast.body) {
		if (statement.type !== "ImportDeclaration") continue;
		const specifier = statement.specifiers.find((entry) => entry.local.name === local);
		if (specifier === undefined) continue;
		const target = dependency(record, String(statement.source.value));
		if (target === undefined) return undefined;
		if (specifier.type === "ImportNamespaceSpecifier")
			return { module: target, name: "*" };
		return exportIdentity(
			modules,
			target,
			specifier.type === "ImportSpecifier" ? name(specifier.imported)! : "default",
			seen,
		);
	}
	return undefined;
}

const moduleParents = new WeakMap<ModuleRecord, ReadonlyMap<ESTree.Node, ESTree.Node>>();
const stableAggregates = new WeakMap<
	ModuleRecord,
	WeakMap<ESTree.ObjectExpression, boolean>
>();

function bindsName(pattern: ESTree.Node | null, local: string): boolean {
	if (pattern === null) return false;
	switch (pattern.type) {
		case "Identifier":
			return pattern.name === local;
		case "RestElement":
			return bindsName(pattern.argument, local);
		case "AssignmentPattern":
			return bindsName(pattern.left, local);
		case "ArrayPattern":
			return pattern.elements.some((element) => bindsName(element, local));
		case "ObjectPattern":
			return pattern.properties.some((property) =>
				property.type === "Property"
					? bindsName(property.value, local)
					: property.type === "RestElement" && bindsName(property.argument, local),
			);
		default:
			return false;
	}
}

function loopBinding(node: ESTree.Node): ESTree.VariableDeclaration | undefined {
	const binding =
		node.type === "ForStatement"
			? node.init
			: node.type === "ForInStatement" || node.type === "ForOfStatement"
				? node.left
				: undefined;
	return binding?.type === "VariableDeclaration" ? binding : undefined;
}

function parentsFor(record: ModuleRecord): ReadonlyMap<ESTree.Node, ESTree.Node> {
	const parents = moduleParents.get(record);
	if (parents !== undefined) return parents;
	const result = new Map<ESTree.Node, ESTree.Node>();
	traverseEstree(record.parsed.ast, (node, { parent }) => {
		if (parent !== null) result.set(node, parent);
	});
	moduleParents.set(record, result);
	return result;
}

function constantInitializer(
	record: ModuleRecord,
	node: ESTree.Node,
	local: string,
): ESTree.Node | undefined {
	const parents = parentsFor(record);
	for (let scope = parents.get(node); scope !== undefined; scope = parents.get(scope)) {
		if (loopBinding(scope)?.declarations.some((entry) => bindsName(entry.id, local)))
			return undefined;
		if (
			scope.type === "FunctionDeclaration" ||
			scope.type === "FunctionExpression" ||
			scope.type === "ArrowFunctionExpression"
		) {
			if (scope.params.some((parameter) => bindsName(parameter, local))) return undefined;
		}
		if (scope.type !== "Program" && scope.type !== "BlockStatement") continue;
		for (const item of scope.body) {
			const statement = item.type === "ExportNamedDeclaration" ? item.declaration : item;
			if (statement?.type !== "VariableDeclaration") continue;
			for (const declaration of statement.declarations) {
				if (declaration.id.type === "Identifier" && declaration.id.name === local)
					return statement.kind === "const" ? (declaration.init ?? undefined) : undefined;
			}
		}
	}
	return undefined;
}

function aliasExpression(
	modules: ReadonlyMap<string, ModuleRecord>,
	record: ModuleRecord,
	node: ESTree.Node,
	seen = new Set<ESTree.Node>(),
	checkAggregate = true,
): ESTree.Node {
	if (seen.has(node)) return node;
	seen.add(node);
	if (node.type === "Identifier") {
		const initializer = constantInitializer(record, node, node.name);
		return initializer === undefined
			? node
			: aliasExpression(modules, record, initializer, seen, checkAggregate);
	}
	if (
		node.type === "MemberExpression" &&
		(!node.computed || node.property.type === "Literal")
	) {
		const object = aliasExpression(modules, record, node.object, seen, checkAggregate);
		if (object.type === "ObjectExpression") {
			if (checkAggregate && !aggregateIsStable(modules, record, object)) return node;
			const propertyName = name(node.property);
			if (object.properties.some((property) => property.type === "SpreadElement"))
				return node;
			for (const property of [...object.properties].reverse()) {
				if (
					property.type === "Property" &&
					property.kind === "init" &&
					!property.computed &&
					name(property.key) === propertyName
				)
					return aliasExpression(modules, record, property.value, seen, checkAggregate);
			}
		}
	}
	return node;
}

function isWriteReference(
	node: ESTree.Node,
	parents: ReadonlyMap<ESTree.Node, ESTree.Node>,
): boolean {
	for (let parent = parents.get(node); parent !== undefined; parent = parents.get(node)) {
		if (parent.type === "AssignmentExpression") return parent.left === node;
		if (parent.type === "UpdateExpression") return parent.argument === node;
		if (parent.type === "UnaryExpression") return parent.operator === "delete";
		if (parent.type === "ForInStatement" || parent.type === "ForOfStatement")
			return parent.left === node;
		if (
			(parent.type === "MemberExpression" && parent.object === node) ||
			(parent.type === "Property" && parent.value === node) ||
			parent.type === "ArrayPattern" ||
			parent.type === "ObjectPattern" ||
			parent.type === "RestElement" ||
			(parent.type === "AssignmentPattern" && parent.left === node)
		) {
			node = parent;
			continue;
		}
		return false;
	}
	return false;
}

function aggregateIsStable(
	modules: ReadonlyMap<string, ModuleRecord>,
	record: ModuleRecord,
	object: ESTree.ObjectExpression,
): boolean {
	let cache = stableAggregates.get(record);
	if (cache === undefined) {
		cache = new WeakMap();
		stableAggregates.set(record, cache);
	}
	const cached = cache.get(object);
	if (cached !== undefined) return cached;
	cache.set(object, false);
	const parents = parentsFor(record);
	let stable = true;
	traverseEstree(record.parsed.ast, (node) => {
		if (
			!stable ||
			(node.type !== "Identifier" &&
				node.type !== "MemberExpression" &&
				node.type !== "ObjectExpression")
		)
			return;
		const parent = parents.get(node);
		if (
			(parent?.type === "VariableDeclarator" && parent.id === node) ||
			(parent?.type === "MemberExpression" &&
				parent.property === node &&
				!parent.computed) ||
			(parent?.type === "Property" &&
				parent.key === node &&
				!parent.computed &&
				parent.value !== node)
		)
			return;
		if (aliasExpression(modules, record, node, new Set(), false) !== object) return;
		if (parent?.type === "MemberExpression" && parent.object === node) {
			const use = parents.get(parent);
			if (
				isWriteReference(parent, parents) ||
				(use?.type === "CallExpression" &&
					use.callee === parent &&
					!isDeclaration(calleeIdentity(modules, record, parent, new Set(), false)))
			)
				stable = false;
			return;
		}
		if (parent?.type === "VariableDeclarator" && parent.init === node) {
			const declaration = parents.get(parent);
			if (
				declaration?.type === "VariableDeclaration" &&
				declaration.kind === "const" &&
				parents.get(declaration)?.type !== "ExportNamedDeclaration"
			)
				return;
		}
		if (parent?.type === "Property" && parent.value === node) {
			const container = parents.get(parent);
			if (
				container?.type === "ObjectExpression" &&
				aggregateIsStable(modules, record, container)
			)
				return;
		}
		// A const binding does not freeze its object: escaped aliases can mutate fields.
		stable = false;
	});
	cache.set(object, stable);
	return stable;
}

function calleeIdentity(
	modules: ReadonlyMap<string, ModuleRecord>,
	record: ModuleRecord,
	node: ESTree.Node,
	seen = new Set<string>(),
	checkAggregate = true,
): ExportIdentity | undefined {
	const expression = aliasExpression(modules, record, node, new Set(), checkAggregate);
	if (expression.type === "Identifier") {
		if (shadowsImportedBinding(expression, parentsFor(record), expression.name))
			return undefined;
		return importedIdentity(modules, record, expression.name, seen);
	}
	if (
		expression.type !== "MemberExpression" ||
		(expression.computed && expression.property.type !== "Literal")
	)
		return undefined;
	const base = calleeIdentity(modules, record, expression.object, seen, checkAggregate);
	const property = name(expression.property);
	return base?.name === "*" && property !== undefined
		? exportIdentity(modules, base.module, property, seen)
		: undefined;
}

function staticUrlValue(
	modules: ReadonlyMap<string, ModuleRecord>,
	record: ModuleRecord,
	node: ESTree.Node,
	seen = new Set<ESTree.Node>(),
): string | undefined {
	if (seen.has(node)) return undefined;
	seen.add(node);
	const alias = aliasExpression(modules, record, node);
	if (alias !== node) return staticUrlValue(modules, record, alias, seen);
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	if (
		node.type === "MemberExpression" &&
		!node.computed &&
		name(node.property) === "url" &&
		node.object.type === "MetaProperty" &&
		node.object.meta.name === "import"
	) {
		return pathToFileURL(record.sourcePath ?? record.path).href;
	}
	if (node.type === "BinaryExpression" && node.operator === "+") {
		const left = staticUrlValue(modules, record, node.left, new Set(seen));
		const right = staticUrlValue(modules, record, node.right, new Set(seen));
		return left !== undefined && right !== undefined ? left + right : undefined;
	}
	if (node.type === "CallExpression" || node.type === "NewExpression") {
		const identity = calleeIdentity(modules, record, node.callee as ESTree.Node);
		const globalUrl =
			node.type === "NewExpression" &&
			node.callee.type === "Identifier" &&
			node.callee.name === "URL" &&
			!shadowsImportedBinding(node.callee, parentsFor(record), "URL");
		const args = node.arguments.map((argument) =>
			argument.type === "SpreadElement"
				? undefined
				: staticUrlValue(modules, record, argument, new Set(seen)),
		);
		if (args[0] === undefined) return undefined;
		if (identity?.module === "node:url" && identity.name === "fileURLToPath")
			return fileURLToPath(args[0]);
		if (globalUrl || (identity?.module === "node:url" && identity.name === "URL")) {
			return new URL(args[0], args[1]).href;
		}
	}
	return undefined;
}

function isDeclaration(identity: ExportIdentity | undefined): boolean {
	if (identity === undefined) return false;
	const entry = lookupPlatformModule(identity.module)?.exports.find(
		(item) => item.name === identity.name,
	);
	return (
		(entry?.contract as { declaration?: string } | undefined)?.declaration ===
		"worker-entry"
	);
}

function shadowsImportedBinding(
	node: ESTree.Node,
	parents: ReadonlyMap<ESTree.Node, ESTree.Node>,
	local: string,
): boolean {
	for (
		let parent = parents.get(node);
		parent !== undefined;
		parent = parents.get(parent)
	) {
		if (
			(parent.type === "FunctionDeclaration" ||
				parent.type === "FunctionExpression" ||
				parent.type === "ArrowFunctionExpression") &&
			(parent.params.some((parameter) => bindsName(parameter, local)) ||
				(parent.type !== "ArrowFunctionExpression" && parent.id?.name === local))
		)
			return true;
		if (parent.type === "CatchClause" && bindsName(parent.param, local)) return true;
		if (loopBinding(parent)?.declarations.some((entry) => bindsName(entry.id, local)))
			return true;
		if (parent.type === "BlockStatement") {
			for (const statement of parent.body) {
				if (
					statement.type === "VariableDeclaration" &&
					statement.declarations.some((entry) => bindsName(entry.id, local))
				)
					return true;
				if (
					(statement.type === "FunctionDeclaration" ||
						statement.type === "ClassDeclaration") &&
					statement.id?.name === local
				)
					return true;
			}
		}
	}
	return false;
}

export function discoverWorkerEntries(
	modules: ReadonlyMap<string, ModuleRecord>,
	sourceRoot: string,
): Array<WorkerEntryDeclaration> {
	const suppliesWorkerEntries = (module: string): boolean =>
		module === "node:worker_threads" ||
		(lookupPlatformModule(module)?.exports.some((entry) => {
			const contract = entry.contract as
				| { declaration?: string; workerSource?: string }
				| undefined;
			return (
				contract?.declaration === "worker-entry" || contract?.workerSource !== undefined
			);
		}) ??
			false);
	// Alias and reexport resolution can only recognize entries from these API origins.
	let hasWorkerOrigin = false;
	for (const record of modules.values()) {
		if (
			suppliesWorkerEntries(record.path) ||
			record.dependencies.some(
				({ resolvedPath }) =>
					resolvedPath !== null && suppliesWorkerEntries(resolvedPath),
			)
		) {
			hasWorkerOrigin = true;
			break;
		}
	}
	if (!hasWorkerOrigin) return [];
	const entries = new Map<string, WorkerEntryDeclaration>();
	for (const record of modules.values()) {
		if (record.host !== undefined) continue;
		for (const statement of record.parsed.ast.body) {
			if (statement.type !== "ImportDeclaration") continue;
			for (const specifier of statement.specifiers) {
				const identity = importedIdentity(modules, record, specifier.local.name);
				const contract =
					identity === undefined
						? undefined
						: lookupPlatformModule(identity.module)?.exports.find(
								(entry) => entry.name === identity.name,
							)?.contract;
				const workerSource = (contract as { workerSource?: string } | undefined)
					?.workerSource;
				if (workerSource === undefined) continue;
				const target = path.resolve(sourceRoot, workerSource);
				entries.set(`${record.path}\0${target}`, {
					importer: record.path,
					path: target,
					href: pathToFileURL(target).href,
					workerSource,
				});
			}
		}
		traverseEstree(record.parsed.ast.body, (node) => {
			if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
			const identity = calleeIdentity(modules, record, node.callee as ESTree.Node);
			const declaration = node.type === "CallExpression" && isDeclaration(identity);
			const worker =
				node.type === "NewExpression" &&
				identity?.module === "node:worker_threads" &&
				identity.name === "Worker";
			if (!declaration && !worker) return;
			try {
				const first = node.arguments[0];
				const value =
					first === undefined || first.type === "SpreadElement"
						? undefined
						: staticUrlValue(modules, record, first);
				if (value === undefined) {
					if (declaration)
						throw new Error("createWorkerUrl requires a statically declared module URL");
					return;
				}
				const baseNode = declaration ? node.arguments[1] : undefined;
				if (declaration && baseNode === undefined)
					throw new Error("createWorkerUrl requires an explicit static base URL");
				const base =
					baseNode === undefined || baseNode.type === "SpreadElement"
						? undefined
						: staticUrlValue(modules, record, baseNode);
				if (baseNode !== undefined && base === undefined)
					throw new Error("createWorkerUrl base must be statically declared");
				const href = declaration
					? new URL(value, base ?? pathToFileURL(record.sourcePath ?? record.path).href)
							.href
					: value.startsWith("file:")
						? new URL(value).href
						: pathToFileURL(value).href;
				const target = fileURLToPath(href);
				entries.set(`${record.path}\0${target}`, {
					importer: record.path,
					path: target,
					href,
				});
			} catch (error) {
				throw new SyntaxDiagnostic(
					"resolution",
					`Invalid worker entry in ${record.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	}
	return [...entries.values()].sort(
		(left, right) =>
			left.href.localeCompare(right.href) || left.importer.localeCompare(right.importer),
	);
}
