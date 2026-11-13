import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypointToBuffer } from "../src/compiler/pipeline/compile-runtime-program.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(
	body: string,
	options: Parameters<typeof inspectStaticValueFunction>[2] = {},
) {
	return inspectStaticValueFunction(
		`function target(base,...values){${body}} globalThis.target=target;`,
		"target",
		options,
	);
}
const iterate = "let total=base;for(const value of values)total+=value;return total;";

function iteratesWithProtocol(source: string, engine: { eval: boolean }): boolean {
	const directory = mkdtempSync(join(tmpdir(), "mal-rest-wire-"));
	try {
		const entrypoint = join(directory, "entry.mjs");
		writeFileSync(entrypoint, source);
		const image = deserializeRuntimeImage(
			compileEntrypointToBuffer(entrypoint, {
				buildConfig: resolveBuildConfig({ engine: { ...engine, realms: false } }),
			}),
		);
		const target = image.functions.find(
			(fn) =>
				String.fromCharCode(...(image.stringConstants[fn.nameStringIndex] ?? [])) ===
				"target",
		);
		expect(target).toBeDefined();
		return target!.instructions.some(
			(instruction) => instruction.opcode === "GET_ITERATOR",
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it("lowers private rest iteration in configured portable runtime images", () => {
	expect(
		iteratesWithProtocol(
			`function target(base,...values){${iterate}} globalThis.target=target;`,
			{ eval: false },
		),
	).toBe(false);
});

it("lowers private rest iteration while run-time code can only run as global code", () => {
	expect(
		iteratesWithProtocol(
			`function target(base,...values){${iterate}} globalThis.target=Function("t","return t")(target);`,
			{ eval: true },
		),
	).toBe(false);
});

it("lowers private rest iteration that no direct eval sees", () => {
	expect(
		iteratesWithProtocol(
			`function target(base,...values){${iterate}} function other(code){return eval(code);} globalThis.target=target; globalThis.other=other;`,
			{ eval: true },
		),
	).toBe(false);
});

it("keeps rest iteration observable to a direct eval", () => {
	expect(
		iteratesWithProtocol(
			`function target(base,...values){eval("values");${iterate}} globalThis.target=target;`,
			{ eval: true },
		),
	).toBe(true);
});

it("lowers a private rest loop to virtual packed reads", () => {
	const output = inspect(iterate);
	expect(output.core.some((op) => op.opcode === "getIterator")).toBe(false);
	expect(
		output.native.instructions.some((plan) => plan?.kind === "virtual-packed-rest-array"),
	).toBe(true);
	expect(
		output.native.instructions.some(
			(plan) => plan?.kind === "exact-packed-rest-array-element",
		),
	).toBe(true);
});

it("keeps rest iteration virtual while forwarding the original arguments", () => {
	const output = inspectStaticValueFunction(
		"function sink(...values){return values.length;} function target(base,...values){let total=base;for(const value of values)total+=value;return sink(...arguments)+total;}globalThis.target=target;",
		"target",
	);
	expect(
		output.native.instructions.some((plan) => plan?.kind === "virtual-packed-rest-array"),
	).toBe(true);
	expect(
		output.native.body.instructions.some((op) => op.opcode === "CALL_REST_ARGUMENTS"),
	).toBe(true);
});

it("updates call summaries when a rest element becomes a callback argument", () => {
	const output = inspect(
		"let total=0;for(const value of values)total+=base(value);return total;",
	);
	expect(
		output.native.instructions.some((plan) => plan?.kind === "virtual-packed-rest-array"),
	).toBe(true);
});

it.each([
	["an escaped rest array", `globalThis.saved=values;${iterate}`],
	["rest writes", `values[1]=base;${iterate}`],
	["a captured rest array", `globalThis.read=()=>values;${iterate}`],
	[
		"multiple iterators",
		"let total=base;for(const value of values)total+=value;for(const value of values)total+=value;return total;",
	],
])("retains %s", (_name, body) => {
	expect(inspect(body).core.some((op) => op.opcode === "getIterator")).toBe(true);
});

it("retains replaceable iterator protocols across realms", () => {
	expect(
		inspect(iterate, { realms: true }).core.some((op) => op.opcode === "getIterator"),
	).toBe(true);
});

it("keeps the iterator protocol as the twin of a protocol guard with mutable primordials", () => {
	const { core } = inspect(iterate, { locked: false });
	expect(core.some((op) => op.opcode === "guardSemanticEpoch")).toBe(true);
	expect(core.some((op) => op.opcode === "getIterator")).toBe(true);
});
