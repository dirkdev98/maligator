import type { ESTree } from "meriyah";
import { forEachEstreeChild } from "./estree-traversal.ts";
import type {
	Binding,
	Scope,
	SemanticFile,
	SemanticProgram,
} from "./semantic-analysis.ts";

type SourceFunction =
	| ESTree.FunctionDeclaration
	| ESTree.FunctionExpression
	| ESTree.ArrowFunctionExpression;

interface SourceSnapshot {
	readonly contents: string;
	readonly moduleKey: string;
	readonly portability: "portable" | "checkout";
	readonly goal: "script" | "module";
	readonly commonjs: boolean;
}

export type SourceFunctionOrigin =
	| {
			readonly status: "unknown";
			readonly reason: string;
	  }
	| {
			readonly status: "captured";
			readonly source: SourceSnapshot;
			readonly portability: "portable" | "checkout";
			readonly declaration: string;
			readonly start: number;
			readonly end: number;
			readonly strict: boolean;
			readonly kind: SourceFunction["type"] | "Program";
			readonly async: boolean;
			readonly generator: boolean;
			readonly bindings: ReadonlyArray<string>;
			readonly classSource?: string;
	  };

export interface SourceFunctionOriginOptions {
	/** Unique resolved-module keys from the build owner; physical paths are the fallback. */
	readonly moduleKeys?: ReadonlyMap<string, string>;
}

export interface SourceFunctionOrigins {
	get(file: SemanticFile, node: ESTree.Node): SourceFunctionOrigin | undefined;
	call(file: SemanticFile, node: ESTree.Node): number | undefined;
	callSites(): ReadonlyArray<SourceCallSite>;
}

export interface SourceCallSite {
	readonly owner: SourceFunctionOrigin | undefined;
	readonly kind: "call" | "construct" | "super" | "tagged-template";
	readonly start: number | undefined;
	readonly end: number | undefined;
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly lowered: boolean;
}

/**
 * A function or class named by its syntactic position inside its container: the
 * nearest enclosing function or class, or the module. Siblings that share a role
 * are told apart by their source order, so every name is unique within its module.
 */
interface NameNode {
	readonly role: Role;
	readonly container: NameNode | undefined;
	path?: ReadonlyArray<Role>;
}

type Role = ReadonlyArray<unknown>;

interface FunctionDraft {
	readonly source: SourceSnapshot;
	readonly name: NameNode;
	readonly parent: FunctionDraft | undefined;
	readonly node: SourceFunction | ESTree.Program;
	readonly start: number | undefined;
	readonly end: number | undefined;
	readonly strict: boolean;
	dynamic: boolean;
	readonly references: Set<Binding>;
	readonly async: boolean;
	readonly generator: boolean;
	readonly classSource?: string;
	origin?: SourceFunctionOrigin;
}

interface ClassContext {
	readonly name: NameNode;
	readonly source: string | undefined;
}

function isFunction(node: ESTree.Node): node is SourceFunction {
	return (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
	);
}

/** `a.b.c`, `this.x` or `a["b"]`: an access path that names the same place in every edit. */
function accessPath(node: ESTree.Node): string | undefined {
	switch (node.type) {
		case "Identifier":
			return node.name;
		case "ThisExpression":
			return "this";
		case "Super":
			return "super";
		case "MemberExpression": {
			const object = accessPath(node.object);
			if (object === undefined) return undefined;
			const property = propertyName(node.property, node.computed);
			return property === undefined ? undefined : `${object}.${property}`;
		}
		default:
			return undefined;
	}
}

function propertyName(key: ESTree.Node | null, computed: boolean): string | undefined {
	if (key === null) return undefined;
	if (!computed && key.type === "Identifier") return key.name;
	if (!computed && key.type === "PrivateIdentifier") return `#${key.name}`;
	if (
		key.type === "Literal" &&
		(typeof key.value === "string" || typeof key.value === "number")
	)
		return JSON.stringify(String(key.value));
	return undefined;
}

/**
 * Where the expression at `stack[index]` sits, described by its syntactic
 * position: the binding, assignment target, property, element or call argument
 * it initializes. Object literal and array positions include their own position.
 */
