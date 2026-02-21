import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parse as meriyahParse } from "meriyah";
import type { ESTree } from "meriyah";

export interface CreateScope {
	createScope(node: ESTree.Node, type: ScopeInformation["type"]): ScopeInformation;
}

type DebugArgs = {
	withBindings?: boolean;
};

export class ProgramInformation {
	// Global Environment (JSON, Math, Object, etc);
	public rootScope: ScopeInformation;
	// Shared parent for every script scope.
	public scriptScope: ScopeInformation;

	public modules: Map<string, ModuleInformation> = new Map();
	public scripts: Map<string, ScriptInformation> = new Map();

	public scopes: Map<ESTree.Node, ScopeInformation> = new Map();

	constructor() {
		this.rootScope = new ScopeInformation(
			this,
			{ type: "global" as "Program", sourceType: "script", body: [] },
			"global",
		);

		this.scriptScope = this.rootScope.createScope(
			{
				type: "global-script" as "Program",
				sourceType: "script",
				body: [],
			},
			"script-global",
		);
	}

	*iterateProgramParts() {
		for (const script of this.scripts.values()) {
			yield script;
		}
		for (const module of this.modules.values()) {
			yield module;
		}
	}

	loadModule(filePath: string) {
		const resolvedPath = path.resolve(filePath);
		const txt = readFileSync(resolvedPath, "utf-8");
		const estree = meriyahParse(txt, {
			sourceType: "module",
			next: true,
			loc: true,
			source: resolvedPath,
			impliedStrict: true,

			raw: false,

			preserveParens: false,
			lexical: false,
			jsx: false,
			validateRegex: false,
		});

		const module = new ModuleInformation(this, estree);
		this.modules.set(resolvedPath, module);
	}

	loadScript(filePath: string, { nonStrict = false }: { nonStrict?: boolean } = {}) {
		const resolvedPath = path.resolve(filePath);
		const txt = readFileSync(resolvedPath, "utf-8");
		const estree = meriyahParse(txt, {
			sourceType: "script",
			next: true,
			loc: true,
			source: resolvedPath,
			impliedStrict: !nonStrict,

			raw: false,

			preserveParens: false,
			lexical: false,
			jsx: false,
			validateRegex: false,
		});

		const script = new ScriptInformation(this, estree, nonStrict);
		this.scripts.set(resolvedPath, script);
	}

	createScope(node: ESTree.Node, type: ScopeInformation["type"]) {
		return this.rootScope.createScope(node, type);
	}

	addScope(node: ESTree.Node, scope: ScopeInformation) {
		this.scopes.set(node, scope);
	}

	getScopeForNode(node: ESTree.Node) {
		if (this.scopes.has(node)) {
			return this.scopes.get(node)!;
		}

		const scriptOrModule =
			this.scripts.get(node.loc?.source ?? "___") ??
			this.modules.get(node.loc?.source ?? "___");

		if (!scriptOrModule) {
			return this.rootScope;
		}

		const nodeInNode = (node: ESTree.Node, potentialParent: ESTree.Node) => {
			const parentStart = potentialParent.loc!.start;
			const parentEnd = potentialParent.loc!.end;
			const nodeStart = node.loc!.start;
			const nodeEnd = node.loc!.end;

			const startsBeforeOrAt =
				parentStart.line < nodeStart.line ||
				(parentStart.line === nodeStart.line && parentStart.column <= nodeStart.column);
			const endsAfterOrAt =
				parentEnd.line > nodeEnd.line ||
				(parentEnd.line === nodeEnd.line && parentEnd.column >= nodeEnd.column);

			return startsBeforeOrAt && endsAfterOrAt;
		};

		const recurse = (scope: ScopeInformation) => {
			for (const child of scope.children) {
				if (nodeInNode(node, child.node)) {
					return recurse(child);
				}
			}

			return scope;
		};

		const result = recurse(scriptOrModule.rootScope);
		if (result) {
			this.scopes.set(node, result);
			return result;
		}

		throw new Error(`Can't find the scope for ${JSON.stringify(node.loc, null, 2)}`);
	}

	debug(opts: DebugArgs = {}) {
		const scopes = this.rootScope.debug(opts);

		return scopes.join("\n");
	}
}

export class ModuleInformation {
	public program: ProgramInformation;
	public node: ESTree.Program;
	public rootScope: ScopeInformation;

	constructor(program: ProgramInformation, node: ESTree.Program) {
		this.program = program;
		this.node = node;
		this.rootScope = this.program.createScope(node, "module");
	}

	createScope(node: ESTree.Node, type: ScopeInformation["type"]) {
		return this.rootScope.createScope(node, type);
	}

	addScope(node: ESTree.Node, scope: ScopeInformation) {
		return this.program.addScope(node, scope);
	}
}

export class ScriptInformation {
	public program: ProgramInformation;
	public node: ESTree.Program;
	public rootScope: ScopeInformation;
	public strict: boolean;

