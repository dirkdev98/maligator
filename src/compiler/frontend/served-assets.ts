import type { ESTree } from "meriyah";
import type { PlatformData } from "../../platform/catalog.ts";
import { isEmbedModule } from "./embed-declarations.ts";
import { traverseEstree } from "./estree-traversal.ts";
import type { ModuleRecord } from "./module-graph.ts";
import { bindingAt } from "./worker-entries.ts";

const HTTP_MODULE = "maligator:http";

/**
 * Mark the embed declarations a program passes to `serveAsset` as `served`, so a
 * production build stores compressed copies of their text files. Only handles that
 * reach the call as constants are followed: a declaration imported, re-exported or
 * bound to a `const` resolves, a computed handle compresses nothing.
 */
export function markServedAssets(modules: Map<string, ModuleRecord>): void {
	const served = new Set<string>();
	for (const record of modules.values()) {
		if (record.host !== undefined || !record.source.includes(HTTP_MODULE)) continue;
		const imports = serveAssetBindings(record);
		if (imports.size === 0) continue;
		traverseEstree(record.parsed.ast, (node) => {
			if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
			const callee = node.callee;
			const binding = bindingAt(record, callee, callee.name);
			if (binding === undefined || !imports.has(binding)) return;
			const [asset] = node.arguments;
			if (asset === undefined || asset.type === "SpreadElement") return;
			const declaration = embedModuleOf(modules, record, asset, new Set());
			if (declaration !== undefined) served.add(declaration);
		});
	}
	for (const id of served) {
		const record = modules.get(id)!;
		const host = record.host!;
		const data = host.installData!.default as Record<string, PlatformData>;
		record.host = { ...host, installData: { default: { ...data, served: true } } };
	}
}

function serveAssetBindings(record: ModuleRecord): Set<ESTree.Node> {
	const bindings = new Set<ESTree.Node>();
	for (const statement of record.parsed.ast.body) {
		if (statement.type !== "ImportDeclaration" || statement.source.value !== HTTP_MODULE)
			continue;
		for (const specifier of statement.specifiers)
			if (
				specifier.type === "ImportSpecifier" &&
				(specifier.imported.type === "Identifier"
					? specifier.imported.name
					: String(specifier.imported.value)) === "serveAsset"
			)
				bindings.add(specifier);
	}
	return bindings;
}

function dependencyOf(record: ModuleRecord, specifier: unknown): string | undefined {
	return (
		record.dependencies.find((entry) => entry.specifier === specifier)?.resolvedPath ??
		undefined
	);
}

/** The embed module a constant expression evaluates to, if the build can tell. */
function embedModuleOf(
	modules: ReadonlyMap<string, ModuleRecord>,
	record: ModuleRecord,
	node: ESTree.Node,
	seen: Set<string>,
): string | undefined {
	if (node.type !== "Identifier") return undefined;
	const binding = bindingAt(record, node, node.name);
	if (binding === undefined) return undefined;
	if (binding.type === "VariableDeclarator") {
		const declaration = parentDeclaration(record, binding);
		return declaration?.kind === "const" &&
			binding.init !== null &&
			binding.init !== undefined
			? embedModuleOf(modules, record, binding.init, seen)
			: undefined;
	}
	if (binding.type !== "ImportSpecifier" && binding.type !== "ImportDefaultSpecifier")
		return undefined;
	const statement = record.parsed.ast.body.find(
		(entry) =>
			entry.type === "ImportDeclaration" &&
			(entry.specifiers as ReadonlyArray<ESTree.Node>).includes(binding),
	) as ESTree.ImportDeclaration | undefined;
	const target =
		statement === undefined ? undefined : dependencyOf(record, statement.source.value);
	if (target === undefined) return undefined;
	if (isEmbedModule(target)) return target;
	const exported =
		binding.type === "ImportDefaultSpecifier"
			? "default"
			: binding.imported.type === "Identifier"
				? binding.imported.name
				: String(binding.imported.value);
	return exportedEmbedModule(modules, target, exported, seen);
}

function exportedEmbedModule(
	modules: ReadonlyMap<string, ModuleRecord>,
	module: string,
	exported: string,
	seen: Set<string>,
): string | undefined {
	const key = `${module}\0${exported}`;
	if (seen.has(key)) return undefined;
	seen.add(key);
	const record = modules.get(module);
	if (record === undefined || record.host !== undefined) return undefined;
	for (const statement of record.parsed.ast.body) {
		if (statement.type !== "ExportNamedDeclaration") continue;
		if (
			statement.declaration?.type === "VariableDeclaration" &&
			statement.declaration.kind === "const"
		) {
			for (const declarator of statement.declaration.declarations)
				if (
					declarator.id.type === "Identifier" &&
					declarator.id.name === exported &&
					declarator.init !== null &&
					declarator.init !== undefined
				)
					return embedModuleOf(modules, record, declarator.init, seen);
		}
		for (const specifier of statement.specifiers) {
			const name =
				specifier.exported.type === "Identifier"
					? specifier.exported.name
					: String(specifier.exported.value);
			if (name !== exported || specifier.local.type !== "Identifier") continue;
			if (statement.source !== null && statement.source !== undefined) {
				const target = dependencyOf(record, statement.source.value);
				return target === undefined
					? undefined
					: exportedEmbedModule(modules, target, specifier.local.name, seen);
			}
			return embedModuleOf(modules, record, specifier.local, seen);
		}
	}
	return undefined;
}

function parentDeclaration(
	record: ModuleRecord,
	declarator: ESTree.VariableDeclarator,
): ESTree.VariableDeclaration | undefined {
	let found: ESTree.VariableDeclaration | undefined;
	traverseEstree(record.parsed.ast, (node) => {
		if (
			found === undefined &&
			node.type === "VariableDeclaration" &&
			node.declarations.includes(declarator)
		)
			found = node;
	});
	return found;
}
