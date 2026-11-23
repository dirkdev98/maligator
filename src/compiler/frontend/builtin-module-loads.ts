import type { ESTree } from "meriyah";
import { traverseEstree } from "./estree-traversal.ts";
import type { SemanticFile } from "./semantic-analysis.ts";

const literalCallees = new WeakMap<SemanticFile, ReadonlyMap<ESTree.Node, string>>();

export const GET_BUILTIN_MODULE = "getBuiltinModule";

/** The key of a member access that names its property statically. */
export function staticMemberKey(member: ESTree.MemberExpression): string | undefined {
	if (!member.computed && member.property.type === "Identifier")
		return member.property.name;
	return member.property.type === "Literal" && typeof member.property.value === "string"
		? member.property.value
		: undefined;
}

function literalString(node: ESTree.Node | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
		return node.quasis[0]?.value.cooked ?? undefined;
	return undefined;
}

export function literalBuiltinModuleCall(
	node: ESTree.CallExpression,
): string | undefined {
	const target = node.callee;
	if (
		target.type === "Identifier" ||
		(target.type === "MemberExpression" && staticMemberKey(target) === GET_BUILTIN_MODULE)
	)
		return literalString(node.arguments[0]);
	return undefined;
}

export function literalBuiltinModuleSpecifier(
	file: SemanticFile,
	callee: ESTree.Node,
): string | undefined {
	let calls = literalCallees.get(file);
	if (calls === undefined) {
		const found = new Map<ESTree.Node, string>();
		traverseEstree(file.ast, (node) => {
			if (node.type !== "CallExpression") return;
			const specifier = literalBuiltinModuleCall(node);
			if (specifier !== undefined) found.set(node.callee, specifier);
		});
		literalCallees.set(file, (calls = found));
	}
	return calls.get(callee);
}
