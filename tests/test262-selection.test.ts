import { describe, expect, it } from "vitest";
import {
	mergeTest262Manifests,
	parseTest262Manifest,
	selectTest262ManifestFiles,
} from "../src/test262/selection.ts";
import type { Test262File } from "../src/test262/types.ts";

function file(path: string): Test262File {
	return { path, frontmatter: {}, content: "", result: "UNKNOWN" };
}

describe("Test262 manifest selection", () => {
	it("parses comments, blank lines, and whitespace", () => {
		expect([...parseTest262Manifest(" # note\n a.js \n\nb.js\n")]).toEqual([
			"a.js",
			"b.js",
		]);
	});

	it("rejects duplicate paths", () => {
		expect(() => parseTest262Manifest("a.js\na.js\n")).toThrow(/duplicate/);
	});

	it("rejects an empty manifest", () => {
		expect(() => parseTest262Manifest("# no tests\n\n")).toThrow(/at least one/);
	});

	it("unions disjoint manifests and rejects overlap", () => {
		expect([...mergeTest262Manifests([new Set(["a.js"]), new Set(["b.js"])])]).toEqual([
			"a.js",
			"b.js",
		]);
		expect(() => mergeTest262Manifests([new Set(["a.js"]), new Set(["a.js"])])).toThrow(
			/overlap.*a\.js/,
		);
	});

	it("applies include and exclude manifests without duplicates", () => {
		const files = [file("a.js"), file("b.js"), file("c.js")];
		const selected = selectTest262ManifestFiles(
			files,
			new Set(["a.js", "b.js"]),
			new Set(["b.js"]),
		);

		expect(selected.map(({ path }) => path)).toEqual(["a.js"]);
	});

	it("supports selecting the strict complement of a manifest", () => {
		const files = [file("a.js"), file("b.js"), file("c.js")];
		const selected = selectTest262ManifestFiles(files, undefined, new Set(["b.js"]));

		expect(selected.map(({ path }) => path)).toEqual(["a.js", "c.js"]);
	});

	it.each([
		["include", new Set(["missing.js"]), undefined],
		["exclude", undefined, new Set(["missing.js"])],
	] as const)("rejects missing %s manifest paths", (_kind, include, exclude) => {
		expect(() => selectTest262ManifestFiles([file("a.js")], include, exclude)).toThrow(
			/missing\.js/,
		);
	});
});
