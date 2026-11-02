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
import rowContract from "./fixtures/ffi-array-rows/rows.ffi.ts";

let model: CModel;
let sdk: string;
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
	const plan = planBindings(model, {
		types: rowContract.types,
		functions: rowContract.functions,
	});
	sdk = [...generateDeclarations([{ name: "rows", plan }])].join("");
});
it("declares native character rows as text inside deeper fixed grids", () => {
	expect(sdk).toContain("char_rows_sum(values: ReadonlyArray<string>): number");
	expect(sdk).toContain(
		"char_grids_sum(values: ReadonlyArray<[string, string]>): number",
	);
});
it("declares byte rows as input views and copied output bytes", () => {
	expect(sdk).toContain(
		"byte_rows_sum(values: ReadonlyArray<ArrayBufferLike | ArrayBufferView>): number",
	);
	expect(sdk).toContain("byte_rows_make(count: bigint): Array<Uint8Array> | null");
});
it("preserves row formats in caller output and inout storage", () => {
	expect(sdk).toContain(
		"char_rows_fill(capacity: bigint): { values: Array<string>; written: bigint }",
	);
	expect(sdk).toContain(
		"char_rows_inout(values: ReadonlyArray<string>): { values: Array<string>; count: bigint }",
	);
});
it("requires an explicit representation for character rows", () => {
	const plan = planBindings(model, {
		types: {},
		functions: { char_rows_sum: { params: { values: { array: { length: "count" } } } } },
	});
	expect(
		plan.unbound
			.find((entry) => entry.name === "char_rows_sum")
			?.gaps.map((gap) => gap.reason)
			.join(" "),
	).toContain("a string or bytes");
});
it("rejects character formats on numeric rows", () => {
	const plan = planBindings(model, {
		types: {},
		functions: {
			rows_sum: {
				params: { values: { array: { length: "count", element: { string: true } } } },
			},
		},
	});
	expect(
		plan.unbound
			.find((entry) => entry.name === "rows_sum")
			?.gaps.map((gap) => gap.reason)
			.join(" "),
	).toContain("fixed character array rows");
});
it.each([
	{},
	{ string: false },
	{ string: true, bytes: true },
	{ bytes: true, length: "4" },
])("rejects ambiguous row representations %j", (element) => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-character-contract-"));
	try {
		writeFileSync(
			path.join(directory, "rows.ffi.ts"),
			`export default ${JSON.stringify({ headers: ["rows.h"], functions: { take: { params: { values: { array: { length: "count", element } } } } } })}`,
		);
		expect(() =>
			loadLibraryContract(
				"rows",
				{ contract: "rows.ffi.ts" },
				directory,
				stripCompactTypes,
			),
		).toThrow("element");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
