import type { ESTree } from "meriyah";
import { buildModuleGraph } from "./module-graph.ts";
import type {
	BuildModuleGraphOptions,
	ModuleGraph,
	ModuleRecord,
} from "./module-graph.ts";
import { parseScript } from "./parser.ts";
import { log } from "./utils.ts";

export interface SemanticProgram {
	entrypointPath: string;
	files: Array<SemanticFile>;
	/**
	 * The module graph the program was built from (loader/graph phase). Absent
	 * for in-memory composition (analyzeSourceAndRunSemanticAnalysis).
	 */
	graph?: ModuleGraph;
}

export interface SemanticFile {
	type: "script" | "module";
	path: string;
	contents: string;
	strict: boolean;
	ast: ESTree.Program;

	/**
	 * A CommonJS module. Its top level is the body of a wrapper function
	 * `(module, exports, require, __filename, __dirname)`, so those names are
	 * predefined bindings and the program scope behaves like a function scope
	 * (top-level declarations are wrapper locals/captures, not globals).
	 */
	commonjs?: boolean;

	// TODO: We ain't fully compliant here yet. Scripts evaluate to the same global scope, so
	//  bindings might reference outside of this semantic file.
	scopes: Array<Scope>;
	nodeToScope: Map<ESTree.Node, Scope>;
	nodeToBinding: Map<ESTree.Node, Binding>;
}

interface Scope {
	parent: Scope | null;
	node: ESTree.Node;

	strict: boolean;
	bindings: Array<Binding>;
}

type BindingKind = "var" | "let" | "const";

export interface Binding {
	kind: BindingKind;
	name: string;
	implicit?: "arguments";

	declarationNode?: ESTree.Node;
	usageNodes: Array<ESTree.Node>;

	undeclared?: true;
	scopedTo?: "local" | "captured" | "global";

	/**
	 * An ES import binding. It aliases (shares storage with) the exporting
	 * module's binding, so the importing module must not give it its own
	 * uninitialized (TDZ) slot.
	 */
	imported?: true;
}

/**
 * Util to dump the full scope + bindings for a program.
 */
export function debugSemanticProgram(program: SemanticProgram) {
	let output = "";
	const indent = "  ";

	for (const file of program.files) {
		output += `${file.path}\n`;

		let scopeIdx = 0;
		for (const scope of file.scopes) {
			const parentIdx = file.scopes.findIndex((s) => s === scope.parent);

			output += `${indent}Scope(${scopeIdx++} ${scope.node.type} (parent: ${parentIdx})\n`;

			for (const binding of scope.bindings) {
				output += `${indent}${indent}Binding(${binding.name} ${binding.kind} ${binding.scopedTo} ${binding.declarationNode?.type ?? "unknown"}) (usages: ${binding.usageNodes.length}, declared: ${!binding.undeclared}) \n`;
			}
		}
	}

	log.debug(output);

	return output;
}

/**
 * Semantic analysis entrypoint.
 *
 * Builds the module graph from the entrypoint (loader/graph phase) and runs
 * semantic analysis over every reachable module in evaluation order
 * (dependencies before dependents). A program with no imports is a single-node
 * graph, so this is behaviorally identical to analyzing the one file.
 */
export function loadEntrypointAndRunSemanticAnalysis(
	entrypointPath: string,
	options: BuildModuleGraphOptions = {},
): SemanticProgram {
	const graph = buildModuleGraph(entrypointPath, options);

	const program: SemanticProgram = {
		entrypointPath: graph.entry,
		files: [],
		graph,
	};

	for (const modulePath of graph.evaluationOrder) {
		program.files.push(analyzeModuleRecord(graph.modules.get(modulePath)!));
	}

	debugSemanticProgram(program);

	return program;
}

/**
 * Run semantic analysis over in-memory source, optionally reusing an
 * existing parse. Used by tooling that composes sources without disk files.
 */
export function analyzeSourceAndRunSemanticAnalysis(
	contents: string,
	virtualPath: string,
	parsed?: Pick<SemanticFile, "type" | "strict" | "ast">,
): SemanticProgram {
	const program: SemanticProgram = {
		entrypointPath: virtualPath,
		files: [],
	};

	const file: SemanticFile = {
		path: virtualPath,
		contents,
		...(parsed ?? parseScript(contents, { strict: true })),

		scopes: [],
		nodeToScope: new Map(),
		nodeToBinding: new Map(),
	};

	program.files.push(file);
	analyzeFile(file);
	debugSemanticProgram(program);

	return program;
}

