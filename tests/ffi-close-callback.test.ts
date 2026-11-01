import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import type { MaligatorFfiValueFacts } from "../src/public-api.d.ts";

describe("one-shot C close completion contracts", () => {
	let model: CModel;
	beforeAll(() => {
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["close.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-close-callback"),
			],
		});
	});
	it("routes a one-shot completion by its canonical handle", () => {
		const plan = planBindings(model, {
			types: { CloseBase: { handle: {} } },
			functions: { close_later: { params: { done: { callback: { closes: "1" } } } } },
		});
		expect(
			plan.functions.find((binding) => binding.name === "close_later")?.params[1]?.value,
		).toMatchObject({
			kept: true,
			queued: true,
			closes: { param: 0, key: 0, keyParam: 0 },
			params: [{ nullable: false }],
		});
	});
	it.each([
		["close_later", { callback: { closes: "missing" } }, "pointer handle input"],
		["close_later", { nullable: true, callback: { closes: "handle" } }, "nonnullable"],
		[
			"close_later",
			{ callback: { closes: "handle", params: { "1": { nullable: true } } } },
			"nonnullable",
		],
		["close_status", { callback: { closes: "handle" } }, "returns void"],
		["close_wrong", { callback: { closes: "handle" } }, "closing handle"],
		["close_missing", { callback: { closes: "handle" } }, "handle or user data"],
	] satisfies Array<[string, MaligatorFfiValueFacts, string]>)(
		"rejects an unsound lifetime on %s with %j",
		(name, done, message) => {
			expect(() =>
				planBindings(model, {
					types: { CloseBase: { handle: {} }, CloseOther: { handle: {} } },
					functions: { [name]: { params: { done } } },
				}),
			).toThrow(message);
		},
	);
});
