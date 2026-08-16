import type { ESTree } from "meriyah";
import { primordialGlobalBindings } from "./builtin-registry.ts";
import type { CompilerDiagnostic } from "./compiler-diagnostics.ts";
import { compareCompilerDiagnostics } from "./compiler-diagnostics.ts";
import { sourceSiteId } from "./compiler-facts.ts";
import type { WorldFacts } from "./compiler-facts.ts";
import { traverseEstree } from "./estree-traversal.ts";
import type { SemanticFile, SemanticProgram } from "./semantic-analysis.ts";

const protectedBindings = new Set(primordialGlobalBindings.map(({ name }) => name));
const primitiveBindings = new Set(["NaN", "Infinity", "undefined"]);

interface PrimordialReference {
	display: string;
	kind: "binding" | "object";
}

function memberPropertyName(node: ESTree.MemberExpression): string | undefined {
	if (!node.computed && node.property.type === "Identifier") return node.property.name;
	if (
		node.computed &&
		node.property.type === "Literal" &&
		typeof node.property.value === "string"
	) {
		return node.property.value;
	}
	return undefined;
}

function literalPropertyName(node: ESTree.Node): string | undefined {
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	return undefined;
}

function globalIdentifier(file: SemanticFile, node: ESTree.Node): string | undefined {
	if (node.type !== "Identifier" || !protectedBindings.has(node.name)) return undefined;
	const binding = file.nodeToBinding.get(node);
	if (
		binding?.undeclared === true ||
		(binding?.scopedTo === "global" && binding.kind === "var")
	) {
		return node.name;
	}
	return undefined;
}

function primordialReference(
	file: SemanticFile,
	node: ESTree.Node,
): PrimordialReference | undefined {
	const identifier = globalIdentifier(file, node);
	if (identifier !== undefined) {
		return {
			display: identifier,
			kind:
				identifier === "globalThis" || primitiveBindings.has(identifier)
					? "binding"
					: "object",
		};
	}
	if (node.type !== "MemberExpression") return undefined;
	const property = memberPropertyName(node);
	if (property === undefined) return undefined;

	const object = primordialReference(file, node.object);
	if (object === undefined) return undefined;
	if (object.display === "globalThis") {
		if (!protectedBindings.has(property)) return undefined;
		return {
			display: `globalThis.${property}`,
			kind: primitiveBindings.has(property) ? "binding" : "object",
		};
	}
	if (object.kind !== "object") return undefined;
	return { display: `${object.display}.${property}`, kind: "object" };
}

function mutationTarget(
	file: SemanticFile,
	node: ESTree.Node,
): PrimordialReference | undefined {
	const direct = globalIdentifier(file, node);
	if (direct !== undefined) {
		return { display: direct, kind: "binding" };
	}
	if (node.type !== "MemberExpression") return undefined;
	const property = memberPropertyName(node);
	const object = primordialReference(file, node.object);
	if (property === undefined || object === undefined) return undefined;
	if (object.display === "globalThis") {
		return protectedBindings.has(property)
			? { display: `globalThis.${property}`, kind: "binding" }
			: undefined;
	}
	return object.kind === "object"
		? { display: `${object.display}.${property}`, kind: "object" }
		: undefined;
}

function callPath(file: SemanticFile, node: ESTree.Node): string | undefined {
	if (node.type !== "MemberExpression") return undefined;
	const property = memberPropertyName(node);
	if (property === undefined) return undefined;
	const object = primordialReference(file, node.object);
	return object === undefined ? undefined : `${object.display}.${property}`;
}

