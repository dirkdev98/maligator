import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { decodeVmValueOperand } from "../src/lower-vm.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "immediate-operands.js");
	return compileSemanticProgramToVmDefinition(semantic);
}

describe("tagged call operands", () => {
	it("embeds primitive, string, and small integer call arguments", () => {
		const definition = compile(`
			function invoke(fn) {
				return fn(undefined, null, false, true, 42, "value");
			}
			globalThis.keep = invoke;
		`);
		const call = definition.functions
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
		const instructions = definition.functions.flatMap((fn) => fn.instructions);
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
});
