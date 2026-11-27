import type { AnyNode, AstNode, Context } from "./types.ts";

type TypeSyntax =
	| AstNode<"ParenthesizedExpression">
	| AstNode<"TSAsExpression">
	| AstNode<"TSNonNullExpression">
	| AstNode<"TSSatisfiesExpression">
	| AstNode<"TSTypeAssertion">;

const TYPE_SYNTAX = new Set([
	"ParenthesizedExpression",
	"TSAsExpression",
	"TSNonNullExpression",
	"TSSatisfiesExpression",
	"TSTypeAssertion",
]);

/** Parentheses and type assertions, which type stripping removes before the compiler runs. */
export function isTypeSyntax(node: AnyNode): node is TypeSyntax {
	return TYPE_SYNTAX.has(node.type);
}

/** `node` as the compiler sees it, without parentheses and type assertions. */
export function stripTypeSyntax(node: AnyNode): AnyNode {
	let current = node;
	while (isTypeSyntax(current)) current = current.expression;
	return current;
}

/**
 * Whether an identifier reads a global: undeclared, or declared by
 * a configured environment without a definition in the program.
 */
export function readsGlobal(context: Context, node: AstNode<"Identifier">): boolean {
	const reference = context.sourceCode
		.getScope(node)
		.references.find((candidate) => candidate.identifier === node);
	if (reference === undefined) return false;
	const variable = reference.resolved;
	return (
		variable === null || (variable.scope.type === "global" && variable.defs.length === 0)
	);
}

/** The key a member access names in its source: `a.key` or `a["key"]`. */
export function staticPropertyName(
	member: AstNode<"MemberExpression">,
): string | undefined {
	const property = stripTypeSyntax(member.property);
	if (!member.computed && property.type === "Identifier") return property.name;
	if (
		member.computed &&
		property.type === "Literal" &&
		typeof property.value === "string"
	)
		return property.value;
	return undefined;
}
