import { describe, expect, it } from "vitest";
import { clangProbeDeclarations, visitClangDeclarations } from "../src/ffi/clang-ast.ts";

function declarations(text: string): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];
	visitClangDeclarations(Buffer.from(text), (node) => result.push(node));
	return result;
}

describe("clang AST decoding", () => {
	it("keeps nested JSON and quoted structural characters inside each declaration", () => {
		const nodes = [
			{
				kind: "FunctionDecl",
				name: "Grüße🙂",
				inner: [{ value: '}][{\\"', values: [true, null, -1.25] }],
			},
			{ kind: "RecordDecl", fields: [] },
		];
		for (const indentation of [undefined, 2])
			expect(
				declarations(
					JSON.stringify(
						{ kind: "TranslationUnitDecl", loc: {}, inner: nodes, tail: false },
						null,
						indentation,
					),
				),
			).toEqual(nodes);
	});

	it("accepts an empty translation unit", () => {
		expect(declarations('{"kind":"TranslationUnitDecl","inner":[]}')).toEqual([]);
	});

	it("reads concatenated macro probe declarations", () => {
		const nodes = [
			{ kind: "EnumDecl", value: "{1}" },
			{ kind: "TypedefDecl", name: "__mal_type" },
		];
		expect(
			clangProbeDeclarations(
				Buffer.from(nodes.map((node) => JSON.stringify(node, null, 2)).join("\n\n")),
			),
		).toEqual(nodes);
	});

	it.each([
		"",
		"[]",
		'{"kind":"FunctionDecl","inner":[]}',
		'{"kind":"TranslationUnitDecl"}',
		'{"kind":"TranslationUnitDecl","inner":[{}]',
		'{"kind":"TranslationUnitDecl","inner":[{"name":"unfinished}]}',
		'{"kind":"TranslationUnitDecl","inner":[1]}',
		'{"kind":"TranslationUnitDecl","inner":[{},]}',
		'{"kind":"TranslationUnitDecl","inner":[],}',
		'{"kind":"TranslationUnitDecl","inner":[],"inner":[]}',
		'{"kind":"TranslationUnitDecl","inner":[]} extra',
		'{"kind":"TranslationUnitDecl","inner":[{"nested":[}]]}',
	])("rejects an incomplete or malformed translation unit: %s", (text) => {
		expect(() => declarations(text)).toThrow(/clang.*AST/);
	});

	it("rejects a truncated filtered dump instead of dropping its final declaration", () => {
		expect(() => clangProbeDeclarations(Buffer.from('{}\n{"kind":'))).toThrow(
			/clang.*AST/,
		);
	});
});
