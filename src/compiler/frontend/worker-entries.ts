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
		if (
			scope.type === "FunctionDeclaration" ||
			scope.type === "FunctionExpression" ||
			scope.type === "ArrowFunctionExpression"
		) {
			let shadowed = false;
			for (const parameter of scope.params)
				traverseEstree(parameter, (part) => {
					if (part.type === "Identifier" && part.name === local) shadowed = true;
				});
			if (shadowed) return undefined;
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
	record: ModuleRecord,
	node: ESTree.Node,
	seen = new Set<ESTree.Node>(),
): ESTree.Node {
	if (seen.has(node)) return node;
	seen.add(node);
	if (node.type === "Identifier") {
		const initializer = constantInitializer(record, node, node.name);
		return initializer === undefined ? node : aliasExpression(record, initializer, seen);
	}
	if (
		node.type === "MemberExpression" &&
		(!node.computed || node.property.type === "Literal")
	) {
		const object = aliasExpression(record, node.object, seen);
		if (object.type === "ObjectExpression") {
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
					return aliasExpression(record, property.value, seen);
			}
		}
	}
	return node;
}

function calleeIdentity(
	modules: ReadonlyMap<string, ModuleRecord>,
	record: ModuleRecord,
	node: ESTree.Node,
	seen = new Set<string>(),
): ExportIdentity | undefined {
	const expression = aliasExpression(record, node);
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
	const base = calleeIdentity(modules, record, expression.object, seen);
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
	const alias = aliasExpression(record, node);
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
	const contains = (pattern: unknown): boolean => {
		let found = false;
		traverseEstree(pattern, (part) => {
			if (part.type === "Identifier" && part.name === local) found = true;
		});
		return found;
	};
	for (
		let parent = parents.get(node);
		parent !== undefined;
		parent = parents.get(parent)
	) {
		if (
			(parent.type === "FunctionDeclaration" ||
				parent.type === "FunctionExpression" ||
				parent.type === "ArrowFunctionExpression") &&
			(parent.params.some(contains) ||
				(parent.type !== "ArrowFunctionExpression" && parent.id?.name === local))
		)
			return true;
		if (parent.type === "CatchClause" && contains(parent.param)) return true;
		if (parent.type === "BlockStatement") {
			for (const statement of parent.body) {
				if (
					statement.type === "VariableDeclaration" &&
					statement.declarations.some((entry) => contains(entry.id))
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
