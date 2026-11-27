import type { AnyNode, AstNode, Rule } from "./types.ts";

type ObjectExpression = AstNode<"ObjectExpression">;
type MemberExpression = AstNode<"MemberExpression">;
type TypeNode = AstNode<"TSTypeAnnotation">["typeAnnotation"];

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/u;
const LOGICAL_ASSIGNMENT = new Set(["&&=", "||=", "??="]);
const STATEMENT_LISTS = new Set([
	"Program",
	"BlockStatement",
	"StaticBlock",
	"SwitchCase",
]);
const FUNCTION_BOUNDARIES = new Set([
	"ArrowFunctionExpression",
	"FunctionDeclaration",
	"FunctionExpression",
	"PropertyDefinition",
	"StaticBlock",
]);

function literalKey(node: AnyNode): string | undefined {
	if (
		node.type === "Literal" &&
		(typeof node.value === "string" || typeof node.value === "number")
	)
		return String(node.value);
	if (node.type === "TemplateLiteral" && node.expressions.length === 0)
		return node.quasis[0]?.value.cooked ?? undefined;
	return undefined;
}

/** The keys a literal defines, or undefined when a spread or computed key hides them. */
function definedKeys(literal: ObjectExpression): Set<string> | undefined {
	const keys = new Set<string>();
	for (const property of literal.properties) {
		if (property.type === "SpreadElement") return undefined;
		const key =
			!property.computed && property.key.type === "Identifier"
				? property.key.name
				: literalKey(property.key);
		if (key === undefined) return undefined;
		keys.add(key);
	}
	return keys;
}

function accessedKey(member: MemberExpression): string | undefined {
	if (member.property.type === "PrivateIdentifier") return undefined;
	return !member.computed && member.property.type === "Identifier"
		? member.property.name
		: literalKey(member.property);
}

const MODIFIER_TYPES = new Set(["Partial", "Readonly", "Required"]);

/** Record and index-signature types announce a dictionary, whose keys vary by design. */
function isDictionaryType(type: TypeNode): boolean {
	switch (type.type) {
		case "TSTypeReference": {
			if (type.typeName.type !== "Identifier") return false;
			if (type.typeName.name === "Record") return true;
			const inner = type.typeArguments?.params[0];
			return (
				MODIFIER_TYPES.has(type.typeName.name) &&
				inner !== undefined &&
				isDictionaryType(inner)
			);
		}
		case "TSTypeLiteral":
			return type.members.some((member) => member.type === "TSIndexSignature");
		case "TSMappedType":
			return true;
		case "TSUnionType":
		case "TSIntersectionType":
			return type.types.some(isDictionaryType);
		default:
			return false;
	}
}

/** The object literal a declarator starts from, unless its type marks it a dictionary. */
function recordLiteral(
	declarator: AstNode<"VariableDeclarator">,
): ObjectExpression | undefined {
	if (declarator.id.type !== "Identifier") return undefined;
	const annotation = declarator.id.typeAnnotation?.typeAnnotation;
	if (annotation !== undefined && isDictionaryType(annotation)) return undefined;
	let expression = declarator.init;
	while (expression !== null) {
		switch (expression.type) {
			case "ObjectExpression":
				return expression;
			case "TSAsExpression":
			case "TSSatisfiesExpression":
				if (isDictionaryType(expression.typeAnnotation)) return undefined;
				expression = expression.expression;
				break;
			case "TSNonNullExpression":
			case "ParenthesizedExpression":
				expression = expression.expression;
				break;
			default:
				return undefined;
		}
	}
	return undefined;
}

function isAddition(member: MemberExpression): boolean {
	const parent = member.parent;
	return (
		(parent.type === "AssignmentExpression" && parent.left === member) ||
		(parent.type === "UpdateExpression" && parent.argument === member)
	);
}

/**
 * Whether `node` runs on some paths only after its object's declaration in the
 * statement list `home`. A key added in straight-line code gives every object
 * from the literal the same shape, so only branches, loops, `try` and callbacks
 * count.
 */
function runsConditionally(node: AnyNode, home: AnyNode): boolean {
	let child = node;
	for (
		let parent = node.parent;
		parent !== home;
		child = parent, parent = parent.parent
	) {
		if (parent === null || FUNCTION_BOUNDARIES.has(parent.type)) return true;
		switch (parent.type) {
			case "IfStatement":
			case "ConditionalExpression":
			case "SwitchCase":
				if (child !== parent.test) return true;
				break;
			case "LogicalExpression":
				if (child === parent.right) return true;
				break;
			case "AssignmentExpression":
				if (child === parent.right && LOGICAL_ASSIGNMENT.has(parent.operator))
					return true;
				break;
			case "ForStatement":
				if (child === parent.body || child === parent.update) return true;
				break;
			case "ForInStatement":
			case "ForOfStatement":
			case "WhileStatement":
				if (child === parent.body) return true;
				break;
			case "TryStatement":
				if (child !== parent.finalizer) return true;
				break;
		}
	}
	return false;
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
	create(context) {
		return {
			VariableDeclarator(declarator) {
				const literal = recordLiteral(declarator);
				const home = declarator.parent.parent;
				if (literal === undefined || home === null || !STATEMENT_LISTS.has(home.type))
					return;
				const keys = definedKeys(literal);
				const [variable] = context.sourceCode.getDeclaredVariables(declarator);
				if (
					keys === undefined ||
					variable === undefined ||
					variable.references.some((reference) => reference.isWrite() && !reference.init)
				)
					return;
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
					if (runsConditionally(member, home)) {
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
