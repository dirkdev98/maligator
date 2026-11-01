import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";

describe("waiting callback contracts", () => {
	let model: CModel;
	beforeAll(() => {
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["waiting.h"],
			compileArguments: ["-I", path.resolve(import.meta.dirname, "fixtures/ffi-waiting")],
		});
	});
	it.each(["waiting_set_integer", "waiting_set_record"])(
		"requires waiting for the result of %s",
		(name) => {
			expect(() =>
				planBindings(model, {
					types: {},
					functions: {
						[name]: {
							params: {
								callback: {
									callback: { data: "data", release: "release", queued: true },
								},
							},
						},
					},
				}),
			).toThrow("a queued callback returns nothing");
		},
	);
	it("requires a retained callback for foreign-thread waiting", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-waiting-facts-"));
		try {
			writeFileSync(
				path.join(directory, "waiting.ffi.ts"),
				`export default ${JSON.stringify({
					headers: ["waiting.h"],
					functions: {
						waiting_set_integer: {
							params: { callback: { callback: { data: "data", queued: "wait" } } },
						},
					},
				})};\n`,
			);
			expect(() =>
				loadLibraryContract(
					"waiting",
					{ contract: "waiting.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow("on a callback the library keeps");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
