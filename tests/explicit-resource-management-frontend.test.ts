import { expect, test } from "vitest";
import type { DirectEvalContext } from "../src/compiler/frontend/direct-eval-context.ts";
import { parseModule, parseScript } from "../src/compiler/frontend/parser.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	parseEvalSource,
} from "../src/compiler/frontend/semantic-analysis.ts";

const inheritedEvalContext: DirectEvalContext = {
	allowSuperProperty: false,
	allowSuperCall: false,
	hasInstanceInitializer: false,
	allowNewTarget: true,
	privateNames: [],
	varConflictNames: [],
	varEnvironmentNames: [],
	varEnvironmentIsGlobal: false,
};

test("parses resource declarations in their permitted source goals", () => {
	const module = parseModule("using resource = null; await using asyncResource = null;");
	expect(
		module.ast.body.map((statement) =>
			statement.type === "VariableDeclaration" ? statement.kind : statement.type,
		),
	).toEqual(["using", "await using"]);

	expect(() => parseScript("using resource = null;", { strict: true })).toThrow(
		SyntaxError,
	);
	expect(() => parseScript("{ using resource = null; }", { strict: true })).not.toThrow();
	expect(() =>
		parseScript(
			"async function f() { for (using x of []); for (await using x of []); for await (using x of []); for await (await using x of []); }",
			{ strict: true },
		),
	).not.toThrow();
});

test.each([
	"{ using resource; }",
	"{ using { resource } = value; }",
	"{ for (using resource in value); }",
	"{ switch (value) { case 0: using resource = null; } }",
])("rejects invalid resource declaration syntax: %s", (source) => {
	expect(() => parseScript(source, { strict: true })).toThrow(SyntaxError);
});

test("rejects top-level using in contextual direct eval", () => {
	expect(() =>
		parseEvalSource("using resource = null;", true, inheritedEvalContext),
	).toThrow(SyntaxError);
	expect(() =>
		parseEvalSource("{ using resource = null; }", true, inheritedEvalContext),
	).not.toThrow();
});

test("analyzes resource declarations as immutable lexical bindings", () => {
	const source = "using resource = null; await using asyncResource = null;";
	const parsed = parseModule(source);
	const program = analyzeSourceAndRunSemanticAnalysis(source, "/resource.mjs", parsed);
	const bindings = program.files[0]!.scopes.flatMap((scope) => scope.bindings);

	expect(bindings.find((binding) => binding.name === "resource")?.kind).toBe("const");
	expect(bindings.find((binding) => binding.name === "asyncResource")?.kind).toBe(
		"const",
	);
});
