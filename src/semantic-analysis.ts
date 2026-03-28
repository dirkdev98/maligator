import { readFileSync } from "node:fs";
import type { ESTree } from "meriyah";
import { parseModule, parseScript } from "./parser.ts";

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
}

interface Scope {
	parent: Scope | null;
	node: ESTree.Node;

	strict: boolean;
	bindings: Array<Binding>;
}

interface Binding {
	name: string;
	declarationNode?: ESTree.Node;
	usageNodes: Array<ESTree.Node>;
}

export function loadAndAnalyze(entrypointPath: string): SemanticProgram {
	const program: SemanticProgram = {
		entrypointPath,
		files: [],
	};

	program.files.push(loadAndAnalyzeFile(program, entrypointPath));

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
	};

	program.files.push(file);

	analyzeFile(file);

	return file;
}

function analyzeFile(file: SemanticFile) {
	createScopesFromNode(file.ast, file);
	collectBindingsForNode(file.ast, file);

	// TODO: bindings, captures
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

	if (node.type === "BlockStatement") {
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
		["ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"].includes(
			node.type,
		)
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
		file.nodeToScope.set(node, parentScope);
	}
	recurseAst(node, createScopesFromNode, file, parentScope);
}

/**
 * Build up the scope tree and infer strict modes.
 */
function collectBindingsForNode(node: ESTree.Node, file: SemanticFile) {
	if ("id" in node) {
		node.id;
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
