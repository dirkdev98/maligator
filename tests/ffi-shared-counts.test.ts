import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import contract from "./fixtures/ffi-shared-counts/pairs.ffi.ts";

let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["pairs.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-shared-counts"),
		],
	});
});
it("hides a shared count while preserving both vector inputs in the SDK", () => {
	const plan = planBindings(model, { types: {}, functions: contract.functions });
	const declarations = [...generateDeclarations([{ name: "pairs", plan }])].join("\n");
	expect(declarations).toContain(
		"pair_dot(left: ReadonlyArray<number> | null, right: ReadonlyArray<number> | null): number",
	);
	expect(declarations).toContain(
		"dotAsync(left: ReadonlyArray<number> | null, right: ReadonlyArray<number> | null): Promise<number>",
	);
});
it("rejects a shared writable count without an input-length contract", () => {
	expect(() =>
		planBindings(model, {
			types: {},
			functions: {
				pair_pointer: {
					params: {
						left: { array: { length: "count" } },
						right: { array: { length: "count" } },
					},
				},
			},
		}),
	).toThrow("a shared count needs integer input lengths");
});
it("rejects an output capacity hidden by a shared input count", () => {
	expect(() =>
		planBindings(model, {
			types: {},
			functions: {
				pair_capacity: {
					params: {
						output: { out: true, array: { length: "written", capacity: "count" } },
						left: { array: { length: "count" } },
						right: { array: { length: "count" } },
					},
				},
			},
		}),
	).toThrow("capacity must remain an integer input");
});
