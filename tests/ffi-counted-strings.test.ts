import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { generateBindingUnit } from "../src/ffi/binding-unit.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiValueFacts } from "../src/public-api.d.ts";
import textContract from "./fixtures/ffi-counted-strings/text.ffi.ts";

describe("counted UTF-8 contracts", () => {
	let model: CModel;
	let directory: string;
	beforeAll(() => {
		directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-string-facts-"));
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["text.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-counted-strings"),
			],
		});
	});
	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});
	it.each(["length", "2"])(
		"hides a counted input's byte count referenced by %s",
		(length) => {
			const plan = planBindings(model, {
				types: {},
				functions: { text_length: { params: { text: { string: { length } } } } },
			});
			const binding = plan.functions.find((entry) => entry.name === "text_length")!;
			expect(binding.params.map((entry) => entry.name)).toEqual(["text"]);
			expect(binding.params[0]?.value).toMatchObject({ kind: "string", counted: true });
		},
	);
	it("declares counted results and async twins as strings", () => {
		const plan = planBindings(model, { types: {}, functions: textContract.functions });
		const declarations = [...generateDeclarations([{ name: "text", plan }])].join("");
		expect(declarations).toContain(
			"export function text_copy(text: string | null): string | null;",
		);
		expect(declarations).toContain(
			"export function text_copy_async(text: string | null): Promise<string | null>;",
		);
	});
	it.each([true, false])(
		"uses target char signedness %s for sync and async byte counts",
		(charSigned) => {
			const targetModel = { ...model, target: { ...model.target, charSigned } };
			const plan = planBindings(targetModel, {
				types: {},
				functions: { text_plain: textContract.functions.text_plain },
			});
			const { source } = generateBindingUnit("text", ["text.h"], targetModel, plan);
			const checks = source
				.split("\n")
				.filter((line) => line.includes("mal_ffi_check_count("));
			expect(checks).toHaveLength(2);
			for (const check of checks) expect(check).toContain(`, 8, ${charSigned},`);
		},
	);
	it.each(["out", "inout"] as const)(
		"declares counted %s outputs with their updated byte lengths",
		(role) => {
			const plan = planBindings(model, {
				types: {},
				functions: {
					text_out: {
						params: { text: { [role]: true, string: { length: "length" } } },
					},
				},
			});
			expect([...generateDeclarations([{ name: "text", plan }])].join("")).toContain(
				role === "out"
					? "export function text_out(): { text: string | null; length: number };"
					: "export function text_out(text: string): { text: string | null; length: number };",
			);
		},
	);
	it("requires C to write an out string's length", () => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: {
					text_out_fixed: {
						params: { text: { out: true, string: { length: "length" } } },
					},
				},
			}),
		).toThrow("count C writes through a pointer");
	});
	it("hides callback counts and declares the copied string argument", () => {
		const plan = planBindings(model, { types: {}, functions: textContract.functions });
		expect([...generateDeclarations([{ name: "text", plan }])].join("")).toContain(
			"export function text_counted_callback(callback: (arg1: string | null) => void, mode: number): void;",
		);
	});
	it.each([true, "wait"] as const)(
		"declares counted queued strings with %s delivery",
		(queued) => {
			const plan = planBindings(model, {
				types: {},
				functions: {
					text_notify: {
						params: {
							callback: {
								callback: {
									data: "data",
									release: "release",
									queued,
									params: { "1": { string: { length: "2" } } },
								},
							},
						},
					},
				},
			});
			expect([...generateDeclarations([{ name: "text", plan }])].join("")).toContain(
				"export function text_notify(callback: (arg1: string | null) => void, mode: number): void;",
			);
		},
	);
	it.each([undefined, true, "wait"] as const)(
		"rejects a wider callback count before narrowing with %s delivery",
		(queued) => {
			expect(() =>
				planBindings(model, {
					types: {},
					functions: {
						text_wide_callback: {
							params: {
								callback: {
									callback: {
										data: "data",
										release: "release",
										queued,
										params: { "1": { string: { length: "2" } } },
									},
								},
							},
						},
					},
				}),
			).toThrow("supported integer of at most 64 bits");
		},
	);
	it("rejects a wider result count before narrowing", () => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: { text_wide_result: { returns: { string: { length: "length" } } } },
			}),
		).toThrow("supported integer of at most 64 bits");
	});
	it.each([
		{ string: { length: "length" }, bytes: { length: "length" } },
		{ string: true, array: { length: "length" } },
	] satisfies Array<MaligatorFfiValueFacts>)(
		"rejects conflicting text and buffer representations %j",
		(facts) => {
			writeFileSync(
				path.join(directory, "text.ffi.ts"),
				`export default ${JSON.stringify({ headers: ["text.h"], find: [{ sources: ["text.c"] }], functions: { text_length: { params: { text: facts } } } })};\n`,
			);
			expect(() =>
				loadLibraryContract(
					"text",
					{ contract: "text.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow("one of string, bytes, or array");
		},
	);
});
