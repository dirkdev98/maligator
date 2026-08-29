import type { ESTree } from "meriyah";
import { debugEnabled, log } from "../../utils.ts";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import { forEachEstreeChild, traverseEstree } from "./estree-traversal.ts";
// Type-only: erasure removes this import, so the module graph is NOT pulled into
// the self-hostable compiler cone. The buildModuleGraph value-using entry lives
// in semantic-program.ts so this file stays runnable on MalVm.
import type { ModuleGraph } from "./module-graph.ts";
import { parseScript } from "./parser.ts";

export interface SemanticProgram {
	entrypointPath: string;
	files: Array<SemanticFile>;
	/**
	 * The module graph the program was built from (loader/graph phase). Absent
	 * for in-memory composition (analyzeSourceAndRunSemanticAnalysis).
	 */
	graph?: ModuleGraph;
}

export interface SemanticFile {
	type: "script" | "module";
	path: string;
	contents: string;
	strict: boolean;
	ast: ESTree.Program;

	/**
	 * A CommonJS module. Its top level is the body of a wrapper function
	 * `(module, exports, require, __filename, __dirname)`, so those names are
	 * predefined bindings and the program scope behaves like a function scope
	 * (top-level declarations are wrapper locals/captures, not globals).
	 */
	commonjs?: boolean;

	// Scripts do not yet fully share the global environment record, so
	//  bindings might reference outside of this semantic file.
	scopes: Array<Scope>;
	nodeToScope: Map<ESTree.Node, Scope>;
	nodeToBinding: Map<ESTree.Node, Binding>;

	/**
	 * Identifier nodes whose name resolution crosses a `with` statement's
	 * dynamic scope before reaching its static binding. The IR compiles these
	 * to a runtime check of the active with-object(s) (honoring
	 * `Symbol.unscopables`) with a fallback to the static binding. `with` is a
	 * strict-mode SyntaxError, so these only occur in sloppy code.
	 */
	withDynamicNodes: Set<ESTree.Node>;

	/**
	 * Implicit `arguments` identifier reads proven to be direct, non-escaping
	 * frame accesses. IR may read the frame count/value without constructing the
	 * arguments object. The map is populated only when every use of that binding
	 * is safe, so one mutation, escape, arrow capture, `with`, or eval use keeps
	 * the whole binding on the ordinary object path.
	 */
	staticArgumentsAccesses: Map<ESTree.Node, StaticArgumentsAccess>;

	/**
	 * Function-defining nodes (and the top-level Program) poisoned by a *direct*
	 * eval — `eval(...)` resolving to the global eval, not a shadowing local —
	 * anywhere in their lexical region. Direct eval can read and mutate every
	 * binding in scope, so it makes that function's locals dynamically
	 * addressable. The C3 rule disables escape / scalar-replacement /
	 * region analysis for any function in this set. A nested direct eval also
	 * poisons every enclosing function (it can reach their locals via the scope
	 * chain). Indirect eval — `(0, eval)(...)`, `globalThis.eval(...)` — cannot see
	 * locals and is deliberately NOT flagged. Query via `functionHasDirectEval`.
	 */
	hasDirectEval: Set<ESTree.Node>;
	/** Function units whose own variable environment can receive sloppy eval vars. */
	directEvalVariableEnvironments: Set<ESTree.Node>;
	/** This/new.target bindings conservatively captured for direct eval in arrows. */
	directEvalThisBindings: Map<ESTree.CallExpression, Binding>;
	directEvalNewTargetBindings: Map<ESTree.CallExpression, Binding>;
	/** The Program is a direct-eval entry and inherits caller frame context. */
	evalDirect?: boolean;
}

export type StaticArgumentsAccess =
	| { member: ESTree.MemberExpression; kind: "length" }
	| { member: ESTree.MemberExpression; kind: "index"; index: number };

export interface Scope {
	parent: Scope | null;
	node: ESTree.Node;

	strict: boolean;
	bindings: Array<Binding>;

	/**
	 * A `with` statement's object scope: it holds no static bindings but
	 * dynamically intercepts every name looked up through it at runtime.
	 */
	dynamic?: true;
}

type BindingKind = "var" | "let" | "const";

export interface Binding {
	kind: BindingKind;
	name: string;
	implicit?: "arguments" | "this" | "new.target";

	declarationNode?: ESTree.Node;
	usageNodes: Array<ESTree.Node>;

	undeclared?: true;
	scopedTo?: "local" | "captured" | "global";

	/**
	 * A named function expression's own-name binding (CreateImmutableBinding).
	 * It is initialized to the closure and reads normally, but is immutable:
	 * reassigning it is a silent no-op in sloppy code and a TypeError in strict
	 * code (unlike `const`, which always throws). The kind stays let/var for
	 * storage/TDZ/read; only the assignment path honors this flag.
	 */
	immutableSelfReference?: true;

	/** Annex B's var-scoped mirror for a sloppy block-level function binding. */
	annexBVarBinding?: Binding;

	/**
	 * An ES import binding. It aliases (shares storage with) the exporting
	 * module's binding, so the importing module must not give it its own
	 * uninitialized (TDZ) slot.
	 */
	imported?: true;
}

interface SemanticAnalysisCandidates {
	directEvalCalls: Array<ESTree.CallExpression>;
	hasImplicitArguments: boolean;
}

const semanticAnalysisWorkCounts = {
	directEvalCandidates: 0,
	staticArgumentsTraversals: 0,
};

/**
 * Util to dump the full scope + bindings for a program.
 */
export function debugSemanticProgram(program: SemanticProgram) {
	let output = "";
	const indent = "  ";

	for (const file of program.files) {
		output += `${file.path}\n`;

		let scopeIdx = 0;
		for (const scope of file.scopes) {
			const parentIdx = file.scopes.findIndex((s) => s === scope.parent);

			output += `${indent}Scope(${scopeIdx++} ${scope.node.type} (parent: ${parentIdx})\n`;

			for (const binding of scope.bindings) {
				output += `${indent}${indent}Binding(${binding.name} ${binding.kind} ${binding.scopedTo} ${binding.declarationNode?.type ?? "unknown"}) (usages: ${binding.usageNodes.length}, declared: ${!binding.undeclared}) \n`;
			}
		}
	}

	log.debug(output);

	return output;
}

