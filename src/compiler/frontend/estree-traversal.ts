import type { ESTree } from "meriyah";

export const ESTREE_CONTINUE = "continue";
export const ESTREE_SKIP = "skip";
export const ESTREE_STOP = "stop";

export type EstreeTraversalAction =
	| typeof ESTREE_CONTINUE
	| typeof ESTREE_SKIP
	| typeof ESTREE_STOP;

export interface EstreeTraversalContext<Context> {
	readonly parent: ESTree.Node | null;
	readonly key: string | number | null;
	readonly context: Context;
}

// ESTree child slots are structural, not data-dependent. Keeping the standard
// keys here avoids allocating and filtering Object.keys() arrays on every node
// during each semantic/IR pass. Unknown future parser nodes retain the generic
// fallback below, so adding syntax cannot silently prune its subtree.
const ESTREE_VISITOR_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
	ArrayExpression: ["elements"],
	ArrayPattern: ["elements"],
	ArrowFunctionExpression: ["params", "body"],
	AssignmentExpression: ["left", "right"],
	AssignmentPattern: ["left", "right"],
	AwaitExpression: ["argument"],
	BinaryExpression: ["left", "right"],
	BlockStatement: ["body"],
	BreakStatement: ["label"],
	CallExpression: ["callee", "arguments"],
	CatchClause: ["param", "body"],
	ChainExpression: ["expression"],
	ClassBody: ["body"],
	ClassDeclaration: ["id", "superClass", "body"],
	ClassExpression: ["id", "superClass", "body"],
	ConditionalExpression: ["test", "consequent", "alternate"],
	ContinueStatement: ["label"],
	DebuggerStatement: [],
	DoWhileStatement: ["body", "test"],
	EmptyStatement: [],
	ExperimentalRestProperty: ["argument"],
	ExperimentalSpreadProperty: ["argument"],
	ExportAllDeclaration: ["exported", "source"],
	ExportDefaultDeclaration: ["declaration"],
	ExportNamedDeclaration: ["declaration", "specifiers", "source"],
	ExportSpecifier: ["exported", "local"],
	ExpressionStatement: ["expression"],
	ForInStatement: ["left", "right", "body"],
	ForOfStatement: ["left", "right", "body"],
	ForStatement: ["init", "test", "update", "body"],
	FunctionDeclaration: ["id", "params", "body"],
	FunctionExpression: ["id", "params", "body"],
	Identifier: [],
	IfStatement: ["test", "consequent", "alternate"],
	ImportAttribute: ["key", "value"],
	ImportDeclaration: ["specifiers", "source", "attributes"],
	ImportDefaultSpecifier: ["local"],
	ImportExpression: ["source", "options"],
	ImportNamespaceSpecifier: ["local"],
	ImportSpecifier: ["imported", "local"],
	JSXAttribute: ["name", "value"],
	JSXClosingElement: ["name"],
	JSXClosingFragment: [],
	JSXElement: ["openingElement", "children", "closingElement"],
	JSXEmptyExpression: [],
	JSXExpressionContainer: ["expression"],
	JSXFragment: ["openingFragment", "children", "closingFragment"],
	JSXIdentifier: [],
	JSXMemberExpression: ["object", "property"],
	JSXNamespacedName: ["namespace", "name"],
	JSXOpeningElement: ["name", "attributes"],
	JSXOpeningFragment: [],
	JSXSpreadAttribute: ["argument"],
	JSXSpreadChild: ["expression"],
	JSXText: [],
	LabeledStatement: ["label", "body"],
	Literal: [],
	LogicalExpression: ["left", "right"],
	MemberExpression: ["object", "property"],
	MetaProperty: ["meta", "property"],
	MethodDefinition: ["key", "value"],
	NewExpression: ["callee", "arguments"],
	ObjectExpression: ["properties"],
	ObjectPattern: ["properties"],
	PrivateIdentifier: [],
	Program: ["body"],
	Property: ["key", "value"],
	PropertyDefinition: ["key", "value"],
	RestElement: ["argument"],
	ReturnStatement: ["argument"],
	SequenceExpression: ["expressions"],
	SpreadElement: ["argument"],
	StaticBlock: ["body"],
	Super: [],
	SwitchCase: ["test", "consequent"],
	SwitchStatement: ["discriminant", "cases"],
	TaggedTemplateExpression: ["tag", "quasi"],
	TemplateElement: [],
	TemplateLiteral: ["quasis", "expressions"],
	ThisExpression: [],
	ThrowStatement: ["argument"],
	TryStatement: ["block", "handler", "finalizer"],
	UnaryExpression: ["argument"],
	UpdateExpression: ["argument"],
	VariableDeclaration: ["declarations"],
	VariableDeclarator: ["id", "init"],
	WhileStatement: ["test", "body"],
	WithStatement: ["object", "body"],
	YieldExpression: ["argument"],
};

export type EstreeVisitor<Context> = (
	node: ESTree.Node,
	at: EstreeTraversalContext<Context>,
) => EstreeTraversalAction | void;

export function isEstreeNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/** Visit each direct ESTree child, ignoring metadata and other non-node objects. */
export function forEachEstreeChild(
	node: ESTree.Node,
	visit: (child: ESTree.Node, key: string | number) => void,
): void {
	for (const key of ESTREE_VISITOR_KEYS[node.type] ?? Object.keys(node)) {
		const value: unknown = (node as unknown as Record<string, unknown>)[key];
		if (isEstreeNode(value)) {
			visit(value, key);
		} else if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				const item: unknown = value[index];
				if (isEstreeNode(item)) visit(item, index);
			}
		}
	}
}

/**
 * Pre-order ESTree traversal. `skip` prunes one node's children and `stop`
 * terminates the entire traversal. Arrays may be used as traversal roots.
 */
export function traverseEstree<Context = undefined>(
	root: unknown,
	visitor: EstreeVisitor<Context>,
	context?: Context,
): typeof ESTREE_CONTINUE | typeof ESTREE_STOP {
	let stopped = false;

	const visit = (
		value: unknown,
		parent: ESTree.Node | null,
		key: string | number | null,
	): void => {
		if (stopped) return;
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length && !stopped; index++) {
				visit(value[index], parent, index);
			}
			return;
		}
		if (!isEstreeNode(value)) return;

		const action = visitor(value, {
			parent,
			key,
			context: context as Context,
		});
		if (action === ESTREE_STOP) {
			stopped = true;
			return;
		}
		if (action === ESTREE_SKIP) return;

		forEachEstreeChild(value, (child, childKey) => visit(child, value, childKey));
	};

	visit(root, null, null);
	return stopped ? ESTREE_STOP : ESTREE_CONTINUE;
}
