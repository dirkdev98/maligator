import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiFunctionFacts } from "../src/public-api.d.ts";
import contract from "./fixtures/ffi-typed-pointees/scalars.ffi.ts";

let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["scalars.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-typed-pointees"),
		],
	});
});

it("exports one typed binding per variant of a void pointer function", () => {
	const plan = planBindings(model, { types: {}, functions: contract.functions });
	const declarations = [...generateDeclarations([{ name: "scalars", plan }])].join("\n");
	expect(declarations).toContain(
		"scalar_step_double(value: number): { result: number; value: number }",
	);
	expect(declarations).toContain(
		"scalar_step_int(value: number): { result: number; value: number }",
	);
	expect(declarations).not.toContain("function scalar_step(");
});

it.each<[string, MaligatorFfiFunctionFacts, string]>([
	[
		"a parameter that is not a void pointer",
		{ params: { type: { pointee: "double" } } },
		"applies to void pointers, not DataType",
	],
	[
		"a type that names nothing",
		{ params: { value: { pointee: "Missing", inout: true } } },
		"'Missing' is not a C value type",
	],
	[
		"variadic arguments",
		{ variants: { stepped: { args: ["int"] } } },
		"scalar_step is not variadic",
	],
	[
		"a variant parameter that names nothing",
		{ variants: { stepped: { params: { amount: { constant: "1" } } } } },
		"scalar_step has no parameter 'amount'",
	],
])("rejects %s", (_name, facts, message) => {
	expect(() =>
		planBindings(model, { types: {}, functions: { scalar_step: facts } }),
	).toThrow(message);
});