/** Whether a Program begins with a "use strict" Directive Prologue. */
function hasUseStrictDirective(ast: ESTree.Program): boolean {
	for (const statement of ast.body) {
		if (
			statement.type !== "ExpressionStatement" ||
			statement.expression.type !== "Literal" ||
			typeof statement.expression.value !== "string"
		) {
			return false; // first non-string-literal statement ends the prologue
		}
		if (statement.expression.value === "use strict") {
			return true;
		}
	}
	return false;
}

export function parseEvalSource(
	contents: string,
	callerStrict: boolean,
	directEvalContext?: DirectEvalContext,
): Pick<SemanticFile, "type" | "strict" | "ast"> {
	const result = parseScript(contents, {
		strict: callerStrict,
		directEvalContext,
	});
	return !callerStrict && hasUseStrictDirective(result.ast)
		? { ...result, strict: true }
		: result;
}

/**
 * Run semantic analysis over in-memory source, optionally reusing an
 * existing parse. Used by tooling that composes sources without disk files.
 */
export function analyzeSourceAndRunSemanticAnalysis(
	contents: string,
	virtualPath: string,
	parsed?: Pick<SemanticFile, "type" | "strict" | "ast">,
	options: {
		eval?: {
			callerStrict: boolean;
			direct?: boolean;
			directEvalContext?: DirectEvalContext;
		};
	} = {},
): SemanticProgram {
	const program: SemanticProgram = {
		entrypointPath: virtualPath,
		files: [],
	};

	// Eval source strictness: strict iff the call is contained in strict code
	// (direct eval; indirect passes callerStrict=false) OR the source has a
	// "use strict" prologue. Otherwise sloppy (so `with`, sloppy global creation,
	// and the var/function-hoisting semantics come out right). meriyah parses a
	// directive'd scope strict regardless of impliedStrict; parseScript only
	// echoes the option, so detect the prologue and correct the flag. Non-eval
	// callers stay implied-strict.
	let parseResult: Pick<SemanticFile, "type" | "strict" | "ast">;
	if (parsed) {
		parseResult = parsed;
	} else if (options.eval) {
		parseResult = parseEvalSource(
			contents,
			options.eval.callerStrict,
			options.eval.directEvalContext,
		);
	} else {
		parseResult = parseScript(contents, { strict: true });
	}

	const file: SemanticFile = {
		path: virtualPath,
		contents,
		...parseResult,

		scopes: [],
		nodeToScope: new Map(),
		nodeToBinding: new Map(),
		withDynamicNodes: new Set(),
		staticArgumentsAccesses: new Map(),
		hasDirectEval: new Set(),
		directEvalVariableEnvironments: new Set(),
		directEvalThisBindings: new Map(),
		directEvalNewTargetBindings: new Map(),
		evalDirect: options.eval?.direct,
	};

	program.files.push(file);
	analyzeFile(file);
	if (debugEnabled) debugSemanticProgram(program);

	return program;
}

/** The wrapper parameters injected into every CommonJS module's program scope. */
export const COMMONJS_BINDINGS = [
	"module",
	"exports",
	"require",
	"__filename",
	"__dirname",
] as const;

/**
 * Inject the CommonJS wrapper parameters (`module`, `exports`, `require`,
 * `__filename`, `__dirname`) into the module's program scope so references
 * resolve to them instead of throwing ReferenceError. A name the module already
 * declares at top level wins (its declaration acts as the parameter).
 */
function injectCommonJsBindings(file: SemanticFile) {
	const programScope = file.scopes[0];
	if (!programScope) {
		return;
	}
	for (const name of COMMONJS_BINDINGS) {
		if (!programScope.bindings.some((binding) => binding.name === name)) {
			programScope.bindings.push({
				kind: "var",
				name,
				declarationNode: file.ast,
				usageNodes: [],
			});
		}
	}
}

/**
 * Exec all analyze steps for a file.
 */
export function analyzeFile(file: SemanticFile) {
	const candidates: SemanticAnalysisCandidates = {
		directEvalCalls: [],
		hasImplicitArguments: false,
	};
	createScopesFromNode(file.ast, file);
	collectBindingsForNode(file.ast, file);
	registerAnnexBVarBindings(file);
	if (file.commonjs) {
		injectCommonJsBindings(file);
	}
	registerBindingUsage(file.ast, file, candidates);
	for (const call of candidates.directEvalCalls) {
		const callee = call.callee as unknown as ESTree.Identifier;
		if (file.nodeToBinding.get(callee)?.undeclared) {
			semanticAnalysisWorkCounts.directEvalCandidates++;
			const hasImplicitArguments = detectDirectEval(call, file);
			candidates.hasImplicitArguments ||= hasImplicitArguments;
		}
	}
	markDirectEvalDynamicUsages(file);
	if (candidates.hasImplicitArguments) {
		semanticAnalysisWorkCounts.staticArgumentsTraversals++;
		classifyStaticArgumentsUsage(file);
	}
	calculateBindingScopedTo(file);
}

/**
 * Scope-node types that compile to their own function unit (a separate IR
 * function / capture boundary), and so are the granularity of the C3 direct-eval
 * poison. The Program is included: a top-level direct eval poisons top-level
 * bindings the same way.
 */
export const FUNCTION_UNIT_NODE_TYPES = new Set<ESTree.Node["type"]>([
	"Program",
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"StaticBlock",
	"PropertyDefinition",
]);

/**
 * Flag every function (and the Program) whose lexical region contains a direct
 * eval, populating `file.hasDirectEval`. See the `hasDirectEval` field doc for
 * the rationale; relies on `registerBindingUsage` having resolved the callee
 * binding first (a global `eval` resolves to an `undeclared` binding).
 */
