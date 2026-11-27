import type { AnyNode, AstNode, Context } from "./types.ts";

type ObjectExpression = AstNode<"ObjectExpression">;
type MemberExpression = AstNode<"MemberExpression">;
type TypeNode = AstNode<"TSTypeAnnotation">["typeAnnotation"];
type Variable = ReturnType<Context["sourceCode"]["getDeclaredVariables"]>[number];

/**
 * A binding that only ever holds one object, created by a literal whose keys are
 * all known. Rules reason about the shape of such records; any other object may
 * be a dictionary or come from code the rule cannot see.
 */
export interface RecordBinding {
	readonly variable: Variable;
	readonly literal: ObjectExpression;
	readonly keys: ReadonlySet<string>;
}

const MODIFIER_TYPES = new Set(["Partial", "Readonly", "Required"]);

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

/** The fixed key a member expression names, or undefined for dynamic and private keys. */
export function accessedKey(member: MemberExpression): string | undefined {
	if (member.property.type === "PrivateIdentifier") return undefined;
	return !member.computed && member.property.type === "Identifier"
		? member.property.name
		: literalKey(member.property);
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
function objectLiteral(
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

/** The record `variable` holds, when `declarator` declares it. */
export function recordBinding(
	declarator: AstNode<"VariableDeclarator">,
	variable: Variable,
): RecordBinding | undefined {
	const literal = objectLiteral(declarator);
	const keys = literal === undefined ? undefined : definedKeys(literal);
	if (
		literal === undefined ||
		keys === undefined ||
		variable.references.some((reference) => reference.isWrite() && !reference.init)
	)
		return undefined;
	return { variable, literal, keys };
}

/** The record an identifier reads, resolved through the scope it appears in. */
export function referencedRecord(
	context: Context,
	identifier: AstNode<"Identifier">,
): RecordBinding | undefined {
	const variable =
		context.sourceCode
			.getScope(identifier)
			.references.find((reference) => reference.identifier === identifier)?.resolved ??
		undefined;
	const definition = variable?.defs[0];
	if (
		variable === undefined ||
		definition?.type !== "Variable" ||
		definition.node.type !== "VariableDeclarator"
	)
		return undefined;
	return recordBinding(definition.node, variable);
}
