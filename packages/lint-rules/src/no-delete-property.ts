import { accessedKey, referencedRecord } from "./records.ts";
import type { Rule } from "./types.ts";

// Integer keys live in an object's elements, not its shape.
const ARRAY_INDEX = /^\d+$/u;

/**
 * The runtime rebuilds an object's shape without a deleted key, moving every key
 * after it to a lower slot. Code that reads those later keys then meets the
 * object in two layouts and falls back to the property cache, while reads of
 * keys before it keep their slots. Whether a key exists is observable, so the
 * compiler cannot replace the delete itself. Only records are reported, whose
 * key order the literal fixes; other objects may be dictionaries, whose keys
 * vary by design.
 */
export const noDeleteProperty: Rule = {
	meta: {
		type: "suggestion",
		docs: {
			description: "Disallow deleting a key that other keys of a record follow",
		},
		hasSuggestions: true,
		messages: {
			deletedKey:
				"Deleting `{{key}}` moves the keys `{{object}}` defines after it, so code that reads them meets two layouts. Assign `undefined` instead.",
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
					member.optional ||
					member.object.type !== "Identifier"
				)
					return;
				const key = accessedKey(member);
				const keys = referencedRecord(context, member.object)?.keys;
				if (key === undefined || keys === undefined || ARRAY_INDEX.test(key)) return;
				const order = [...keys].filter((name) => !ARRAY_INDEX.test(name));
				const position = order.indexOf(key);
				if (position < 0 || position === order.length - 1) return;
				context.report({
					node,
					messageId: "deletedKey",
					data: { object: member.object.name, key },
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
