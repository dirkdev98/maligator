import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import contract from "./fixtures/ffi-product-lengths/grid.ffi.ts";

const fixture = path.resolve(import.meta.dirname, "fixtures/ffi-product-lengths");
let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["grid.h"],
		compileArguments: ["-I", fixture],
	});
});

it("keeps every factor of a product length in the SDK", () => {
	const plan = planBindings(model, { types: {}, functions: contract.functions });
	const declarations = [...generateDeclarations([{ name: "grid", plan }])].join("\n");
	expect(declarations).toContain(
		"fill_pixels(width: number, height: number, pixels: ArrayBufferLike | ArrayBufferView): number",
	);
	expect(declarations).toContain(
		"sum_grid(values: ReadonlyArray<number> | Float64Array, rows: number, cols: number): number",
	);
});

it.each([
	[
		"a result",
		{
			fill_pixels: {
				params: { pixels: { out: true, bytes: { length: "width * height" } } },
			},
		},
		"a product length applies to input buffers and arrays of a function",
	],
	[
		"a factor that is not an integer input",
		{ fill_pixels: { params: { pixels: { bytes: { length: "width * pixels" } } } } },
		"a parameter cannot count itself",
	],
	[
		"a factor that names nothing",
		{ fill_pixels: { params: { pixels: { bytes: { length: "width * depth" } } } } },
		"fill_pixels has no parameter 'depth'",
	],
])("rejects a product length on %s", (_name, functions, message) => {
	expect(() => planBindings(model, { types: {}, functions })).toThrow(message);
});

it("rejects a product length without a parameter", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-product-lengths-"));
	try {
		writeFileSync(
			path.join(directory, "grid.ffi.ts"),
			`export default ${JSON.stringify({
				headers: ["grid.h"],
				find: [{ includeDirs: ["."], sources: ["grid.c"] }],
				functions: {
					fill_pixels: { params: { pixels: { bytes: { length: "2 * 4" } } } },
				},
			})};`,
		);
		expect(() =>
			loadLibraryContract(
				"grid",
				{ contract: "grid.ffi.ts" },
				directory,
				stripCompactTypes,
			),
		).toThrow("a product such as 'width * height * 4'");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
