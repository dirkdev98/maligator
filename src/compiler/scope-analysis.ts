import type { ESTree } from "meriyah";
import type { CreateScope, ProgramInformation } from "./program-info.ts";
import { walkTree } from "./tree.ts";

export function doScopeAnalysis(program: ProgramInformation) {
	createScopeInformation(program);
	initializeBindingInformation(program);
	collectBindingUsageInformation(program);

	// TODO: Go through all identifiers and link them up to the registered symbols.
}

function createScopeInformation(program: ProgramInformation) {
	const createScopes = (node: ESTree.Node, scopeCreator: CreateScope) => {
		if (node.type === "FunctionDeclaration") {
			const newScope = scopeCreator.createScope(node, "function");

			walkTree(node, createScopes, newScope);
			return;
		} else if (node.type === "BlockStatement") {
			const newScope = scopeCreator.createScope(node, "block");
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
					scope.createBinding(name, declaration, kind);
				}
			}

			return;
		}

		if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression"
		) {
			if (node.type === "FunctionDeclaration") {
				// TODO: Shouldn't this one be hoisted to the parent scope?
				//
				// TODO: What about classes?
				const names = extractNames(node.id);
				for (const name of names) {
					scope.parent!.createBinding(name, node, "function");
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

			return;
		}

		// TODO: Imports / exports

		walkTree(node, initializeBindings);
	};

	for (const module of program.iterateProgramParts()) {
		walkTree(module.node, initializeBindings);
	}
}

function collectBindingUsageInformation(program: ProgramInformation) {
	const collectInformation = (node: ESTree.Node) => {
		const scope = program.getScopeForNode(node);

		if (node.type === "AssignmentExpression") {
			const names = extractNames(node.left);
			for (const name of names) {
				const binding = scope.getBinding(name);
				if (binding) {
					binding.addUpdateUsage(node);
				}
			}
		}

		if (node.type === "UpdateExpression") {
			const names = extractNames(node.argument);
			for (const name of names) {
				const binding = scope.getBinding(name);
				if (binding) {
					binding.addUpdateUsage(node);
				}
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
			return extractNames(node.key);
		case "MemberExpression":
			return extractNames(node.object);
	}

	return [];
}
