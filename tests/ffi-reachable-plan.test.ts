import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import type { BindingPlan } from "../src/ffi/binding-plan.ts";
import { callbackExports, reachableBindingPlan } from "../src/ffi/binding-reach.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import asyncContract from "./fixtures/ffi-async-callbacks/async.ffi.ts";
import viewsContract from "./fixtures/ffi-handle-views/views.ffi.ts";
import ownerContract from "./fixtures/ffi-owner-fields/owner.ffi.ts";
import registrationContract from "./fixtures/ffi-root-registrations/lifetime.ffi.ts";

function fixturePlan(
	fixture: string,
	header: string,
	contract: Parameters<typeof planBindings>[1],
): BindingPlan {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	const model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: [header],
		compileArguments: ["-I", path.resolve(import.meta.dirname, "fixtures", fixture)],
	});
	return planBindings(model, contract);
}

function reachedSurface(plan: BindingPlan, exports: ReadonlyArray<string>) {
	const reached = reachableBindingPlan(plan, new Set(exports));
	return {
		handles: [...reached.handles.keys()].sort(),
		hasCallbacks: reached.hasCallbacks,
	};
}

describe("reachable binding plans", () => {
	let views: BindingPlan;
	beforeAll(() => {
		views = fixturePlan("ffi-handle-views", "views.h", viewsContract);
	});

	it.each([
		// A view's descriptor points at the views and the family's registry key.
		["views_read_sibling", ["ViewBase", "ViewSibling"], false],
		// Callable fields keep the callbacks their signatures accept.
		["views_read_derived", ["ViewBase", "ViewDerived", "ViewMiddle"], true],
		["views_lend", ["ViewBase"], true],
		// An allocator export reaches the storage type it allocates.
		["ViewCaller", ["ViewBase", "ViewCaller"], false],
		["views_unrelated", ["ViewUnrelated"], false],
		["views_copy", ["ViewCopied"], false],
	] as const)("%s reaches only its handle types", (name, handles, hasCallbacks) => {
		expect(reachedSurface(views, [name])).toEqual({ handles, hasCallbacks });
	});

	it("keeps the complete plan's callback reentry when every export is read", () => {
		const everything = [
			...views.functions.map((binding) => binding.name),
			...[...views.handles.values()].flatMap((handle) =>
				handle.allocator === undefined ? [] : [handle.allocator],
			),
		];
		expect(reachedSurface(views, everything)).toEqual({
			handles: [...views.handles.keys()].sort(),
			hasCallbacks: views.hasCallbacks,
		});
	});

	it("keeps an async twin only when the program reads it", () => {
		const plan = fixturePlan("ffi-async-callbacks", "async.h", asyncContract);
		const twin = (exports: ReadonlyArray<string>) =>
			reachableBindingPlan(plan, new Set(exports)).functions.map((binding) => [
				binding.name,
				binding.async,
			]);
		expect(twin(["async_replaced_data_call"])).toEqual([
			["async_replaced_data_call", undefined],
		]);
		expect(twin(["async_replaced_data_call_async"])).toEqual([
			["async_replaced_data_call", "async_replaced_data_call_async"],
		]);
	});

	it.each([
		["ffi-handle-views", "views.h", viewsContract],
		["ffi-async-callbacks", "async.h", asyncContract],
		["ffi-owner-fields", "owner.h", ownerContract],
		["ffi-root-registrations", "lifetime.h", registrationContract],
	] as const)(
		"finds the %s exports that reach callbacks in one pass",
		(fixture, header, contract) => {
			const plan = fixturePlan(fixture, header, contract);
			const exports = [
				...plan.functions.flatMap((binding) =>
					binding.async === undefined ? [binding.name] : [binding.name, binding.async],
				),
				...plan.dispatchers.map((dispatch) => dispatch.name),
				...plan.constants.map((constant) => constant.name),
				...[...plan.handles.values()].flatMap((handle) =>
					handle.allocator === undefined ? [] : [handle.allocator],
				),
			];
			expect([...callbackExports(plan)].sort()).toEqual(
				exports
					.filter((name) => reachableBindingPlan(plan, new Set([name])).hasCallbacks)
					.sort(),
			);
		},
	);
});
