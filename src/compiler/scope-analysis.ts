import type { ESTree } from "meriyah";
import type { CreateScope, ProgramInformation } from "./program-info.ts";
import { treeGetNodeParent, walkTree } from "./tree.ts";

export function doScopeAnalysis(program: ProgramInformation) {
	createScopeInformation(program);
	initializeBindingInformation(program);
	collectBindingWriteInformation(program);
	collectBindingReadInformation(program);

	// TODO: Determine the number of declarations, params i.e registers of env values

	// TODO: Assign register / env slots + unique names to functions

	// TODO: Verify the behaviors against various Static Semantics from the ecma262 spec. i.e https://tc39.es/ecma262/multipage/syntax-directed-operations.html#sec-syntax-directed-operations-scope-analysis

	// TODO: Track async/generator flags

	// TODO: track exported bindings

	// TODO: Show rest parameter indicator (...args) vs regular params

	// TODO: Track temporary dead zones  (let, const) vs hoisted (var, function)
}

function createScopeInformation(program: ProgramInformation) {
	const createScopes = (node: ESTree.Node, scopeCreator: CreateScope) => {
		if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression"
		) {
			const newScope = scopeCreator.createScope(node, "function");

			walkTree(node, createScopes, newScope);
			return;
		} else if (node.type === "BlockStatement") {
			const newScope = scopeCreator.createScope(node, "block");
			walkTree(node, createScopes, newScope);
			return;
		} else if (node.type === "StaticBlock") {
			const newScope = scopeCreator.createScope(node, "static-block");
			walkTree(node, createScopes, newScope);
			return;
		} else if (node.type === "ClassDeclaration") {
			const newScope = scopeCreator.createScope(node, "class");
			walkTree(node, createScopes, newScope);
			return;
		} else if (
			node.type === "ForStatement" ||
			node.type === "ForInStatement" ||
			node.type === "ForOfStatement"
		) {
			const newScope = scopeCreator.createScope(node, "for-loop");
			walkTree(node, createScopes, newScope);
			return;
		} else if (node.type === "WithStatement") {
			const newScope = scopeCreator.createScope(node, "with-block");
			walkTree(node, createScopes, newScope);
			return;
		} else if (node.type === "SwitchStatement") {
			const newScope = scopeCreator.createScope(node, "switch-block");
			walkTree(node, createScopes, newScope);
			return;
		}

		walkTree(node, createScopes, scopeCreator);
	};

	for (const module of program.iterateProgramParts()) {
		walkTree(module.node, createScopes, module);
	}
}

function initializeBindingInformation(program: ProgramInformation) {
	const initializeBindings = (node: ESTree.Node) => {
		const scope = program.getScopeForNode(node);
		if (node.type === "VariableDeclaration") {
			const kind = node.kind;

			for (const declaration of node.declarations) {
				const names = extractNames(declaration.id);
				for (const name of names) {
					// TODO: Var declarations that match parameter names should NOT create new bindings.
					// Per ECMAScript: if a var declaration's name matches a parameter, it reuses that
					// binding. Currently creates a duplicate Binding[var] instead of reusing Binding[param].
					// See: local2.js:varShadowsParam - shows Binding[var]: param1 instead of reusing param.

					// TODO: When both var and function declarations exist with same name, function wins.
					// Currently both bindings are created. Function declaration should replace var binding.
					// See: local2.js:funcVsVar, local2.js:varBeforeFunc
					scope.createBinding(name, declaration, kind);
				}
			}

			return;
		}

		if (node.type === "ClassDeclaration") {
			const names = extractNames(node.id);
			for (const name of names) {
				scope.parent!.createBinding(name, node, "class");
			}
		}

		if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression"
		) {
			if (node.type === "FunctionDeclaration") {
				// TODO: Function declarations should be hoisted to the enclosing function/module/script
				// scope, NOT the immediate parent scope. In sloppy mode, functions inside blocks should
				// hoist to function scope. Currently the binding is created at the wrong scope level. See:
				// local2.js:funcInBlock, local2.js:sloppyBlockFunc, local2.js:outerHoisting Per 14.2.2
				// Static Semantics: VarScopedDeclarations, FunctionDeclaration is var-scoped.
				const names = extractNames(node.id);
				for (const name of names) {
					scope.createBinding(name, node, "function");
				}
			}

			for (const param of node.params) {
				const names = extractNames(param);
				for (const name of names) {
					scope.createBinding(name, param, "param");
				}
			}

			// We still recurse in to the declaration for nested functions
		}

		if (node.type === "CatchClause") {
			const names = extractNames(node.param);
			for (const name of names) {
				scope.createBinding(name, node, "let");
			}
		}

		if (node.type === "PropertyDefinition") {
			const names = extractNames(node.key);
			for (const name of names) {
				scope.createBinding(name, node, "field");
			}
		}

		// TODO: Imports / exports

		walkTree(node, initializeBindings);
	};

	for (const module of program.iterateProgramParts()) {
		walkTree(module.node, initializeBindings);
	}
}

