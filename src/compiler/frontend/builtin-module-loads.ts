import type { ESTree } from "meriyah";
import { traverseEstree } from "./estree-traversal.ts";
import type { SemanticFile } from "./semantic-analysis.ts";

/**
 * How a file's code can reach `process.getBuiltinModule`. Its installers link only
 * for module names the compiler can see, so lowering retains the literal name of
 * each call and every installer for any other use.
 */
export interface BuiltinModuleLoads {
	/** Callees of `getBuiltinModule("…")` calls, with the literal module name. */
	readonly literalCallees: ReadonlyMap<ESTree.Node, string>;
	/** Expressions only `typeof` or a truth test observes, such as feature detection. */
	readonly tested: ReadonlySet<ESTree.Node>;
	/**
	 * Expressions whose object only a static member access, a destructuring of static
	 * names or a test observes. Any other use can reflect on it.
	 */
	readonly followed: ReadonlySet<ESTree.Node>;
}

const loads = new WeakMap<SemanticFile, BuiltinModuleLoads>();

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

function staticPattern(pattern: ESTree.Node): boolean {
	return (
		pattern.type === "ObjectPattern" &&
		pattern.properties.every(
			(property) =>
				property.type === "Property" &&
				!property.computed &&
				(property.key.type === "Identifier"
					? property.key.name !== GET_BUILTIN_MODULE
					: literalString(property.key) !== undefined &&
						literalString(property.key) !== GET_BUILTIN_MODULE),
		)
	);
}

export function builtinModuleLoads(file: SemanticFile): BuiltinModuleLoads {
	let found = loads.get(file);
	if (found !== undefined) return found;
	const literalCallees = new Map<ESTree.Node, string>();
	const tested = new Set<ESTree.Node>();
	const followed = new Set<ESTree.Node>();
	traverseEstree(file.ast, (node, { parent, key }) => {
		if (node.type === "CallExpression") {
			const callee = node.callee as ESTree.Node;
			const named =
				callee.type === "Identifier" ||
				(callee.type === "MemberExpression" &&
					staticMemberKey(callee) === GET_BUILTIN_MODULE);
			const specifier = literalString(node.arguments[0]);
			if (named && specifier !== undefined) literalCallees.set(callee, specifier);
		}
		if (parent === null) return;
		if (
			(parent.type === "UnaryExpression" &&
				key === "argument" &&
				(parent.operator === "typeof" || parent.operator === "!")) ||
			(parent.type === "LogicalExpression" &&
				key === "left" &&
				parent.operator === "&&") ||
			((parent.type === "IfStatement" || parent.type === "ConditionalExpression") &&
				key === "test")
		) {
			tested.add(node);
			followed.add(node);
		} else if (
			(parent.type === "BinaryExpression" &&
				(parent.operator === "===" ||
					parent.operator === "!==" ||
					(parent.operator === "in" &&
						key === "right" &&
						parent.left.type === "Literal" &&
						typeof parent.left.value === "string"))) ||
			(parent.type === "MemberExpression" &&
				key === "object" &&
				staticMemberKey(parent) !== undefined) ||
			(parent.type === "VariableDeclarator" && key === "init" && staticPattern(parent.id))
		)
			followed.add(node);
	});
	found = { literalCallees, tested, followed };
	loads.set(file, found);
	return found;
}
