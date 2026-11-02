import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiValueFacts } from "../src/public-api.d.ts";

let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["rows.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-array-rows"),
		],
	});
});
it("keeps an output capacity visible and returns non-null array storage", () => {
	const plan = planBindings(model, {
		types: {},
		functions: {
			rows_fill: {
				params: {
					values: { out: true, array: { length: "written", capacity: "capacity" } },
				},
			},
		},
	});
	const declarations = [...generateDeclarations([{ name: "rows", plan }])].join("");
	expect(declarations).toMatch(
		/rows_fill\(capacity: (bigint|number)\): \{ values: Array<\[number, number, number\]>; written: (bigint|number) \}/,
	);
});
it.each([
	[{ out: true, array: { length: "written", capacity: "missing" } }, "no parameter"],
	[{ out: true, array: { length: "written", capacity: "values" } }, "integer input"],
	[{ out: true, array: { length: "written", capacity: "written" } }, "integer input"],
	[
		{ out: true, array: { length: "written", capacity: "capacity" }, free: "rows_free" },
		"cannot be nullable or declare free",
	],
	[
		{ out: true, array: { length: "written", capacity: "capacity" }, nullable: true },
		"cannot be nullable",
	],
	[
		{ inout: true, array: { length: "written", capacity: "capacity" } },
		"inout buffers use their input length",
	],
] satisfies Array<[MaligatorFfiValueFacts, string]>)(
	"rejects unsafe caller buffer facts %j",
	(values, diagnostic) => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: { rows_fill: { params: { values } } },
			}),
		).toThrow(diagnostic);
	},
);
it("rejects a capacity hidden by another fact", () => {
	expect(() =>
		planBindings(model, {
			types: {},
			functions: {
				rows_fill: {
					params: {
						values: { out: true, array: { length: "written", capacity: "capacity" } },
						capacity: { constant: "3" },
					},
				},
			},
		}),
	).toThrow("capacity must remain an integer input");
});
