import { parse as meriyahParse } from "meriyah";
import type { ESTree } from "meriyah";
import type { DirectEvalContext } from "./direct-eval-context.ts";
import { ESTREE_SKIP, ESTREE_STOP, traverseEstree } from "./estree-traversal.ts";
import type { SemanticFile } from "./semantic-analysis.ts";

const MERIYAH_OPTIONS = {
	sourceType: "script" as const,
	next: true,
	loc: true,
	raw: false,
	preserveParens: false,
	lexical: true,
	webcompat: true,
	jsx: false,
	validateRegex: true,
};

function rejectEvalReturn(body: Array<ESTree.Statement>): void {
	const containsReturn =
		traverseEstree(body, (node) => {
			if (node.type === "ReturnStatement") return ESTREE_STOP;
			if (
				node.type === "FunctionDeclaration" ||
				node.type === "FunctionExpression" ||
				node.type === "ArrowFunctionExpression" ||
				node.type === "ClassDeclaration" ||
				node.type === "ClassExpression"
			) {
				return ESTREE_SKIP;
			}
		}) === ESTREE_STOP;
	if (containsReturn) {
		throw new SyntaxError("Illegal return statement in eval code");
	}
}

function containsInheritedContextSyntax(
	body: Array<ESTree.Statement>,
	kind: "super" | "new.target",
): boolean {
	return (
		traverseEstree(body, (node) => {
			if (kind === "super" && node.type === "Super") return ESTREE_STOP;
			if (
				kind === "new.target" &&
				node.type === "MetaProperty" &&
				node.meta.name === "new" &&
				node.property.name === "target"
			) {
				return ESTREE_STOP;
			}
			if (
				node.type === "FunctionDeclaration" ||
				node.type === "FunctionExpression" ||
				node.type === "ClassDeclaration" ||
				node.type === "ClassExpression"
			) {
				return ESTREE_SKIP;
			}
		}) === ESTREE_STOP
	);
}

function contextualEvalProgram(
	txt: string,
	strict: boolean,
	context: DirectEvalContext,
): ESTree.Program {
	let prefix: string;
	let suffix: string;
	let extractBody: (program: ESTree.Program) => Array<ESTree.Statement>;
	if (context.privateNames.length > 0) {
		const declarations = context.privateNames.map((entry) => `${entry.name};`).join("");
		prefix = `class __MaligatorEvalContext {${declarations} __eval__() {\n`;
		suffix = "\n} }";
		extractBody = (program) => {
			const declaration = program.body[0];
			if (declaration?.type !== "ClassDeclaration")
				throw new SyntaxError("Invalid eval wrapper");
			const method = declaration.body.body.at(-1);
			const methodBody =
				method?.type === "MethodDefinition" ? method.value.body : undefined;
			if (methodBody?.type !== "BlockStatement") {
				throw new SyntaxError("Invalid eval wrapper");
			}
			return methodBody.body;
		};
	} else if (context.allowSuperProperty) {
		prefix = "({ __eval__() {\n";
		suffix = "\n} });";
		extractBody = (program) => {
			const statement = program.body[0];
			const expression =
				statement?.type === "ExpressionStatement" ? statement.expression : null;
			const property =
				expression?.type === "ObjectExpression" ? expression.properties[0] : null;
			const propertyBody =
				property?.type === "Property" && property.value.type === "FunctionExpression"
					? property.value.body
					: undefined;
			if (propertyBody?.type !== "BlockStatement") {
				throw new SyntaxError("Invalid eval wrapper");
			}
			return propertyBody.body;
		};
	} else {
		prefix = "function __MaligatorEvalContext() {\n";
		suffix = "\n}";
		extractBody = (program) => {
			const declaration = program.body[0];
			if (declaration?.type !== "FunctionDeclaration") {
				throw new SyntaxError("Invalid eval wrapper");
			}
			const declarationBody = declaration.body;
			if (!declarationBody) throw new SyntaxError("Invalid eval wrapper");
			return declarationBody.body;
		};
	}

	const wrapped = meriyahParse(`${prefix}${txt}${suffix}`, {
		...MERIYAH_OPTIONS,
		impliedStrict: strict,
	});
	const body = extractBody(wrapped);
	rejectEvalReturn(body);
	if (!context.allowSuperProperty && containsInheritedContextSyntax(body, "super")) {
		throw new SyntaxError("Member access on super must be in a method");
	}
	if (!context.allowNewTarget && containsInheritedContextSyntax(body, "new.target")) {
		throw new SyntaxError("new.target only allowed within functions or static blocks");
	}
	traverseEstree(body, (node) => {
		if (node.loc) {
			node.loc.start.line--;
			node.loc.end.line--;
		}
	});
	return {
		type: "Program",
		sourceType: "script",
		body,
		loc: {
			start: { line: 1, column: 0 },
			end: body.at(-1)?.loc?.end ?? { line: 1, column: txt.length },
		},
	};
}

/**
 * Parse a script into an AST. Can be forced non-strict.
 */
export function parseScript(
	txt: string,
	{
		strict = true,
		directEvalContext,
	}: {
		strict?: boolean;
		directEvalContext?: DirectEvalContext;
	},
): Pick<SemanticFile, "type" | "strict" | "ast"> {
	const contextual =
		directEvalContext &&
		(directEvalContext.allowSuperProperty ||
			directEvalContext.allowNewTarget ||
			directEvalContext.privateNames.length > 0);
	return {
		type: "script",
		strict,

		ast: contextual
			? contextualEvalProgram(txt, strict, directEvalContext)
			: meriyahParse(txt, {
					...MERIYAH_OPTIONS,
					impliedStrict: strict,
					// Enforce static-semantic early errors so invalid source is rejected
					// with a SyntaxError at compile: lexical catches duplicate/redeclared
					// bindings, illegal continue/break, duplicate switch defaults, etc.;
					// validateRegex validates regexp literals; webcompat enables the AnnexB
					// sloppy relaxations we actually support (`\8`/`\9` string escapes,
					// labelled/block function declarations) so they are not over-rejected.
					// (webcompat has one meriyah bug — it accepts an invalid call-expression
					// destructuring target `[f() = 1] = x` — but breaking real AnnexB code
					// is worse than missing that one early error.)
				}),
	};
}

/**
 * Parse a module into an AST.
 */
export function parseModule(txt: string): Pick<SemanticFile, "type" | "strict" | "ast"> {
	return {
		type: "module" as const,
		strict: true,

		ast: meriyahParse(txt, {
			sourceType: "module",
			next: true,
			loc: true,
			impliedStrict: true,

			raw: false,

			preserveParens: false,
			// See parseScript: enforce early errors + regexp validation so invalid
			// module source is rejected with a SyntaxError at compile. (webcompat is
			// a no-op for modules — AnnexB is sloppy-script-only — but kept for
			// config parity.)
			lexical: true,
			webcompat: true,
			jsx: false,
			validateRegex: true,
		}),
	};
}
