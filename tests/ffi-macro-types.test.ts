import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import { resolveCType } from "../src/ffi/c-model.ts";

it("extracts macro-qualified function types without erasing native representations", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-macro-types-"));
	try {
		writeFileSync(
			path.join(directory, "api.h"),
			`
#define API_CALL __attribute__((ms_abi))
typedef int (API_CALL *NativeStep)(int);
NativeStep native_step(void);
#undef API_CALL
#define API_CALL __attribute__((sysv_abi))
int (API_CALL *native_other(void))(int);
typedef struct MacroApi { int (API_CALL *step)(int); } MacroApi;
#define API_VECTOR __attribute__((vector_size(16)))
typedef API_VECTOR int NativeVector;
typedef int __attribute__((address_space(1))) *NativeAddress;
`,
		);
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		const model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["api.h"],
			compileArguments: ["-target", "x86_64-unknown-linux-gnu", "-I", directory],
		});
		const plan = planBindings(model, {
			types: {},
			functions: {
				native_step: { returns: { callable: { lifetime: "library" } } },
				native_other: { returns: { callable: { lifetime: "library" } } },
			},
		});
		expect(plan.unbound).toEqual([]);
		expect(model.records.get("MacroApi")?.fields[0]?.type.kind).toBe("pointer");
		expect(resolveCType(model, { kind: "typedef", name: "NativeVector" })).toMatchObject({
			kind: "vector",
			of: { kind: "integer", name: "int" },
			length: 4,
			flavor: "gnu",
		});
		expect(resolveCType(model, { kind: "typedef", name: "NativeAddress" }).kind).toBe(
			"unsupported",
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
