import { stripTypeSyntax } from "./syntax.ts";
import type { AstNode, Rule } from "./types.ts";

type Expression = NonNullable<AstNode<"VariableDeclarator">["init"]>;

/** Whether `init` creates an empty object: `{}` or `Object.create(null)`. */
function createsEmptyObject(init: Expression): boolean {
	const expression = stripTypeSyntax(init);
	if (expression.type === "ObjectExpression") return expression.properties.length === 0;
	if (expression.type !== "CallExpression" || expression.arguments.length !== 1)
		return false;
	const [argument] = expression.arguments;
	const callee = expression.callee;
	return (
		argument?.type === "Literal" &&
		argument.value === null &&
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier" &&
		callee.object.name === "Object" &&
		callee.property.type === "Identifier" &&
		callee.property.name === "create"
	);
}

/** Whether a member expression's key comes from a value rather than the source text. */
function hasDataKey(member: AstNode<"MemberExpression">): boolean {
	if (!member.computed) return false;
	const key = member.property;
	return !(
		key.type === "Literal" ||
		(key.type === "TemplateLiteral" && key.expressions.length === 0)
	);
}

/**
 * Each new key gives an object a new shape, and the heap keeps every shape it has
 * created, with its key, until the program exits. An object whose keys come from
 * data therefore grows the heap with the data, and past 64 keys it falls back to a
 * dictionary anyway. A `Map` or `Set` hashes its keys without creating shapes.
 */
export const preferMap: Rule = {
	meta: {
		type: "suggestion",
		docs: {
			description: "Prefer a Map or Set over an object whose keys come from data",
		},
		messages: {
			dataKeys:
				"`{{name}}` is used as a map: each new key from data gives it a new shape, and the heap keeps those shapes. Use a `Map` or `Set`.",
		},
	},
	createOnce(context) {
		return {
			VariableDeclarator(declarator) {
				if (
					declarator.id.type !== "Identifier" ||
					declarator.init === null ||
					!createsEmptyObject(declarator.init)
				)
					return;
				const [variable] = context.sourceCode.getDeclaredVariables(declarator);
				if (
					variable === undefined ||
					variable.references.some((reference) => reference.isWrite() && !reference.init)
				)
					return;
				let writes = false;
				let reads = false;
				for (const { identifier } of variable.references) {
					const parent = identifier.parent;
					if (parent.type === "BinaryExpression") {
						if (parent.operator === "in" && parent.right === identifier) reads = true;
						continue;
					}
					if (
						parent.type !== "MemberExpression" ||
						parent.object !== identifier ||
						!hasDataKey(parent)
					)
						continue;
					const use = parent.parent;
					if (use.type === "AssignmentExpression" && use.left === parent) {
						writes = true;
						if (use.operator !== "=") reads = true;
					} else if (
						use.type === "UpdateExpression" ||
						(use.type === "UnaryExpression" && use.operator === "delete")
					) {
						writes = true;
						reads ||= use.type === "UpdateExpression";
					} else {
						reads = true;
					}
				}
				if (writes && reads)
					context.report({
						node: declarator.id,
						messageId: "dataKeys",
						data: { name: variable.name },
					});
			},
		};
	},
};
