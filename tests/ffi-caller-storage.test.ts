import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { generateBindingUnit } from "../src/ffi/binding-unit.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiHandle } from "../src/public-api.d.ts";

describe("caller storage contracts", () => {
	let model: CModel;
	it.each([
		{ storage: "caller", trailing: 2 },
		{ storage: "caller", trailing: "tail.member" },
		{ trailing: "tail" },
	])("rejects malformed trailing storage facts %j", (handle) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-trailing-facts-"));
		try {
			writeFileSync(
				path.join(directory, "state.ffi.ts"),
				`export default ${JSON.stringify({ headers: ["state.h"], types: { VariableState: { handle } } })};\n`,
			);
			expect(() =>
				loadLibraryContract(
					"state",
					{ contract: "state.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow("trailing");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
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
				path.resolve(import.meta.dirname, "fixtures/ffi-caller-storage/include"),
			],
		});
	});
	it("exports an allocator from the type fact and keeps caller structs pointer-based", () => {
		const plan = planBindings(model, {
			types: { CopiedState: { handle: { storage: "caller" } } },
			functions: {},
		});
		expect(plan.handles.get("CopiedState")).toMatchObject({
			representation: "pointer",
			allocator: "CopiedState",
		});
		expect(plan.unbound.some((entry) => entry.name === "caller_copy")).toBe(true);
		expect(generateBindingUnit("state", ["state.h"], model, plan).exports).toContain(
			"CopiedState",
		);
		expect([...generateDeclarations([{ name: "state", plan }])].join("")).toContain(
			"export function CopiedState(): CopiedState & {",
		);
	});
	it.each([
		["IncompleteState", { storage: "caller" }, "complete struct"],
		["VariableState", { storage: "caller" }, "allocation size"],
		["VariableState", { trailing: "tail" }, "caller storage"],
		["VariableState", { storage: "caller", trailing: "missing" }, "final flexible"],
		["VariableState", { storage: "caller", trailing: "length" }, "final flexible"],
		["NonfinalState", { storage: "caller", trailing: "tail" }, "final flexible"],
		["FixedTailState", { storage: "caller", trailing: "tail" }, "final flexible"],
		[
			"CallerState",
			{ storage: "caller", destroy: "caller_state_cleanup" },
			"cleanup must remain explicit",
		],
		["CallerState", { storage: "caller", collect: true }, "cleanup must remain explicit"],
	] satisfies Array<[string, MaligatorFfiHandle, string]>)(
		"rejects unsupported allocation for %s with %j",
		(name, handle, message) => {
			expect(() =>
				planBindings(model, { types: { [name]: { handle } }, functions: {} }),
			).toThrow(message);
		},
	);
	it.each(["VariableState", "WideState"])(
		"declares a trailing element count for %s",
		(name) => {
			const plan = planBindings(model, {
				types: { [name]: { handle: { storage: "caller", trailing: "tail" } } },
				functions: {},
			});
			expect([...generateDeclarations([{ name: "state", plan }])].join("")).toContain(
				`export function ${name}(length: bigint):`,
			);
			expect(plan.handles.get(name)?.fields.some((field) => field.name === "tail")).toBe(
				false,
			);
		},
	);
	it("rejects a factory that would hide an asynchronous function export", () => {
		expect(() =>
			planBindings(model, {
				types: { CallerState: { handle: { storage: "caller" } } },
				functions: { caller_state_live: { async: "CallerState" } },
			}),
		).toThrow("'CallerState' is already an export");
	});
});
