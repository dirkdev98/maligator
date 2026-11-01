import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import type { LibraryFacts } from "../src/ffi/contract.ts";
import { suggestFacts } from "../src/ffi/suggest.ts";
import type { MaligatorFfiHandle } from "../src/public-api.d.ts";

describe("conditional cleanup facts", () => {
	let model: CModel;
	beforeAll(() => {
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["release.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-conditional-destroy"),
			],
		});
	});
	const facts = (handle: MaligatorFfiHandle): LibraryFacts => ({
		types: { BusyResource: { handle } },
		functions: {},
	});
	it("preserves new lifetime facts on pointer results", () => {
		const plan = planBindings(model, {
			...facts({}),
			functions: { release_open: { returns: { fresh: true } } },
		});
		expect(
			plan.functions.find((entry) => entry.name === "release_open")?.returns,
		).toMatchObject({
			kind: "handle",
			pass: "pointer",
			fresh: true,
		});
	});
	it.each([
		{ release_value: { returns: { fresh: true } } },
		{ release_value: { params: { resource: { fresh: true } } } },
	])("rejects a fresh fact outside pointer results: %j", (functions) => {
		expect(() => planBindings(model, { ...facts({}), functions })).toThrow(
			"fresh applies only to pointer handle results",
		);
	});
	it.each(["0", "RELEASE_OK"])(
		"accepts the explicit successful cleanup code %s",
		(success) => {
			const plan = planBindings(
				model,
				facts({ destroy: { function: "release_close", success } }),
			);
			expect(plan.handles.get("BusyResource")?.destroy).toMatchObject({
				name: "release_close",
				success,
			});
			expect(plan.functions.find((entry) => entry.name === "release_close")?.closes).toBe(
				0,
			);
		},
	);
	it("accepts a boolean cleanup result with an explicit true success code", () => {
		const plan = planBindings(model, {
			types: {
				BooleanResource: {
					handle: { destroy: { function: "release_boolean_close", success: "true" } },
				},
			},
			functions: {},
		});
		expect(plan.handles.get("BooleanResource")?.destroy).toMatchObject({
			success: "true",
		});
	});
	it.each([
		[
			{ destroy: { function: "release_close", success: "UNDECLARED_STATUS" } },
			"known integer constant",
		],
		[
			{ destroy: { function: "release_close", success: "0" }, collect: true },
			"explicit disposal",
		],
		[
			{ destroy: { function: "release_busy", success: "0" } },
			"return an integer or boolean",
		],
	] satisfies Array<[MaligatorFfiHandle, string]>)(
		"rejects an unsafe conditional cleanup contract %j",
		(handle, error) => {
			expect(() => planBindings(model, facts(handle))).toThrow(error);
		},
	);
	it("requires the explicit destroy binding to keep its handle argument", () => {
		expect(() =>
			planBindings(model, {
				...facts({ destroy: { function: "release_close", success: "0" } }),
				functions: { release_close: { params: { resource: { constant: "0" } } } },
			}),
		).toThrow("keep its handle as an input");
	});
	it("does not infer unconditional release from a nonvoid destructor name", () => {
		const plan = planBindings(model);
		const suggestions = suggestFacts(model, { types: {}, functions: {} }, plan);
		expect(suggestions.types.BusyResource?.handle?.destroy).toBeUndefined();
		expect(suggestions.types.AlwaysResource?.handle?.destroy).toBeUndefined();
	});
});