function positionRole(
	stack: ReadonlyArray<ESTree.Node>,
	index: number,
): Role | undefined {
	const node = stack[index]!;
	const parent = stack[index - 1];
	switch (parent?.type) {
		case "VariableDeclarator":
			return parent.init === node && parent.id.type === "Identifier"
				? ["binding", parent.id.name]
				: undefined;
		case "AssignmentExpression":
			return parent.right === node && parent.operator === "="
				? ["assignment", accessPath(parent.left) ?? null]
				: undefined;
		case "Property":
			return parent.value === node
				? [
						"property",
						parent.method ? "method" : parent.kind,
						propertyName(parent.key, parent.computed) ?? null,
						positionRole(stack, index - 2) ?? null,
					]
				: undefined;
		case "ArrayExpression":
			return [
				"element",
				parent.elements.indexOf(node as ESTree.Expression),
				positionRole(stack, index - 1) ?? null,
			];
		case "CallExpression":
		case "NewExpression": {
			const argument = parent.arguments.indexOf(node as ESTree.Expression);
			return argument < 0
				? undefined
				: [
						"argument",
						parent.type === "NewExpression" ? "new" : "call",
						accessPath(parent.callee) ?? null,
						argument,
					];
		}
		case "ReturnStatement":
			return ["return"];
		case "ArrowFunctionExpression":
			return parent.body === node ? ["return"] : undefined;
		default:
			return undefined;
	}
}

/** The role of the function or class at the top of `stack` within its container. */
function nameRole(stack: ReadonlyArray<ESTree.Node>): Role {
	const index = stack.length - 1;
	const node = stack[index]!;
	const parent = stack[index - 1];
	if (node.type === "FunctionDeclaration" && node.id !== null)
		return ["declaration", node.id.name];
	if (node.type === "ClassDeclaration" && node.id !== null)
		return ["class", node.id.name];
	if (parent?.type === "MethodDefinition" && parent.value === node) {
		const key = parent.key;
		return key !== null &&
			!parent.computed &&
			(key.type === "Identifier" || key.type === "PrivateIdentifier")
			? ["method", parent.static ? "static" : "instance", parent.kind, key.type, key.name]
			: [
					"method",
					parent.static ? "static" : "instance",
					parent.kind,
					"key",
					propertyName(key, parent.computed) ?? null,
				];
	}
	if (parent?.type === "PropertyDefinition" && parent.value === node)
		return [
			"field",
			parent.static ? "static" : "instance",
			propertyName(parent.key, parent.computed) ?? null,
		];
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier")
		return ["binding", parent.id.name];
	if (parent?.type === "ExportDefaultDeclaration") return ["default-export"];
	if (node.type === "FunctionExpression" && node.id !== null)
		return ["expression", node.id.name];
	if (node.type === "ClassExpression" && node.id !== null)
		return ["class-expression", node.id.name];
	return positionRole(stack, index) ?? ["anonymous"];
}

/**
 * Resolve a module's names in pre-order, so containers resolve before their
 * members. The first sibling with a role keeps it; later ones append their
 * ordinal among the siblings that share it.
 */
function resolveNames(names: ReadonlyArray<NameNode>): void {
	const seen = new Map<NameNode | undefined, Map<string, number>>();
	for (const name of names) {
		let roles = seen.get(name.container);
		if (roles === undefined)
			seen.set(name.container, (roles = new Map<string, number>()));
		const text = JSON.stringify(name.role);
		const ordinal = roles.get(text) ?? 0;
		roles.set(text, ordinal + 1);
		name.path = [
			...(name.container?.path ?? []),
			ordinal === 0 ? name.role : [...name.role, ["ordinal", ordinal]],
		];
	}
}

function lineOffsets(contents: string): ReadonlyArray<number> {
	const offsets = [0];
	for (let index = 0; index < contents.length; index++) {
		const code = contents.charCodeAt(index);
		if (code === 13 && contents.charCodeAt(index + 1) === 10) index++;
		if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) {
			offsets.push(index + 1);
		}
	}
	return offsets;
}

function sourceOffset(
	offsets: ReadonlyArray<number>,
	position: { line: number; column: number } | undefined,
): number | undefined {
	if (position === undefined) return undefined;
	const line = offsets[position.line - 1];
	return line === undefined ? undefined : line + position.column;
}

function isOwnedBy(owner: FunctionDraft | undefined, fn: FunctionDraft): boolean {
	for (let current = owner; current !== undefined; current = current.parent) {
		if (current === fn) return true;
	}
	return false;
}

