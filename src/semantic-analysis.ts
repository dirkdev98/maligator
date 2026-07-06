import type { ESTree } from "meriyah";
// Type-only: ts-blank-space strips this, so the module-graph (and its
// ts-blank-space → typescript chain) is NOT pulled into the self-hostable
// compiler cone. The buildModuleGraph value-using entry lives in
// semantic-program.ts so this file stays runnable on MalVm.
import type { ModuleGraph } from "./module-graph.ts";
import { parseScript } from "./parser.ts";
import { log } from "./utils.ts";

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

	// TODO: We ain't fully compliant here yet. Scripts evaluate to the same global scope, so
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
}

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

	/**
	 * An ES import binding. It aliases (shares storage with) the exporting
	 * module's binding, so the importing module must not give it its own
	 * uninitialized (TDZ) slot.
	 */
	imported?: true;
}

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

/**
 * Run semantic analysis over in-memory source, optionally reusing an
 * existing parse. Used by tooling that composes sources without disk files.
 */
export function analyzeSourceAndRunSemanticAnalysis(
	contents: string,
	virtualPath: string,
	parsed?: Pick<SemanticFile, "type" | "strict" | "ast">,
	options: { eval?: { callerStrict: boolean } } = {},
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
		const strict = options.eval.callerStrict;
		const result = parseScript(contents, { strict });
		parseResult =
			!strict && hasUseStrictDirective(result.ast) ? { ...result, strict: true } : result;
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
		hasDirectEval: new Set(),
	};

	program.files.push(file);
	analyzeFile(file);
	debugSemanticProgram(program);

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
	createScopesFromNode(file.ast, file);
	collectBindingsForNode(file.ast, file);
	if (file.commonjs) {
		injectCommonJsBindings(file);
	}
	registerBindingUsage(file.ast, file);
	detectDirectEval(file.ast, file);
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
function detectDirectEval(node: ESTree.Node, file: SemanticFile) {
	if (node.type === "CallExpression") {
		// meriyah types `callee` loosely; cast as the rest of the compiler does.
		const callee = node.callee as unknown as ESTree.Node;
		if (callee.type === "Identifier" && callee.name === "eval") {
			const binding = file.nodeToBinding.get(callee);
			// `undeclared` == resolves to the global eval, not a shadowing local. A
			// local `eval` (or an imported one) is a normal call, not direct eval.
			if (binding?.undeclared) {
				// Mark this call's enclosing function and every function above it: a
				// nested direct eval can still address an outer function's locals.
				let scope: Scope | null | undefined = file.nodeToScope.get(node);
				while (scope) {
					if (FUNCTION_UNIT_NODE_TYPES.has(scope.node.type)) {
						file.hasDirectEval.add(scope.node);
					}
					scope = scope.parent;
				}
			}
		}
	}

	recurseAst(node, detectDirectEval, file);
}

/**
 * Whether a function-defining node (or the Program) is poisoned by a direct eval
 * in its lexical region — escape / scalar-replacement / region analysis must be
 * disabled for it (C3).
 */
