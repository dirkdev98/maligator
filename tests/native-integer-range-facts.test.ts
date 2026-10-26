import { describe, expect, it } from "vitest";
import {
	instructionFactsAreValid,
	instructionInputIntegerRange,
	instructionInputIsInt32,
	instructionResultIntegerRange,
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
import { nativeInt32ArithmeticExpression } from "../src/compiler/target/native-scalar-operators.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("native integer ranges", () => {
	it("uses the external operand's bounds in a numeric fusion's integer finish", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right,gate){const n=(right&255)+1;gate(n);return (left+2)^n;}globalThis.compute=compute;",
			"compute",
		);
		expect(
			out.native.specializations.some((region) => region.kind === "numeric-fusion"),
		).toBe(true);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "^",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "BINARY") throw new Error("Missing integer finish");
		expect(out.native.registerRepresentations[op.right]).toBe("number");
		expect(instructionInputIntegerRange(out.native.facts?.[ip], op.right)).toMatchObject({
			minimum: 1,
			maximum: 256,
		});
		expect(out.c.source).toContain(`^ ((i32) r${op.right})`);
		expect(out.c.source).not.toContain(`mal_ops_number_to_i32(r${op.right})`);
	});

	it("distinguishes input and result bounds when storage aliases their registers", () => {
		const result = { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 7 };
		const facts = {
			registers: [5, 5, 6, 8],
			inputOffset: 1,
			resultKindMasks: [8],
			inputKindMasks: [8, 8, 8],
			resultIntegerRanges: [result],
			inputIntegerRanges: [COMPILER_UINT32_RANGE, undefined, COMPILER_INT32_RANGE],
		};
		expect(instructionFactsAreValid(facts)).toBe(true);
		expect(instructionResultIntegerRange(facts, 5)).toEqual(result);
		expect(instructionInputIntegerRange(facts, 5)).toEqual(COMPILER_UINT32_RANGE);
		for (const register of [-1, 6, 8, 99])
			expect(instructionResultIntegerRange(facts, register)).toBeUndefined();
		for (const malformed of [
			{ resultKindMasks: [8], resultIntegerRanges: [] },
			{ resultKindMasks: [8], resultIntegerRanges: [COMPILER_INT32_RANGE, undefined] },
			{ resultKindMasks: [16], resultIntegerRanges: [result] },
			{ resultKindMasks: [8], resultIntegerRanges: [{ ...result, minimum: -0 }] },
			{ resultIntegerRanges: [result] },
		])
			expect(instructionFactsAreValid(malformed)).toBe(false);
	});

	it.each([
		["input&255", "10", true],
		["input>>>0", "(other>>>0)+1", false],
		["input>>>0", "(other&255)+1", true],
		["input|0", "10", false],
		["input>>>0", "other&255", false],
		["(input>>>0)*2", "10", false],
		["input?-0:3", "10", false],
	] as const)(
		"uses unsigned C remainder only for its exact domain: %s %% %s",
		(left, right, direct) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other,gate){const n=${left}, d=${right};gate(n,d);return n%d;}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.c.source.includes("% (u32)")).toBe(direct);
			expect(out.c.source.includes("mal_number_remainder(")).toBe(!direct);
		},
	);

	it.each(["isFinite", "isInteger", "isSafeInteger"])(
		"folds Number.%s for unsigned and wider safe integers across suspension",
		(method) => {
			for (const generator of [false, true]) {
				const out = inspectStaticValueFunction(
					`function${generator ? "*" : ""} compute(input,gate){const n=(input>>>0)*2+1;${generator ? "yield n;" : ""}gate(n);return Number.${method}(n);}globalThis.compute=compute;`,
					"compute",
				);
				expect(out.native.storage!.numberPredicates).toEqual([]);
				const ip = out.native.body.instructions.findIndex((op) => op.opcode === "CALL");
				const observer = out.native.body.instructions[ip]!;
				if (observer.opcode !== "CALL") throw new Error("Missing range observation");
				expect(
					instructionInputIntegerRange(out.native.facts![ip], observer.arguments[0]!),
				).toEqual({
					minimum: 1,
					maximum: 8589934591,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				});
				expect(out.native.body.instructions).toContainEqual(
					expect.objectContaining({ opcode: "CREATE_BOOLEAN", value: true }),
				);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
					out.image,
				);
			}
		},
	);

	it("keeps range facts in admitted entries when their canonical table is shared", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,gate){const n=input>>>0;gate(n);return Number.isSafeInteger(n);}globalThis.compute=compute;globalThis.result=compute(+globalThis.input,globalThis.observe);",
			"compute",
		);
		expect(out.native.directEntries.length).toBeGreaterThan(0);
		const ip = out.native.body.instructions.findIndex((op) => op.opcode === "CALL");
		const observer = out.native.body.instructions[ip]!;
		if (observer.opcode !== "CALL") throw new Error("Missing range observation");
		for (const entry of out.native.directEntries)
			expect(
				instructionInputIntegerRange(
					nativeVariantContract(out.native, entry).facts?.[ip],
					observer.arguments[0]!,
				),
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

describe("integer loop emission", () => {
	it("requires both operand proofs and keeps signed division and remainder outside integer kernels", () => {
		for (const operator of ["+", "-", "*"]) {
			expect(
				nativeInt32ArithmeticExpression(operator, "left", undefined),
			).toBeUndefined();
			expect(
				nativeInt32ArithmeticExpression(operator, undefined, "right"),
			).toBeUndefined();
		}
		for (const operator of ["/", "%", "**"])
			expect(nativeInt32ArithmeticExpression(operator, "left", "right")).toBeUndefined();
	});

	it.each([false, true])(
		"carries integer update proofs through canonical and suspended bodies, suspended=%s",
		(suspended) => {
			const out = inspectStaticValueFunction(
				`function${suspended ? "*" : ""} compute(gate){let sum=0.5;for(let i=0;i<16;i++){${suspended ? "yield i;" : ""}gate(i);sum+=i;}return sum;}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "UNARY" && op.operator === "increment",
			);
			const update = out.native.body.instructions[ip]!;
			if (update.opcode !== "UNARY") throw new Error("Missing loop update");
			expect(out.native.registerRepresentations[update.dst]).toBe("int32");
			expect(instructionResultIntegerRange(out.native.facts?.[ip], update.dst)).toEqual(
				COMPILER_INT32_RANGE,
			);
			expect(instructionInputIsInt32(out.native.facts?.[ip], update.src)).toBe(true);
			expect(out.c.source).not.toContain("MAL_UNARY_INCREMENT");
			expect(out.c.source).not.toContain("mal_ops_number_to_i32(");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it("preserves integer kernels in a boxed fast entry", () => {
		const out = inspectStaticValueFunction(
			"function compute(flag,gate){let sum=0.5;for(let i=0;i<16;i++){const next=i+1;if(flag)return next;gate(i);sum+=i;}return sum;}globalThis.compute=compute;",
			"compute",
		);
		expect(out.c.source).toContain("mal_compiled_1_try(");
		expect(out.c.source).toContain("mal_value_from_i32((i32) (");
		expect(out.c.source).not.toContain("MAL_UNARY_INCREMENT");
	});
});