function detectDirectEval(node: ESTree.CallExpression, file: SemanticFile): boolean {
	const argumentsBinding = resolveArgumentsBinding(file.nodeToScope.get(node));
	if (argumentsBinding) {
		// Eval source can dynamically name `arguments`; record a non-static
		// use and retain the binding for direct-eval scope marshaling.
		argumentsBinding.usageNodes.push(node);
		file.nodeToBinding.set(node, argumentsBinding);
	}
	const lexicalOwner = resolveDirectEvalLexicalOwner(
		file.nodeToScope.get(node),
		file.evalDirect ?? false,
	);
	if (lexicalOwner) {
		const thisBinding = ensureImplicitBinding(lexicalOwner, "this", node);
		const newTargetBinding = ensureImplicitBinding(lexicalOwner, "new.target", node);
		file.directEvalThisBindings.set(node, thisBinding);
		file.directEvalNewTargetBindings.set(node, newTargetBinding);
	}
	// Mark this call's enclosing function and every function above it: a
	// nested direct eval can still address an outer function's locals. Record a
	// conservative use of every visible binding for the same reason, so bindings
	// across a function boundary are captured and can be marshaled to eval.
	const visibleNames = new Set<string>();
	let scope: Scope | null | undefined = file.nodeToScope.get(node);
	const directEvalIsStrict = scope?.strict ?? file.strict;
	let variableEnvironmentRecorded = false;
	while (scope) {
		for (const binding of scope.bindings) {
			if (visibleNames.has(binding.name)) continue;
			visibleNames.add(binding.name);
			if (
				!binding.undeclared &&
				!binding.implicit &&
				!binding.usageNodes.includes(node)
			) {
				binding.usageNodes.push(node);
			}
		}
		if (FUNCTION_UNIT_NODE_TYPES.has(scope.node.type)) {
			file.hasDirectEval.add(scope.node);
			if (!variableEnvironmentRecorded) {
				if (scope.node.type !== "Program" && !directEvalIsStrict) {
					file.directEvalVariableEnvironments.add(scope.node);
				}
				variableEnvironmentRecorded = true;
			}
		}
		scope = scope.parent;
	}
	return argumentsBinding?.implicit === "arguments";
}

/**
 * A sloppy eval can add a var binding to its containing function activation.
 * References that would otherwise resolve outside that activation must probe the
 * activation's dynamic eval environment first, including references in closures.
 */
function markDirectEvalDynamicUsages(file: SemanticFile): void {
	if (file.directEvalVariableEnvironments.size === 0) return;
	const bindingScopes = new Map<Binding, Scope>();
	for (const scope of file.scopes) {
		for (const binding of scope.bindings) bindingScopes.set(binding, scope);
	}
	for (const scope of file.scopes) {
		for (const binding of scope.bindings) {
			const bindingScope = bindingScopes.get(binding);
			for (const usage of binding.usageNodes) {
				if (usage.type !== "Identifier") continue;
				const declaration = binding.declarationNode;
				if (
					!binding.undeclared &&
					(usage === declaration ||
						(declaration && "id" in declaration && declaration.id === usage))
				) {
					continue;
				}
				for (
					let current: Scope | null | undefined = file.nodeToScope.get(usage);
					current;
					current = current.parent
				) {
					if (
						binding.undeclared &&
						file.directEvalVariableEnvironments.has(current.node)
					) {
						file.withDynamicNodes.add(usage);
						break;
					}
					if (current === bindingScope) break;
					if (file.directEvalVariableEnvironments.has(current.node)) {
						file.withDynamicNodes.add(usage);
						break;
					}
				}
			}
		}
	}
}

function ensureImplicitBinding(
	owner: Scope,
	implicit: "this" | "new.target",
	usage: ESTree.Node,
): Binding {
	let binding = owner.bindings.find((candidate) => candidate.implicit === implicit);
	if (!binding) {
		binding = {
			kind: "const",
			name: implicit,
			implicit,
			declarationNode: owner.node,
			usageNodes: [],
		};
		owner.bindings.push(binding);
	}
	binding.usageNodes.push(usage);
	return binding;
}

function resolveDirectEvalLexicalOwner(
	scope: Scope | undefined,
	allowProgram: boolean,
): Scope | null {
	const providesContext = (node: ESTree.Node) => FUNCTION_UNIT_NODE_TYPES.has(node.type);
	let current: Scope | null | undefined = scope;
	while (current && !providesContext(current.node)) current = current.parent;
	if (current?.node.type !== "ArrowFunctionExpression") return null;

	let owner = current.parent;
	while (
		owner &&
		(owner.node.type === "ArrowFunctionExpression" || !providesContext(owner.node))
	) {
		owner = owner.parent;
	}
	if (!owner || (owner.node.type === "Program" && !allowProgram)) return null;
	return owner;
}

/** Resolve the `arguments` binding visible at a direct-eval call site. */
function resolveArgumentsBinding(scope: Scope | undefined): Binding | undefined {
	for (let current: Scope | null | undefined = scope; current; current = current.parent) {
		const existing = current.bindings.find((binding) => binding.name === "arguments");
		if (existing) {
			return existing;
		}
		if (
			current.node.type === "FunctionDeclaration" ||
			current.node.type === "FunctionExpression"
		) {
			const binding: Binding = {
				kind: "var",
				name: "arguments",
				implicit: "arguments",
				declarationNode: current.node,
				usageNodes: [],
			};
			current.bindings.push(binding);
			return binding;
		}
		if (
			current.node.type === "PropertyDefinition" ||
			current.node.type === "StaticBlock"
		) {
			return undefined;
		}
	}
	return undefined;
}

/** Canonical array-index property represented by a literal, if any. */
function staticArgumentsIndex(member: ESTree.MemberExpression): number | undefined {
	if (!member.computed || member.property.type !== "Literal") {
		return undefined;
	}
	const value = member.property.value;
	const index =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : -1;
	// The VM calling convention and LOAD_ARGUMENT operand use signed i32 counts.
	// Larger canonical array indices are always absent and use the object fallback.
	if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
		return undefined;
	}
	if (typeof value === "string" && String(index) !== value) {
		return undefined;
	}
	return index;
}

