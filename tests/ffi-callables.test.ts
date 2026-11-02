import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiValueFacts } from "../src/public-api.d.ts";
import contract from "./fixtures/ffi-callables/callables.ffi.ts";

describe("returned C function contracts", () => {
	let model: CModel;
	beforeAll(() => {
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["callables.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-callables"),
			],
		});
	});
	it("loads nested callable facts from a contract", () => {
		expect(
			loadLibraryContract(
				"callables",
				{ contract: "callables.ffi.ts" },
				path.join(import.meta.dirname, "fixtures/ffi-callables"),
				stripCompactTypes,
			),
		).toBeDefined();
	});
	it.each([
		"export function callable_choose(mode: number): ((arg1: number) => number) | null;",
		"export function callable_choose_async(mode: number): Promise<((arg1: number) => number) | null>;",
		"export function callable_bytes(): ((arg1: ArrayBufferLike | ArrayBufferView) => number) | null;",
		"export function callable_out(): ((arg1: number) => { result: number; arg2: number }) | null;",
		"export function callable_factory(): ((arg1: number) => ((arg1: number) => number) | null) | null;",
	])("declares the callable ABI %s", (signature) => {
		const plan = planBindings(model, { types: {}, functions: contract.functions });
		const declarations = [...generateDeclarations([{ name: "callables", plan }])].join(
			"",
		);
		expect(declarations).toContain(signature);
	});
	it("leaves a function pointer unbound without a lifetime assertion", () => {
		const plan = planBindings(model, { types: {}, functions: {} });
		expect(plan.unbound.some(({ name }) => name === "callable_choose")).toBe(true);
	});
	it("rejects callable facts on an input", () => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: {
					callable_choose: { params: { mode: { callable: { lifetime: "library" } } } },
				},
			}),
		).toThrow("applies to returned function pointers");
	});
	it("rejects a parameter position outside the pointed-to signature", () => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: {
					callable_choose: {
						returns: { callable: { lifetime: "library", params: { "2": {} } } },
					},
				},
			}),
		).toThrow("function pointer has no such parameter");
	});
	it.each<MaligatorFfiValueFacts>([
		{ borrowed: true },
		{ fresh: true },
		{ free: "release" },
		{ string: true },
		{ callback: {} },
	])("rejects conflicting callable facts %j", (facts) => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: {
					callable_choose: {
						returns: { ...facts, callable: { lifetime: "library" } },
					},
				},
			}),
		).toThrow("cannot accompany another value representation");
	});
	it("leaves a variadic function pointer unbound without a fixed signature", () => {
		const plan = planBindings(model, {
			types: {},
			functions: {
				callable_variadic: { returns: { callable: { lifetime: "library" } } },
			},
		});
		expect(plan.unbound.find(({ name }) => name === "callable_variadic")?.gaps).toEqual([
			{ at: "return", reason: "a callable function pointer needs a fixed signature" },
		]);
	});
	it.each([
		{},
		{ lifetime: "call" },
		{ lifetime: "library", params: { value: {} } },
		{ lifetime: "library", params: { "0": {} } },
	])("rejects an incomplete callable contract %j", (callable) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-callable-facts-"));
		try {
			writeFileSync(
				path.join(directory, "library.ffi.ts"),
				`export default ${JSON.stringify({
					headers: ["callables.h"],
					find: [{ includeDirs: ["."], sources: ["callables.c"] }],
					functions: { callable_choose: { returns: { callable } } },
				})};`,
			);
			expect(() =>
				loadLibraryContract(
					"callables",
					{ contract: "library.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow("callable");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
