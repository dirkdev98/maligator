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
			lexical: false,
			jsx: false,
			validateRegex: false,
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
			lexical: false,
			jsx: false,
			validateRegex: false,
		}),
	};
}
