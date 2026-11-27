import {
	isTypeSyntax,
	readsGlobal,
	staticPropertyName,
	stripTypeSyntax,
} from "./syntax.ts";
import type { AnyNode, AstNode, Context, Rule } from "./types.ts";

const FUNCTION_EXPRESSIONS = new Set([
	"ArrowFunctionExpression",
	"ClassExpression",
	"FunctionExpression",
]);

function isGlobalNamed(context: Context, node: AnyNode, name: string): boolean {
	return node.type === "Identifier" && node.name === name && readsGlobal(context, node);
}

/** Whether `node` is `Function.prototype.toString`, on the global `Function`. */
function isFunctionToString(
	context: Context,
	node: AstNode<"MemberExpression">,
): boolean {
	if (staticPropertyName(node) !== "toString") return false;
	const prototype = stripTypeSyntax(node.object);
	return (
		prototype.type === "MemberExpression" &&
		staticPropertyName(prototype) === "prototype" &&
		isGlobalNamed(context, stripTypeSyntax(prototype.object), "Function")
	);
}

/**
 * Whether `node` evaluates to a function or class defined in this file: an
 * inline expression, or a binding that is never reassigned after its definition.
 */
function isFunctionValue(context: Context, node: AnyNode): boolean {
	const expression = stripTypeSyntax(node);
	if (FUNCTION_EXPRESSIONS.has(expression.type)) return true;
	if (expression.type !== "Identifier") return false;
	const variable = context.sourceCode
		.getScope(expression)
		.references.find((candidate) => candidate.identifier === expression)?.resolved;
	const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
	if (
		variable === null ||
		variable === undefined ||
		definition === undefined ||
		variable.references.some((reference) => reference.isWrite() && !reference.init)
	)
		return false;
	switch (definition.type) {
		case "FunctionName":
		case "ClassName":
			return true;
		case "Variable":
			return (
				definition.node.type === "VariableDeclarator" &&
				definition.node.id === definition.name &&
				definition.node.init !== null &&
				FUNCTION_EXPRESSIONS.has(stripTypeSyntax(definition.node.init).type)
			);
		default:
			return false;
	}
}

/** Whether `node` is a string by its syntax: a string literal, a template, or a `+` with one. */
function isString(node: AnyNode): boolean {
	const expression = stripTypeSyntax(node);
	switch (expression.type) {
		case "Literal":
			return typeof expression.value === "string";
		case "TemplateLiteral":
			return true;
		case "BinaryExpression":
			return (
				expression.operator === "+" &&
				(isString(expression.left) || isString(expression.right))
			);
		default:
			return false;
	}
}

/** Whether `node` is a template literal that builds a string, rather than one passed to a tag. */
function isUntaggedTemplate(node: AnyNode): boolean {
	return (
		node.type === "TemplateLiteral" && node.parent.type !== "TaggedTemplateExpression"
	);
}

/**
 * Whether the string `read` produces only reaches a `console` call, through
 * concatenation and templates. Logged text that differs from Node's output
 * changes nothing the program computes.
 */
function isLogged(context: Context, read: AnyNode): boolean {
	let current = read;
	let parent = read.parent;
	while (
		parent !== null &&
		(isTypeSyntax(parent) ||
			(parent.type === "BinaryExpression" && parent.operator === "+") ||
			isUntaggedTemplate(parent))
	) {
		current = parent;
		parent = parent.parent;
	}
	if (parent?.type !== "CallExpression" || parent.callee === current) return false;
	const callee = stripTypeSyntax(parent.callee);
	return (
		callee.type === "MemberExpression" &&
		isGlobalNamed(context, stripTypeSyntax(callee.object), "console")
	);
}

/** The expression that turns `member` into source text, past `.call` and `.apply`. */
function sourceRead(member: AstNode<"MemberExpression">): AnyNode {
	let current: AnyNode = member;
	while (current.parent !== null && isTypeSyntax(current.parent))
		current = current.parent;
	const invoker = current.parent;
	if (
		invoker?.type === "MemberExpression" &&
		invoker.object === current &&
		(staticPropertyName(invoker) === "call" || staticPropertyName(invoker) === "apply") &&
		invoker.parent.type === "CallExpression" &&
		invoker.parent.callee === invoker
	)
		return invoker.parent;
	return member;
}

function subject(node: AnyNode): string {
	const expression = stripTypeSyntax(node);
	if (expression.type === "Identifier") return `\`${expression.name}\``;
	return expression.type === "ClassExpression" ? "this class" : "this function";
}

/**
 * Maligator keeps no source text: `Function.prototype.toString` returns
 * `function name() { [native code] }` for every function, user code included.
 * Code that reads parameter names or tells classes from functions by their
 * source gets that text instead and silently takes another path. Without type
 * information the rule sees only functions and classes this file defines.
 */
export const noFunctionSource: Rule = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow reading a function's source text, which Maligator does not keep",
		},
		messages: {
			functionToString:
				"Maligator keeps no source text, so `Function.prototype.toString` returns `function name() { [native code] }` for every function. Pass what this code reads from the source explicitly.",
			stringified:
				"Maligator keeps no source text, so converting {{subject}} to a string gives `function name() { [native code] }`. Pass what this code reads from the source explicitly.",
		},
	},
	createOnce(context) {
		function check(operand: AnyNode, read: AnyNode): void {
			if (!isFunctionValue(context, operand) || isLogged(context, read)) return;
			context.report({
				node: operand,
				messageId: "stringified",
				data: { subject: subject(operand) },
			});
		}
		return {
			MemberExpression(member) {
				if (isFunctionToString(context, member) && !isLogged(context, sourceRead(member)))
					context.report({ node: member, messageId: "functionToString" });
			},
			CallExpression(call) {
				const callee = stripTypeSyntax(call.callee);
				if (
					callee.type === "MemberExpression" &&
					staticPropertyName(callee) === "toString"
				) {
					check(callee.object, call);
					return;
				}
				const [argument] = call.arguments;
				if (
					argument !== undefined &&
					argument.type !== "SpreadElement" &&
					isGlobalNamed(context, callee, "String")
				)
					check(argument, call);
			},
			TemplateLiteral(template) {
				if (!isUntaggedTemplate(template)) return;
				for (const expression of template.expressions) check(expression, template);
			},
			BinaryExpression(binary) {
				if (binary.operator !== "+") return;
				if (isString(binary.right)) check(binary.left, binary);
				if (isString(binary.left)) check(binary.right, binary);
			},
		};
	},
};