/** Capture before lowering mutates bindings; only compact immutable records escape into Core. */
export function collectSourceFunctionOrigins(
	semantic: SemanticProgram,
	options: SourceFunctionOriginOptions,
): SourceFunctionOrigins {
	const drafts = new Map<SemanticFile, Map<ESTree.Node, FunctionDraft>>();
	const bindingRecords = new Map<
		Binding,
		{
			file: SemanticFile;
			owner: FunctionDraft | undefined;
			key: string | undefined;
			portability: "portable" | "checkout";
		}
	>();
	const scopes: Array<{
		file: SemanticFile;
		source: SourceSnapshot;
		offsets: ReadonlyArray<number>;
		owners: Map<ESTree.Node, FunctionDraft | undefined>;
		classes: Map<ESTree.Node, ClassContext | undefined>;
	}> = [];
	const moduleKeys = new Set<string>();
	const calls: Array<{
		file: SemanticFile;
		node: ESTree.Node;
		owner: FunctionDraft | undefined;
		kind: SourceCallSite["kind"];
		start: number | undefined;
		end: number | undefined;
		lowered: boolean;
	}> = [];
	const callIds = new Map<ESTree.Node, number>();

	for (const file of semantic.files) {
		const supplied = options.moduleKeys?.get(file.path);
		const moduleKey = supplied ?? file.path;
		if (moduleKey.length === 0 || moduleKeys.has(moduleKey)) {
			throw new Error("Source origins require unique nonempty resolved-module keys");
		}
		moduleKeys.add(moduleKey);
		const source: SourceSnapshot = Object.freeze({
			contents: file.contents,
			moduleKey,
			portability: supplied === undefined ? "checkout" : "portable",
			goal: file.type,
			commonjs: file.commonjs === true,
		});
		const offsets = lineOffsets(source.contents);
		const functions = new Map<ESTree.Node, FunctionDraft>();
		const owners = new Map<ESTree.Node, FunctionDraft | undefined>();
		const classes = new Map<ESTree.Node, ClassContext | undefined>();
		const scopeNodes = new Set(file.scopes.map((scope) => scope.node));
		drafts.set(file, functions);
		scopes.push({ file, source, offsets, owners, classes });
		const names: Array<NameNode> = [];
		const stack: Array<ESTree.Node> = [];
		// The module body owns the sites outside every function, also of a CommonJS
		// module, whose wrapper function exists only after lowering.
		const moduleBody: FunctionDraft = {
			source,
			name: { role: ["module"], container: undefined, path: [["module"]] },
			parent: undefined,
			node: file.ast,
			start: 0,
			end: source.contents.length,
			strict: file.strict,
			dynamic: file.evalDirect === true || file.hasDirectEval.has(file.ast),
			references: new Set(),
			async: false,
			generator: false,
		};
		functions.set(file.ast, moduleBody);
		const visit = (
			node: ESTree.Node,
			owner: FunctionDraft | undefined,
			container: NameNode | undefined,
			classContext: ClassContext | undefined,
		): void => {
			stack.push(node);
			if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
				const start = sourceOffset(offsets, node.loc?.start);
				const end = sourceOffset(offsets, node.loc?.end);
				container = { role: nameRole(stack), container };
				names.push(container);
				classContext = {
					name: container,
					source:
						start === undefined || end === undefined
							? undefined
							: source.contents.slice(start, end),
				};
			}
			if (isFunction(node)) {
				container = { role: nameRole(stack), container };
				names.push(container);
				owner = {
					source,
					name: container,
					parent: owner,
					node,
					start: sourceOffset(offsets, node.loc?.start),
					end: sourceOffset(offsets, node.loc?.end),
					strict:
						(node.body === null || node.body === undefined
							? undefined
							: file.nodeToScope.get(node.body)?.strict) ?? file.strict,
					dynamic: file.evalDirect === true || file.hasDirectEval.has(node),
					references: new Set(),
					async: node.async === true,
					generator: node.type !== "ArrowFunctionExpression" && node.generator === true,
					classSource: classContext?.source,
				};
				functions.set(node, owner);
			}
			if (scopeNodes.has(node)) {
				owners.set(node, owner);
				classes.set(node, classContext);
			}
			if (
				node.type === "CallExpression" ||
				node.type === "NewExpression" ||
				node.type === "TaggedTemplateExpression"
			) {
				callIds.set(node, calls.length);
				const start = sourceOffset(offsets, node.loc?.start);
				const end = sourceOffset(offsets, node.loc?.end);
				calls.push({
					file,
					node,
					owner,
					kind:
						node.type === "NewExpression"
							? "construct"
							: node.type === "TaggedTemplateExpression"
								? "tagged-template"
								: (node.callee as ESTree.Node).type === "Super"
									? "super"
									: "call",
					start:
						start === undefined || owner?.start === undefined
							? undefined
							: start - owner.start,
					end:
						end === undefined || owner?.start === undefined
							? undefined
							: end - owner.start,
					lowered: false,
				});
			}
			if (file.withDynamicNodes.has(node)) {
				if (owner === undefined) moduleBody.dynamic = true;
				for (let fn = owner; fn !== undefined; fn = fn.parent) fn.dynamic = true;
			}
			const binding = file.nodeToBinding.get(node);
			if (binding !== undefined) {
				moduleBody.references.add(binding);
				for (let fn = owner; fn !== undefined; fn = fn.parent) fn.references.add(binding);
			}
			forEachEstreeChild(node, (child) => visit(child, owner, container, classContext));
			stack.pop();
		};
		visit(file.ast, undefined, undefined, undefined);
		resolveNames(names);
	}

	for (const { file, source, offsets, owners, classes } of scopes) {
		for (const scope of file.scopes) {
			const owner = owners.get(scope.node);
			const classContext = classes.get(scope.node);
			const offset = sourceOffset(offsets, scope.node.loc?.start);
			const scopeRole =
				scope.node.type === "Program"
					? "module"
					: scope.node === owner?.node
						? "parameters"
						: scope.node === owner?.node.body
							? "body"
							: scope.node.type === "ClassDeclaration" && classContext !== undefined
								? [
										"class",
										JSON.stringify([source.moduleKey, ...classContext.name.path!]),
									]
								: offset === undefined
									? undefined
									: [scope.node.type, offset - (owner?.start ?? 0)];
			const knownOwner = owners.has(scope.node) && scopeRole !== undefined;
			let dynamic = false;
			for (let parent: Scope | null = scope; parent !== null; parent = parent.parent) {
				if (parent.dynamic === true) dynamic = true;
			}
			for (const binding of scope.bindings) {
				bindingRecords.set(binding, {
					file,
					owner,
					portability: source.portability,
					key:
						knownOwner && binding.imported !== true
							? JSON.stringify([
									source.moduleKey,
									source.portability,
									source.goal,
									source.commonjs,
									owner === undefined
										? null
										: JSON.stringify([source.moduleKey, ...owner.name.path!]),
									scopeRole,
									binding.name,
									binding.kind,
									binding.implicit ?? null,
									binding.undeclared === true,
									binding.immutableSelfReference === true,
									dynamic,
								])
							: undefined,
				});
			}
		}
	}

	const result: SourceFunctionOrigins = {
		call(file, node) {
			const id = callIds.get(node);
			if (id === undefined || calls[id]!.file !== file) return undefined;
			calls[id]!.lowered = true;
			return id;
		},
		callSites() {
			return Object.freeze(
				calls.map((call) =>
					Object.freeze({
						owner:
							call.owner === undefined
								? undefined
								: result.get(call.file, call.owner.node),
						kind: call.kind,
						start: call.start,
						end: call.end,
						file: call.file.path,
						line: call.node.loc?.start.line ?? 0,
						column: call.node.loc?.start.column ?? 0,
						lowered: call.lowered,
					}),
				),
			);
		},
		get(file, node) {
			const draft = drafts.get(file)?.get(node);
			if (draft === undefined) return undefined;
			if (draft.origin !== undefined) return draft.origin;
			const missing = (reason: string): SourceFunctionOrigin => {
				const origin = Object.freeze({ status: "unknown" as const, reason });
				draft.origin = origin;
				return origin;
			};
			for (
				let parent: FunctionDraft | undefined = draft;
				parent !== undefined;
				parent = parent.parent
			) {
				if (parent.dynamic) return missing("dynamic-scope");
			}
			if (draft.start === undefined || draft.end === undefined)
				return missing("missing-source-span");
			const bindings: Array<string> = [];
			let portability = draft.source.portability;
			for (const binding of draft.references) {
				const record = bindingRecords.get(binding);
				// The module body's source covers every binding its module declares.
				if (
					draft.node === file.ast
						? record?.file === file
						: isOwnedBy(record?.owner, draft)
				)
					continue;
				if (record?.key === undefined) return missing("unmapped-binding-owner");
				if (record.portability === "checkout") portability = "checkout";
				bindings.push(record.key);
			}
			const origin: SourceFunctionOrigin = Object.freeze({
				status: "captured",
				source: draft.source,
				portability,
				declaration: JSON.stringify([draft.source.moduleKey, ...draft.name.path!]),
				start: draft.start,
				end: draft.end,
				strict: draft.strict,
				kind: draft.node.type,
				async: draft.async,
				generator: draft.generator,
				bindings: Object.freeze(bindings.sort()),
				...(draft.classSource === undefined ? {} : { classSource: draft.classSource }),
			});
			draft.origin = origin;
			return origin;
		},
	};
	return result;
}
