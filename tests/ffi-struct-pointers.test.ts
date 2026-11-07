import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import contract from "./fixtures/ffi-struct-pointers/styles.ffi.ts";

let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["styles.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-struct-pointers"),
		],
	});
});

it("binds pointer results to a struct handle that also passes by value", () => {
	const plan = planBindings(model, {
		types: contract.types,
		functions: contract.functions,
	});
	expect(plan.unbound.map((entry) => entry.name)).toEqual([]);
	const declarations = [...generateDeclarations([{ name: "styles", plan }])].join("\n");
	expect(declarations).toContain("export function style_new(): Style | null;");
	expect(declarations).toContain("export function style_weight(style: Style): number;");
});

it("keeps fresh for handles with pointer identity", () => {
	expect(() =>
		planBindings(model, {
			types: contract.types,
			functions: { style_new: { returns: { fresh: true } } },
		}),
	).toThrow("applies only to pointer handle results");
});
