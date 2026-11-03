import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import contract from "./fixtures/ffi-owner-fields/owner.ffi.ts";

let model: CModel;
it.each([
	{ handle: { lifetime: "call" } },
	{ handle: {} },
	{ handle: { lifetime: "owner" }, string: { length: "size" } },
])("rejects ambiguous resource field facts %j", (field) => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-owner-facts-"));
	try {
		writeFileSync(
			path.join(directory, "owner.ffi.ts"),
			`export default ${JSON.stringify({ headers: ["owner.h"], types: { OwnerResult: { handle: {}, fields: { first: field } } } })};\n`,
		);
		expect(() =>
			loadLibraryContract(
				"owner",
				{ contract: "owner.ffi.ts" },
				directory,
				stripCompactTypes,
			),
		).toThrow();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["owner.h"],
		compileArguments: ["-I", path.join(import.meta.dirname, "fixtures/ffi-owner-fields")],
	});
});

it("declares borrowed resource fields with their destruction boundary", () => {
	const plan = planBindings(model, contract);
	expect(
		plan.handles.get("OwnerResult")?.fields.find((field) => field.name === "first")
			?.value,
	).toMatchObject({
		kind: "handle",
		name: "OwnerChild",
		owner: "OwnerResult",
		owned: false,
	});
	const library = plan.handles
		.get("OwnerResult")
		?.fields.find((field) => field.name === "library")?.value;
	expect(library).toMatchObject({ kind: "handle", owned: false });
	expect(library).not.toHaveProperty("owner");
	const sdk = [...generateDeclarations([{ name: "owner", plan }])].join("");
	expect(sdk).toContain("readonly first: OwnerChild | null");
});

it("requires a destructor for owner-bound fields", () => {
	expect(() =>
		planBindings(model, {
			...contract,
			types: {
				...contract.types,
				OwnerResult: { ...contract.types.OwnerResult, handle: {} },
			},
		}),
	).toThrow("destructor-backed result handle");
});

it("rejects non-resource fields with a resource lifetime", () => {
	expect(() =>
		planBindings(model, {
			...contract,
			types: {
				...contract.types,
				OwnerResult: {
					...contract.types.OwnerResult,
					fields: { marker: { handle: { lifetime: "owner" } } },
				},
			},
		}),
	).toThrow("pointer-represented resource handle");
});

it("rejects caller-storage children in library-owned resource fields", () => {
	expect(() =>
		planBindings(model, {
			...contract,
			types: {
				...contract.types,
				OwnerChild: { handle: { storage: "caller" } },
			},
		}),
	).toThrow("library-owned resource storage");
});
