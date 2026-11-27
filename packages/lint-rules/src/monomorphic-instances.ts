import { accessedKey, literalKey } from "./records.ts";
import { conditionalBranch, stripTypeSyntax } from "./syntax.ts";
import type { AnyNode, AstNode, Context, Rule } from "./types.ts";

type Class = AstNode<"ClassDeclaration" | "ClassExpression">;
type ClassBody = AstNode<"ClassBody">;
type Member = AstNode<"MemberExpression">;
type InstanceElement = AstNode<
	"MethodDefinition" | "PropertyDefinition" | "AccessorProperty"
>;

interface InstanceShape {
	fixed: Set<string>;
	constructorKeys: Set<string>;
	candidates: Map<string, Member>;
	unknownFields: boolean;
	unknownConstructorKeys: boolean;
}

function instanceElement(node: AnyNode): InstanceElement | undefined {
	let child = node;
	for (
		let parent = node.parent;
		parent !== null;
		child = parent, parent = parent.parent
	) {
		switch (parent.type) {
			case "FunctionExpression": {
				const method = parent.parent;
				return method.type === "MethodDefinition" &&
					method.value === parent &&
					!method.static
					? method
					: undefined;
			}
			case "FunctionDeclaration":
			case "StaticBlock":
				return undefined;
			case "PropertyDefinition":
			case "AccessorProperty":
				if (child === parent.value) return parent.static ? undefined : parent;
				break;
		}
	}
	return undefined;
}

function classShape(body: ClassBody): InstanceShape {
	const fixed = new Set<string>();
	let unknownFields = false;
	for (const element of body.body) {
		if (
			element.type === "StaticBlock" ||
			element.type === "TSIndexSignature" ||
			element.static
		)
			continue;
		if (
			(element.type === "MethodDefinition" ||
				element.type === "TSAbstractMethodDefinition") &&
			element.kind === "constructor"
		) {
			for (const param of element.value.params) {
				if (param.type !== "TSParameterProperty") continue;
				const binding = param.parameter;
				const name = binding.type === "AssignmentPattern" ? binding.left : binding;
				if (name.type === "Identifier") fixed.add(name.name);
			}
			continue;
		}
		// Writing an accessor calls the setter instead of adding an own key.
		if (
			(element.type === "MethodDefinition" ||
				element.type === "TSAbstractMethodDefinition") &&
			element.kind === "method"
		)
			continue;
		const { key, computed } = element;
		if (key.type === "PrivateIdentifier") continue;
		const name = !computed && key.type === "Identifier" ? key.name : literalKey(key);
		if (name === undefined) unknownFields = true;
		else fixed.add(name);
	}
	return {
		fixed,
		constructorKeys: new Set(),
		candidates: new Map(),
		unknownFields,
		unknownConstructorKeys: false,
	};
}

function localBase(context: Context, superClass: AnyNode): Class | undefined {
	const expression = stripTypeSyntax(superClass);
	if (expression.type === "ClassExpression") return expression;
	if (expression.type !== "Identifier") return undefined;
	const scope = context.sourceCode.getScope(expression);
	const readsBase = (candidate: (typeof scope.references)[number]) =>
		candidate.identifier === expression;
	const reference = scope.references.find(readsBase) ?? scope.through.find(readsBase);
	const binding = reference?.resolved;
	if (binding === null || binding === undefined || binding.defs.length !== 1)
		return undefined;
	if (binding.references.some((use) => use.isWrite() && !use.init)) return undefined;
	const definition = binding.defs[0];
	if (definition?.type === "ClassName" && definition.node.type === "ClassDeclaration")
		return definition.node.declare ? undefined : definition.node;
	if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator")
		return undefined;
	const { id, init } = definition.node;
	if (id !== definition.name || init === null) return undefined;
	const initializer = stripTypeSyntax(init);
	return initializer.type === "ClassExpression" ? initializer : undefined;
}

function inheritedKeys(
	context: Context,
	derived: ClassBody,
	shapes: ReadonlyMap<ClassBody, InstanceShape>,
): Set<string> | undefined {
	const keys = new Set<string>();
	const seen = new Set([derived]);
	let current = derived.parent;
	while (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
		if (current.superClass === null) return keys;
		const base = localBase(context, current.superClass);
		if (base === undefined || base.decorators.length > 0 || seen.has(base.body))
			return undefined;
		const shape = shapes.get(base.body);
		if (shape === undefined || shape.unknownFields || shape.unknownConstructorKeys)
			return undefined;
		for (const key of shape.fixed) keys.add(key);
		for (const key of shape.constructorKeys) keys.add(key);
		seen.add(base.body);
		current = base;
	}
	return undefined;
}

