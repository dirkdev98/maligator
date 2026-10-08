import { describe, expect, it } from "vitest";
import { generatedDeclarationReferences } from "../src/compiler/target/generated-declaration-references.ts";

const declarations = new Map<string, ReadonlyArray<number>>([
	["mal_alpha", [7, 2]],
	["mal_beta_2", [3]],
	["mal_gamma", [9]],
	["mal_mal_alpha", [11]],
]);

function regexReferences(source: string): Array<number> {
	const referenced = new Set<number>();
	for (const match of source.matchAll(/\bmal_[A-Za-z0-9_]+\b/g))
		for (const index of declarations.get(match[0]) ?? []) referenced.add(index);
	return [...referenced];
}

describe("generated C declaration references", () => {
	it("retains encounter order and all declaration aliases once", () => {
		expect(
			generatedDeclarationReferences(
				"mal_beta_2(mal_alpha); mal_beta_2(mal_gamma); mal_alpha;",
				declarations,
			),
		).toEqual([3, 7, 2, 9]);
	});

	it.each([
		"",
		"mal_",
		"mal_alpha",
		"mal_alpha_suffix",
		"premal_alpha 0mal_gamma _mal_beta_2",
		"mal_mal_alpha",
		"émal_alpha😀mal_beta_2\ud800mal_gamma",
		'/* mal_alpha */ "mal_beta_2" // mal_gamma',
		"mal_🙂mal_alpha mal_!mal_gamma",
	])("preserves the generated-source lexical reference contract for %s", (source) => {
		expect(generatedDeclarationReferences(source, declarations)).toEqual(
			regexReferences(source),
		);
	});

	it("bounds duplicate references in a large generated body", () => {
		const source = "mal_unknown(mal_alpha, mal_beta_2);".repeat(4096);
		expect(generatedDeclarationReferences(source, declarations)).toEqual(
			regexReferences(source),
		);
	});
});
