import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { generateBindingUnit } from "../src/ffi/binding-unit.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type {
	MaligatorFfiTypeFacts,
	MaligatorFfiValueFacts,
} from "../src/public-api.d.ts";

describe("managed C state contracts", () => {
	let model: CModel;
	beforeAll(() => {
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["state.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-managed-state"),
			],
		});
	});
	it("keeps caller field counts and C access permissions in the binding contract", () => {
		const plan = planBindings(model, {
			types: {
				ManagedState: {
					handle: { storage: "caller" },
					fields: {
						next_in: { bytes: { length: "avail_in", writable: false } },
						next_out: { bytes: { length: "avail_out" } },
					},
				},
			},
			functions: {},
		});
		expect(plan.handles.get("ManagedState")?.managedFields).toMatchObject([
			{ name: "next_in", count: "avail_in", writable: false },
			{ name: "next_out", count: "avail_out", writable: true },
		]);
		expect(plan.handles.get("ManagedState")?.fields.map((field) => field.name)).toEqual(
			expect.arrayContaining(["avail_in", "avail_out", "total"]),
		);
	});
	it("declares UTF-8 field snapshots and assignments as strings", () => {
		const plan = planBindings(model, {
			types: {
				ManagedText: {
					handle: { storage: "caller" },
					fields: { text: { string: { length: "remaining" } } },
				},
			},
			functions: {},
		});
		const declarations = generateDeclarations([{ name: "managed", plan }]);
		expect(declarations).toContain("get text(): string | null;");
		expect(declarations).toContain("set text(value: string | null);");
	});
	it.each([
		{},
		{ bytes: { length: "remaining" }, string: { length: "remaining" } },
		{ string: { length: "remaining", writable: true } },
	])("rejects ambiguous or unsupported state text facts %j", (field) => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-state-text-facts-"));
		try {
			writeFileSync(
				path.join(directory, "state.ffi.ts"),
				`export default ${JSON.stringify({ headers: ["state.h"], types: { ManagedText: { handle: { storage: "caller" }, fields: { text: field } } } })};\n`,
			);
			expect(() =>
				loadLibraryContract(
					"state",
					{ contract: "state.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		[
			"ManagedTextVoid",
			{
				handle: { storage: "caller" },
				fields: { text: { string: { length: "remaining" } } },
			},
			"byte pointer field",
		],
		[
			"ManagedState",
			{
				handle: { storage: "caller" },
				fields: {
					next_in: { bytes: { length: "avail_in" } },
					next_out: { string: { length: "avail_in" } },
				},
			},
			"already counts",
		],
		[
			"ManagedState",
			{ fields: { next_in: { bytes: { length: "avail_in" } } } },
			"caller storage",
		],
		[
			"ManagedState",
			{
				handle: { storage: "caller" },
				fields: { missing: { bytes: { length: "avail_in" } } },
			},
			"pointer field",
		],
		[
			"ManagedState",
			{
				handle: { storage: "caller" },
				fields: { avail_in: { bytes: { length: "avail_out" } } },
			},
			"pointer field",
		],
		[
			"ManagedState",
			{
				handle: { storage: "caller" },
				fields: { next_in: { bytes: { length: "next_out" } } },
			},
			"integer field",
		],
		[
			"ManagedState",
			{
				handle: { storage: "caller" },
				fields: {
					next_in: { bytes: { length: "avail_in" } },
					next_out: { bytes: { length: "avail_in" } },
				},
			},
			"already counts",
		],
		[
			"ManagedConst",
			{
				handle: { storage: "caller" },
				fields: { data: { bytes: { length: "length" } } },
			},
			"pointer field",
		],
		[
			"ManagedBits",
			{
				handle: { storage: "caller" },
				fields: { data: { bytes: { length: "length" } } },
			},
			"integer field",
		],
	] satisfies Array<[string, MaligatorFfiTypeFacts, string]>)(
		"rejects unsafe field facts for %s: %j",
		(name, facts, message) => {
			expect(() =>
				planBindings(model, { types: { [name]: facts }, functions: {} }),
			).toThrow(message);
		},
	);
	it("omits a C-computed struct size from the JavaScript arguments", () => {
		const plan = planBindings(model, {
			types: {},
			functions: { managed_abi_size: { params: { size: { sizeof: "ManagedState" } } } },
		});
		expect(
			plan.functions.find((entry) => entry.name === "managed_abi_size")?.params,
		).toEqual([]);
	});
	it("rejects a struct size that cannot fit the C integer parameter", () => {
		const plan = planBindings(model, {
			types: {},
			functions: { managed_small_size: { params: { size: { sizeof: "ManagedWide" } } } },
		});
		const binding = generateBindingUnit("managed", ["state.h"], model, plan);
		const compiled = spawnSync(
			process.env.CC ?? "clang",
			[
				"-std=c2x",
				"-fsyntax-only",
				"-x",
				"c",
				"-I",
				path.resolve(import.meta.dirname, "../runtime/src/ffi"),
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-managed-state"),
				"-",
			],
			{ input: binding.source, encoding: "utf8", timeout: 10000 },
		);
		expect(compiled.status).not.toBe(0);
		expect(compiled.stderr).toContain("C type size exceeds parameter range");
	});
	it.each([
		["managed_abi_size", "size", { sizeof: "Missing" }, "complete record"],
		["managed_abi_size", "size", { sizeof: "ManagedOpaque" }, "complete record"],
		["managed_copy", "state", { sizeof: "ManagedState" }, "integer parameter"],
		[
			"managed_abi_size",
			"size",
			{ sizeof: "ManagedState", constant: "0" },
			"no other role",
		],
	] satisfies Array<[string, string, MaligatorFfiValueFacts, string]>)(
		"rejects invalid ABI size facts for %s.%s",
		(name, param, facts, message) => {
			expect(() =>
				planBindings(model, {
					types: {},
					functions: { [name]: { params: { [param]: facts } } },
				}),
			).toThrow(message);
		},
	);
});
