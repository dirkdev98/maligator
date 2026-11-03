import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import valueContract from "./fixtures/ffi-native-values/values.ffi.ts";

let model: CModel;
beforeAll(() => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-native-contract-"));
	try {
		writeFileSync(
			path.join(directory, "extra.h"),
			`
typedef const NativeUnsigned NativeConstAlias;
typedef const int NativeConstInt;
typedef _Atomic(int) NativeAtomic;
typedef int __attribute__((address_space(1))) NativeAddressSpace;
typedef NativeUnsigned *NativePointer;
NativeConstAlias native_const_alias(void);
typedef __int128 Collision;
struct Collision { int value; };
typedef struct Collision CollisionState;
Collision collision_value(void);
CollisionState collision_state(void);
`,
		);
		const compiler = process.env.CC ?? "clang";
		const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
		expect(version.status, version.stderr).toBe(0);
		model = extractCModel({
			compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
			environment: process.env,
			headers: ["values.h", "extra.h"],
			compileArguments: [
				"-I",
				path.resolve(import.meta.dirname, "fixtures/ffi-native-values"),
				"-I",
				directory,
			],
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
it("declares nominal native factories and preserves constant and global aliases", () => {
	const plan = planBindings(model, {
		types: valueContract.types,
		functions: valueContract.functions,
		globals: valueContract.globals,
	});
	const sdk = [...generateDeclarations([{ name: "native", plan }])].join("");
	expect(sdk).toContain("export function NativeUnsigned(): NativeUnsigned;");
	expect(sdk).toContain("readonly NativeUnsigned: true");
	expect(sdk).toContain("readonly NativeOtherUnsigned: true");
	expect(sdk).toContain("export const NATIVE_MAX: NativeUnsigned;");
	expect(sdk).toContain("export const NATIVE_ONE: NativeExtended;");
	expect(sdk).toContain("getConstUnsigned(): NativeUnsigned;");
	expect(sdk).toContain("getConstValues(): [NativeUnsigned, NativeUnsigned];");
});
it("resolves an unannotated alias to its opted native root", () => {
	const plan = planBindings(model, {
		types: { NativeUnsigned: { representation: "native" } },
		functions: {},
	});
	const sdk = [...generateDeclarations([{ name: "native", plan }])].join("");
	expect(sdk).toContain("native_alias(value: NativeUnsigned): NativeUnsigned;");
});
it("keeps unsupported const aliases local to their declaration", () => {
	const plan = planBindings(model, {
		types: { NativeUnsigned: { representation: "native" } },
		functions: {},
	});
	expect(
		plan.unbound
			.find((entry) => entry.name === "native_const_alias")
			?.gaps.map((gap) => gap.reason)
			.join(" "),
	).toContain("const typedef aliases");
	expect(plan.functions.some((entry) => entry.name === "native_alias")).toBe(true);
});
it.each([
	"NativePointer",
	"NativeAtomic",
	"NativeAddressSpace",
	"NativeConstInt",
	"NativeRecord",
])("rejects non-value native representation for %s", (name) => {
	expect(() =>
		planBindings(model, {
			types: { [name]: { representation: "native" } },
			functions: {},
		}),
	).toThrow("unqualified arithmetic typedef");
});
it("keeps fixed vector lanes separate from their padded storage layout", () => {
	const triple = model.typedefs.get("NativeTriple")!;
	expect(triple.type).toEqual({
		kind: "vector",
		of: { kind: "float", name: "float" },
		length: 3,
		flavor: "ext",
	});
	expect(triple.sizeBits).toBe(4 * model.target.sizes.float! * 8);
	expect(model.typedefs.get("NativeAlignedTriple")!.alignmentBits).toBe(64 * 8);
	expect(model.typedefs.get("NativeBits")!.type).toEqual({
		kind: "bitint",
		bits: 127,
		signed: false,
	});
	expect(model.typedefs.get("NativeComplex")!.type).toEqual({
		kind: "complex",
		of: { kind: "float", name: "long double" },
	});
});
it.each(["sizeBits", "alignmentBits"] as const)(
	"rejects native values when Clang has not supplied %s",
	(property) => {
		const typedefs = new Map(model.typedefs);
		typedefs.set("NativeTriple", {
			...typedefs.get("NativeTriple")!,
			[property]: undefined,
		});
		expect(() =>
			planBindings(
				{ ...model, typedefs },
				{
					types: { NativeTriple: { representation: "native" } },
					functions: {},
				},
			),
		).toThrow("Clang did not identify native storage layout");
	},
);
it("rejects two nominal facts in the same alias chain", () => {
	expect(() =>
		planBindings(model, {
			types: {
				NativeUnsigned: { representation: "native" },
				NativeAlias: { representation: "native" },
			},
			functions: {},
		}),
	).toThrow("typedef chain already has a native representation");
});
it.each([false, true])(
	"rejects record and handle names colliding with native factories (%s)",
	(handle) => {
		expect(() =>
			planBindings(model, {
				types: {
					Collision: { representation: "native" },
					...(handle ? { CollisionState: { handle: {} } } : {}),
				},
				functions: {},
			}),
		).toThrow("already an export");
	},
);
it("rejects a global accessor name that hides a native factory", () => {
	expect(() =>
		planBindings(model, {
			types: { NativeUnsigned: { representation: "native" } },
			functions: {},
			globals: { native_unsigned_global: { get: "NativeUnsigned" } },
		}),
	).toThrow("already an export");
});
