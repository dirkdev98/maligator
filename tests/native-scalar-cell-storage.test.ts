import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function cell(expression: string, captured: boolean) {
	const body = `let saved={old:true};function compute(left,right,gate){const a=+left,b=+right;const value=${expression};saved=value;gate();return value;}`;
	return inspectStaticValueFunction(
		captured
			? `function factory(){${body}return{compute,read(){return saved;}};}globalThis.factory=factory;`
			: `${body}globalThis.compute=compute;`,
		"compute",
	);
}

describe("existing scalar proofs at cell stores", () => {
	it.each([
		["a*b", "number"],
		["a<b", "boolean"],
		["!a", "boolean"],
	] as const)(
		"keeps %s scalar at module and escaping captured-cell stores",
		(expression, rep) => {
			for (const captured of [false, true]) {
				const out = cell(expression, captured);
				const store = out.native.body.instructions.find(
					(op) => op.opcode === (captured ? "STORE_CAPTURED" : "STORE_GLOBAL"),
				)!;
				if (store.opcode !== "STORE_CAPTURED" && store.opcode !== "STORE_GLOBAL")
					throw new Error("Missing cell store");
				expect(out.native.registerRepresentations[store.src]).toBe(rep);
				expect(out.native.storage!.rootRegisters).not.toContain(store.src);
				expect(out.c.source).toContain(`r${store.src}`);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
					out.image,
				);
			}
		},
	);

	it("retains scalar snapshot restoration across await after a cell store", () => {
		const out = inspectStaticValueFunction(
			"let saved;async function compute(left,right,gate){const a=+left,b=+right;const value=a*b;saved=value;await gate;return value;}globalThis.compute=compute;",
			"compute",
		);
		const store = out.native.body.instructions.find(
			(op) => op.opcode === "STORE_GLOBAL",
		)!;
		if (store.opcode !== "STORE_GLOBAL") throw new Error("Missing suspended store");
		expect(out.native.registerRepresentations[store.src]).toBe("number");
		expect(
			out.native.storage!.suspension!.points.some((point) =>
				point.registers.includes(store.src),
			),
		).toBe(true);
		expect(out.c.source).toContain("mal_ops_number_as_f64(");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each(["left+right", "left*right", "left&right"])(
		"preserves generic %s results stored in a cell",
		(expression) => {
			const out = cell(expression, false);
			const store = out.native.body.instructions.find(
				(op) => op.opcode === "STORE_GLOBAL",
			)!;
			if (store.opcode !== "STORE_GLOBAL") throw new Error("Missing generic store");
			expect(out.native.registerRepresentations[store.src]).toBe("boxed");
			expect(out.native.storage!.rootRegisters).toContain(store.src);
		},
	);

	it("keeps dynamic captured strings traced", () => {
		const out = cell("'value:'+left", true);
		const store = out.native.body.instructions.find(
			(op) => op.opcode === "STORE_CAPTURED",
		)!;
		if (store.opcode !== "STORE_CAPTURED") throw new Error("Missing string store");
		expect(out.native.storage!.rootRegisters).toContain(store.src);
		expect(["boxed", "string"]).toContain(out.native.registerRepresentations[store.src]);
	});

	it("preserves profiled execution sites around scalar cell stores", () => {
		const out = inspectStaticValueFunction(
			"let saved;function compute(left,right){const a=+left,b=+right;saved=a*b;return saved;}globalThis.compute=compute;",
			"compute",
			{ profile: true },
		);
		expect(out.native.storage!.expressionIps).toEqual([]);
		for (const site of out.native.body.profileSiteIds!.filter((site) => site >= 0))
			expect(out.c.source).toContain(
				`MAL_PROFILE_SITE_EVENT(vm, ${site}, MAL_PROFILE_SITE_EXECUTION, 1);`,
			);
	});
});
