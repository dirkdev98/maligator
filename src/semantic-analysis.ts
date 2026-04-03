import { readFileSync } from "node:fs";
import type { ESTree } from "meriyah";
import { parseModule, parseScript } from "./parser.ts";
import { log } from "./utils.ts";

export interface SemanticProgram {
	entrypointPath: string;
	files: Array<SemanticFile>;
}

export interface SemanticFile {
	type: "script" | "module";
	path: string;
	contents: string;
	strict: boolean;
	ast: ESTree.Program;

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

	declarationNode?: ESTree.Node;
	usageNodes: Array<ESTree.Node>;

	undeclared?: true;
	scopedTo?: "local" | "captured" | "global";
}

/**
 * Util to dump the full scope + bindings for a program.
 */
function debugSemanticProgram(program: SemanticProgram) {
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
}

/**
 * Semantic analysis entrypoint
 */
export function loadEntrypointAndRunSemanticAnalysis(
	entrypointPath: string,
): SemanticProgram {
	const program: SemanticProgram = {
		entrypointPath,
		files: [],
	};

	loadAndAnalyzeFile(program, entrypointPath);
	debugSemanticProgram(program);

	return program;
}

/**
 * Add a file to be loaded in to the pgoram.
 */
export function loadAndAnalyzeFile(
	program: SemanticProgram,
	path: string,
	asModule = false,
) {
	const contents = readFileSync(path, "utf-8");

	const file: SemanticFile = {
		path,
		contents,
		...(asModule ? parseModule(contents) : parseScript(contents, { strict: true })),

		scopes: [],
		nodeToScope: new Map(),
		nodeToBinding: new Map(),
	};

	program.files.push(file);

	analyzeFile(file);

	return file;
}

/**
 * Exec all analyze steps for a file.
 */
function analyzeFile(file: SemanticFile) {
	createScopesFromNode(file.ast, file);
	collectBindingsForNode(file.ast, file);
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
			// Register a function as a binding in their parent scope.
			extractBindingsAndRegister(
				file,
				scope.parent!,
				node.id,
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
			extractBindingsAndRegister(file, scope.parent!, node.id, "let");
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

	if (node.type === "MemberExpression" && !node.computed) {
		// Skip the property from member expressions, except when they are computed.
		return registerBindingUsage(node.object, file);
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
			if (intermediate.node.type.includes("Function")) {
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
		if (declarationScope.node.type === "Program") {
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
