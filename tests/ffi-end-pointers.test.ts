import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import contract from "./fixtures/ffi-end-pointers/ranges.ffi.ts";

let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["ranges.h"],
		compileArguments: [
			"-I",
			path.resolve(import.meta.dirname, "fixtures/ffi-end-pointers"),
		],
	});
});

it("drops an end pointer from the SDK", () => {
	const plan = planBindings(model, { types: {}, functions: contract.functions });
	const declarations = [...generateDeclarations([{ name: "ranges", plan }])].join("\n");
	expect(declarations).toContain(
		"wrap_position(text: string, width: number): string | null",
	);
	expect(declarations).toContain("nullable_bytes(text: string | null): number");
});

it.each([
	[
		"a counted string",
		{
			wrap_position: {
				params: { text: { string: { length: "width" } }, text_end: { end: "text" } },
			},
		},
		"'text' must be a NUL-terminated string input",
	],
	[
		"a non-pointer parameter",
		{ wrap_position: { params: { width: { end: "text" } } } },
		"applies to void and byte pointers, not int",
	],
	[
		"a source that is not text",
		{ wrap_position: { params: { text: { end: "width" } } } },
		"'width' must be a NUL-terminated string input",
	],
	[
		"another role",
		{ text_bytes: { params: { text_end: { end: "text", nullable: true } } } },
		"an end pointer of a function parameter takes no other role",
	],
])("rejects an end pointer of %s", (_name, functions, message) => {
	expect(() => planBindings(model, { types: {}, functions })).toThrow(message);
});
