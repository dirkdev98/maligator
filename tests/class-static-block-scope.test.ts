import { describe, expect, it } from "vitest";
import { parseModule, parseScript } from "../src/compiler/frontend/parser.ts";

describe("ordinary block declaration scope", () => {
	it.each([
		"{ function f() {} function f() {} }",
		"function outer() { { function f() {} function f() {} } }",
	])("accepts duplicate sloppy block functions: %s", (source) => {
		expect(() => parseScript(source, { strict: false })).not.toThrow();
	});

	it.each([
		"{ function f() {} function f() {} }",
		"{ function f() {} let f; }",
		"{ function* f() {} function* f() {} }",
		"{ async function f() {} async function f() {} }",
	])("preserves strict block early errors: %s", (source) => {
		expect(() => parseScript(source, { strict: true })).toThrow(SyntaxError);
		expect(() => parseModule(source)).toThrow(SyntaxError);
	});
});

describe.each([
	{ goal: "module", parse: parseModule },
	{
		goal: "strict script",
		parse: (source: string) => parseScript(source, { strict: true }),
	},
	{
		goal: "sloppy script",
		parse: (source: string) => parseScript(source, { strict: false }),
	},
])("$goal class static-block scope", ({ parse }) => {
	it.each([
		["var and function", "class C { static { var f; function f() {} } }"],
		["duplicate functions", "class C { static { function f() {} function f() {} } }"],
		["var and async function", "class C { static { var f; async function f() {} } }"],
		["nested lexical function", "class C { static { var f; { function f() {} } } }"],
		[
			"outer lexical before",
			"const name = 1; class C { static { if (false) { var name; } } }",
		],
		[
			"outer lexical after",
			"class C { static { if (false) { var name; } } } const name = 1;",
		],
		["class name shadow", "class C { static { var C; } }"],
		["separate static bodies", "class C { static { let name; } static { var name; } }"],
		[
			"nested function arguments",
			"class C { static { function f() { return arguments; } } }",
		],
	])("accepts independent declarations: %s", (_name, source) => {
		expect(() => parse(source)).not.toThrow();
	});

	it.each([
		["lexical and function", "class C { static { let f; function f() {} } }"],
		["function and lexical", "class C { static { function f() {} const f = 1; } }"],
		["lexical before var", "class C { static { let name; var name; } }"],
		["var before lexical", "class C { static { var name; let name; } }"],
		["nested var", "class C { static { let name; { var name; } } }"],
		["nested var before lexical", "class C { static { { var name; } let name; } }"],
		["await", "class C { static { await 0; } }"],
		["return", "class C { static { return; } }"],
		["arguments", "class C { static { arguments; } }"],
		["super call", "class C { static { super(); } }"],
	])("rejects static-block early errors: %s", (_name, source) => {
		expect(() => parse(source)).toThrow(SyntaxError);
	});
});
