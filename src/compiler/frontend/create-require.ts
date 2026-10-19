import type { ESTree } from "meriyah";
import { traverseEstree } from "./estree-traversal.ts";

// Shared by the module graph and Core lowering; it must stay free of Node imports so
// the self-hosted eval compiler can carry it.

export type CreateRequireDeclarator = ESTree.VariableDeclarator & {
	id: ESTree.Identifier;
	init: ESTree.CallExpression;
};

/**
 * Declarators initialized with `createRequire(import.meta.url)` from node:module.
 * The returned `require` resolves relative to this module, so its literal calls
 * are graph edges exactly like a CommonJS module's `require("…")`.
 */
export function moduleCreateRequireDeclarators(
	ast: ESTree.Program,
): Array<CreateRequireDeclarator> {
	const factories = new Set<string>();
	const namespaces = new Set<string>();
	for (const statement of ast.body) {
		if (
			statement.type !== "ImportDeclaration" ||
			(statement.source.value !== "module" && statement.source.value !== "node:module")
		) {
			continue;
		}
		for (const specifier of statement.specifiers) {
			if (specifier.type === "ImportSpecifier") {
				const imported = specifier.imported;
				if (imported.type === "Identifier" && imported.name === "createRequire") {
					factories.add(specifier.local.name);
				}
			} else {
				namespaces.add(specifier.local.name);
			}
		}
	}
	const declarators: Array<CreateRequireDeclarator> = [];
	if (factories.size === 0 && namespaces.size === 0) return declarators;
	traverseEstree(ast.body, (node) => {
		if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			node.init?.type === "CallExpression" &&
			isModuleCreateRequire(node.init, factories, namespaces)
		) {
			declarators.push(node as CreateRequireDeclarator);
		}
	});
	return declarators;
}

function isModuleCreateRequire(
	node: ESTree.Node,
	factories: ReadonlySet<string>,
	namespaces: ReadonlySet<string>,
): boolean {
	if (node.type !== "CallExpression" || node.arguments.length !== 1) return false;
	const callee = node.callee as ESTree.Node;
	const factory =
		(callee.type === "Identifier" && factories.has(callee.name)) ||
		(callee.type === "MemberExpression" &&
			!callee.computed &&
			callee.object.type === "Identifier" &&
			namespaces.has(callee.object.name) &&
			callee.property.type === "Identifier" &&
			callee.property.name === "createRequire");
	return factory && isImportMetaUrl(node.arguments[0] as ESTree.Node);
}

function isImportMetaUrl(node: ESTree.Node): boolean {
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.object.type === "MetaProperty" &&
		node.object.meta.name === "import" &&
		node.property.type === "Identifier" &&
		node.property.name === "url"
	);
}
