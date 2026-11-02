import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CExtractionInput } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import type { FfiInspection } from "../src/ffi/inspect.ts";
import { loadCModel } from "../src/ffi/model-cache.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";

describe("C global declarations", () => {
	let directory: string;
	let request: CExtractionInput;
	let model: CModel;
	beforeAll(() => {
		directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-globals-"));
		const compiler = resolvePathExecutable(process.env.CC ?? "clang");
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		writeFileSync(
			path.join(directory, "globals.h"),
			`
/** Current native mode. */
extern int native_mode;
extern const int native_limit;
extern _Thread_local int native_thread;
static int native_private;
extern int native_private;
constexpr int native_constant = 7;
static inline int native_read(void) { static int local_state; return local_state; }
#define NATIVE_CALL __attribute__((ms_abi))
extern int (NATIVE_CALL *native_transform)(int);
`,
		);
		request = {
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["globals.h"],
			compileArguments: ["-target", "x86_64-unknown-linux-gnu", "-I", directory],
		};
		model = extractCModel(request);
	});
	afterAll(() => rmSync(directory, { recursive: true, force: true }));
	it("retains qualifiers and thread-local storage on external objects", () => {
		expect(model.globals.find(({ name }) => name === "native_mode")).toMatchObject({
			linkage: "external",
			threadLocal: false,
			type: { kind: "integer", name: "int" },
		});
		expect(model.globals.find(({ name }) => name === "native_limit")).toMatchObject({
			linkage: "external",
			type: { kind: "integer", name: "int", const: true },
		});
		expect(model.globals.find(({ name }) => name === "native_thread")).toMatchObject({
			linkage: "external",
			threadLocal: true,
		});
	});
	it.each(["native_private", "native_constant"])(
		"keeps %s internal when its declaration has no exported object",
		(name) =>
			expect(model.globals.find((global) => global.name === name)?.linkage).toBe(
				"internal",
			),
	);
	it("excludes a function's local static objects", () => {
		expect(model.globals.some(({ name }) => name === "local_state")).toBe(false);
	});
	it("recovers macro-qualified global function pointer types", () => {
		expect(
			model.globals.find(({ name }) => name === "native_transform")?.type,
		).toMatchObject({
			kind: "pointer",
			to: {
				kind: "function",
				returns: { kind: "integer", name: "int" },
				params: [{ kind: "integer", name: "int" }],
			},
		});
	});
	it("preserves global types through warm caching and header changes", () => {
		const header = path.join(directory, "cache.h");
		const cached = { ...request, headers: ["cache.h"] };
		writeFileSync(header, "extern int cache_mode;\n");
		const first = loadCModel(cached);
		expect(loadCModel(cached)).toEqual(first);
		expect(first.globals[0]?.type).toEqual({ kind: "integer", name: "int" });
		writeFileSync(header, "extern double cache_mode;\n");
		expect(loadCModel(cached).globals[0]?.type).toEqual({
			kind: "float",
			name: "double",
		});
	});
	it("exposes global qualifiers through CLI inspection", () => {
		writeFileSync(
			path.join(directory, "inspect.h"),
			"extern const int inspected_limit;\n",
		);
		writeFileSync(path.join(directory, "empty.c"), "");
		writeFileSync(
			path.join(directory, "globals.ffi.ts"),
			'export default {headers:["inspect.h"],find:[{includeDirs:["."],sources:["empty.c"]}]};\n',
		);
		writeFileSync(
			path.join(directory, "maligator.build.ts"),
			'export default {ffi:{globals:{contract:"globals.ffi.ts"}}};\n',
		);
		const result = spawnSync(
			process.execPath,
			[
				path.resolve(import.meta.dirname, "../src/index.ts"),
				"ffi",
				"inspect",
				"globals",
				"--json",
			],
			{ cwd: directory, encoding: "utf8", timeout: 30_000 },
		);
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const inspection = JSON.parse(result.stdout) as FfiInspection;
		expect(
			inspection.model.globals.find(({ name }) => name === "inspected_limit"),
		).toMatchObject({
			linkage: "external",
			type: { kind: "integer", name: "int", const: true },
		});
	});
});
