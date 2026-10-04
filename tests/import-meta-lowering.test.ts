import { describe, expect, it } from "vitest";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToRuntimeImage } from "../src/compiler/pipeline/compile-runtime-core.ts";

function compile(source: string, path: string, parsed = parseModule(source)) {
	const program = analyzeSourceAndRunSemanticAnalysis(source, path, parsed);
	const image = compileSemanticProgramToRuntimeImage(program);
	return image.stringConstants.map((units) => String.fromCharCode(...units));
}

describe("import.meta lowering from the semantic node index", () => {
	it.each([
		"globalThis.url = () => import.meta.url;",
		"globalThis.url = function read(value = import.meta) { return value.url; };",
		"globalThis.url = class { field = import.meta.url; static url = import.meta.url; };",
	])("initializes metadata used by nested syntax: %s", (source) => {
		expect(compile(source, "/virtual/import-meta-index.mjs")).toContain(
			"file:///virtual/import-meta-index.mjs",
		);
	});

	it("ignores lookalikes and new.target", () => {
		const source = `
			// import.meta.url
			globalThis.label = "import.meta.url";
			globalThis.read = function () { return [new.target, this.import.meta]; };
		`;
		expect(compile(source, "/virtual/no-import-meta.mjs")).not.toContain(
			"file:///virtual/no-import-meta.mjs",
		);
	});

	it("rebuilds file-specific metadata when reusing a parsed module", () => {
		const source = "globalThis.url = () => import.meta.url;";
		const parsed = parseModule(source);
		const first = compile(source, "/virtual/first.mjs", parsed);
		const second = compile(source, "/virtual/second.mjs", parsed);
		expect(first).toContain("file:///virtual/first.mjs");
		expect(first).not.toContain("file:///virtual/second.mjs");
		expect(second).toContain("file:///virtual/second.mjs");
		expect(second).not.toContain("file:///virtual/first.mjs");
	});
});