export function functionHasDirectEval(file: SemanticFile, node: ESTree.Node): boolean {
	return file.hasDirectEval.has(node);
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
			// Register a function as a binding in their scope.
			extractBindingsAndRegister(
				file,
				// FunctionDeclarations are available in the parent scope, named FunctionExpressions are
				// only available in their own scope.
				node.type === "FunctionDeclaration" ? scope.parent! : scope,
				node,
				scope.strict ? "let" : "var",
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
		for (const decl of node.declarations) {
			extractBindingsAndRegister(file, scope, decl.id, node.kind);
		}
	}

	if (node.type === "CatchClause") {
		if (node.param) {
			extractBindingsAndRegister(file, scope, node.param, "let");
		}
	}

	if (node.type === "ClassDeclaration") {
		if ("id" in node && node.id) {
			// Register a class a binding in their parent scope.
			extractBindingsAndRegister(file, scope.parent!, node, "let");
		}
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

	if (kind === "var" && !bindingScope.node.type.includes("Function")) {
		// Hoist var bindings to their nearest function scope or the module root.
		while (bindingScope.parent) {
			const parentType = bindingScope.parent.node.type;

			if (
				parentType !== "FunctionDeclaration" &&
				parentType !== "FunctionExpression" &&
				parentType !== "ArrowFunctionExpression"
			) {
				bindingScope = bindingScope.parent;
			} else {
				break;
			}
		}
	}

	for (const name of names) {
		const binding: Binding = {
			kind,

			name,
			declarationNode: node,
			usageNodes: [],
		};

		if (immutableSelfReference) {
			binding.immutableSelfReference = true;
		}

		bindingScope.bindings.push(binding);
		file.nodeToBinding.set(node, binding);
	}
}

/**
 * Raw resolve every identifier in the AST to its binding.
 *
 * Note that we also collect a usage for the declaration. So we have to handle this downstream
 * or fix that here at some point.
 */
function registerBindingUsage(node: ESTree.Node, file: SemanticFile) {
	const scope = file.nodeToScope.get(node);
	if (!scope) {
		return;
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
			// TODO(arguments): Have sema classify static arguments usages so IR can avoid
			// materializing the arguments object for direct non-escaping reads like
			// arguments.length and arguments[0].
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
			return registerBindingUsage(node.declaration, file);
		}
		if (node.source) {
			// `export { x } from "m"` — specifiers name the source module's exports.
			return;
		}
		// `export { a, b as c }` — each specifier's local is a usage of a local binding.
		for (const specifier of node.specifiers) {
			registerBindingUsage(specifier.local, file);
		}
		return;
	}

	if (node.type === "ExportDefaultDeclaration") {
		return registerBindingUsage(node.declaration, file);
	}

	if (node.type === "MemberExpression" && !node.computed) {
		// Skip the property from member expressions, except when they are computed.
		return registerBindingUsage(node.object, file);
	}

	if ((node.type === "Property" || node.type === "MethodDefinition") && !node.computed) {
		// Skip non-computed keys of object literals, object patterns and class
		// members; only the value side contains references. Shorthand pattern
		// properties share the key node as their value, so the value walk still
		// registers those usages.
		return registerBindingUsage(node.value, file);
	}

	if (node.type === "Identifier") {
		const binding = resolveBindingByName(scope, node.name);
		binding.usageNodes.push(node);
		file.nodeToBinding.set(node, binding);
		if (crossedDynamic) {
			file.withDynamicNodes.add(node);
		}
	}

	if (node.type === "ThisExpression") {
		// Arrow functions inherit `this` lexically — they have no own `this`
		// binding. When a `this` is lexically inside an arrow, resolve it to an
		// implicit `this` binding on the nearest enclosing non-arrow `this`-provider
		// (a function/method, class field initializer, or static block) so it is
		// captured through the closure env like any other captured local. A `this`
		// directly in a non-arrow function — or whose owner is the program scope
		// (top-level `this` is globalThis/undefined, handled in IR) — keeps its
		// own-frame `loadThis` path and is left unbound here.
		const owner = resolveLexicalThisOwner(scope);
		if (owner) {
			let binding = owner.bindings.find((b) => b.implicit === "this");
			if (!binding) {
				binding = {
					kind: "const",
					name: "this",
					implicit: "this",
					declarationNode: owner.node,
					usageNodes: [],
				};
				owner.bindings.push(binding);
			}
			binding.usageNodes.push(node);
			file.nodeToBinding.set(node, binding);
		}
	}

	// new.target inside an arrow is lexical too: bind it to an implicit
	// "new.target" binding on the nearest enclosing non-arrow provider so the
	// arrow captures it through the closure env (like `this`). A direct new.target
	// in a non-arrow function keeps its own-frame loadNewTarget path.
	if (
		node.type === "MetaProperty" &&
		(node).meta?.name === "new" &&
		(node).property?.name === "target"
	) {
		const owner = resolveLexicalThisOwner(scope);
		if (owner) {
			let binding = owner.bindings.find((b) => b.implicit === "new.target");
			if (!binding) {
				binding = {
					kind: "const",
					name: "new.target",
					implicit: "new.target",
					declarationNode: owner.node,
					usageNodes: [],
				};
				owner.bindings.push(binding);
			}
			binding.usageNodes.push(node);
			file.nodeToBinding.set(node, binding);
		}
	}

	recurseAst(node, registerBindingUsage, file);
}

/**
 * For a `this` whose lexical scope is `scope`, return the scope of the nearest
 * enclosing non-arrow `this`-provider IF the `this` is inside an arrow (so it
 * must capture that provider's `this`); otherwise null. Walks up to the innermost
 * `this`-context: if that is an arrow, `this` is lexical and the owner is the next
 * non-arrow provider; a program-scope owner returns null (top-level `this` is not
 * captured — IR resolves it directly).
 */
function resolveLexicalThisOwner(scope: Scope): Scope | null {
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
	while (owner && (owner.node.type === "ArrowFunctionExpression" || !providesThis(owner.node.type))) {
		owner = owner.parent;
	}
	if (
		!owner ||
		owner.node.type === "Program" ||
		// A class field initializer / static block runs inside the constructor or
		// static initializer (it has no own prologue to snapshot `this` into), so
		// capturing its `this` lexically for a nested arrow is not handled yet.
		// Such arrows keep the own-frame loadThis path — correct when invoked with
		// the field's `this` as receiver (e.g. `C.f()`); a follow-up will snapshot
		// `this` in the initializer so detached calls also see the lexical `this`.
		owner.node.type === "PropertyDefinition" ||
		owner.node.type === "StaticBlock"
	) {
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
		declarationScope: Scope,
		usageScopes: Array<Scope>,
	): Binding["scopedTo"] => {
		// A CommonJS module's program scope is its wrapper function's scope, so
		// top-level bindings are wrapper locals/captures rather than globals.
		if (declarationScope.node.type === "Program" && !file.commonjs) {
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
			binding.scopedTo = calculateScopedTo(scope, usageScopes);
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
	const isNode = (value: unknown): value is ESTree.Node => {
		return typeof value === "object" && value !== null && "type" in value;
	};

	for (const key of Object.keys(node)) {
		const value: unknown = node[key as keyof ESTree.Node];
		if (isNode(value)) {
			callback(value, ...args);
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (isNode(item)) {
					callback(item, ...args);
				}
			}
		}
	}
}