/**
 * Build and analyze a SemanticFile from a module-graph record, reusing the
 * record's goal-correct parse.
 */
function analyzeModuleRecord(record: ModuleRecord): SemanticFile {
	const file: SemanticFile = {
		path: record.path,
		contents: record.source,
		type: record.parsed.type,
		strict: record.parsed.strict,
		ast: record.parsed.ast,
		commonjs: record.goal === "cjs",

		scopes: [],
		nodeToScope: new Map(),
		nodeToBinding: new Map(),
	};

	analyzeFile(file);

	return file;
}

/** The wrapper parameters injected into every CommonJS module's program scope. */
export const COMMONJS_BINDINGS = [
	"module",
	"exports",
	"require",
	"__filename",
	"__dirname",
] as const;

/**
 * Inject the CommonJS wrapper parameters (`module`, `exports`, `require`,
 * `__filename`, `__dirname`) into the module's program scope so references
 * resolve to them instead of throwing ReferenceError. A name the module already
 * declares at top level wins (its declaration acts as the parameter).
 */
function injectCommonJsBindings(file: SemanticFile) {
	const programScope = file.scopes[0];
	if (!programScope) {
		return;
	}
	for (const name of COMMONJS_BINDINGS) {
		if (!programScope.bindings.some((binding) => binding.name === name)) {
			programScope.bindings.push({
				kind: "var",
				name,
				declarationNode: file.ast,
				usageNodes: [],
			});
		}
	}
}

/**
 * Exec all analyze steps for a file.
 */
function analyzeFile(file: SemanticFile) {
	createScopesFromNode(file.ast, file);
	collectBindingsForNode(file.ast, file);
	if (file.commonjs) {
		injectCommonJsBindings(file);
	}
	registerBindingUsage(file.ast, file);
	calculateBindingScopedTo(file);
}

/**
 * Build up the scope tree and infer strict modes.
 */