function collectBindingWriteInformation(program: ProgramInformation) {
	const collectInformation = (node: ESTree.Node) => {
		const scope = program.getScopeForNode(node);

		if (node.type === "AssignmentExpression") {
			const names = extractNames(node.left);
			for (const name of names) {
				const binding = scope.getBinding(name);
				if (binding) {
					binding.addUpdateUsage(program, node);
				}
			}
		}

		if (node.type === "UpdateExpression") {
			const names = extractNames(node.argument);
			for (const name of names) {
				const binding = scope.getBinding(name);
				if (binding) {
					binding.addUpdateUsage(program, node);
				}
			}
		}

		walkTree(node, collectInformation);
	};

	for (const module of program.iterateProgramParts()) {
		walkTree(module.node, collectInformation);
	}
}

function collectBindingReadInformation(program: ProgramInformation) {
	const collectInformation = (node: ESTree.Node) => {
		const scope = program.getScopeForNode(node);

		if (node.type === "Identifier") {
			if (node.name === "arguments") {
				// Track arguments usage. This allows us to only compile the arguments object when its used.
				scope.usedFunctionArgumentsObject();
			}

			const parent = treeGetNodeParent(node);
			if (!parent) {
				return;
			}

			if (parent.type === "MemberExpression" && parent.property === node) {
				// Skip tracking foo in x.foo;
				return;
			}

			if (parent.type === "VariableDeclarator" && parent.id === node) {
				// Skip tracking x in var x = foo;
				return;
			}

			if (parent.type === "AssignmentExpression" && parent.left === node) {
				// Skip tracking x in x = foo;
				return;
			}

			if (parent.type === "AssignmentPattern" && parent.left === node) {
				// Skip tracking x in let {x = z} = {};
				return;
			}

			if (parent.type === "ArrayPattern") {
				// Skip tracking x in let [x, y] = [];
				return;
			}

			if (parent.type === "Property" && parent.key === node) {
				// Skip tracking x in let f = { x: y };
				return;
			}

			if (
				parent.type === "Property" &&
				treeGetNodeParent(parent)?.type === "ObjectPattern"
			) {
				// Skip tracking x in let {x} = {};
				return;
			}

			if (
				(parent.type === "FunctionDeclaration" ||
					parent.type === "FunctionExpression" ||
					parent.type === "ArrowFunctionExpression") &&
				(("id" in parent && parent.id === node) || parent.params.includes(node))
			) {
				// Skip tracking foo in function foo() {}
				// Skip tracking x in function foo(x) {}
				return;
			}

			const binding = scope.getBinding(node.name);
			if (binding) {
				binding.addReadUsage(program, node);
			}
		}

		walkTree(node, collectInformation);
	};

	for (const module of program.iterateProgramParts()) {
		walkTree(module.node, collectInformation);
	}
}

function extractNames(
	node:
		| null
		| ESTree.AssignmentPattern
		| ESTree.PrivateIdentifier
		| ESTree.Identifier
		| ESTree.BindingPattern
		| ESTree.Expression
		| ESTree.RestElement
		| ESTree.SpreadElement
		| ESTree.Property
		| ESTree.ObjectLiteralElementLike,
): Array<
	| {
			name: string;
			isPrivate: boolean;
	  }
	| string
> {
	if (node === null) {
		return [];
	}

	switch (node.type) {
		case "PrivateIdentifier":
			return [
				{
					name: node.name,
					isPrivate: true,
				},
			];
		case "Identifier":
			return [node.name];
		case "ArrayPattern":
			return node.elements.flatMap(extractNames);
		case "ObjectPattern":
			return node.properties.flatMap(extractNames);
		case "AssignmentPattern":
			return extractNames(node.left);
		case "RestElement":
		case "SpreadElement":
			return extractNames(node.argument);
		case "Property":
			return extractNames(node.value);
		case "MemberExpression":
			return extractNames(node.object);
	}

	return [];
}
