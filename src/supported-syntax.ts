import type { ESTree } from "meriyah";

/**
 * Node types the compiler has no lowering for at all.
 */
const unsupportedNodeTypes = new Map<string, string>([
	["WithStatement", "with"],
	["TaggedTemplateExpression", "tagged template"],
	// Static import/export are lowered (ES modules). Dynamic import() is not yet:
	// it needs the static-string resolution + promise plumbing of a later step.
	["ImportExpression", "dynamic import"],
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
export function collectUnsupportedSyntax(
	node: ESTree.Node,
	{ isModule = false }: { isModule?: boolean } = {},
): Set<string> {
	const unsupported = new Set<string>();
	walk(node, unsupported, { inArrowFunction: false, inAsyncFunction: false, isModule });
	return unsupported;
}

interface WalkContext {
	inArrowFunction: boolean;
	inAsyncFunction: boolean;
	/** Module goal: top-level await is allowed. */
	isModule: boolean;
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

	// `await` outside an async function is top-level await — supported only in a
	// module (the init becomes async). In a script it never parses, so this only
	// guards the (impossible) script case defensively.
	if (node.type === "AwaitExpression" && !context.inAsyncFunction && !context.isModule) {
		unsupported.add("top-level await");
	}

	switch (node.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression": {
			const innerContext: WalkContext = {
				inArrowFunction: node.type === "ArrowFunctionExpression",
				inAsyncFunction: node.async === true,
				isModule: context.isModule,
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
		case "MetaProperty": {
			// new.target reads the active frame's new.target. import.meta is
			// module-only and unsupported; new.target in an arrow is lexical
			// (the enclosing function's), which is not captured yet.
			if (node.meta.name === "import") {
				unsupported.add("import.meta");
			} else if (context.inArrowFunction) {
				unsupported.add("new.target in arrow function");
			}
			break;
		}
		case "ExportAllDeclaration": {
			// `export * from "m"` is supported; `export * as ns from "m"` (the
			// namespace re-export form) is deferred.
			if (node.exported) {
				unsupported.add("namespace re-export");
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