function createScopesFromNode(
	node: ESTree.Node,
	file: SemanticFile,
	parentScope: Scope | null = null,
) {
	// Handle "use strict" directives.
	if (parentScope && "directive" in node && node.directive === "use strict") {
		parentScope.strict = true;
	}

	const strict = file.strict || parentScope?.strict || false;

	if (node.type === "Program") {
		// Wrap each program in a scope.
		// On this we can track global variables and other top-level declarations.
		parentScope = {
			parent: parentScope,
			node,

			strict,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (node.type === "BlockStatement" || node.type === "StaticBlock") {
		// All blocks need their own scope.
		parentScope = {
			parent: parentScope,
			node,

			strict,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (node.type === "PropertyDefinition") {
		// A class field initializer is its own scope: it is compiled as a
		// distinct function (the constructor or static initializer), so outer
		// references must resolve as captures, not as the enclosing locals.
		parentScope = {
			parent: parentScope,
			node,

			strict: true,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (
		node.type === "ArrowFunctionExpression" &&
		node.body?.type !== "BlockStatement" &&
		node.params.length
	) {
		// We need a block scope for a single-line function expression if it has params
		parentScope = {
			parent: parentScope,
			node: node.body,

			strict,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (
		[
			"ForStatement",
			"ForInStatement",
			"ForOfStatement",
			"SwitchStatement",
			"CatchClause",

			"FunctionDeclaration",
			"FunctionExpression",
			"ArrowFunctionExpression",
		].includes(node.type)
	) {
		// All statements that can have a separate scope for their created variables.

		parentScope = {
			parent: parentScope,
			node,

			strict,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (["ClassDeclaration", "ClassExpression"].includes(node.type)) {
		// Class declaration and expressions are always in strict mode.

		parentScope = {
			parent: parentScope,
			node,

			strict: true,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (parentScope) {
		// Make it easier to lookup a scope for a node in later passes.
		//
		// This prevents us from also having to walk the scopes while walking the AST.
		//
		// The thing is, at some point we are probably going to want to do a single AST walk tho, to
		// optimize things, so then this will become obselete.
		file.nodeToScope.set(node, parentScope);
	}

	recurseAst(node, createScopesFromNode, file, parentScope);
}

/**
 * Build up the scope tree and infer strict modes.
 */
function collectBindingsForNode(node: ESTree.Node, file: SemanticFile) {
	const scope = file.nodeToScope.get(node);
	if (!scope) {
		return;
	}

	if (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
	) {
		if ("id" in node && node.id) {
			// Register a function as a binding in their scope.
			extractBindingsAndRegister(
				file,
				// FunctionDeclarations are available in the parent scope, named FunctionExpressions are
				// only available in their own scope.
				node.type === "FunctionDeclaration" ? scope.parent! : scope,
				node,
				scope.strict ? "let" : "var",
			);
		}

		if (node.params.length) {
			for (const param of node.params) {
				extractBindingsAndRegister(file, scope, param, "var");
			}
		}
	}

	if (node.type === "VariableDeclaration") {
		for (const decl of node.declarations) {
			extractBindingsAndRegister(file, scope, decl.id, node.kind);
		}
	}

	if (node.type === "CatchClause") {
		if (node.param) {
			extractBindingsAndRegister(file, scope, node.param, "let");
		}
	}

	if (node.type === "ClassDeclaration") {
		if ("id" in node && node.id) {
			// Register a class a binding in their parent scope.
			extractBindingsAndRegister(file, scope.parent!, node, "let");
		}
	}

	if (node.type === "ImportDeclaration") {
		// Each import introduces an immutable module-scoped binding for its local
		// name. The linker later aliases usages of these to the exporting module's
		// binding; until then they exist so references resolve to a real binding
		// (not a spurious undeclared global).
		for (const specifier of node.specifiers) {
			extractBindingsAndRegister(file, scope, specifier.local, "const");
			const binding = file.nodeToBinding.get(specifier.local);
			if (binding) {
				binding.imported = true;
			}
		}
	}

	recurseAst(node, collectBindingsForNode, file);
}

/**
 * Extract bindings for all function and class id's, params and variable declarations.
 */
function extractBindingsAndRegister(
	file: SemanticFile,
	scope: Scope,
	node: ESTree.Node,
	kind: BindingKind,
) {
	/**
	 * Recursively walk expression to extract names.
	 *
	 * We need this for destructure patterns.
	 */
	const extractNames = (node?: ESTree.Node): Array<string> => {
		if (!node) {
			return [];
		}

		if ("id" in node && node.id) {
			return extractNames(node.id);
		}

		if (node.type === "Identifier") {
			return [node.name];
		}

		if (node.type === "PrivateIdentifier") {
			return [`#${node.name}`];
		}

		if (node.type === "ArrayPattern") {
			return node.elements.flatMap(extractNames);
		}

		if (node.type === "ObjectPattern") {
			return node.properties.flatMap(extractNames);
		}

		if (node.type === "RestElement") {
			return extractNames(node.argument);
		}

		if (node.type === "AssignmentPattern") {
			return extractNames(node.left);
		}

		if (node.type === "Property") {
			return extractNames(node.value);
		}

		return [];
	};

	const names = extractNames(node);

	let bindingScope = scope;

	if (kind === "var" && !bindingScope.node.type.includes("Function")) {
		// Hoist var bindings to their nearest function scope or the module root.
		while (bindingScope.parent) {
			const parentType = bindingScope.parent.node.type;

			if (
				parentType !== "FunctionDeclaration" &&
				parentType !== "FunctionExpression" &&
				parentType !== "ArrowFunctionExpression"
			) {
				bindingScope = bindingScope.parent;
			} else {
				break;
			}
		}
	}

	for (const name of names) {
		const binding = {
			kind,

			name,
			declarationNode: node,
			usageNodes: [],
		};

		bindingScope.bindings.push(binding);
		file.nodeToBinding.set(node, binding);
	}
}

/**
 * Raw resolve every identifier in the AST to its binding.
 *
 * Note that we also collect a usage for the declaration. So we have to handle this downstream
 * or fix that here at some point.
 */
function registerBindingUsage(node: ESTree.Node, file: SemanticFile) {
	const scope = file.nodeToScope.get(node);
	if (!scope) {
		return;
	}

	const resolveBindingByName = (recurseScope: Scope, name: string) => {
		const binding = recurseScope.bindings.find((b) => b.name === name);
		if (binding) {
			return binding;
		}

		if (
			name === "arguments" &&
			(recurseScope.node.type === "FunctionDeclaration" ||
				recurseScope.node.type === "FunctionExpression")
		) {
			// TODO(arguments): Have sema classify static arguments usages so IR can avoid
			// materializing the arguments object for direct non-escaping reads like
			// arguments.length and arguments[0].
			const binding: Binding = {
				kind: "var",
				name: "arguments",
				implicit: "arguments",
				declarationNode: recurseScope.node,
				usageNodes: [],
			};
			recurseScope.bindings.push(binding);
			return binding;
		}

		if (!recurseScope.parent) {
			// No binding found, so we create an undeclared binding.
			//
			// These can be globals, like 'undefined' or intrinsics like 'Object'.

			const binding: Binding = {
				kind: "var",
				name,

				declarationNode: node,
				usageNodes: [],

				undeclared: true,
			};
			scope.bindings.push(binding);
			return binding;
		}

		return resolveBindingByName(recurseScope.parent, name);
	};

	if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") {
		// Imports carry only declarations (specifier locals) and the source/imported
		// names — never a local usage. `export * from` / `export * as ns` likewise
		// reference the source module, not local bindings.
		return;
	}

	if (node.type === "ExportNamedDeclaration") {
		if (node.declaration) {
			// `export const/function/class` — the real usages live in the declaration.
			return registerBindingUsage(node.declaration, file);
		}
		if (node.source) {
			// `export { x } from "m"` — specifiers name the source module's exports.
			return;
		}
		// `export { a, b as c }` — each specifier's local is a usage of a local binding.
		for (const specifier of node.specifiers) {
			registerBindingUsage(specifier.local, file);
		}
		return;
	}

	if (node.type === "ExportDefaultDeclaration") {
		return registerBindingUsage(node.declaration, file);
	}

	if (node.type === "MemberExpression" && !node.computed) {
		// Skip the property from member expressions, except when they are computed.
		return registerBindingUsage(node.object, file);
	}

	if ((node.type === "Property" || node.type === "MethodDefinition") && !node.computed) {
		// Skip non-computed keys of object literals, object patterns and class
		// members; only the value side contains references. Shorthand pattern
		// properties share the key node as their value, so the value walk still
		// registers those usages.
		return registerBindingUsage(node.value, file);
	}

	if (node.type === "Identifier") {
		const binding = resolveBindingByName(scope, node.name);
		binding.usageNodes.push(node);
		file.nodeToBinding.set(node, binding);
	}

	recurseAst(node, registerBindingUsage, file);
}

/**
 * Based on usages of a binding, figure out where it is scoped to.
 */
function calculateBindingScopedTo(file: SemanticFile) {
	const usageToDeclarationScopeCrossesFunction = (from: Scope, to: Scope) => {
		if (from === to) {
			return false;
		}

		let intermediate: Scope | null = from;

		while (intermediate && intermediate !== to) {
			// Functions are capture boundaries; so are class field initializers
			// and static blocks, which are compiled as their own functions (the
			// constructor / static initializer).
			if (
				intermediate.node.type.includes("Function") ||
				intermediate.node.type === "PropertyDefinition" ||
				intermediate.node.type === "StaticBlock"
			) {
				return true;
			}

			intermediate = intermediate.parent;
		}

		return false;
	};

	const calculateScopedTo = (
		declarationScope: Scope,
		usageScopes: Array<Scope>,
	): Binding["scopedTo"] => {
		// A CommonJS module's program scope is its wrapper function's scope, so
		// top-level bindings are wrapper locals/captures rather than globals.
		if (declarationScope.node.type === "Program" && !file.commonjs) {
			return "global";
		}

		for (const usage of usageScopes) {
			if (usageToDeclarationScopeCrossesFunction(usage, declarationScope)) {
				return "captured";
			}
		}

		return "local";
	};

	for (const scope of file.scopes) {
		for (const binding of scope.bindings) {
			const usageScopes = binding.usageNodes.map((node) => file.nodeToScope.get(node)!);
			binding.scopedTo = calculateScopedTo(scope, usageScopes);
		}
	}
}

/**
 * Recurse through the AST starting at the given node. Going depth first.
 */
function recurseAst<
	Args extends Array<unknown>,
	Callback extends (node: ESTree.Node, ...args: Args) => void,
>(node: ESTree.Node, callback: Callback, ...args: Args) {
	const isNode = (value: unknown): value is ESTree.Node => {
		return typeof value === "object" && value !== null && "type" in value;
	};

	for (const key of Object.keys(node)) {
		const value: unknown = node[key as keyof ESTree.Node];
		if (isNode(value)) {
			callback(value, ...args);
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (isNode(item)) {
					callback(item, ...args);
				}
			}
		}
	}
}
