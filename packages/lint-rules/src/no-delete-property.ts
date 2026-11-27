import { accessedKey, referencedRecord } from "./records.ts";
import type { AnyNode, AstNode, Context, Rule } from "./types.ts";

const ARRAY_INDEX = /^\d+$/u;

/** Whether `this` at `node` is a class instance: in a method, constructor or field. */
function instanceThis(node: AnyNode): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		switch (parent.type) {
			case "FunctionExpression":
				return parent.parent.type === "MethodDefinition" && !parent.parent.static;
			case "PropertyDefinition":
				return !parent.static;
			case "FunctionDeclaration":
			case "StaticBlock":
				return false;
		}
	}
	return false;
}

/** How to name the object a delete targets, when it is a record or class instance. */
function shapedObjectName(
	context: Context,
	node: AnyNode,
	object: AstNode<"MemberExpression">["object"],
): string | undefined {
	if (object.type === "ThisExpression") return instanceThis(node) ? "this" : undefined;
	if (object.type === "Identifier" && referencedRecord(context, object) !== undefined)
		return object.name;
	return undefined;
}

/**
 * Deleting a key gives the object a new shape: the runtime rebuilds it from the
 * remaining keys, and once a heap has created enough such shapes, a delete turns
 * the object into a dictionary. Objects with and without the key then reach the
 * same readers in different shapes. Whether the key exists is observable, so the
 * compiler cannot replace the delete itself. Records and class instances are
 * reported; other objects may be dictionaries, whose keys vary by design.
 */
export const noDeleteProperty: Rule = {
	meta: {
		type: "suggestion",
		docs: {
			description: "Disallow deleting a fixed key from a record or class instance",
		},
		hasSuggestions: true,
		messages: {
			deletedKey:
				"Deleting `{{key}}` gives `{{object}}` a new shape, so code that reads these objects meets more than one shape. Assign `undefined` instead, or leave `{{key}}` out when the object is created.",
			assignUndefined: "Assign `undefined` to `{{key}}` instead.",
		},
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const member = node.argument;
				if (
					node.operator !== "delete" ||
					member.type !== "MemberExpression" ||
					member.optional
				)
					return;
				const key = accessedKey(member);
				if (key === undefined || ARRAY_INDEX.test(key)) return;
				const name = shapedObjectName(context, node, member.object);
				if (name === undefined) return;
				context.report({
					node,
					messageId: "deletedKey",
					data: { object: name, key },
					suggest:
						node.parent.type === "ExpressionStatement"
							? [
									{
										messageId: "assignUndefined",
										data: { key },
										fix: (fixer) =>
											fixer.replaceText(
												node,
												`${context.sourceCode.getText(member)} = undefined`,
											),
									},
								]
							: undefined,
				});
			},
		};
	},
};
