import { describe, expect, it } from "vitest";
import { executeIROptimizations, irOptTestHooks } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type {
	IntermediateProgram,
	IRFunction,
	IRInstruction,
	IRTypeofResult,
} from "../src/ir.ts";
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
				globalThis.mutated = value;
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

	it("folds exact primitive, object, and callable facts", () => {
		const instructions = optimizedInstructions(`
			function classify() {
				return [
					typeof 1 === "number",
					typeof true === "boolean",
					typeof "value" === "string",
					typeof 1n === "bigint",
					typeof null === "object",
					typeof {} === "object",
					typeof function target() {} === "function",
				];
			}
			globalThis.classify = classify;
		`);

		expect(instructions.some((instruction) => instruction.type === "typeofCompare")).toBe(
			false,
		);
		expect(
			instructions.filter(
				(instruction) => instruction.type === "createBoolean" && instruction.value,
			),
			// The post-fixpoint primitive-constant sharing pass intentionally
			// canonicalizes all seven folded true results to one producer.
		).toHaveLength(1);
	});

	it("preserves an exact fact across same-type control-flow definitions", () => {
		const fn = {
			parameterCount: 1,
			blocks: [
				[{ type: "jumpIf", registers: [0], blocks: [2] }],
				[
					{ type: "createObject", registers: [1] },
					{ type: "jump", blocks: [3] },
				],
				[
					{ type: "createArray", registers: [1], length: 0 },
					{ type: "jump", blocks: [3] },
				],
				[
					{
						type: "typeofCompare",
						registers: [2, 1],
						expected: "object",
						negated: false,
					},
					{ type: "return", registers: [2] },
				],
			].map((instructions) => ({ instructions })) as Array<IRFunction["blocks"][number]>,
		} as IRFunction;
		const program = { functions: [fn] } as IntermediateProgram;

		expect(irOptTestHooks.foldStaticTypeofComparisons(program)).toBe(true);
		expect(fn.blocks[3]!.instructions[0]).toEqual({
			type: "createBoolean",
			registers: [2],
			value: true,
		});
	});

	it("folds a union that excludes the tested type but preserves mixed uncertainty", () => {
		const instructions = optimizedInstructions(`
			function classify(flag, unknown) {
				let primitive;
				if (flag) primitive = 1;
				else primitive = "value";
				return [typeof primitive === "function", typeof unknown === "object"];
			}
			globalThis.classify = classify;
		`);

		const comparisons = instructions.filter(
			(instruction): instruction is Extract<IRInstruction, { type: "typeofCompare" }> =>
				instruction.type === "typeofCompare",
		);
		expect(comparisons).toHaveLength(1);
		expect(comparisons[0]!.expected).toBe("object");
		expect(
			instructions.some(
				(instruction) => instruction.type === "createBoolean" && !instruction.value,
			),
		).toBe(true);
	});

	it("refines a stable value through nested and early-return typeof branches", () => {
		const instructions = optimizedInstructions(`
			function nested(value) {
				if (typeof value === "number") {
					if (typeof value === "number") return 1;
				}
				return 0;
			}
			function early(value) {
				if (typeof value !== "string") return 0;
				return typeof value === "string" ? 1 : 2;
			}
			globalThis.keep = [nested, early];
		`);

		const comparisons = instructions.filter(
			(instruction) => instruction.type === "typeofCompare",
		);
		// Only the two source predicates remain. Their dominated duplicate checks
		// fold to true and constant-branch cleanup removes the dead alternatives.
		expect(comparisons).toHaveLength(2);
	});

	it("does not refine through a join with an untested predecessor", () => {
		const instructions = optimizedInstructions(`
			function joined(value, chooseTest) {
				if (chooseTest) {
					if (typeof value !== "number") return 0;
				}
				return typeof value === "number" ? 1 : 2;
			}
			globalThis.joined = joined;
		`);

		expect(
			instructions.filter((instruction) => instruction.type === "typeofCompare"),
		).toHaveLength(2);
	});

	it("keeps exception-region branch facts conservative", () => {
		const instructions = optimizedInstructions(`
			function guarded(value) {
				try {
					if (typeof value === "number") {
						return typeof value === "number" ? 1 : 2;
					}
				} catch (error) {
					return error;
				}
				return 0;
			}
			globalThis.guarded = guarded;
		`);

		expect(
			instructions.filter((instruction) => instruction.type === "typeofCompare"),
		).toHaveLength(2);
	});
});
