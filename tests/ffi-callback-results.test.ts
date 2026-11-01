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
import { generateDeclarations } from "../src/ffi/declarations.ts";
import resultContract from "./fixtures/ffi-callback-results/results.ffi.ts";

describe("callback pointer result contracts", () => {
	let model: CModel;
	beforeAll(() => {
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["results.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-callback-results"),
			],
		});
	});
	it("declares pointer representations and hides native result counts", () => {
		const plan = planBindings(model, { types: {}, functions: resultContract.functions });
		const declarations = generateDeclarations([{ name: "results", plan }]);
		expect(declarations).toContain(
			"export function result_counted(callback: (arg1: number) => string | null): string | null;",
		);
		expect(declarations).toContain(
			"export function result_bytes(callback: (arg1: number) => ArrayBufferLike | ArrayBufferView | null): Uint8Array | null;",
		);
		expect(declarations).toContain(
			"export function result_retain(callback: (arg1: number) => string | null): void;",
		);
		expect(declarations).toContain(
			"export function result_retain_bytes_async(callback: (arg1: number) => ArrayBufferLike | ArrayBufferView | null): Promise<void>;",
		);
	});
	it("loads registration result facts through a library contract", () => {
		const loaded = loadLibraryContract(
			"results",
			{ contract: "results.ffi.ts" },
			path.join(import.meta.dirname, "fixtures/ffi-callback-results"),
			stripCompactTypes,
		);
		expect(loaded).toBeDefined();
	});
	it("requires an explicit pointer-result lifetime", () => {
		const plan = planBindings(model, {
			types: {},
			functions: {
				result_text: { params: { callback: { callback: { data: "data" } } } },
			},
		});
		expect(
			plan.unbound
				.find((entry) => entry.name === "result_text")
				?.gaps.map((gap) => gap.reason)
				.join(" "),
		).toContain("lifetime fact");
	});
	it.each(["2", "3", "9"])(
		"rejects result count position %s without a writable integer pointer",
		(length) => {
			expect(() =>
				planBindings(model, {
					types: {},
					functions: {
						result_counted: {
							params: {
								callback: {
									callback: {
										data: "data",
										returns: { lifetime: "call", string: { length } },
									},
								},
							},
						},
					},
				}),
			).toThrow("writable supported integer pointer");
		},
	);
	it.each(["result_const_count", "result_wide_count"])(
		"rejects an unsupported result count on %s",
		(name) => {
			expect(() =>
				planBindings(model, {
					types: {},
					functions: {
						[name]: {
							params: {
								callback: {
									callback: {
										data: "data",
										returns: { lifetime: "call", string: { length: "1" } },
									},
								},
							},
						},
					},
				}),
			).toThrow("writable supported integer pointer");
		},
	);
	it("rejects a call lifetime on a retained callback", () => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: {
					result_retain: {
						params: {
							callback: {
								callback: {
									data: "data",
									release: "release",
									returns: { lifetime: "call" },
								},
							},
						},
					},
				},
			}),
		).toThrow("call-scoped callback");
	});
	it("rejects a registration lifetime on a call-scoped callback", () => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: {
					result_text: {
						params: {
							callback: {
								callback: {
									data: "data",
									returns: { lifetime: "registration" },
								},
							},
						},
					},
				},
			}),
		).toThrow("registration lifetime needs a retained callback");
	});
	it("rejects pointer results from a completion that ends its registration", () => {
		expect(() =>
			planBindings(model, {
				types: { ResultResource: { handle: {} } },
				functions: {
					result_close: {
						params: {
							callback: {
								callback: {
									data: "data",
									closes: "resource",
									queued: "wait",
									returns: { lifetime: "registration" },
								},
							},
						},
					},
				},
			}),
		).toThrow("a close completion ends its registration");
	});
	it("rejects a pointer lifetime on a scalar result", () => {
		expect(() =>
			planBindings(model, {
				types: {},
				functions: {
					result_scalar: {
						params: { callback: { callback: { returns: { lifetime: "call" } } } },
					},
				},
			}),
		).toThrow("pointer results");
	});
	it.each([
		{ lifetime: "call", free: "free" },
		{ lifetime: "call", string: true, bytes: { length: "1" } },
		{ lifetime: "forever", string: true },
		{ string: true },
	])("rejects incomplete or conflicting pointer result facts %j", (returns) => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-pointer-result-facts-"));
		try {
			writeFileSync(
				path.join(directory, "results.ffi.ts"),
				`export default ${JSON.stringify({ headers: ["results.h"], functions: { result_text: { params: { callback: { callback: { data: "data", returns } } } } } })};\n`,
			);
			expect(() =>
				loadLibraryContract(
					"results",
					{ contract: "results.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
