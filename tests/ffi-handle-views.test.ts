import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import type { MaligatorFfiHandle } from "../src/public-api.d.ts";

describe("directed C handle views", () => {
	let model: CModel;
	beforeAll(() => {
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["views.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-handle-views"),
			],
		});
	});
	it("resolves aliases and transitive views while keeping compatibility directed", () => {
		const plan = planBindings(model, {
			types: {
				ViewBase: { handle: {} },
				ViewMiddle: { handle: { views: ["ViewBaseAlias"] } },
				ViewDerived: { handle: { views: ["ViewMiddle"] } },
			},
			functions: {},
		});
		expect(plan.handles.get("ViewDerived")).toMatchObject({
			views: ["ViewBase", "ViewMiddle"],
			family: "ViewBase",
		});
		expect(plan.handles.get("ViewBase")).toMatchObject({ views: [], family: "ViewBase" });
	});
	it("rejects two callable declarations with the same property name in one family", () => {
		expect(() =>
			planBindings(model, {
				types: {
					ViewBase: { handle: {}, fields: { read: { callable: { lifetime: "owner" } } } },
					ViewDerived: {
						handle: { views: ["ViewBase"] },
						fields: { read: { callable: { lifetime: "owner" } } },
					},
				},
				functions: {},
			}),
		).toThrow("callable view field conflicts with ViewBase.read");
	});
	it.each([
		[{ ViewDerived: { views: ["Missing"] } }, "needs a handle fact"],
		[{ ViewDerived: { views: ["ViewBase"] } }, "needs a handle fact"],
		[{ ViewBase: { views: ["ViewBaseAlias"] } }, "self view"],
		[{ ViewBase: {}, ViewDerived: { views: ["ViewBase", "ViewBaseAlias"] } }, "repeated"],
		[
			{ ViewBase: { views: ["ViewDerived"] }, ViewDerived: { views: ["ViewBase"] } },
			"cyclic",
		],
		[{ ViewBase: {}, ViewCopied: { views: ["ViewBase"] } }, "pointer handles"],
		[{ ViewCopied: {}, ViewDerived: { views: ["ViewCopied"] } }, "pointer handles"],
	] satisfies Array<[Record<string, MaligatorFfiHandle>, string]>)(
		"rejects invalid compatibility %j",
		(handles, message) => {
			expect(() =>
				planBindings(model, {
					types: Object.fromEntries(
						Object.entries(handles).map(([name, handle]) => [name, { handle }]),
					),
					functions: {},
				}),
			).toThrow(message);
		},
	);
});
