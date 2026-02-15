import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parse as meriyahParse } from "meriyah";
import type { ESTree } from "meriyah";

export interface CreateScope {
	createScope(node: ESTree.Node, type: ScopeInformation["type"]): ScopeInformation;
}

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

	debug() {
		const scopes = this.rootScope.debug();

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
	public type: "global" | "script-global" | "script" | "module" | "function" | "block";
	public node: ESTree.Node;
	public bindings: Map<string, Binding> = new Map();
	public parent: ScopeInformation | null = null;
	public children: Array<ScopeInformation> = [];

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

	debug(): Array<string> {
		const str = [
			`- Scope[${this.type}]: ${this.node.loc?.source ?? "[unknown].js"}:${this.node.loc?.start?.line ?? "-"}:${this.node.loc?.start?.column ?? "-"}`,
		];

		for (const child of this.children) {
			const result = child.debug();
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
	public kind: "let" | "const" | "var" | "param";
	public isCaptured: boolean = false;
	public isMutated: boolean = true;

	constructor(name: string, definition: ESTree.Node, kind: Binding["kind"]) {
		this.name = name;
		this.definition = definition;
		this.kind = kind;
	}

	canBeGloballyHoisted() {
		return !this.isMutated;
	}
}
