import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("catalogued primitive builtin result storage", () => {
	it.each([
		["Date.now", "Date.now()", "number"],
		["Date.parse", "Date.parse(input)", "number"],
		["Date.UTC", "Date.UTC(input, 0)", "number"],
		["Object.is", "Object.is(input, other)", "boolean"],
		["Object.hasOwn", "Object.hasOwn(input, other)", "boolean"],
	] as const)(
		"keeps %s scalar across a collecting callback",
		(operation, expression, rep) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other,gate){const value=${expression};gate();return value;}globalThis.compute=compute;`,
				"compute",
			);
			const op = out.native.body.instructions.find(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			)!;
			if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing exact builtin call");
			expect(out.native.registerRepresentations[op.dst]).toBe(rep);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
			if (["Date.parse", "Date.UTC", "Object.hasOwn"].includes(operation))
				expect(out.c.source).toMatch(
					/MalValue __boxed_load_\d+ = [^;]+;\n\s+if \([^\n]+\) goto __throw_exit;\n\s+r\d+ = mal_(?:ops_number_as_f64|value_to_boolean)\(__boxed_load_\d+\);/,
				);
		},
	);

	it.each([
		["Map", "has"],
		["Map", "delete"],
		["Set", "has"],
		["Set", "delete"],
	] as const)("keeps exact %s.%s results Boolean", (family, method) => {
		const out = inspectStaticValueFunction(
			`function compute(input,other,gate){const value=${family}.prototype.${method}.call(input,other);gate();return value;}globalThis.compute=compute;`,
			"compute",
		);
		const op = out.native.body.instructions.find(
			(op) =>
				op.opcode === "CALL_KNOWN" && op.operation === `${family}.prototype.${method}`,
		)!;
		if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing collection predicate");
		expect(out.native.registerRepresentations[op.dst]).toBe("boolean");
		expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		["some", "boolean"],
		["every", "boolean"],
		["findIndex", "number"],
		["findLastIndex", "number"],
	] as const)(
		"keeps %s results scalar while callback dispatch can collect or throw",
		(method, rep) => {
			const out = inspectStaticValueFunction(
				`function compute(input,predicate,gate){const values=[input,3];const value=values.${method}(predicate);gate();return value;}globalThis.compute=compute;`,
				"compute",
			);
			const op = out.native.body.instructions.find(
				(op) =>
					op.opcode === "CALL_KNOWN" && op.operation === `Array.prototype.${method}`,
			)!;
			if (op?.opcode !== "CALL_KNOWN") throw new Error("Missing array callback call");
			expect(out.native.registerRepresentations[op.dst]).toBe(rep);
			expect(out.native.storage!.rootRegisters).not.toContain(op.dst);
			expect(out.c.source).toContain("mal_vm_call_known_native");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
});
