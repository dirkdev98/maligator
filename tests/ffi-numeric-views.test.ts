import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import contract from "./fixtures/ffi-numeric-views/numeric.ffi.ts";

let sdk: string;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	const model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["numeric.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-numeric-views"),
		],
	});
	const plan = planBindings(model, { types: {}, functions: contract.functions });
	sdk = [...generateDeclarations([{ name: "numeric", plan }])].join("");
});
it.each([
	["i8", "number", "Int8Array"],
	["u8", "number", "Uint8Array"],
	["i16", "number", "Int16Array"],
	["u16", "number", "Uint16Array"],
	["i32", "number", "Int32Array"],
	["u32", "number", "Uint32Array"],
	["i64", "bigint", "BigInt64Array"],
	["u64", "bigint", "BigUint64Array"],
	["f32", "number", "Float32Array"],
])("declares the matching view for %s const elements", (name, scalar, view) => {
	expect(sdk).toContain(
		`numeric_${name}(values: ReadonlyArray<${scalar}> | ${view}): ${scalar}`,
	);
});
it("declares nullable synchronous and worker double inputs consistently", () => {
	expect(sdk).toContain(
		"numeric_f64(values: ReadonlyArray<number> | Float64Array | null): number",
	);
	expect(sdk).toContain(
		"sumAsync(values: ReadonlyArray<number> | Float64Array | null): Promise<number>",
	);
});
it("keeps mutable numeric pointers and booleans on the copy contract", () => {
	expect(sdk).toContain("numeric_mutable(values: ReadonlyArray<number>): number");
	expect(sdk).toContain("numeric_bool(values: ReadonlyArray<boolean>): boolean");
});
