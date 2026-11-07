import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiTypeFacts } from "../src/public-api.d.ts";
import contract from "./fixtures/ffi-array-fields/sorting.ffi.ts";

let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["sorting.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-array-fields"),
		],
	});
});

it("types counted array fields of a library-owned handle", () => {
	const plan = planBindings(model, {
		types: contract.types,
		functions: contract.functions,
	});
	const declarations = [...generateDeclarations([{ name: "sorting", plan }])].join("\n");
	expect(declarations).toContain("readonly specs: Array<SortSpec> | null;");
	expect(declarations).toContain("readonly order: Array<number> | null;");
});

it.each<[string, MaligatorFfiTypeFacts, string]>([
	[
		"a type without a handle",
		{ fields: { specs: { array: { length: "count" } } } },
		"array fields require a handle",
	],
	[
		"a count that is not an integer field",
		{ handle: {}, fields: { specs: { array: { length: "order" } } } },
		"'order' must be an integer field of at most 64 bits",
	],
	[
		"a field that is not a pointer",
		{ handle: {}, fields: { count: { array: { length: "order_count" } } } },
		"'count' is not a pointer field",
	],
])("rejects an array field on %s", (_name, facts, message) => {
	expect(() =>
		planBindings(model, { types: { SortSpecs: facts }, functions: contract.functions }),
	).toThrow(message);
});
