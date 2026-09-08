import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	decodeVmValueOperand,
	encodeVmValueOperand,
} from "../src/compiler/target/runtime-image.ts";

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "immediate-operands.js");
	return compileSemanticProgramToProgramImage(semantic);
}

function compileWithLockedBuiltins(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "builtin-immediates.js");
	return compileSemanticProgramToProgramImage(semantic, {
		facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
	});
}

describe("tagged VM call operands", () => {
	it("uses self-host-stable negative arithmetic tags", () => {
		expect(encodeVmValueOperand(-1, { kind: "undefined" })).toBe(-1);
		expect(encodeVmValueOperand(-1, { kind: "null" })).toBe(-2);
		expect(encodeVmValueOperand(-1, { kind: "string", index: 0 })).toBe(-5);
		expect(
			decodeVmValueOperand(encodeVmValueOperand(-1, { kind: "number", value: -7 })),
		).toEqual({
			kind: "number",
			value: -7,
		});
	});

	it("embeds primitive, string, and small integer call arguments", () => {
		const definition = compile(`
			function invoke(fn) {
				return fn(undefined, null, false, true, 42, "value");
			}
			globalThis.keep = invoke;
		`);
		const call = definition.runtime.functions
			.flatMap((fn) => fn.instructions)
			.find((instruction) => instruction.opcode === "CALL");
		expect(call?.opcode).toBe("CALL");
		if (call?.opcode !== "CALL") return;

		const decoded = call.arguments.map(decodeVmValueOperand);
		expect(decoded.slice(0, 5)).toEqual([
			{ kind: "undefined" },
			{ kind: "null" },
			{ kind: "boolean", value: false },
			{ kind: "boolean", value: true },
			{ kind: "number", value: 42 },
		]);
		expect(decoded[5]?.kind).toBe("string");
	});

	it("embeds constructor arguments but preserves negative zero in a register", () => {
		const definition = compile(`
			function make(C) { return new C(undefined, "x", 7, -0); }
			globalThis.keep = make;
		`);
		const instructions = definition.runtime.functions.flatMap((fn) => fn.instructions);
		const construct = instructions.find(
			(instruction) => instruction.opcode === "CONSTRUCT",
		);
		expect(construct?.opcode).toBe("CONSTRUCT");
		if (construct?.opcode !== "CONSTRUCT") return;

		const decoded = construct.arguments.map(decodeVmValueOperand);
		expect(decoded[0]).toEqual({ kind: "undefined" });
		expect(decoded[1]?.kind).toBe("string");
		expect(decoded[2]).toEqual({ kind: "number", value: 7 });
		expect(decodeVmValueOperand(construct.arguments[3]!)).toMatchObject({
			kind: "register",
		});
		expect(
			instructions.some(
				(instruction) =>
					instruction.opcode === "CREATE_F64" && Object.is(instruction.value, -0),
			),
		).toBe(true);
	});

	it("embeds primitive receivers and mixed direct-builtin arguments", () => {
		const definition = compileWithLockedBuiltins(`
			function invoke(dynamic) {
				return [
					"alpha,beta".split(",", dynamic),
					(17).toString(dynamic),
					Object.prototype.isPrototypeOf.call(true, dynamic),
					Object.is(undefined, dynamic),
					Object.is(null, false),
				];
			}
			globalThis.keep = invoke;
		`);
		const instructions = definition.runtime.functions[1]!.instructions;
		const calls = instructions.filter(
			(instruction) => instruction.opcode === "CALL_KNOWN",
		);
		expect(calls).toHaveLength(5);
		if (calls.some((instruction) => instruction.opcode !== "CALL_KNOWN")) return;

		expect(decodeVmValueOperand(calls[0]!.thisValue).kind).toBe("string");
		expect(decodeVmValueOperand(calls[0]!.arguments[0]!).kind).toBe("string");
		expect(decodeVmValueOperand(calls[1]!.thisValue)).toEqual({
			kind: "number",
			value: 17,
		});
		expect(decodeVmValueOperand(calls[2]!.thisValue)).toEqual({
			kind: "boolean",
			value: true,
		});
		expect(calls[3]!.arguments.map(decodeVmValueOperand)).toEqual([
			{ kind: "undefined" },
			{ kind: "register", register: 0 },
		]);
		expect(calls[4]!.arguments.map(decodeVmValueOperand)).toEqual([
			{ kind: "null" },
			{ kind: "boolean", value: false },
		]);

		expect(
			instructions.some(
				(instruction) =>
					instruction.opcode === "CREATE_NUMBER" && instruction.value === 17,
			),
		).toBe(false);
		for (const opcode of [
			"CREATE_UNDEFINED",
			"CREATE_NULL",
			"CREATE_BOOLEAN",
			"CREATE_STRING",
		]) {
			expect(instructions.some((instruction) => instruction.opcode === opcode)).toBe(
				false,
			);
		}
	});
});
