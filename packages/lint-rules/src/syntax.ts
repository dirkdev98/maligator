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
const LOGICAL_ASSIGNMENT = new Set(["&&=", "||=", "??="]);
const DEFERRED_EXECUTION = new Set([
	"ArrowFunctionExpression",
	"FunctionDeclaration",
	"FunctionExpression",
	"PropertyDefinition",
	"StaticBlock",
]);

function hasOptionalLink(node: AnyNode): boolean {
	let link = node;
	while (link.type === "CallExpression" || link.type === "MemberExpression") {
		if (link.optional) return true;
		link = link.type === "CallExpression" ? link.callee : link.object;
	}
	return false;
}

/** The nearest ancestor entered on only some paths from `home`, if any. */
export function conditionalBranch(node: AnyNode, home: AnyNode): AnyNode | undefined {
	let child = node;
	for (
		let parent = node.parent;
		parent !== home;
		child = parent, parent = parent.parent
	) {
		if (parent === null || DEFERRED_EXECUTION.has(parent.type)) return child;
		switch (parent.type) {
			case "IfStatement":
			case "ConditionalExpression":
			case "SwitchCase":
				if (child !== parent.test) return child;
				break;
			case "LogicalExpression":
			case "AssignmentPattern":
				if (child === parent.right) return child;
				break;
			case "AssignmentExpression":
				if (child === parent.right && LOGICAL_ASSIGNMENT.has(parent.operator))
					return child;
				break;
			case "CallExpression":
				if (
					child !== parent.callee &&
					(parent.optional || hasOptionalLink(parent.callee))
				)
					return child;
				break;
			case "MemberExpression":
				if (
					child === parent.property &&
					(parent.optional || hasOptionalLink(parent.object))
				)
					return child;
				break;
			case "ForStatement":
				if (child === parent.body || child === parent.update) return child;
				break;
			case "ForInStatement":
			case "ForOfStatement":
				if (child !== parent.right) return child;
				break;
			case "WhileStatement":
				if (child === parent.body) return child;
				break;
			case "TryStatement":
				if (child !== parent.finalizer) return child;
				break;
		}
	}
	return undefined;
}

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
