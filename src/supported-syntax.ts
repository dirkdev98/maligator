import type { ESTree } from "meriyah";

/**
 * Node types the compiler has no lowering for at all.
 */
const unsupportedNodeTypes = new Map<string, string>([
	["PropertyDefinition", "class field"],
	["StaticBlock", "class static block"],
	["PrivateIdentifier", "private class member"],
	["MetaProperty", "new.target / import.meta"],
	["LabeledStatement", "labeled statement"],
	["WithStatement", "with"],
	["AwaitExpression", "async function"],
	["TaggedTemplateExpression", "tagged template"],
	["ImportDeclaration", "module syntax"],
	["ImportExpression", "module syntax"],
	["ExportNamedDeclaration", "module syntax"],
	["ExportDefaultDeclaration", "module syntax"],
	["ExportAllDeclaration", "module syntax"],
]);

const supportedBinaryOperators = new Set<string>([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
	"in",
	"instanceof",
]);

const supportedUnaryOperators = new Set<string>([
	"!",
	"-",
	"+",
	"~",
	"typeof",
	"void",
	"delete",
]);

const supportedAssignmentOperators = new Set<string>([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"&=",
	"|=",
	"^=",
	"<<=",
	">>=",
	">>>=",
	"||=",
	"&&=",
	"??=",
]);

/**
 * Collect the unsupported language constructs used in an AST.
 *
 * The tracing compiler silently skips most constructs it cannot lower, which
 * would otherwise turn into vacuously passing or crashing programs. Scanning
 * upfront turns those into an explicit UNSUPPORTED verdict and doubles as a
 * priority ranking for which features block the most tests.
 */
export function collectUnsupportedSyntax(node: ESTree.Node): Set<string> {
	const unsupported = new Set<string>();
	walk(node, unsupported, { inArrowFunction: false });
	return unsupported;
}

interface WalkContext {
	inArrowFunction: boolean;
}

function walk(value: unknown, unsupported: Set<string>, context: WalkContext) {
	if (Array.isArray(value)) {
		for (const entry of value) {
			walk(entry, unsupported, context);
		}
		return;
	}

	if (!value || typeof value !== "object" || !("type" in value)) {
		return;
	}

	const node = value as ESTree.Node;
	const mapped = unsupportedNodeTypes.get(node.type);
	if (mapped) {
		unsupported.add(mapped);
	}

	if (node.type === "ForOfStatement" && node.await) {
		unsupported.add("for-await-of");
	}

	switch (node.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression": {
			if (node.async) {
				unsupported.add("async function");
			}

			const innerContext: WalkContext = {
				inArrowFunction: node.type === "ArrowFunctionExpression",
			};
			for (const key of Object.keys(node)) {
				walk(
					(node as unknown as Record<string, unknown>)[key],
					unsupported,
					innerContext,
				);
			}
			return;
		}
		case "ThisExpression": {
			// Frames carry their own this value; the lexical this of arrow
			// functions is not captured yet.
			if (context.inArrowFunction) {
				unsupported.add("lexical this in arrow function");
			}
			break;
		}
		case "BinaryExpression": {
			if (!supportedBinaryOperators.has(node.operator)) {
				unsupported.add(`${node.operator} operator`);
			}
			break;
		}
		case "UnaryExpression": {
			if (!supportedUnaryOperators.has(node.operator)) {
				unsupported.add(`${node.operator} operator`);
			}
			break;
		}
		case "AssignmentExpression": {
			if (!supportedAssignmentOperators.has(node.operator)) {
				unsupported.add(`${node.operator} operator`);
			}
			break;
		}
		case "BreakStatement":
		case "ContinueStatement": {
			if (node.label) {
				unsupported.add("labeled break / continue");
			}
			break;
		}
		case "Literal": {
			if ("regex" in node && node.regex) {
				unsupported.add("regex literal");
			}
			break;
		}
		default:
			break;
	}

	for (const key of Object.keys(node)) {
		walk((node as unknown as Record<string, unknown>)[key], unsupported, context);
	}
}
