import type { ESTree } from "meriyah";
import { staticMemberKey } from "./builtin-module-loads.ts";
import { traverseEstree } from "./estree-traversal.ts";
import type { SemanticFile, SemanticProgram } from "./semantic-analysis.ts";

type Uses = Set<string> | null;

export interface HostExportSelection {
	readonly id: string;
	readonly names: ReadonlyArray<string>;
}

function readMember(
	value: ESTree.Node,
	parents: ReadonlyMap<ESTree.Node, ESTree.Node>,
): string | undefined {
	const member = parents.get(value);
	if (member?.type !== "MemberExpression" || member.object !== value) return undefined;
	let target: ESTree.Node = member;
	for (let parent = parents.get(target); parent; parent = parents.get(target)) {
		switch (parent.type) {
			case "AssignmentExpression":
			case "AssignmentPattern":
			case "ForOfStatement":
			case "ForInStatement":
				if (parent.left === target) return undefined;
				break;
			case "UpdateExpression":
				return undefined;
			case "UnaryExpression":
				if (parent.operator === "delete") return undefined;
				break;
			case "Property":
			case "ObjectPattern":
			case "ArrayPattern":
			case "RestElement":
				target = parent;
				continue;
		}
		break;
	}
	return staticMemberKey(member);
}

function bindingReads(
	file: SemanticFile,
	declaration: ESTree.Identifier,
	parents: ReadonlyMap<ESTree.Node, ESTree.Node>,
): Uses {
	const binding = file.nodeToBinding.get(declaration);
	if (!binding) return null;
	const names = new Set<string>();
	for (const usage of binding.usageNodes) {
		if (usage === declaration) continue;
		const name = readMember(usage, parents);
		if (name === undefined) return null;
		names.add(name);
	}
	return names;
}

function requiredUses(
	file: SemanticFile,
	call: ESTree.CallExpression,
	parents: ReadonlyMap<ESTree.Node, ESTree.Node>,
): Uses {
	const parent = parents.get(call);
	if (parent?.type === "VariableDeclarator" && parent.init === call) {
		if (parent.id.type === "Identifier") return bindingReads(file, parent.id, parents);
		if (parent.id.type !== "ObjectPattern") return null;
		const names = new Set<string>();
		for (const property of parent.id.properties) {
			if (property.type !== "Property") return null;
			if (property.key.type === "Identifier" && !property.computed)
				names.add(property.key.name);
			else if (property.key.type === "Literal" && typeof property.key.value === "string")
				names.add(property.key.value);
			else return null;
		}
		return names;
	}
	const name = readMember(call, parents);
	return name === undefined ? null : new Set([name]);
}

/** Static projections of a host module in source. An opaque use requires its complete object. */
export function hostExportUses(
	program: SemanticProgram,
	modules: ReadonlySet<string>,
): ReadonlyMap<string, Uses> {
	const uses = new Map<string, Uses>();
	const graph = program.graph;
	if (!graph) return uses;
	const observe = (id: string, names: Uses) => {
		let current = uses.get(id);
		if (current === null) return;
		if (names === null) {
			uses.set(id, null);
			return;
		}
		if (current === undefined) uses.set(id, (current = new Set()));
		for (const name of names) current.add(name);
	};
	for (const file of program.files) {
		const dependencies = (graph.modules.get(file.path)?.dependencies ?? []).filter(
			({ resolvedPath }) => resolvedPath !== null && modules.has(resolvedPath),
		);
		if (dependencies.length === 0) continue;
		const parents = new Map<ESTree.Node, ESTree.Node>();
		const calls: Array<ESTree.CallExpression> = [];
		const imports: Array<ESTree.ImportDeclaration> = [];
		let dynamicScope = false;
		traverseEstree(file.ast, (node, { parent }) => {
			if (parent) parents.set(node, parent);
			if (node.type === "WithStatement") dynamicScope = true;
			if (node.type === "ImportDeclaration") imports.push(node);
			if (
				node.type === "CallExpression" &&
				node.callee.type === "Identifier" &&
				node.callee.name === "require" &&
				node.arguments.length === 1 &&
				file.nodeToBinding.get(node.callee)?.declarationNode === file.ast
			)
				calls.push(node);
		});
		for (const { kind, resolvedPath, specifier } of dependencies) {
			if (dynamicScope || specifier === null) {
				observe(resolvedPath!, null);
				continue;
			}
			if (kind === "require") {
				const matches = calls.filter(
					({ arguments: [argument] }) =>
						argument?.type === "Literal" && argument.value === specifier,
				);
				if (matches.length === 0) observe(resolvedPath!, null);
				for (const call of matches)
					observe(resolvedPath!, requiredUses(file, call, parents));
			} else if (kind === "import") {
				const matches = imports.filter(({ source }) => source.value === specifier);
				if (matches.length === 0) observe(resolvedPath!, null);
				for (const declaration of matches) {
					if (declaration.specifiers.length === 0) observe(resolvedPath!, null);
					for (const entry of declaration.specifiers) {
						const name =
							entry.type === "ImportSpecifier"
								? entry.imported.type === "Identifier"
									? entry.imported.name
									: String(entry.imported.value)
								: undefined;
						observe(
							resolvedPath!,
							name === undefined || name === "default"
								? bindingReads(file, entry.local, parents)
								: new Set([name]),
						);
					}
				}
			} else observe(resolvedPath!, null);
		}
	}
	return uses;
}
