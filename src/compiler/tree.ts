import type { ESTree } from "meriyah";

type WalkerProps = {
	[K in ESTree.Node["type"] as K extends `JSX${string}` ? never : K]: Array<
		keyof Extract<ESTree.Node, { type: K }>
	>;
};

const WALKER_PROPS = {
	AccessorProperty: ["key", "decorators"],
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
	ChainExpression: ["expression"],
	CatchClause: ["param", "body"],
	ClassBody: ["body"],
	ClassDeclaration: ["id", "body", "superClass", "decorators"],
	ClassExpression: ["id", "body", "superClass", "decorators"],
	ConditionalExpression: ["test", "consequent", "alternate"],
	ContinueStatement: ["label"],
	DebuggerStatement: [],
	Decorator: ["expression"],
	DoWhileStatement: ["body", "test"],
	EmptyStatement: [],
	ExportAllDeclaration: ["exported", "attributes"],
	ExportDefaultDeclaration: ["declaration"],
	ExportNamedDeclaration: ["declaration", "attributes", "specifiers"],
	ExportSpecifier: ["exported", "local"],
	ExpressionStatement: ["expression"],
	PropertyDefinition: ["key", "decorators"],
	ForInStatement: ["left", "right", "body"],
	ForOfStatement: ["left", "right", "body"],
	ForStatement: ["init", "test", "update", "body"],
	FunctionDeclaration: ["id", "params", "body"],
	FunctionExpression: ["id", "params", "body"],
	Identifier: [],
	IfStatement: ["test", "consequent", "alternate"],
	ImportAttribute: ["key"],
	ImportDeclaration: ["specifiers", "attributes"],
	ImportDefaultSpecifier: ["local"],
	ImportExpression: ["source", "options"],
	ImportNamespaceSpecifier: ["local"],
	ImportSpecifier: ["local", "imported"],
	LabeledStatement: ["label"],
	Literal: [],
	LogicalExpression: ["left", "right"],
	MemberExpression: ["object", "property"],
	MetaProperty: ["meta", "property"],
	MethodDefinition: ["key", "decorators", "value"],
	NewExpression: ["callee", "arguments"],
	ObjectExpression: ["properties"],
	ObjectPattern: ["properties"],
	ParenthesizedExpression: ["expression"],
	PrivateIdentifier: ["name"],
	Program: ["body"],
	Property: ["key", "value"],
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
	TemplateLiteral: ["expressions", "quasis"],
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
} satisfies WalkerProps;

const _nodeParentMap = new WeakMap<ESTree.Node, ESTree.Node | null>();

export function walkTree<Args extends Array<unknown>>(
	tree: ESTree.Node | null | string,
	cb: (node: ESTree.Node, ...args: Args) => void,
	...args: NoInfer<Args>
): void {
	if (tree === null || typeof tree === "string") {
		return;
	}

	if (tree.type.startsWith("JSX")) {
		return;
	}

	const props = WALKER_PROPS[tree.type as keyof WalkerProps] ?? [];
	const isNode = (n: unknown): n is ESTree.Node =>
		typeof n === "object" && n !== null && "type" in n;

	for (const prop of props) {
		// @ts-expect-error - string can't be used to index Node.
		const val = tree[prop] as unknown as ESTree.Node;

		if (Array.isArray(val)) {
			for (const it of val) {
				if (isNode(it)) {
					_nodeParentMap.set(it, tree);
					cb(it, ...args);
				}
			}
		} else if (isNode(val)) {
			_nodeParentMap.set(val, tree);
			cb(val, ...args);
		}
	}
}

export function treeGetNodeParent(node: ESTree.Node): ESTree.Node | null {
	return _nodeParentMap.get(node) ?? null;
}
