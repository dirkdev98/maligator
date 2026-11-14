import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { nativeRecordSortOrderFields } from "../src/compiler/target/native-record-sort.ts";

function certifiedFields(body: string): ReadonlyArray<string> {
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function compare(a, b) { ${body} }
			globalThis.result = [{ title: "b", group: "x", score: 2 }, { title: "a", group: "y", score: 1 }].sort(compare);`,
			"record-sort.js",
		),
	);
	const native = image.native.functions.find((fn) =>
		fn.directEntries.some((entry) => entry.fieldParameters !== undefined),
	);
	expect(native).toBeDefined();
	const entry = native!.directEntries.find(
		(entry) => entry.fieldParameters !== undefined,
	)!;
	return nativeRecordSortOrderFields(native!, entry).keys.map((key) =>
		String.fromCharCode(...image.runtime.stringConstants[key]!),
	);
}

describe("record sort order-only fields", () => {
	it.each(["<", ">", "<=", ">=", "===", "!=="])(
		"admits opposite-record %s comparisons",
		(operator) => {
			expect(certifiedFields(`return a.title ${operator} b.title ? -1 : 1;`)).toEqual([
				"title",
			]);
		},
	);

	it("keeps arithmetic fields numeric beside order-only fields", () => {
		expect(
			certifiedFields("return b.score - a.score || (a.title < b.title ? -1 : 1);"),
		).toEqual(["title"]);
	});

	it("admits aliases whose field provenance stays unchanged", () => {
		expect(
			certifiedFields(
				"const left = a.title; const right = b.title; return left < right ? -1 : 1;",
			),
		).toEqual(["title"]);
	});

	it.each([
		"return a.title < b.group ? -1 : 1;",
		"return a.title < a.group ? -1 : 1;",
		"return a.title < 1 ? -1 : 1;",
		"return a.title ? -1 : 1;",
		"return a.title - b.title || (a.title < b.title ? -1 : 1);",
		"return a.title == b.title ? 0 : 1;",
	])("declines non-order use in %s", (body) => {
		expect(certifiedFields(body)).toEqual([]);
	});

	it("rejects a field whose aliases can change records", () => {
		expect(
			certifiedFields(
				"let title = a.title; if (a.score < b.score) title = b.title; return title < b.title ? -1 : 1;",
			),
		).toEqual(["score"]);
	});

	it("bounds variant generation to two fields", () => {
		expect(
			certifiedFields(
				"return (a.title < b.title ? -1 : 0) || (a.group < b.group ? -1 : 0) || (a.score < b.score ? -1 : 0);",
			),
		).toEqual(["title", "group"]);
	});
});
