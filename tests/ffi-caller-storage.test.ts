import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { generateBindingUnit } from "../src/ffi/binding-unit.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { MaligatorFfiHandle } from "../src/public-api.d.ts";

describe("caller storage contracts", () => {
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
		expect(generateDeclarations([{ name: "state", plan }])).toContain(
			"export function CopiedState(): CopiedState & {",
		);
	});
	it.each([
		["IncompleteState", { storage: "caller" }, "complete struct"],
		["VariableState", { storage: "caller" }, "allocation size"],
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
	it("rejects a factory that would hide an asynchronous function export", () => {
		expect(() =>
			planBindings(model, {
				types: { CallerState: { handle: { storage: "caller" } } },
				functions: { caller_state_live: { async: "CallerState" } },
			}),
		).toThrow("'CallerState' is already an export");
	});
});