/** Whether `member` is evaluated as a value rather than a reference target/receiver. */
function isDirectArgumentsRead(
	member: ESTree.MemberExpression,
	parents: Map<ESTree.Node, ESTree.Node>,
): boolean {
	let current: ESTree.Node = member;
	for (;;) {
		const parent = parents.get(current);
		if (!parent) return true;
		if (parent.type === "ChainExpression") {
			current = parent;
			continue;
		}
		if (
			(parent.type === "CallExpression" || parent.type === "NewExpression") &&
			parent.callee === current
		) {
			return false;
		}
		if (parent.type === "TaggedTemplateExpression" && parent.tag === current) {
			return false;
		}
		if (parent.type === "AssignmentExpression") {
			return parent.left !== current;
		}
		if (parent.type === "UpdateExpression" && parent.argument === current) {
			return false;
		}
		if (parent.type === "UnaryExpression" && parent.operator === "delete") {
			return false;
		}
		if (
			(parent.type === "ForInStatement" || parent.type === "ForOfStatement") &&
			parent.left === current
		) {
			return false;
		}
		if (
			parent.type === "ArrayPattern" ||
			parent.type === "ObjectPattern" ||
			parent.type === "RestElement" ||
			parent.type === "AssignmentPattern" ||
			parent.type === "Property"
		) {
			current = parent;
			continue;
		}
		return true;
	}
}

/** A direct read cannot outlive its owning frame through an arrow closure. */
function accessIsInOwningFunction(
	file: SemanticFile,
	usage: ESTree.Node,
	binding: Binding,
): boolean {
	const owner = file.scopes.find((scope) => scope.bindings.includes(binding));
	if (!owner) return false;
	for (
		let scope: Scope | null | undefined = file.nodeToScope.get(usage);
		scope;
		scope = scope.parent
	) {
		if (scope === owner) return true;
		if (
			scope.node.type === "ArrowFunctionExpression" ||
			scope.node.type === "FunctionDeclaration" ||
			scope.node.type === "FunctionExpression"
		) {
			return false;
		}
	}
	return false;
}

/**
 * Classify binding-wide-safe `arguments.length` and canonical constant-index
 * reads. ECMAScript creates one mutable arguments object binding per non-arrow
 * function, so optimization is all-or-nothing for that binding: any observable
 * object use retains CreateMapped/UnmappedArgumentsObject behavior.
 */
function classifyStaticArgumentsUsage(file: SemanticFile): void {
	const parents = new Map<ESTree.Node, ESTree.Node>();
	const candidates = new Map<Binding, Map<ESTree.Node, StaticArgumentsAccess>>();

	traverseEstree(file.ast, (node, { parent }) => {
		if (parent) parents.set(node, parent);
		if (node.type === "MemberExpression" && node.object.type === "Identifier") {
			const identifier = node.object;
			const binding = file.nodeToBinding.get(identifier);
			if (
				binding?.implicit === "arguments" &&
				!file.withDynamicNodes.has(identifier) &&
				accessIsInOwningFunction(file, identifier, binding)
			) {
				let access: StaticArgumentsAccess | undefined;
				if (
					!node.computed &&
					node.property.type === "Identifier" &&
					node.property.name === "length"
				) {
					access = { member: node, kind: "length" };
				} else {
					const index = staticArgumentsIndex(node);
					if (index !== undefined) access = { member: node, kind: "index", index };
				}
				if (access) {
					const byNode =
						candidates.get(binding) ?? new Map<ESTree.Node, StaticArgumentsAccess>();
					byNode.set(identifier, access);
					candidates.set(binding, byNode);
				}
			}
		}
	});

	for (const [binding, byNode] of candidates) {
		if (
			binding.usageNodes.length > 0 &&
			binding.usageNodes.every(
				(usage) =>
					byNode.has(usage) && isDirectArgumentsRead(byNode.get(usage)!.member, parents),
			)
		) {
			for (const [usage, access] of byNode)
				file.staticArgumentsAccesses.set(usage, access);
		}
	}
}

/**
 * Whether a function-defining node (or the Program) is poisoned by a direct eval
 * in its lexical region — escape / scalar-replacement / region analysis must be
 * disabled for it (C3).
 */
export function functionHasDirectEval(file: SemanticFile, node: ESTree.Node): boolean {
	return file.hasDirectEval.has(node);
}

/** A statically-detected use of a dynamic-code entry point, with its location. */
export interface DisallowedEvalUsage {
	/** `eval(...)` or `Function(...)`/`new Function(...)`. */
	kind: "eval" | "Function";
	path: string;
	line: number;
	column: number;
}

/**
 * The narrow, call-site-specific `engine.eval: "compile-check"` audit:
 * flag `eval(...)` calls and `Function(...)` / `new Function(...)` constructions
 * where the callee is the global (undeclared) binding. Bare references
 * (`typeof eval`, `x instanceof Function`, `Function.prototype`) are intentionally
 * NOT flagged — they create no dynamic code, and anything this misses (aliased
 * indirect eval, `Object.getPrototypeOf(async()=>{}).constructor`, the other
 * Function families) is caught by the runtime gate in builtin_eval.c.
 */
function collectFileEvalUsage(
	node: ESTree.Node,
	file: SemanticFile,
	out: Array<DisallowedEvalUsage>,
): void {
	if (node.type === "CallExpression" || node.type === "NewExpression") {
		const callee = node.callee as unknown as ESTree.Node;
		if (callee.type === "Identifier" && file.nodeToBinding.get(callee)?.undeclared) {
			const isEvalCall = callee.name === "eval" && node.type === "CallExpression";
			const isFunctionCtor = callee.name === "Function";
			if (isEvalCall || isFunctionCtor) {
				const loc = callee.loc?.start ?? { line: 0, column: 0 };
				out.push({
					kind: isEvalCall ? "eval" : "Function",
					path: file.path,
					line: loc.line,
					column: loc.column,
				});
			}
		}
	}
	recurseAst(node, collectFileEvalUsage, file, out);
}

/**
 * Collect every disallowed dynamic-code use across a program's files (see
 * {@link collectFileEvalUsage}). Consumed by the compiler entry points when
 * `engine.eval` is `"compile-check"` to fail the build with a pointer at the config.
 */
export function collectDisallowedEvalUsage(
	program: SemanticProgram,
): Array<DisallowedEvalUsage> {
	const out: Array<DisallowedEvalUsage> = [];
	for (const file of program.files) {
		collectFileEvalUsage(file.ast, file, out);
	}
	return out;
}

