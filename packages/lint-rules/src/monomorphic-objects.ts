import { accessedKey, recordBinding } from "./records.ts";
import { conditionalBranch } from "./syntax.ts";
import type { AstNode, Rule } from "./types.ts";

type MemberExpression = AstNode<"MemberExpression">;

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/u;
const STATEMENT_LISTS = new Set([
	"Program",
	"BlockStatement",
	"StaticBlock",
	"SwitchCase",
]);

function isAddition(member: MemberExpression): boolean {
	const parent = member.parent;
	return (
		(parent.type === "AssignmentExpression" && parent.left === member) ||
		(parent.type === "UpdateExpression" && parent.argument === member)
	);
}

function propertyText(key: string): string {
	return `${IDENTIFIER_NAME.test(key) ? key : JSON.stringify(key)}: undefined`;
}

/**
 * Objects from one literal share a shape only while they gain the same keys in
 * the same order. Presence and order are observable through `in`,
 * `Object.keys` and spread, so the compiler cannot add a missing key itself;
 * a key added on some paths only splits those objects across shapes, and every
 * property site that reads them sees each shape.
 */
export const monomorphicObjects: Rule = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Require keys that are added on some paths only to be initialized in the object literal",
		},
		hasSuggestions: true,
		messages: {
			addedConditionally:
				"`{{object}}.{{key}}` is added on some paths only, so objects from this literal get different shapes. Initialize `{{key}}` in the literal.",
			initializeKey: "Initialize `{{key}}: undefined` in the object literal.",
		},
	},
	createOnce(context) {
		return {
			VariableDeclarator(declarator) {
				const home = declarator.parent.parent;
				const [declared] = context.sourceCode.getDeclaredVariables(declarator);
				const record =
					declared === undefined ? undefined : recordBinding(declarator, declared);
				if (record === undefined || home === null || !STATEMENT_LISTS.has(home.type))
					return;
				const { variable, literal, keys } = record;
				// A write after the key's first unconditional addition updates the key instead.
				const unconditional = new Map<string, number>();
				const conditional = new Map<string, MemberExpression>();
				for (const { identifier } of variable.references) {
					const member = identifier.parent;
					if (
						member.type !== "MemberExpression" ||
						member.object !== identifier ||
						member.start < declarator.end ||
						!isAddition(member)
					)
						continue;
					const key = accessedKey(member);
					if (key === undefined || keys.has(key)) continue;
					if (conditionalBranch(member, home) !== undefined) {
						const first = conditional.get(key);
						if (first === undefined || member.start < first.start)
							conditional.set(key, member);
					} else {
						unconditional.set(
							key,
							Math.min(unconditional.get(key) ?? Infinity, member.start),
						);
					}
				}
				for (const [key, member] of conditional) {
					if (member.start > (unconditional.get(key) ?? Infinity)) continue;
					context.report({
						node: member,
						messageId: "addedConditionally",
						data: { object: variable.name, key },
						suggest: [
							{
								messageId: "initializeKey",
								data: { key },
								fix(fixer) {
									const last = literal.properties.at(-1);
									return last === undefined
										? fixer.replaceText(literal, `{ ${propertyText(key)} }`)
										: fixer.insertTextAfter(last, `, ${propertyText(key)}`);
								},
							},
						],
					});
				}
			},
		};
	},
};
