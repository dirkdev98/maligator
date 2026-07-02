import { parse as meriyahParse } from "meriyah";
import type { SemanticFile } from "./semantic-analysis.ts";

/**
 * Parse a script into an AST. Can be forced non-strict.
 */
export function parseScript(
	txt: string,
	{
		strict = true,
	}: {
		strict?: boolean;
	},
): Pick<SemanticFile, "type" | "strict" | "ast"> {
	return {
		type: "script",
		strict,

		ast: meriyahParse(txt, {
			sourceType: "script" as const,
			next: true,
			loc: true,
			impliedStrict: strict,

			raw: false,

			preserveParens: false,
			// Enforce static-semantic early errors so invalid source is rejected
			// with a SyntaxError at compile: lexical catches duplicate/redeclared
			// bindings, illegal continue/break, duplicate switch defaults, etc.;
			// validateRegex validates regexp literals; webcompat enables the AnnexB
			// sloppy relaxations we actually support (`\8`/`\9` string escapes,
			// labelled/block function declarations) so they are not over-rejected.
			// (webcompat has one meriyah bug — it accepts an invalid call-expression
			// destructuring target `[f() = 1] = x` — but breaking real AnnexB code
			// is worse than missing that one early error.)
			lexical: true,
			webcompat: true,
			jsx: false,
			validateRegex: true,
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