export interface DisallowedRegexpUsage {
	/** A `/…/` literal or a `new RegExp(...)` / `RegExp(...)` on the global binding. */
	kind: "literal" | "RegExp";
	path: string;
	line: number;
	column: number;
}

/**
 * The syntactic half of the `engine.regexp: false` enforcement: flag regex
 * literals and `RegExp(...)` / `new RegExp(...)` on the global (undeclared) binding.
 * The parallel to {@link collectFileEvalUsage}. Bare references (`typeof RegExp`)
 * are not flagged, and anything this misses (a string coerced by
 * `String.prototype.match`, an aliased `globalThis.RegExp`) is caught by the runtime
 * gate (the RegExp intrinsic is not installed, so use throws).
 */
function collectFileRegexpUsage(
	node: ESTree.Node,
	file: SemanticFile,
	out: Array<DisallowedRegexpUsage>,
): void {
	if (node.type === "Literal" && "regex" in node && node.regex) {
		const loc = node.loc?.start ?? { line: 0, column: 0 };
		out.push({ kind: "literal", path: file.path, line: loc.line, column: loc.column });
	} else if (node.type === "CallExpression" || node.type === "NewExpression") {
		const callee = node.callee as unknown as ESTree.Node;
		if (
			callee.type === "Identifier" &&
			callee.name === "RegExp" &&
			file.nodeToBinding.get(callee)?.undeclared
		) {
			const loc = callee.loc?.start ?? { line: 0, column: 0 };
			out.push({ kind: "RegExp", path: file.path, line: loc.line, column: loc.column });
		}
	}
	recurseAst(node, collectFileRegexpUsage, file, out);
}

/**
 * Collect every syntactic RegExp use across a program's files (see
 * {@link collectFileRegexpUsage}). Consumed by the compiler entry points when
 * `engine.regexp` is false to fail the build with a pointer at the config.
 */
