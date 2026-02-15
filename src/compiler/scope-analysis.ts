import type { ESTree } from "meriyah";
import type { CreateScope, ProgramInformation } from "./program-info.ts";
import { walkTree } from "./tree.ts";

export function doScopeAnalysis(program: ProgramInformation) {
	createScopeInformation(program);
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
