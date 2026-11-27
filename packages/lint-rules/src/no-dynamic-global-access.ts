import { isTypeSyntax, readsGlobal, staticPropertyName } from "./syntax.ts";
import type { AnyNode, Rule } from "./types.ts";

const GLOBAL_OBJECTS = new Set(["globalThis", "global"]);

/** Whether `node` sits in a type, which type stripping erases. */
function inType(node: AnyNode): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		if (parent.type.startsWith("TS") && !isTypeSyntax(parent)) return true;
	}
	return false;
}

/** The node a use of `node` belongs to, past type assertions and parentheses. */
function use(node: AnyNode): { node: AnyNode; parent: AnyNode | null } {
	let current = node;
	let parent = node.parent;
	while (parent !== null && isTypeSyntax(parent)) {
		current = parent;
		parent = parent.parent;
	}
	return { node: current, parent };
}

/**
 * Whether the compiler can name the global this use of the global object reads,
 * mirroring `collectGlobalAndStringMemberUses` in `src/compiler/frontend/linker.ts`:
 * `typeof`, an identity comparison, or a member access with a fixed key.
 */
function isNamedUse(node: AnyNode, parent: AnyNode | null): boolean {
	if (parent === null) return false;
	switch (parent.type) {
		case "UnaryExpression":
			return parent.operator === "typeof";
		case "BinaryExpression":
			return parent.operator === "===" || parent.operator === "!==";
		case "MemberExpression":
			return parent.object === node && staticPropertyName(parent) !== undefined;
		default:
			return false;
	}
}

/**
 * The compiler links a host installer, such as `process`, `Buffer` or the timers,
 * only for the globals a program reads by name. Once the global object is read
 * through a computed key, passed on or destructured, any global may be read, so
 * every installer stays in the image.
 */
export const noDynamicGlobalAccess: Rule = {
	meta: {
		type: "suggestion",
		docs: {
			description: "Require reading globals from the global object by name",
		},
		messages: {
			untraced:
				"This use of `{{name}}` hides which globals the program reads, so the build keeps every host installer. Read each global by name, like `{{name}}.fetch`.",
		},
	},
	createOnce(context) {
		return {
			Identifier(identifier) {
				if (
					!GLOBAL_OBJECTS.has(identifier.name) ||
					inType(identifier) ||
					!readsGlobal(context, identifier)
				)
					return;
				const { node, parent } = use(identifier);
				if (isNamedUse(node, parent)) return;
				context.report({
					node: identifier,
					messageId: "untraced",
					data: { name: identifier.name },
				});
			},
		};
	},
};
