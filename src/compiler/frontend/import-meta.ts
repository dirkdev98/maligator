import type { ESTree } from "meriyah";

// Shared by the module graph and Core lowering; it must stay free of Node imports so
// the self-hosted eval compiler can carry it.

export function isImportMeta(node: ESTree.Node): node is ESTree.MetaProperty {
	return (
		node.type === "MetaProperty" &&
		node.meta.name === "import" &&
		node.property.name === "meta"
	);
}

/** `import.meta.resolve(…)`, whatever its arguments. */
export function isImportMetaResolveCall(
	node: ESTree.Node,
): node is ESTree.CallExpression {
	if (node.type !== "CallExpression") return false;
	const callee = node.callee as ESTree.Node;
	return (
		callee.type === "MemberExpression" &&
		isImportMeta(callee.object) &&
		(callee.computed
			? callee.property.type === "Literal" && callee.property.value === "resolve"
			: callee.property.type === "Identifier" && callee.property.name === "resolve")
	);
}