function reflectedTarget(
	file: SemanticFile,
	call: ESTree.CallExpression,
	path: string,
): PrimordialReference | undefined {
	const argument = call.arguments[0];
	if (argument === undefined || argument.type === "SpreadElement") return undefined;
	const target = primordialReference(file, argument);
	if (target?.kind === "object") return target;

	if (
		(target?.display === "globalThis" ||
			(argument.type === "Identifier" &&
				globalIdentifier(file, argument) === "globalThis")) &&
		(path === "Object.defineProperty" ||
			path === "Reflect.defineProperty" ||
			path === "Reflect.set" ||
			path === "Reflect.deleteProperty")
	) {
		const key = call.arguments[1];
		if (key !== undefined && key.type !== "SpreadElement") {
			const name = literalPropertyName(key);
			if (name !== undefined && protectedBindings.has(name)) {
				return { display: `globalThis.${name}`, kind: "binding" };
			}
		}
	}
	return undefined;
}

const reflectedMutators = new Set([
	"Object.assign",
	"Object.defineProperty",
	"Object.defineProperties",
	"Object.setPrototypeOf",
	"Reflect.defineProperty",
	"Reflect.deleteProperty",
	"Reflect.set",
	"Reflect.setPrototypeOf",
]);

const mutatingMethods = new Set([
	"Array.prototype.copyWithin",
	"Array.prototype.fill",
	"Array.prototype.pop",
	"Array.prototype.push",
	"Array.prototype.reverse",
	"Array.prototype.shift",
	"Array.prototype.sort",
	"Array.prototype.splice",
	"Array.prototype.unshift",
	"Object.prototype.__defineGetter__",
	"Object.prototype.__defineSetter__",
]);

function diagnostic(
	file: SemanticFile,
	node: ESTree.Node,
	target: PrimordialReference,
	operation: string,
): CompilerDiagnostic {
	const line = node.loc?.start.line ?? 1;
	const column = node.loc?.start.column ?? 0;
	return {
		code: "primordial.mutation",
		severity: "warning",
		message: `${operation} targets locked primordial ${target.display}; execution will throw TypeError`,
		path: file.path,
		line,
		column,
		siteId: sourceSiteId(file.path, line, column, "primordial.mutation"),
	};
}

/** Sound, intentionally incomplete source diagnostics; runtime enforcement is complete. */
export function collectPrimordialMutationDiagnostics(
	program: SemanticProgram,
	world: WorldFacts,
): Array<CompilerDiagnostic> {
	if (world.primordialPolicy !== "locked") return [];
	const diagnostics: Array<CompilerDiagnostic> = [];
	for (const file of program.files) {
		traverseEstree(file.ast.body, (node) => {
			if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
				const target = mutationTarget(
					file,
					node.type === "AssignmentExpression" ? node.left : node.argument,
				);
				if (target !== undefined) {
					diagnostics.push(diagnostic(file, node, target, "assignment"));
				}
			} else if (node.type === "UnaryExpression" && node.operator === "delete") {
				const target = mutationTarget(file, node.argument);
				if (target !== undefined) {
					diagnostics.push(diagnostic(file, node, target, "delete"));
				}
			} else if (node.type === "FunctionDeclaration" && node.id !== null) {
				const binding = globalIdentifier(file, node.id);
				if (binding !== undefined) {
					diagnostics.push(
						diagnostic(file, node, { display: binding, kind: "binding" }, "declaration"),
					);
				}
			} else if (node.type === "VariableDeclarator" && node.init !== null) {
				const binding = globalIdentifier(file, node.id);
				if (binding !== undefined) {
					diagnostics.push(
						diagnostic(file, node, { display: binding, kind: "binding" }, "initializer"),
					);
				}
			} else if (node.type === "CallExpression") {
				const callee = node.callee as ESTree.Node;
				const path = callPath(file, callee);
				if (path !== undefined && reflectedMutators.has(path)) {
					const target = reflectedTarget(file, node, path);
					if (target !== undefined) {
						diagnostics.push(diagnostic(file, node, target, path));
					}
				} else if (
					path !== undefined &&
					mutatingMethods.has(path) &&
					callee.type === "MemberExpression"
				) {
					const target = primordialReference(file, callee.object);
					if (target?.kind === "object") {
						diagnostics.push(diagnostic(file, node, target, path));
					}
				}
			}
		});
	}
	return diagnostics.sort(compareCompilerDiagnostics);
}
