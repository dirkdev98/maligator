import { describe, expect, it } from "vitest";
import { evaluateConstantOperation } from "../src/compiler/shared/constant-evaluator.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function returnedBigint(result: ReturnType<typeof inspectStaticValueFunction>) {
	const instructions = result.fn.instructions;
	const returns = instructions.filter((instruction) => instruction.opcode === "RETURN");
	expect(returns).toHaveLength(1);
	let register = returns[0]!.value;
	for (let index = instructions.indexOf(returns[0]!) - 1; index >= 0; index--) {
		const instruction = instructions[index]!;
		if (!("dst" in instruction) || instruction.dst !== register) continue;
		if (instruction.opcode === "MOVE") {
			register = instruction.src;
			continue;
		}
		expect(instruction.opcode).toBe("CREATE_BIGINT");
		if (instruction.opcode !== "CREATE_BIGINT") return undefined;
		return result.image.runtime.bigintConstants[instruction.bigintIndex];
	}
	return undefined;
}

describe("bounded BigInt constant operations", () => {
	const minimum = -(1n << 127n);
	const maximum = -minimum - 1n;

	it.each([
		["increment", -1n, 0n],
		["increment", 9007199254740992n, 9007199254740993n],
		["decrement", 0n, -1n],
		["decrement", -9007199254740992n, -9007199254740993n],
	] as const)("folds %s of %s exactly", (operator, input, expected) => {
		expect(
			evaluateConstantOperation(`bigint.unary:${operator}`, [
				{ kind: "bigint", value: input },
			]),
		).toMatchObject({ kind: "value", value: { kind: "bigint", value: expected } });
	});

	it("leaves signed128 boundary updates to the target runtime", () => {
		for (const [operator, value] of [
			["increment", maximum],
			["decrement", minimum],
		] as const) {
			expect(
				evaluateConstantOperation(`bigint.unary:${operator}`, [
					{ kind: "bigint", value },
				]),
			).toMatchObject({ kind: "unsupported", reason: "target-contract" });
		}
	});

	it.each([
		["&", minimum, maximum, 0n],
		["&", -1n, 9007199254740993n, 9007199254740993n],
		["|", minimum, maximum, -1n],
		["|", 9007199254740992n, 1n, 9007199254740993n],
		["^", minimum, -1n, maximum],
		["^", maximum, maximum, 0n],
	] as const)("folds signed128 bitwise %s", (operator, left, right, expected) => {
		expect(
			evaluateConstantOperation(`bigint.binary:${operator}`, [
				{ kind: "bigint", value: left },
				{ kind: "bigint", value: right },
			]),
		).toMatchObject({ kind: "value", value: { kind: "bigint", value: expected } });
	});

	it.each([
		["<<", -1n, 127n, minimum],
		["<<", 9007199254740993n, 1n, 18014398509481986n],
		["<<", -5n, -1n, -3n],
		["<<", minimum, 0n, minimum],
		[">>", maximum, 127n, 0n],
		[">>", minimum, 127n, -1n],
		[">>", -5n, 1n, -3n],
		[">>", -3n, -2n, -12n],
		[">>", -1n, -127n, minimum],
		[">>", maximum, 0n, maximum],
	] as const)("folds %s with signed counts", (operator, left, right, expected) => {
		expect(
			evaluateConstantOperation(`bigint.binary:${operator}`, [
				{ kind: "bigint", value: left },
				{ kind: "bigint", value: right },
			]),
		).toMatchObject({ kind: "value", value: { kind: "bigint", value: expected } });
	});

	it.each([
		[">>", -2n, 128n, -1n],
		["<<", -2n, -128n, -1n],
		[">>", maximum, maximum, 0n],
		["<<", -1n, minimum, -1n],
		["<<", maximum, minimum, 0n],
		["<<", 0n, maximum, 0n],
		[">>", 0n, minimum, 0n],
	] as const)("bounds enormous %s counts", (operator, left, right, expected) => {
		expect(
			evaluateConstantOperation(`bigint.binary:${operator}`, [
				{ kind: "bigint", value: left },
				{ kind: "bigint", value: right },
			]),
		).toMatchObject({ kind: "value", value: { kind: "bigint", value: expected } });
	});

	it.each([
		["<<", 1n, 127n],
		["<<", -2n, 127n],
		["<<", minimum, 1n],
		[">>", maximum, -1n],
		["<<", 1n, 128n],
		[">>", -1n, minimum],
		["<<", 0n, maximum + 1n],
		[">>", 1n, minimum - 1n],
		["&", maximum + 1n, 0n],
		["|", 0n, minimum - 1n],
		["^", minimum - 1n, -1n],
	] as const)("retains target-dependent %s", (operator, left, right) => {
		expect(
			evaluateConstantOperation(`bigint.binary:${operator}`, [
				{ kind: "bigint", value: left },
				{ kind: "bigint", value: right },
			]),
		).toMatchObject({ kind: "unsupported", reason: "target-contract" });
	});

	it.each([
		["==", 9007199254740992n, 9007199254740993n, false],
		["!=", 9007199254740992n, 9007199254740993n, true],
		["!==", -9007199254740993n, -9007199254740993n, false],
		["<", -9007199254740993n, -9007199254740992n, true],
		["<=", 9007199254740993n, 9007199254740993n, true],
		[">", 9007199254740993n, 9007199254740992n, true],
		[">=", -9007199254740993n, -9007199254740992n, false],
	] as const)("folds %s without Number conversion", (operator, left, right, expected) => {
		expect(
			evaluateConstantOperation(`bigint.binary:${operator}`, [
				{ kind: "bigint", value: left },
				{ kind: "bigint", value: right },
			]),
		).toMatchObject({ kind: "value", value: { kind: "boolean", value: expected } });
	});

	it.each([
		[0n, 0n, 1n],
		[minimum, 0n, 1n],
		[0n, maximum, 0n],
		[1n, maximum, 1n],
		[-1n, maximum, -1n],
		[-1n, maximum - 1n, 1n],
		[minimum, 1n, minimum],
		[maximum, 1n, maximum],
		[2n, 126n, 85070591730234615865843651857942052864n],
		[-2n, 127n, minimum],
		[3n, 40n, 12157665459056928801n],
		[-3n, 3n, -27n],
	] as const)("folds exact power %s ** %s", (base, exponent, expected) => {
		expect(
			evaluateConstantOperation("bigint.binary:**", [
				{ kind: "bigint", value: base },
				{ kind: "bigint", value: exponent },
			]),
		).toMatchObject({ kind: "value", value: { kind: "bigint", value: expected } });
	});

	it.each([
		[2n, 127n],
		[-2n, 128n],
		[minimum, 2n],
		[maximum, 2n],
		[2n, maximum],
		[maximum + 1n, 0n],
		[0n, maximum + 1n],
	] as const)("retains target-dependent power %s ** %s", (base, exponent) => {
		expect(
			evaluateConstantOperation("bigint.binary:**", [
				{ kind: "bigint", value: base },
				{ kind: "bigint", value: exponent },
			]),
		).toMatchObject({ kind: "unsupported", reason: "target-contract" });
	});

	it.each([
		[0n, -1n],
		[1n, minimum],
		[-1n, -1n],
		[2n, -1n],
	] as const)("retains the negative exponent error for %s ** %s", (base, exponent) => {
		expect(
			evaluateConstantOperation("bigint.binary:**", [
				{ kind: "bigint", value: base },
				{ kind: "bigint", value: exponent },
			]),
		).toMatchObject({ kind: "unsupported", reason: "uncertified-operation" });
	});

	it.each([0, 1, 2, 3])("stops power evaluation within work limit %s", (workLimit) => {
		const evaluated = evaluateConstantOperation(
			"bigint.binary:**",
			[
				{ kind: "bigint", value: 2n },
				{ kind: "bigint", value: 126n },
			],
			undefined,
			workLimit,
		);
		expect(evaluated).toMatchObject({ kind: "unsupported", reason: "work-limit" });
		expect(evaluated.work).toBeLessThanOrEqual(workLimit);
	});

	it.each([
		[0n, maximum, 0n],
		[1n, maximum, 1n],
		[-1n, maximum, -1n],
		[-1n, maximum - 1n, 1n],
	] as const)(
		"bounds identity power %s ** %s to constant work",
		(base, exponent, expected) => {
			const evaluated = evaluateConstantOperation(
				"bigint.binary:**",
				[
					{ kind: "bigint", value: base },
					{ kind: "bigint", value: exponent },
				],
				undefined,
				1,
			);
			expect(evaluated).toMatchObject({
				kind: "value",
				value: { kind: "bigint", value: expected },
			});
			expect(evaluated.work).toBeLessThanOrEqual(1);
		},
	);

	it("retains mixed numeric operands for the runtime", () => {
		for (const operator of ["<", "&", "|", "^", "<<", ">>", "**"]) {
			expect(
				evaluateConstantOperation(`bigint.binary:${operator}`, [
					{ kind: "bigint", value: 9007199254740993n },
					{ kind: "number", value: 9007199254740992 },
				]),
			).toMatchObject({ kind: "unsupported", reason: "uncertified-operation" });
		}
	});

	it("replaces a constant BigInt update in Core", () => {
		const result = inspectStaticValueFunction(
			"function probe(){let value=9007199254740992n; return ++value;} globalThis.probe=probe;",
			"probe",
		);
		expect(returnedBigint(result)).toBe(9007199254740993n);
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "increment",
			),
		).toBe(false);
	});

	it.each([
		["(9007199254740992n | 1n) & -1n", 9007199254740993n],
		["-1n ^ (-1n << 127n)", maximum],
		["-1n << 127n", minimum],
		["-5n << -1n", -3n],
		["-3n >> -2n", -12n],
		["-1n << (-1n << 127n)", -1n],
		["0n ** 0n", 1n],
		["2n ** 126n", 85070591730234615865843651857942052864n],
		["(-2n) ** 127n", minimum],
		["3n ** 40n", 12157665459056928801n],
		["(-1n) ** 170141183460469231731687303715884105727n", -1n],
	] as const)("exposes the exact Core result of %s", (expression, expected) => {
		const result = inspectStaticValueFunction(
			`function probe(){return BigInt.asIntN(128, ${expression});} globalThis.probe=probe;`,
			"probe",
		);
		expect(returnedBigint(result)).toBe(expected);
	});

	it.each(["2n ** -1n", "0n ** -1n", "2n ** 127n"])(
		"keeps runtime power behavior in %s",
		(expression) => {
			const result = inspectStaticValueFunction(
				`function probe(){return ${expression};} globalThis.probe=probe;`,
				"probe",
			);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "**",
				),
			).toBe(true);
		},
	);

	it.each([
		["asIntN", "0", "BigInt(x)"],
		["asUintN", "0", "!!x"],
		["asIntN", "undefined", "BigInt(x)"],
		["asUintN", "0.9", "BigInt(x)"],
		["asIntN", "-0.9", "!!x"],
		["asUintN", "' '", "!!x"],
		["asIntN", "NaN", "BigInt(x)"],
		["asUintN", "null", "!!x"],
	] as const)("folds certified zero-width %s(%s, %s)", (method, width, value) => {
		const result = inspectStaticValueFunction(
			`function probe(x){return BigInt.${method}(${width},${value});} globalThis.probe=probe;`,
			"probe",
		);
		expect(returnedBigint(result)).toBe(0n);
		expect(
			result.core.some(
				(operation) => operation.attributes.operation === `BigInt.${method}`,
			),
		).toBe(false);
	});

	it("retains producers and ignored extra argument effects for zero-width narrowing", () => {
		const result = inspectStaticValueFunction(
			"function probe(value,extra){return BigInt.asIntN(0,BigInt(value()),extra());} globalThis.probe=probe;",
			"probe",
		);
		expect(returnedBigint(result)).toBe(0n);
		expect(result.structure.genericCalls).toBe(2);
	});

	it.each([
		["asIntN", "1", "!!x"],
		["asUintN", "128", "BigInt(x)"],
		["asIntN", "0", "x"],
		["asUintN", "0", "String(x)"],
	] as const)(
		"retains %s(%s, %s) when narrowing is not certified",
		(method, width, value) => {
			const result = inspectStaticValueFunction(
				`function probe(x){return BigInt.${method}(${width},${value});} globalThis.probe=probe;`,
				"probe",
			);
			expect(
				result.core.some(
					(operation) => operation.attributes.operation === `BigInt.${method}`,
				),
			).toBe(true);
		},
	);
});
