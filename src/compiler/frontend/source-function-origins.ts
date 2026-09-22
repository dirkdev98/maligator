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
			readonly status: "unknown" | "ambiguous";
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
			readonly kind: SourceFunction["type"];
			readonly async: boolean;
			readonly generator: boolean;
			readonly bindings: ReadonlyArray<string>;
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

interface FunctionDraft {
	readonly source: SourceSnapshot;
	readonly declaration: string | undefined;
	readonly path: ReadonlyArray<ReadonlyArray<string>> | undefined;
	readonly parent: FunctionDraft | undefined;
	readonly node: SourceFunction;
	readonly start: number | undefined;
	readonly end: number | undefined;
	readonly strict: boolean;
	dynamic: boolean;
	readonly references: Set<Binding>;
	readonly async: boolean;
	readonly generator: boolean;
	origin?: SourceFunctionOrigin;
}

function isFunction(node: ESTree.Node): node is SourceFunction {
	return (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
	);
}

function declarationRole(
	node: SourceFunction,
	parent: ESTree.Node | undefined,
): ReadonlyArray<string> | undefined {
	if (node.type === "FunctionDeclaration" && node.id !== null) {
		return ["declaration", node.id.name];
	}
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") {
		return ["binding", parent.id.name];
	}
	if (parent?.type === "ExportDefaultDeclaration") return ["default-export"];
	if (node.type === "FunctionExpression" && node.id !== null) {
		return ["expression", node.id.name];
	}
	return undefined;
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
	const candidates = new Map<string, number>();
	const bindingRecords = new Map<
		Binding,
		{
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
		const scopeNodes = new Set(file.scopes.map((scope) => scope.node));
		drafts.set(file, functions);
		scopes.push({ file, source, offsets, owners });
		const visit = (
			node: ESTree.Node,
			parent: ESTree.Node | undefined,
			owner: FunctionDraft | undefined,
			inClass: boolean,
		): void => {
			if (isFunction(node)) {
				const role = declarationRole(node, parent);
				const path =
					role === undefined ||
					inClass ||
					(owner !== undefined && owner.path === undefined)
						? undefined
						: [...(owner?.path ?? []), role];
				const declaration =
					path === undefined ? undefined : JSON.stringify([source.moduleKey, ...path]);
				if (declaration !== undefined) {
					candidates.set(declaration, (candidates.get(declaration) ?? 0) + 1);
				}
				owner = {
					source,
					declaration,
					path,
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
				};
				functions.set(node, owner);
			}
			if (scopeNodes.has(node)) owners.set(node, owner);
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
				for (let fn = owner; fn !== undefined; fn = fn.parent) fn.dynamic = true;
			}
			const binding = file.nodeToBinding.get(node);
			if (binding !== undefined) {
				for (let fn = owner; fn !== undefined; fn = fn.parent) fn.references.add(binding);
			}
			const classContext =
				inClass || node.type === "ClassDeclaration" || node.type === "ClassExpression";
			forEachEstreeChild(node, (child) => visit(child, node, owner, classContext));
		};
		visit(file.ast, undefined, undefined, false);
	}

	for (const { file, source, offsets, owners } of scopes) {
		for (const scope of file.scopes) {
			const owner = owners.get(scope.node);
			const offset = sourceOffset(offsets, scope.node.loc?.start);
			const scopeRole =
				scope.node.type === "Program"
					? "module"
					: scope.node === owner?.node
						? "parameters"
						: scope.node === owner?.node.body
							? "body"
							: offset === undefined
								? undefined
								: [scope.node.type, offset - (owner?.start ?? 0)];
			const knownOwner =
				owners.has(scope.node) &&
				scopeRole !== undefined &&
				(owner === undefined ||
					(owner.declaration !== undefined && candidates.get(owner.declaration) === 1));
			let dynamic = false;
			for (let parent: Scope | null = scope; parent !== null; parent = parent.parent) {
				if (parent.dynamic === true) dynamic = true;
			}
			for (const binding of scope.bindings) {
				bindingRecords.set(binding, {
					owner,
					portability: source.portability,
					key:
						knownOwner && binding.imported !== true
							? JSON.stringify([
									source.moduleKey,
									source.portability,
									source.goal,
									source.commonjs,
									owner?.declaration ?? null,
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
			const missing = (
				status: "unknown" | "ambiguous",
				reason: string,
			): SourceFunctionOrigin => {
				const origin = Object.freeze({ status, reason });
				draft.origin = origin;
				return origin;
			};
			if (draft.declaration === undefined)
				return missing("unknown", "unsupported-lexical-owner");
			for (
				let parent: FunctionDraft | undefined = draft;
				parent !== undefined;
				parent = parent.parent
			) {
				if (
					parent.declaration !== undefined &&
					candidates.get(parent.declaration) !== 1
				) {
					return missing("ambiguous", "duplicate-declaration");
				}
				if (parent.dynamic) return missing("unknown", "dynamic-scope");
			}
			if (draft.start === undefined || draft.end === undefined)
				return missing("unknown", "missing-source-span");
			const bindings: Array<string> = [];
			let portability = draft.source.portability;
			for (const binding of draft.references) {
				const record = bindingRecords.get(binding);
				if (isOwnedBy(record?.owner, draft)) continue;
				if (record?.key === undefined)
					return missing("unknown", "unmapped-binding-owner");
				if (record.portability === "checkout") portability = "checkout";
				bindings.push(record.key);
			}
			const origin: SourceFunctionOrigin = Object.freeze({
				status: "captured",
				source: draft.source,
				portability,
				declaration: draft.declaration,
				start: draft.start,
				end: draft.end,
				strict: draft.strict,
				kind: draft.node.type,
				async: draft.async,
				generator: draft.generator,
				bindings: Object.freeze(bindings.sort()),
			});
			draft.origin = origin;
			return origin;
		},
	};
	return result;
}
