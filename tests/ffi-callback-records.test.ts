import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiFunctionFacts } from "../src/public-api.d.ts";
import contract from "./fixtures/ffi-callback-records/requests.ffi.ts";

let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["requests.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-callback-records"),
		],
	});
});

it("takes a JavaScript function for a callback record parameter", () => {
	const plan = planBindings(model, { types: {}, functions: contract.functions });
	const declarations = [...generateDeclarations([{ name: "requests", plan }])].join("\n");
	expect(declarations).toContain(
		"request_device(info: (arg1: number, arg2: string | null) => void): number",
	);
	expect(declarations).toContain(
		"visit_values(count: number, visitor: (arg1: number) => number): number",
	);
});

it.each<[string, Record<string, MaligatorFfiFunctionFacts>, string]>([
	[
		"a one-shot callback without data",
		{ request_value: { params: { done: { callback: { once: true } } } } },
		"a one-shot callback needs data or a lookup to find its registration",
	],
	[
		"a record that is not a struct",
		{ visit_values: { params: { count: { callback: { field: "visit" } } } } },
		"int is not a struct passed by value",
	],
	[
		"a member the record lacks",
		{
			visit_values: {
				params: { visitor: { callback: { field: "call", data: "userdata" } } },
			},
		},
		"Visitor has no member 'call'",
	],
	[
		"a constant for the data member",
		{
			request_device: {
				params: {
					info: {
						callback: {
							field: "callback",
							data: "userdata",
							once: true,
							constants: { userdata: "0" },
						},
					},
				},
			},
		},
		"the binding sets the callback and data members",
	],
	[
		"an async twin",
		{
			request_value: {
				params: { done: { callback: { data: "userdata", once: true } } },
				async: "requestValueAsync",
			},
		},
		"one-shot and record callbacks register only through synchronous calls",
	],
])("rejects %s", (_name, functions, message) => {
	expect(() => planBindings(model, { types: {}, functions })).toThrow(message);
});
