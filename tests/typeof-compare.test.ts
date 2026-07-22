import { describe, expect, it } from "vitest";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IRInstruction, IRTypeofResult } from "../src/ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function optimizedInstructions(source: string): Array<IRInstruction> {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "typeof-compare-test.js");
	const program = compileSemanticProgramToIr(semantic);
	executeIROptimizations(program);
	return program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);
}

describe("typeof comparison fusion", () => {
	it("fuses every canonical tag, equality operator, and operand order", () => {
		const tags: Array<IRTypeofResult> = [
			"undefined",
			"object",
			"boolean",
			"number",
			"string",
			"symbol",
			"bigint",
			"function",
		];
		const operators = ["===", "!==", "==", "!="] as const;
		const expressions = tags.flatMap((tag) =>
			operators.flatMap((operator) => [
				`typeof value ${operator} "${tag}"`,
				`"${tag}" ${operator} typeof value`,
			]),
		);
		const instructions = optimizedInstructions(`
			function classify(value) { return [${expressions.join(",\n")}]; }
			globalThis.classify = classify;
		`);
		const fused = instructions.filter(
			(instruction): instruction is Extract<IRInstruction, { type: "typeofCompare" }> =>
				instruction.type === "typeofCompare",
		);

		expect(fused).toHaveLength(expressions.length);
		expect(fused.map((instruction) => instruction.expected)).toEqual(
			tags.flatMap((tag) => operators.flatMap(() => [tag, tag])),
		);
		expect(fused.map((instruction) => instruction.negated)).toEqual(
			tags.flatMap(() =>
				operators.flatMap((operator) => [
					operator === "!==" || operator === "!=",
					operator === "!==" || operator === "!=",
				]),
			),
		);
		expect(
			instructions.some(
				(instruction) =>
					instruction.type === "unary" && instruction.operator === "typeof",
			),
		).toBe(false);
	});

	it("keeps standalone, dynamic, noncanonical, and multiply-used typeof generic", () => {
		const instructions = optimizedInstructions(`
			function generic(value, expected) {
				const saved = typeof value;
				return [typeof value, typeof value === expected, typeof value === "Number", saved, saved === "number"];
			}
			globalThis.generic = generic;
		`);

		expect(instructions.some((instruction) => instruction.type === "typeofCompare")).toBe(
			false,
		);
		expect(
			instructions.filter(
				(instruction) =>
					instruction.type === "unary" && instruction.operator === "typeof",
			),
		).toHaveLength(4);
	});

	it("replaces the producer before an intervening source mutation", () => {
		const instructions = optimizedInstructions(`
			function timing(value) {
				const saved = typeof value;
				value = {};
				return saved === "number";
			}
			globalThis.timing = timing;
		`);
		const compareIndex = instructions.findIndex(
			(instruction) => instruction.type === "typeofCompare",
		);
		const mutationIndex = instructions.findIndex(
			(instruction) => instruction.type === "createObject",
		);

		expect(compareIndex).toBeGreaterThanOrEqual(0);
		expect(compareIndex).toBeLessThan(mutationIndex);
		expect(instructions[compareIndex]).toMatchObject({
			type: "typeofCompare",
			expected: "number",
			negated: false,
		});
	});
});