function initializedOnAllBranches(
	node: AnyNode,
	home: AnyNode,
	key: string,
	writesByBranch: Map<AnyNode, Set<string>>,
): boolean {
	let branch = conditionalBranch(node, home);
	while (branch !== undefined) {
		const parent = branch.parent;
		let other: AnyNode | null;
		switch (parent?.type) {
			case "IfStatement":
			case "ConditionalExpression":
				other = branch === parent.consequent ? parent.alternate : parent.consequent;
				break;
			case "TryStatement":
				// An exception that leaves the constructor produces no instance.
				if (parent.handler === null) {
					branch = conditionalBranch(parent, home);
					continue;
				}
				other = branch === parent.block ? parent.handler : parent.block;
				break;
			default:
				return false;
		}
		if (other === null) return false;
		let writes = writesByBranch.get(branch);
		if (writes === undefined) {
			writes = new Set();
			writesByBranch.set(branch, writes);
		}
		writes.add(key);
		if (!writesByBranch.get(other)?.has(key)) return false;
		branch = conditionalBranch(parent, home);
	}
	return true;
}

function fieldText(context: Context, body: ClassBody, key: string): string {
	const first = body.body[0];
	const { text } = context.sourceCode;
	const lineBreak = /^[ \t]*(\r\n|\n)/u.exec(
		text.slice(body.start + 1, first?.start),
	)?.[1];
	if (lineBreak === undefined || first === undefined) return ` ${key};`;
	const lineStart = text.lastIndexOf("\n", first.start - 1) + 1;
	const indent = /^[ \t]*/u.exec(text.slice(lineStart, first.start))?.[0] ?? "";
	return `${lineBreak}${indent}${key};`;
}

/** Keep keys present on every instance so property readers see a single shape. */
export const monomorphicInstances: Rule = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Require instance keys added on some paths only to be declared as fields",
		},
		hasSuggestions: true,
		messages: {
			addedConditionally:
				"`this.{{key}}` can be added on some paths only, so instances of this class get different shapes. Declare `{{key}}` as a field.",
			declareField: "Declare `{{key}}` as a class field.",
		},
	},
	createOnce(context) {
		const shapes = new Map<ClassBody, InstanceShape>();
		const writesByBranch = new Map<AnyNode, Set<string>>();
		return {
			before() {
				shapes.clear();
				writesByBranch.clear();
			},
			ClassBody(body) {
				shapes.set(body, classShape(body));
			},
			MemberExpression(member) {
				const assignment = member.parent;
				if (
					assignment.type !== "AssignmentExpression" ||
					assignment.left !== member ||
					assignment.operator !== "=" ||
					stripTypeSyntax(member.object).type !== "ThisExpression"
				)
					return;
				const element = instanceElement(member);
				const body = element?.parent;
				if (element === undefined || body?.type !== "ClassBody") return;
				const shape = shapes.get(body);
				if (shape === undefined) return;
				const constructor =
					element.type === "MethodDefinition" && element.kind === "constructor";
				const initializer = element.type !== "MethodDefinition";
				const key = accessedKey(member);
				if (key === undefined) {
					if ((constructor || initializer) && member.computed)
						shape.unknownConstructorKeys = true;
					return;
				}
				if (key === "constructor" || key === "__proto__") return;
				if (constructor || initializer) {
					shape.constructorKeys.add(key);
					if (
						element.value !== null &&
						element.value.type !== "ArrowFunctionExpression" &&
						initializedOnAllBranches(member, element.value, key, writesByBranch)
					) {
						shape.fixed.add(key);
						return;
					}
				}
				if (!member.computed && !shape.candidates.has(key))
					shape.candidates.set(key, member);
			},
			"Program:exit"() {
				for (const [body, shape] of shapes) {
					if (shape.candidates.size === 0 || shape.unknownFields) continue;
					const inherited = inheritedKeys(context, body, shapes);
					if (inherited === undefined) continue;
					for (const [key, member] of shape.candidates) {
						if (shape.fixed.has(key) || inherited.has(key)) continue;
						context.report({
							node: member,
							messageId: "addedConditionally",
							data: { key },
							suggest: [
								{
									messageId: "declareField",
									data: { key },
									fix(fixer) {
										return fixer.insertTextAfterRange(
											[body.start, body.start + 1],
											fieldText(context, body, key),
										);
									},
								},
							],
						});
					}
				}
			},
		};
	},
};
