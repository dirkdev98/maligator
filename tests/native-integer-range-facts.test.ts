import { describe, expect, it } from "vitest";
import {
	instructionFactsAreValid,
	instructionInputIntegerRange,
	instructionInputIsInt32,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	compilerIntegerRangeComparison,
	compilerIntegerRangeIsValid,
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
} from "../src/compiler/shared/integer-range.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeVariantContract } from "../src/compiler/target/lower-native-storage.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("native integer ranges", () => {
	it.each(["isFinite", "isInteger", "isSafeInteger"])(
		"folds Number.%s for unsigned and wider safe integers across suspension",
		(method) => {
			for (const generator of [false, true]) {
				const out = inspectStaticValueFunction(
					`function${generator ? "*" : ""} compute(input,gate){const n=(input>>>0)*2+1;${generator ? "yield n;" : "gate(n);"}return Number.${method}(n);}globalThis.compute=compute;`,
					"compute",
				);
				const plan = out.native.storage!.numberPredicates[0]!;
				expect(plan.mode).toBe("integer");
				expect(out.native.facts![plan.instructionIp]!.inputIntegerRanges?.[1]).toEqual({
					minimum: 1,
					maximum: 8589934591,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				});
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
					out.image,
				);
			}
		},
	);

	it("keeps range facts in admitted entries when their canonical table is shared", () => {
		const out = inspectStaticValueFunction(
			"function compute(input){return Number.isSafeInteger(input>>>0);}globalThis.compute=compute;globalThis.result=compute(+globalThis.input);",
			"compute",
		);
		expect(out.native.directEntries.length).toBeGreaterThan(0);
		const ip = out.native.storage!.numberPredicates[0]!.instructionIp;
		for (const entry of out.native.directEntries)
			expect(
				nativeVariantContract(out.native, entry).facts?.[ip]?.inputIntegerRanges?.[1],
			).toEqual(COMPILER_UINT32_RANGE);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it.each([
		["((input>>>0)&65535)+1", true],
		["input>>>0", false],
	] as const)(
		"uses an ordinary int32 cast only within its range: %s",
		(expression, safe) => {
			const out = inspectStaticValueFunction(
				`function compute(input,gate){const n=${expression};gate(n);return n^7;}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === "^",
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY") throw new Error("Missing bitwise consumer");
			expect(instructionInputIsInt32(out.native.facts?.[ip], op.left)).toBe(safe);
			const converted = `mal_ops_number_to_i32((f64) r${op.left})`;
			expect(out.c.source.includes(converted)).toBe(!safe);
		},
	);

	it("removes a proven positive branch while preserving its input range", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,gate){const n=((input>>>0)&65535)+1;gate(n);return n?7:9;}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex((op) => op.opcode === "JUMP_IF");
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "JUMP_IF") throw new Error("Missing conditional input");
		expect(instructionInputIntegerRange(out.native.facts?.[ip], op.cond)).toMatchObject({
			minimum: 1,
			maximum: 65536,
		});
		expect(out.c.source).not.toContain("mal_number_is_truthy(");
	});

	it.each(["Math.abs(n)", "Math.sign(n)", "Math.min(n,0)", "Math.max(n,0)"])(
		"uses bounds in numeric builtin emission: %s",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(input,gate){const n=((input>>>0)&65535)+1;gate(n);return ${expression};}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.c.source).not.toMatch(
				/fabs\(|mal_number_sign\(|mal_number_min_max\(|mal_builtin_math_min_max_numbers\(/,
			);
		},
	);

	it("keeps negative-zero arithmetic outside the integer contract", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,gate){const n=(input>>>0)*-1;gate(n);return Math.abs(n);}globalThis.compute=compute;",
			"compute",
		);
		expect(out.c.source).toContain("fabs(");
	});

	it("keeps path refinements on int32 joins stored as floating-point values", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right,flag,gate){const n=flag?(left|0):(right>>1);gate(n);if(n>5)return Math.sign(n);return Math.sign(n);}globalThis.compute=compute;",
			"compute",
		);
		const signs = out.native.body.instructions.flatMap((op, ip) =>
			op.opcode === "CALL_KNOWN" && op.operation === "Math.sign"
				? [out.native.facts?.[ip]?.inputIntegerRanges?.[1]]
				: [],
		);
		expect(signs).toHaveLength(2);
		expect(signs).toContainEqual({ ...COMPILER_INT32_RANGE, minimum: 6 });
		expect(signs).toContainEqual({ ...COMPILER_INT32_RANGE, maximum: 5 });
	});

	it.each([
		{ minimum: -0, maximum: 0 },
		{ minimum: 0, maximum: Infinity },
		{ minimum: 0.5, maximum: 1 },
		{ minimum: 2, maximum: 1 },
		{ minimum: 0, maximum: 9007199254740992 },
	])("rejects malformed integer bounds %j", (bounds) => {
		const range = { ...COMPILER_INT32_RANGE, ...bounds };
		expect(compilerIntegerRangeIsValid(range)).toBe(false);
		expect(
			instructionFactsAreValid({ inputKindMasks: [8], inputIntegerRanges: [range] }),
		).toBe(false);
	});

	it("checks interval comparison answers against every represented JavaScript value", () => {
		const operators = {
			"<": (a: number, b: number) => a < b,
			"<=": (a: number, b: number) => a <= b,
			">": (a: number, b: number) => a > b,
			">=": (a: number, b: number) => a >= b,
			"===": (a: number, b: number) => a === b,
			"!==": (a: number, b: number) => a !== b,
		};
		let answered = 0,
			unknown = 0;
		for (let amin = -3; amin <= 3; amin++)
			for (let amax = amin; amax <= 3; amax++)
				for (let bmin = -3; bmin <= 3; bmin++)
					for (let bmax = bmin; bmax <= 3; bmax++)
						for (const [operator, evaluate] of Object.entries(operators)) {
							const result = compilerIntegerRangeComparison(
								operator,
								{ ...COMPILER_INT32_RANGE, minimum: amin, maximum: amax },
								{ ...COMPILER_INT32_RANGE, minimum: bmin, maximum: bmax },
							);
							if (result === undefined) {
								unknown++;
								continue;
							}
							answered++;
							for (let a = amin; a <= amax; a++)
								for (let b = bmin; b <= bmax; b++) expect(evaluate(a, b)).toBe(result);
						}
		expect(answered).toBeGreaterThan(0);
		expect(unknown).toBeGreaterThan(0);
	});
});