	static isStrictNode(node: { body: Array<ESTree.Node> }) {
		return (
			!!node.body[0] &&
			"directive" in node.body[0] &&
			node.body[0].directive === "use strict"
		);
	}

	constructor(
		program: ProgramInformation,
		node: ESTree.Program,
		nonStrict: boolean = false,
	) {
		this.program = program;
		this.node = node;
		this.rootScope = this.program.scriptScope.createScope(node, "script");
		this.strict = !nonStrict || ScriptInformation.isStrictNode(node);
	}

	createScope(node: ESTree.Node, type: ScopeInformation["type"]) {
		return this.rootScope.createScope(node, type);
	}

	addScope(node: ESTree.Node, scope: ScopeInformation) {
		return this.program.addScope(node, scope);
	}
}

export class ScopeInformation {
	public program: ProgramInformation | ModuleInformation | ScriptInformation;
	public type:
		| "global"
		| "script-global"
		| "script"
		| "module"
		| "function"
		| "class"
		| "block"
		| "static-block"
		| "with-block"
		| "switch-block"
		| "for-loop";
	public node: ESTree.Node;
	public bindings: Map<string, Binding> = new Map();
	public parent: ScopeInformation | null = null;
	public children: Array<ScopeInformation> = [];

	private usedArguments = false;

	constructor(
		program: ScopeInformation["program"],
		node: ESTree.Node,
		type: ScopeInformation["type"],
	) {
		this.program = program;
		this.node = node;
		this.type = type;
	}

	createScope(node: ESTree.Node, type: ScopeInformation["type"]) {
		const childScope = new ScopeInformation(this.program, node, type);
		childScope.parent = this;

		this.children.push(childScope);
		this.program.addScope(node, childScope);

		return childScope;
	}

	createBinding(
		name: string | { name: string; isPrivate: boolean },
		definition: ESTree.Node,
		kind: Binding["kind"],
	): Binding {
		if (
			(kind === "var" || kind === "function") &&
			this.type !== "function" &&
			this.type !== "module" &&
			this.type !== "script-global" &&
			this.type !== "static-block" &&
			this.parent
		) {
			return this.parent.createBinding(name, definition, kind);
		}

		// TODO: is it a syntax error when duplicate binding names are found?

		const binding = new Binding(name, definition, kind);
		this.bindings.set(binding.name, binding);

		return binding;
	}

	getBinding(name: string | { name: string }): Binding | null {
		const n = typeof name === "string" ? name : name.name;
		const res = this.bindings.get(n);
		if (res) {
			return res;
		}

		if (this.parent) {
			return this.parent.getBinding(name);
		}

		return null;
	}

	usedFunctionArgumentsObject() {
		if (this.type === "function") {
			this.usedArguments = true;
			return;
		}

		this.parent?.usedFunctionArgumentsObject();
	}

	debug(opts: DebugArgs = {}): Array<string> {
		const str = [
			`- Scope[${this.type}]: ${this.node.loc?.source ?? "[unknown].js"}:${this.node.loc?.start?.line ?? "-"}:${this.node.loc?.start?.column ?? "-"}`,
		];

		if (this.usedArguments) {
			str[0] += " (arguments=1)";
		}

		if (opts.withBindings) {
			for (const binding of this.bindings.values()) {
				const result = binding.debug();
				for (const row of result) {
					str.push(`  >${row}`);
				}
			}
		}

		for (const child of this.children) {
			const result = child.debug(opts);
			for (const row of result) {
				str.push(`  ${row}`);
			}
		}

		return str;
	}
}

class Binding {
	public name: string;
	public definition: ESTree.Node;
	public isPrivate: boolean = false;
	public kind:
		| "import"
		| "label"
		| "let"
		| "const"
		| "var"
		| "function"
		| "class"
		| "param";
	public isCaptured: boolean = false;
	public isMutated: boolean = true;
	public updateNodes: Array<ESTree.Node> = [];
	public readNodes: Array<ESTree.Node> = [];

	constructor(
		name: string | { name: string; isPrivate: boolean },
		definition: ESTree.Node,
		kind: Binding["kind"],
	) {
		this.name = typeof name === "string" ? name : name.name;
		this.definition = definition;
		this.isPrivate = typeof name === "string" ? false : name.isPrivate;
		this.kind = kind;
	}

	canBeGloballyHoisted() {
		return !this.isMutated;
	}

	addUpdateUsage(node: ESTree.Node) {
		this.updateNodes.push(node);
	}

	addReadUsage(node: ESTree.Node) {
		this.readNodes.push(node);
	}

	debug() {
		let suffix = "";

		if (this.readNodes.length) {
			suffix += `->${this.readNodes.length}`;
		}

		if (this.updateNodes.length) {
			const s = `<-${this.updateNodes.length}`;

			if (suffix) {
				suffix = `${s}, ${suffix}`;
			} else {
				suffix = s;
			}
		}

		return [`- Binding[${this.kind}]: ${this.name}${suffix ? ` (${suffix})` : ""}`];
	}
}
