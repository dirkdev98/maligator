import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { describeBindingUnit } from "../src/ffi/binding-unit.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import contract from "./fixtures/ffi-reentry/reentry.ffi.ts";

describe("audited native reentry facts", () => {
	let directory: string;
	let model: CModel;
	beforeAll(() => {
		directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-reentry-facts-"));
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["reentry.h"],
			compileArguments: ["-I", path.resolve(import.meta.dirname, "fixtures/ffi-reentry")],
		});
	});
	afterAll(() => rmSync(directory, { recursive: true, force: true }));
	it.each([
		["reentry_text", false],
		["reentry_emit", true],
		["reentry_after", true],
		["reentry_owned_text", true],
		["reentry_open", true],
		["reentry_bad_result", true],
		["reentry_i32", false],
		["reentry_callable", false],
	] as const)(
		"publishes whole-wrapper JavaScript capability for %s",
		(name, callsUserCode) => {
			const plan = planBindings(model, contract);
			expect(describeBindingUnit("reentry", plan).direct[name]?.callsUserCode).toBe(
				callsUserCode,
			);
		},
	);
	it("keeps returned function pointers independent of their factory audit", () => {
		const plan = planBindings(model, contract);
		const callable = plan.functions.find(
			(entry) => entry.name === "reentry_callable",
		)!.returns;
		if (callable.kind !== "callable") throw new Error("Missing callable contract");
		expect(callable.signature.callsJavaScript).toBeUndefined();
	});
	it("preserves conservative native calls beside an audited function", () => {
		const plan = planBindings(model, { types: contract.types, functions: {} });
		const modules = describeBindingUnit("reentry", { ...plan, hasCallbacks: true });
		expect(modules.direct.reentry_text?.callsUserCode).toBe(true);
	});
	it.each([true, "false", 0, null])(
		"rejects invalid native audit %s",
		(callsJavaScript) => {
			writeFileSync(
				path.join(directory, "reentry.ffi.ts"),
				`export default ${JSON.stringify({ headers: ["reentry.h"], find: [{ includeDirs: ["."], sources: ["reentry.c"] }], functions: { reentry_text: { callsJavaScript } } })};\n`,
			);
			expect(() =>
				loadLibraryContract(
					"reentry",
					{ contract: "reentry.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow("callsJavaScript");
		},
	);
});
