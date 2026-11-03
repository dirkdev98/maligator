import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { planBindings } from "../src/ffi/binding-plan.ts";
import { describeBindingUnit } from "../src/ffi/binding-unit.ts";
import { extractCModel } from "../src/ffi/c-extract.ts";
import type { CModel } from "../src/ffi/c-model.ts";
import { loadLibraryContract } from "../src/ffi/contract.ts";
import { generateDeclarations } from "../src/ffi/declarations.ts";
import contract from "./fixtures/ffi-variadic-dispatch/dispatch.ffi.ts";
let model: CModel;
beforeAll(() => {
	const compiler = process.env.CC ?? "clang";
	const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
	expect(version.status, version.stderr).toBe(0);
	model = extractCModel({
		compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
		environment: process.env,
		headers: ["dispatch.h"],
		compileArguments: [
			"-I",
			path.join(import.meta.dirname, "fixtures/ffi-variadic-dispatch"),
		],
	});
});
function plan(dispatch: string = "invoke") {
	return planBindings(model, {
		types: {},
		functions: {
			...contract.functions,
			dispatch_apply: { ...contract.functions.dispatch_apply, dispatch },
		},
	});
}
it("declares correlated runtime tuples while preserving each typed variant", () => {
	const bindings = plan();
	const sdk = [...generateDeclarations([{ name: "dispatch", plan: bindings }])].join("");
	expect(sdk).toContain('[variant: "small", arg3: number, arg4: number, arg5: number]');
	expect(sdk).toContain('[variant: "array", arg3: ReadonlyArray<number> | Int32Array]');
	expect(sdk).toContain(
		'export function invoke(...args: [variant: "output"]): { result: number; arg3: number }',
	);
	const abi = describeBindingUnit("dispatch", bindings);
	expect(abi.exports).toContain("invoke");
	expect(abi.exports).toContain("small");
	expect(abi.direct.small).toBeDefined();
	expect(abi.direct.invoke).toBeUndefined();
});
it.each(["dispatch_calls", "small", "DISPATCH_SMALL"])(
	"rejects a dispatcher colliding with %s",
	(name) => {
		expect(() => plan(name)).toThrow("already");
	},
);
it("can expose the original C name as the dispatcher", () => {
	expect(describeBindingUnit("dispatch", plan("dispatch_apply")).exports).toContain(
		"dispatch_apply",
	);
});
it("keeps a dispatcher unbound until all of its cases have enough facts", () => {
	const facts = contract.functions.dispatch_apply;
	const bindings = planBindings(model, {
		types: {},
		functions: {
			dispatch_apply: {
				...facts,
				variants: { ...facts.variants, callback: { args: facts.variants.callback.args } },
			},
		},
	});
	expect(bindings.dispatchers).toHaveLength(0);
	expect(
		bindings.unbound
			.find((entry) => entry.name === "invoke")
			?.gaps.some((gap) => gap.at === "callback"),
	).toBe(true);
});
it.each([
	{ dispatch: "class", variants: { typed: { args: [] } } },
	{ dispatch: "invoke", variants: {} },
	{ dispatch: "invoke" },
	{ dispatch: "invoke", variants: { typed: { args: [] } }, async: "asyncInvoke" },
])("rejects an invalid dispatch contract %j", (facts) => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-dispatch-contract-"));
	try {
		writeFileSync(
			path.join(directory, "contract.ffi.ts"),
			`export default ${JSON.stringify({ headers: ["dispatch.h"], find: [{ libraries: ["fixture"] }], functions: { dispatch_apply: facts } })};`,
		);
		expect(() =>
			loadLibraryContract(
				"dispatch",
				{ contract: "contract.ffi.ts" },
				directory,
				stripCompactTypes,
			),
		).toThrow();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
