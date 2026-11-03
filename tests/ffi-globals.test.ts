import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CExtractionInput } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import type { FfiInspection } from "../src/ffi/inspect.ts";
import { loadCModel } from "../src/ffi/model-cache.ts";
import type { MaligatorFfiGlobalFacts } from "../src/public-api.d.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";
import globalContract from "./fixtures/ffi-globals/globals.ffi.ts";

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

describe("C global accessor contracts", () => {
	const fixture = path.join(import.meta.dirname, "fixtures/ffi-globals");
	let model: CModel;
	beforeAll(() => {
		const compiler = resolvePathExecutable(process.env.CC ?? "clang");
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["globals.h"],
			compileArguments: ["-I", fixture],
		});
	});
	function plan(globals: Record<string, MaligatorFfiGlobalFacts>) {
		return planBindings(model, { types: globalContract.types, functions: {}, globals });
	}
	it("exposes nullable copied values for replacement lifetimes", () => {
		const binding = plan({
			globals_retained_title: {
				get: "readText",
				set: "writeText",
				value: { string: true, lifetime: "replacement" },
			},
			globals_retained_bytes: {
				get: "readBytes",
				set: "writeBytes",
				value: { bytes: { length: "globals_retained_count" }, lifetime: "replacement" },
			},
		});
		const sdk = [...generateDeclarations([{ name: "globals", plan: binding }])].join("");
		expect(sdk).toContain("readText(): string | null");
		expect(sdk).toContain("writeText(value: string | null): void");
		expect(sdk).toContain("readBytes(): Uint8Array | null");
		expect(sdk).toContain(
			"writeBytes(value: ArrayBufferLike | ArrayBufferView | null): void",
		);
	});
	it.each([
		[
			"globals_retained_tls",
			{ string: true, lifetime: "replacement" },
			"non-TLS pointer",
		],
		["globals_retained_const", { string: true, lifetime: "replacement" }, "assignable"],
		["globals_mode", { string: true, lifetime: "replacement" }, "pointer"],
		[
			"globals_context",
			{ bytes: { length: "globals_retained_count" }, lifetime: "replacement" },
			"byte storage",
		],
		[
			"globals_retained_bytes",
			{ bytes: { length: "globals_limit" }, lifetime: "replacement" },
			"writable external",
		],
		[
			"globals_retained_bytes",
			{ bytes: { length: "globals_thread" }, lifetime: "replacement" },
			"non-TLS integer",
		],
		[
			"globals_retained_bytes",
			{ bytes: { length: "globals_ratio" }, lifetime: "replacement" },
			"integer",
		],
		[
			"globals_retained_bytes",
			{ bytes: { length: "missing_count" }, lifetime: "replacement" },
			"external",
		],
	] satisfies Array<[string, NonNullable<MaligatorFfiGlobalFacts["value"]>, string]>)(
		"rejects unsupported retained storage on %s with %j",
		(name, value, reason) => {
			expect(() => plan({ [name]: { set: "write", value } })).toThrow(reason);
		},
	);
	it("keeps a retained count exclusive to its pointer", () => {
		const bytes: MaligatorFfiGlobalFacts = {
			set: "writeBytes",
			value: { bytes: { length: "globals_retained_count" }, lifetime: "replacement" },
		};
		expect(() =>
			plan({
				globals_retained_bytes: bytes,
				globals_retained_count: { set: "writeCount" },
			}),
		).toThrow("exclusively");
		expect(() =>
			plan({
				globals_retained_bytes: bytes,
				globals_retained_title: { ...bytes, set: "writeOther" },
			}),
		).toThrow("exclusively");
	});
	it("loads explicit accessor and documentation facts", () => {
		const contract = loadLibraryContract(
			"globals",
			{ contract: "globals.ffi.ts" },
			fixture,
			stripCompactTypes,
		);
		expect(contract.facts.globals?.globals_mode).toMatchObject({
			get: "getMode",
			set: "setMode",
			evidence: [{ kind: "global", name: "globals_mode" }],
		});
	});
	it.each(["class", "default", "get-mode"])(
		"rejects %s as an accessor export name",
		(name) => {
			const directory = mkdtempSync(path.join(tmpdir(), "mal-global-name-"));
			try {
				writeFileSync(
					path.join(directory, "invalid.ffi.ts"),
					`export default ${JSON.stringify({ headers: ["api.h"], find: [{ libraries: ["fixture"] }], globals: { mode: { get: name } } })};`,
				);
				expect(() =>
					loadLibraryContract(
						"fixture",
						{ contract: "invalid.ffi.ts" },
						directory,
						stripCompactTypes,
					),
				).toThrow("function export name");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
	it.each([
		[
			"globals_fixed_label",
			{ set: "writeFixedLabel", value: { string: true } },
			"assignable",
		],
		["globals_mode", { get: "readBytes", value: { bytes: true } }, "fixed byte array"],
		["globals_limit", { set: "writeLimit" }, "assignable"],
		["globals_aliased_limit", { set: "writeAliasedLimit" }, "assignable"],
		["globals_title", { set: "writeTitle" }, "retained pointers"],
		["globals_context", { get: "readContext" }, "borrowed: true"],
		["globals_private", { get: "readPrivate" }, "externally linked"],
		["globals_incomplete", { get: "readValues" }, "resource-free"],
		["globals_empty", { get: "readEmpty" }, "resource-free"],
		["globals_oversized", { get: "readOversized" }, "resource-free"],
		["globals_fixed_values", { set: "writeFixedValues" }, "assignable"],
		["globals_values", { get: "readValues", value: { string: true } }, "byte array"],
		["globals_mode", {}, "getter or setter"],
		["missing_global", { get: "readMissing" }, "no global"],
	] satisfies Array<[string, MaligatorFfiGlobalFacts, string]>)(
		"rejects unsafe access to %s with %j",
		(name, facts, message) => {
			expect(() => plan({ [name]: facts })).toThrow(message);
		},
	);
	it.each([
		{ free: "release" },
		{ fresh: true },
		{ out: true },
		{ inout: true },
		{ bytes: { length: "count" } },
		{ string: { length: "count" } },
		{ bytes: true, string: true },
	])("rejects function-only or ambiguous global conversion facts %j", (value) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-global-value-"));
		try {
			writeFileSync(
				path.join(directory, "invalid.ffi.ts"),
				`export default ${JSON.stringify({ headers: ["api.h"], find: [{ libraries: ["fixture"] }], globals: { buffer: { get: "readBuffer", value } } })};`,
			);
			expect(() =>
				loadLibraryContract(
					"fixture",
					{ contract: "invalid.ffi.ts" },
					directory,
					stripCompactTypes,
				),
			).toThrow("globals.buffer.value");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each(["globals_advance", "GLOBALS_CONSTANT"])(
		"rejects the existing export %s as an accessor",
		(name) => {
			expect(() => plan({ globals_mode: { get: name } })).toThrow("already an export");
		},
	);
	it("rejects accessor names already used by another global or async export", () => {
		expect(() =>
			plan({ globals_mode: { get: "readValue" }, globals_limit: { get: "readValue" } }),
		).toThrow("already an export");
		expect(() =>
			planBindings(model, {
				types: {},
				functions: { globals_advance: { async: "readMode" } },
				globals: { globals_mode: { get: "readMode" } },
			}),
		).toThrow("already an export");
	});
	it("rejects accessor names already used by caller-storage factories", () => {
		const types = { GlobalsPoint: { handle: { storage: "caller" as const } } };
		const allocator = planBindings(model, { types, functions: {} }).handles.get(
			"GlobalsPoint",
		)!.allocator!;
		expect(() =>
			planBindings(model, {
				types,
				functions: {},
				globals: { globals_mode: { get: allocator } },
			}),
		).toThrow("already an export");
	});
	it("exports only the requested write access", () => {
		const accessors = plan({ globals_mode: { set: "writeMode" } }).functions.filter(
			(binding) => binding.global !== undefined,
		);
		expect(accessors.map(({ name, global }) => [name, global?.access])).toEqual([
			["writeMode", "set"],
		]);
	});
	it.each(["globals_resource", "globals_resource_holder", "globals_resources"])(
		"rejects persistent copies of a resource handle in %s",
		(name) => {
			const directory = mkdtempSync(path.join(tmpdir(), "mal-global-resource-"));
			try {
				const compiler = resolvePathExecutable(process.env.CC ?? "clang");
				const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
				expect(version.status, version.stderr).toBe(0);
				writeFileSync(
					path.join(directory, "resource.h"),
					`typedef struct Resource { int descriptor; } Resource;
typedef struct Holder { Resource resource; } Holder;
extern Resource globals_resource;
extern Holder globals_resource_holder;
extern Resource globals_resources[2];
void release_resource(Resource resource);
`,
				);
				const extracted = extractCModel({
					compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
					environment: process.env,
					headers: ["resource.h"],
					compileArguments: ["-I", directory],
				});
				expect(() =>
					planBindings(extracted, {
						types: { Resource: { handle: { destroy: "release_resource" } } },
						functions: {},
						globals: { [name]: { set: "setResource" } },
					}),
				).toThrow("assignable");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
	it("watches hidden sizeof dependencies in nested global callable facts", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-global-sizeof-"));
		try {
			const header = path.join(directory, "api.h");
			writeFileSync(
				header,
				"typedef struct Config { int size; } Config;\nextern void (*(*factory)(void))(unsigned long);\n",
			);
			writeFileSync(
				path.join(directory, "api.c"),
				'#include "api.h"\nvoid (*(*factory)(void))(unsigned long);\n',
			);
			writeFileSync(
				path.join(directory, "maligator.build.ts"),
				'export default {ffi:{api:{contract:"api.ffi.ts"}}};\n',
			);
			writeFileSync(
				path.join(directory, "api.ffi.ts"),
				`export default ${JSON.stringify({
					headers: ["api.h"],
					find: [{ includeDirs: ["."], sources: ["api.c"] }],
					globals: {
						factory: {
							get: "getFactory",
							value: {
								callable: {
									lifetime: "library",
									returns: {
										callable: {
											lifetime: "library",
											params: { "1": { sizeof: "Config" } },
										},
									},
								},
							},
						},
					},
				})};\n`,
			);
			const cli = (...args: Array<string>) =>
				spawnSync(
					process.execPath,
					[
						path.resolve(import.meta.dirname, "../src/index.ts"),
						"ffi",
						"check",
						"api",
						...args,
					],
					{ cwd: directory, encoding: "utf8", timeout: 30_000 },
				);
			const accepted = cli("--update");
			expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
			writeFileSync(
				header,
				readFileSync(header, "utf8").replace("int size", "long size"),
			);
			const changed = cli();
			expect(changed.status).not.toBe(0);
			expect(changed.stderr + changed.stdout).toContain("struct Config");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);
	it("requires ABI review when a bounded byte global changes capacity", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-global-capacity-"));
		try {
			const header = path.join(directory, "api.h");
			writeFileSync(header, "extern unsigned char payload[4];\n");
			writeFileSync(path.join(directory, "api.c"), "");
			writeFileSync(
				path.join(directory, "maligator.build.ts"),
				'export default {ffi:{abi_bytes:{contract:"api.ffi.ts"}}};\n',
			);
			writeFileSync(
				path.join(directory, "api.ffi.ts"),
				`export default ${JSON.stringify({ headers: ["api.h"], find: [{ includeDirs: ["."], sources: ["api.c"] }], globals: { payload: { get: "getPayload", set: "setPayload", value: { bytes: true } } } })};\n`,
			);
			const check = (...args: Array<string>) =>
				spawnSync(
					process.execPath,
					[
						path.resolve(import.meta.dirname, "../src/index.ts"),
						"ffi",
						"check",
						"--json",
						...args,
					],
					{ cwd: directory, encoding: "utf8", timeout: 30_000 },
				);
			const accepted = check("--update");
			expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
			writeFileSync(header, "extern unsigned char payload[8];\n");
			const changed = check();
			expect(changed.status, changed.stderr || changed.stdout).toBe(1);
			const report = JSON.parse(changed.stdout) as {
				libraries: Array<{ changes: Array<unknown> }>;
			};
			expect(report.libraries[0]?.changes).toContainEqual({
				path: "declarations.global payload.type.length",
				kind: "changed",
				before: 4,
				after: 8,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("reports native origins and watches accepted global ABI changes through the CLI", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-global-check-"));
		try {
			cpSync(fixture, directory, { recursive: true });
			const cli = (args: Array<string>) =>
				spawnSync(
					process.execPath,
					[path.resolve(import.meta.dirname, "../src/index.ts"), "ffi", ...args],
					{ cwd: directory, encoding: "utf8", timeout: 30_000 },
				);
			const inspected = cli(["inspect", "globals", "--json"]);
			expect(inspected.status, inspected.stderr || inspected.stdout).toBe(0);
			const inspection = JSON.parse(inspected.stdout) as FfiInspection;
			const getter = inspection.functions.find(({ name }) => name === "getMode");
			expect(getter).toMatchObject({
				global: { name: "globals_mode", access: "get" },
				status: "bound",
				ts: "() => number",
			});
			expect(getter).not.toHaveProperty("variantOf");
			expect(
				inspection.functions.some(({ name }) => name.startsWith("mal_ffi_global_")),
			).toBe(false);
			expect(inspection.suggestions.functions).not.toHaveProperty("getMode");
			const accepted = cli(["check", "globals", "--update"]);
			expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
			const header = path.join(directory, "globals.h");
			writeFileSync(
				header,
				`${readFileSync(header, "utf8")}\nextern double unrelated_global;\n`,
			);
			const unchanged = cli(["check", "globals"]);
			expect(unchanged.status, unchanged.stderr || unchanged.stdout).toBe(0);
			writeFileSync(
				header,
				readFileSync(header, "utf8").replace(
					"_Thread_local int globals_thread",
					"int globals_thread",
				),
			);
			const source = path.join(directory, "globals.c");
			writeFileSync(
				source,
				readFileSync(source, "utf8").replace(
					"_Thread_local int globals_thread",
					"int globals_thread",
				),
			);
			const changed = cli(["check", "globals"]);
			expect(changed.status).not.toBe(0);
			expect(changed.stderr + changed.stdout).toContain("global globals_thread");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);
});