export function collectDisallowedRegexpUsage(
	program: SemanticProgram,
): Array<DisallowedRegexpUsage> {
	const out: Array<DisallowedRegexpUsage> = [];
	for (const file of program.files) {
		collectFileRegexpUsage(file.ast, file, out);
	}
	return out;
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

	if (node.type === "WithStatement") {
		// The object expression is evaluated in the enclosing scope; only the body
		// runs under the dynamic with-scope. Recurse into each explicitly so an
		// identifier in the object is NOT flagged as intercepted by its own with.
		createScopesFromNode(node.object, file, parentScope);

		const withScope: Scope = {
			parent: parentScope,
			node,
			strict,
			bindings: [],
			dynamic: true,
		};
		file.scopes.push(withScope);
		file.nodeToScope.set(node, withScope);
		createScopesFromNode(node.body, file, withScope);
		return;
	}

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

	if (node.type === "BlockStatement" || node.type === "StaticBlock") {
		// All blocks need their own scope.
		parentScope = {
			parent: parentScope,
			node,

			strict,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (node.type === "PropertyDefinition") {
		// A class field initializer is its own scope: it is compiled as a
		// distinct function (the constructor or static initializer), so outer
		// references must resolve as captures, not as the enclosing locals.
		parentScope = {
			parent: parentScope,
			node,

			strict: true,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (
		node.type === "ArrowFunctionExpression" &&
		node.body?.type !== "BlockStatement" &&
		node.params.length
	) {
		// We need a block scope for a single-line function expression if it has params
		parentScope = {
			parent: parentScope,
			node: node.body,

			strict,
			bindings: [],
		};

		file.scopes.push(parentScope);
	}

	if (
		[
			"ForStatement",
			"ForInStatement",
			"ForOfStatement",
			"SwitchStatement",
			"CatchClause",

			"FunctionDeclaration",
			"FunctionExpression",
			"ArrowFunctionExpression",
		].includes(node.type)
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
		// Make it easier to lookup a scope for a node in later passes.
		//
		// This prevents us from also having to walk the scopes while walking the AST.
		//
		// The thing is, at some point we are probably going to want to do a single AST walk tho, to
		// optimize things, so then this will become obselete.
		file.nodeToScope.set(node, parentScope);
	}

	recurseAst(node, createScopesFromNode, file, parentScope);
}

function collectBindingsForNode(node: ESTree.Node, file: SemanticFile) {
	const scope = file.nodeToScope.get(node);
	if (!scope) {
		return;
	}

	if (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
	) {
		if ("id" in node && node.id) {
			const kind =
				node.type === "FunctionDeclaration" &&
				isVarScopedFunctionDeclaration(node, scope, file)
					? "var"
					: "let";
			// Register a function as a binding in their scope.
			extractBindingsAndRegister(
				file,
				// FunctionDeclarations are available in the parent scope, named FunctionExpressions are
				// only available in their own scope.
				node.type === "FunctionDeclaration" ? scope.parent! : scope,
				node,
				kind,
				// A named function/generator/async expression's own-name binding is
				// immutable (CreateImmutableBinding); a FunctionDeclaration's is not.
				node.type === "FunctionExpression" ? true : undefined,
			);
		}

		if (node.params.length) {
			for (const param of node.params) {
				extractBindingsAndRegister(file, scope, param, "var");
			}
		}
	}

	if (node.type === "VariableDeclaration") {
		const kind =
			node.kind === "using" || node.kind === "await using" ? "const" : node.kind;
		for (const decl of node.declarations) {
			extractBindingsAndRegister(file, scope, decl.id, kind);
		}
	}

	if (node.type === "CatchClause") {
		if (node.param) {
			extractBindingsAndRegister(file, scope, node.param, "let");
		}
	}

	if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id) {
		if (node.type === "ClassDeclaration") {
			// The declaration binding lives outside ClassDefinitionEvaluation.
			extractBindingsAndRegister(file, scope.parent!, node, "let");
		}
		// Named classes also have an immutable inner binding visible to heritage
		// expressions and the class body, distinct from a declaration's outer name.
		extractBindingsAndRegister(file, scope, node.id, "const");
	}

	if (node.type === "ImportDeclaration") {
		// Each import introduces an immutable module-scoped binding for its local
		// name. The linker later aliases usages of these to the exporting module's
		// binding; until then they exist so references resolve to a real binding
		// (not a spurious undeclared global).
		for (const specifier of node.specifiers) {
			extractBindingsAndRegister(file, scope, specifier.local, "const");
			const binding = file.nodeToBinding.get(specifier.local);
			if (binding) {
				binding.imported = true;
			}
		}
	}

	recurseAst(node, collectBindingsForNode, file);
}

/** Whether this declaration participates in Script/Function var declarations. */
function isVarScopedFunctionDeclaration(
	node: ESTree.FunctionDeclaration,
	scope: Scope,
	file: SemanticFile,
): boolean {
	const declarationScope = scope.parent;
	if (
		file.type === "script" &&
		declarationScope?.node.type === "Program" &&
		declarationScope.node.body.includes(node)
	) {
		return true;
	}

	if (declarationScope?.node.type !== "BlockStatement") {
		return false;
	}
	const functionScope = declarationScope.parent;
	return (
		(functionScope?.node.type === "FunctionDeclaration" ||
			functionScope?.node.type === "FunctionExpression" ||
			functionScope?.node.type === "ArrowFunctionExpression") &&
		functionScope.node.body === declarationScope.node &&
		declarationScope.node.body.includes(node)
	);
}

function annexBVariableScope(scope: Scope): Scope {
	let current = scope;
	while (current.parent) {
		const parent = current.parent;
		if (
			parent.node.type === "FunctionDeclaration" ||
			parent.node.type === "FunctionExpression" ||
			parent.node.type === "ArrowFunctionExpression"
		) {
			return hasParameterExpressions(parent.node) ? current : parent;
		}
		current = parent;
	}
	return current;
}

function registerAnnexBVarBindings(file: SemanticFile): void {
	for (const scope of file.scopes) {
		for (const binding of scope.bindings) {
			const declaration = binding.declarationNode;
			if (
				binding.kind !== "let" ||
				scope.strict ||
				declaration?.type !== "FunctionDeclaration" ||
				binding.name === "let" ||
				binding.annexBVarBinding
			) {
				continue;
			}

			const variableScope = annexBVariableScope(scope);
			let eligible = true;
			for (let current: Scope | null = scope; current; current = current.parent) {
				const conflict = current.bindings.find(
					(candidate) =>
						candidate !== binding &&
						candidate.name === binding.name &&
						candidate.kind !== "var",
				);
				if (conflict) {
					const simpleCatchParameter =
						current.node.type === "CatchClause" &&
						current.node.param?.type === "Identifier" &&
						conflict.declarationNode === current.node.param;
					if (!simpleCatchParameter) eligible = false;
				}
				if (current === variableScope) break;
			}
			if (!eligible || binding.name === "arguments") continue;

			let owner = scope.parent;
			while (
				owner &&
				owner.node.type !== "FunctionDeclaration" &&
				owner.node.type !== "FunctionExpression" &&
				owner.node.type !== "ArrowFunctionExpression"
			) {
				owner = owner.parent;
			}
			const ownerNode = owner?.node;
			if (
				owner &&
				ownerNode &&
				(ownerNode.type === "FunctionDeclaration" ||
					ownerNode.type === "FunctionExpression" ||
					ownerNode.type === "ArrowFunctionExpression") &&
				ownerNode.params.some((parameter) =>
					owner.bindings.some(
						(candidate) =>
							candidate.name === binding.name && candidate.declarationNode === parameter,
					),
				)
			) {
				continue;
			}

			let outer = variableScope.bindings.find(
				(candidate) =>
					candidate.kind === "var" &&
					candidate.name === binding.name &&
					!candidate.immutableSelfReference,
			);
			if (outer?.implicit) continue;
			if (!outer) {
				outer = {
					kind: "var",
					name: binding.name,
					declarationNode: declaration,
					usageNodes: [],
				};
				variableScope.bindings.push(outer);
			}
			binding.annexBVarBinding = outer;
		}
	}
}

function hasParameterExpressions(
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
): boolean {
	const bindingPatternContainsExpression = (value: unknown): boolean => {
		if (typeof value !== "object" || value === null || !("type" in value)) {
			return false;
		}
		const pattern = value as ESTree.Node;
		switch (pattern.type) {
			case "AssignmentPattern":
				return true;
			case "ArrayPattern":
				return pattern.elements.some(
					(element) => element && bindingPatternContainsExpression(element),
				);
			case "ObjectPattern":
				return pattern.properties.some((property) => {
					if ("argument" in property) {
						return bindingPatternContainsExpression(property.argument);
					}
					if ("computed" in property && "value" in property) {
						return property.computed || bindingPatternContainsExpression(property.value);
					}
					return false;
				});
			case "RestElement":
				return bindingPatternContainsExpression(pattern.argument);
			default:
				return false;
		}
	};

	return node.params.some(bindingPatternContainsExpression);
}

/**
 * Extract bindings for all function and class id's, params and variable declarations.
 */
function extractBindingsAndRegister(
	file: SemanticFile,
	scope: Scope,
	node: ESTree.Node,
	kind: BindingKind,
	immutableSelfReference?: true,
) {
	/**
	 * Recursively walk expression to extract names.
	 *
	 * We need this for destructure patterns.
	 */
	const extractNames = (node?: ESTree.Node): Array<string> => {
		if (!node) {
			return [];
		}

		if ("id" in node && node.id) {
			return extractNames(node.id);
		}

		if (node.type === "Identifier") {
			return [node.name];
		}

		if (node.type === "PrivateIdentifier") {
			return [`#${node.name}`];
		}

		if (node.type === "ArrayPattern") {
			return node.elements.flatMap(extractNames);
		}

		if (node.type === "ObjectPattern") {
			return node.properties.flatMap(extractNames);
		}

		if (node.type === "RestElement") {
			return extractNames(node.argument);
		}

		if (node.type === "AssignmentPattern") {
			return extractNames(node.left);
		}

		if (node.type === "Property") {
			return extractNames(node.value);
		}

		return [];
	};

	const names = extractNames(node);

	let bindingScope = scope;

	if (
		kind === "var" &&
		!bindingScope.node.type.includes("Function") &&
		bindingScope.node.type !== "StaticBlock"
	) {
		// Hoist var bindings to the function body scope, static block, or program.
		// Keeping the body scope distinct from the function/parameter scope models
		// the separate environment required when parameter expressions are present.
		while (bindingScope.parent) {
			const parentType = bindingScope.parent.node.type;
			if (
				parentType !== "FunctionDeclaration" &&
				parentType !== "FunctionExpression" &&
				parentType !== "ArrowFunctionExpression" &&
				parentType !== "StaticBlock"
			) {
				bindingScope = bindingScope.parent;
			} else {
				const collidesWithImmutableFunctionName =
					parentType === "FunctionExpression" &&
					bindingScope.parent.bindings.some(
						(binding) => binding.immutableSelfReference && names.includes(binding.name),
					);
				if (
					parentType !== "StaticBlock" &&
					!collidesWithImmutableFunctionName &&
					!hasParameterExpressions(bindingScope.parent.node)
				) {
					bindingScope = bindingScope.parent;
				}
				break;
			}
		}
	}

	for (const name of names) {
		const existingVarBinding =
			kind === "var"
				? bindingScope.bindings.find(
						(binding) =>
							binding.kind === "var" &&
							binding.name === name &&
							!binding.immutableSelfReference,
					)
				: undefined;
		if (existingVarBinding) {
			file.nodeToBinding.set(node, existingVarBinding);
			continue;
		}

		const binding: Binding = {
			kind,

			name,
			declarationNode: node,
			usageNodes: [],
		};

		if (immutableSelfReference) {
			binding.immutableSelfReference = true;
		}

		const immutableSelfIndex = bindingScope.bindings.findIndex(
			(candidate) =>
				candidate.name === name &&
				candidate.immutableSelfReference &&
				bindingScope.node.type === "FunctionExpression" &&
				bindingScope.node.params.includes(node as ESTree.Parameter),
		);
		if (immutableSelfIndex === -1) {
			bindingScope.bindings.push(binding);
		} else {
			bindingScope.bindings.splice(immutableSelfIndex, 0, binding);
		}
		file.nodeToBinding.set(node, binding);
	}
}

/**
 * Raw resolve every identifier in the AST to its binding.
 *
 * Note that we also collect a usage for the declaration. So we have to handle this downstream
 * or fix that here at some point.
 */
function registerBindingUsage(
	node: ESTree.Node,
	file: SemanticFile,
	candidates: SemanticAnalysisCandidates,
) {
	const scope = file.nodeToScope.get(node);
	if (!scope) {
		return;
	}

	if (node.type === "CallExpression" && !node.optional) {
		// Optional `eval?.()` is indirect eval. Member and sequence callees are
		// indirect too, so only a bare identifier can reach the direct-eval pass.
		const callee = node.callee as unknown as ESTree.Node;
		if (callee.type === "Identifier" && callee.name === "eval") {
			candidates.directEvalCalls.push(node);
		}
	}

	// Set when name resolution walks past a `with` statement's dynamic scope: the
	// name is then intercepted at runtime by the active with-object(s).
	let crossedDynamic = false;

	const resolveBindingByName = (recurseScope: Scope, name: string): Binding => {
		const binding = recurseScope.bindings.find((b) => b.name === name);
		if (binding) {
			return binding;
		}

		if (
			name === "arguments" &&
			(recurseScope.node.type === "FunctionDeclaration" ||
				recurseScope.node.type === "FunctionExpression")
		) {
			// Create the implicit binding lazily. A later semantic pass classifies
			// binding-wide-safe direct reads for raw frame access; all other uses keep
			// the ordinary arguments-object path.
			const binding: Binding = {
				kind: "var",
				name: "arguments",
				implicit: "arguments",
				declarationNode: recurseScope.node,
				usageNodes: [],
			};
			recurseScope.bindings.push(binding);
			return binding;
		}

		if (!recurseScope.parent) {
			// No binding found, so we create an undeclared binding.
			//
			// These can be globals, like 'undefined' or intrinsics like 'Object'.
			//
			// Cache it on the ROOT scope (where an undeclared global effectively
			// lives), not on the usage's own scope: caching it in the usage scope
			// makes a later resolution of the same name find it immediately, without
			// walking up past any enclosing `with` — so the later usage would not be
			// flagged `crossedDynamic` and would miss the with-object interception
			// (e.g. `with(o){ r = x; x = 1; }` — the second `x` must still be dynamic).
			const binding: Binding = {
				kind: "var",
				name,

				declarationNode: node,
				usageNodes: [],

				undeclared: true,
			};
			recurseScope.bindings.push(binding);
			return binding;
		}

		if (recurseScope.dynamic) {
			crossedDynamic = true;
		}

		return resolveBindingByName(recurseScope.parent, name);
	};

	if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") {
		// Imports carry only declarations (specifier locals) and the source/imported
		// names — never a local usage. `export * from` / `export * as ns` likewise
		// reference the source module, not local bindings.
		return;
	}

	if (node.type === "ExportNamedDeclaration") {
		if (node.declaration) {
			// `export const/function/class` — the real usages live in the declaration.
			return registerBindingUsage(node.declaration, file, candidates);
		}
		if (node.source) {
			// `export { x } from "m"` — specifiers name the source module's exports.
			return;
		}
		// `export { a, b as c }` — each specifier's local is a usage of a local binding.
		for (const specifier of node.specifiers) {
			registerBindingUsage(specifier.local, file, candidates);
		}
		return;
	}

	if (node.type === "ExportDefaultDeclaration") {
		return registerBindingUsage(node.declaration, file, candidates);
	}

	if (node.type === "MemberExpression" && !node.computed) {
		// Skip the property from member expressions, except when they are computed.
		return registerBindingUsage(node.object, file, candidates);
	}

	if ((node.type === "Property" || node.type === "MethodDefinition") && !node.computed) {
		// Skip non-computed keys of object literals, object patterns and class
		// members; only the value side contains references. Shorthand pattern
		// properties share the key node as their value, so the value walk still
		// registers those usages.
		return registerBindingUsage(node.value, file, candidates);
	}

	if (node.type === "Identifier") {
		const binding = resolveBindingByName(scope, node.name);
		binding.usageNodes.push(node);
		file.nodeToBinding.set(node, binding);
		if (binding.implicit === "arguments") {
			candidates.hasImplicitArguments = true;
		}
		if (crossedDynamic) {
			file.withDynamicNodes.add(node);
		}
	}

	if (node.type === "ThisExpression" || node.type === "Super") {
		// Arrow functions inherit `this` lexically — they have no own `this`
		// binding. When a `this` is lexically inside an arrow, resolve it to an
		// implicit `this` binding on the nearest enclosing non-arrow `this`-provider
		// (a function/method, class field initializer, or static block) so it is
		// captured through the closure env like any other captured local. A `this`
		// directly in a non-arrow function — or whose owner is the program scope
		// (top-level `this` is globalThis/undefined, handled in IR) — keeps its
		// own-frame `loadThis` path and is left unbound here.
		const owner = resolveLexicalThisOwner(scope, file.evalDirect ?? false);
		if (owner) {
			const binding = ensureImplicitBinding(owner, "this", node);
			file.nodeToBinding.set(node, binding);
		}
	}

	// new.target inside an arrow is lexical too: bind it to an implicit
	// "new.target" binding on the nearest enclosing non-arrow provider so the
	// arrow captures it through the closure env (like `this`). A direct new.target
	// in a non-arrow function keeps its own-frame loadNewTarget path.
	if (
		node.type === "MetaProperty" &&
		node.meta?.name === "new" &&
		node.property?.name === "target"
	) {
		const owner = resolveLexicalThisOwner(scope, file.evalDirect ?? false);
		if (owner) {
			const binding = ensureImplicitBinding(owner, "new.target", node);
			file.nodeToBinding.set(node, binding);
		}
	}

	recurseAst(node, registerBindingUsage, file, candidates);
}

/**
 * For a `this` whose lexical scope is `scope`, return the scope of the nearest
 * enclosing non-arrow `this`-provider IF the `this` is inside an arrow (so it
 * must capture that provider's `this`); otherwise null. Walks up to the innermost
 * `this`-context: if that is an arrow, `this` is lexical and the owner is the next
 * non-arrow provider; a program-scope owner returns null (top-level `this` is not
 * captured — IR resolves it directly).
 */
function resolveLexicalThisOwner(scope: Scope, allowProgram = false): Scope | null {
	const providesThis = (type: string) =>
		type === "ArrowFunctionExpression" ||
		type === "FunctionDeclaration" ||
		type === "FunctionExpression" ||
		type === "PropertyDefinition" ||
		type === "StaticBlock" ||
		type === "Program";

	let current: Scope | null = scope;
	while (current && !providesThis(current.node.type)) {
		current = current.parent;
	}
	if (!current || current.node.type !== "ArrowFunctionExpression") {
		// `this` is owned by the innermost context directly (or no context found).
		return null;
	}

	// `this` is lexical: find the nearest enclosing non-arrow provider.
	let owner: Scope | null = current.parent;
	while (
		owner &&
		(owner.node.type === "ArrowFunctionExpression" || !providesThis(owner.node.type))
	) {
		owner = owner.parent;
	}
	if (!owner || (owner.node.type === "Program" && !allowProgram)) {
		return null;
	}
	return owner;
}

/**
 * Based on usages of a binding, figure out where it is scoped to.
 */
function calculateBindingScopedTo(file: SemanticFile) {
	const usageToDeclarationScopeCrossesFunction = (from: Scope, to: Scope) => {
		if (from === to) {
			return false;
		}

		let intermediate: Scope | null = from;

		while (intermediate && intermediate !== to) {
			// Functions are capture boundaries; so are class field initializers
			// and static blocks, which are compiled as their own functions (the
			// constructor / static initializer).
			if (
				intermediate.node.type.includes("Function") ||
				intermediate.node.type === "PropertyDefinition" ||
				intermediate.node.type === "StaticBlock"
			) {
				return true;
			}

			intermediate = intermediate.parent;
		}

		return false;
	};

	const calculateScopedTo = (
		binding: Binding,
		declarationScope: Scope,
		usageScopes: Array<Scope>,
	): Binding["scopedTo"] => {
		// A CommonJS module's program scope is its wrapper function's scope, so
		// top-level bindings are wrapper locals/captures rather than globals.
		if (
			declarationScope.node.type === "Program" &&
			!file.commonjs &&
			// Strict direct eval creates a fresh variable environment. Its top-level
			// declarations are locals/captures owned by the eval entry, not bindings
			// in the caller realm's global environment. Sloppy direct eval continues
			// through the caller variable-environment machinery below the IR seam.
			// Undeclared references remain global/dynamic so they can resolve through
			// the caller environment at runtime.
			!(file.evalDirect && (binding.implicit || (file.strict && !binding.undeclared)))
		) {
			return "global";
		}

		for (const usage of usageScopes) {
			if (usageToDeclarationScopeCrossesFunction(usage, declarationScope)) {
				return "captured";
			}
		}

		return "local";
	};

	for (const scope of file.scopes) {
		for (const binding of scope.bindings) {
			const usageScopes = binding.usageNodes.map((node) => file.nodeToScope.get(node)!);
			binding.scopedTo = calculateScopedTo(binding, scope, usageScopes);
		}
	}
}

/**
 * Recurse through the AST starting at the given node. Going depth first.
 */
function recurseAst<
	Args extends Array<unknown>,
	Callback extends (node: ESTree.Node, ...args: Args) => void,
>(node: ESTree.Node, callback: Callback, ...args: Args) {
	forEachEstreeChild(node, (child) => callback(child, ...args));
}

export const semanticAnalysisTestHooks = {
	resetWorkCounts() {
		semanticAnalysisWorkCounts.directEvalCandidates = 0;
		semanticAnalysisWorkCounts.staticArgumentsTraversals = 0;
	},
	workCounts() {
		return { ...semanticAnalysisWorkCounts };
	},
};
