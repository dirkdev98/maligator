import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	EFFECT_DOMAINS,
	NO_EFFECT_SUMMARY,
} from "../src/compiler/shared/effect-summary.ts";
import {
	decodeInstructionEffects,
	encodeInstructionEffects,
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_SUSPEND,
	INSTRUCTION_MAY_THROW,
	instructionEffectMaskIsValid,
	instructionFactsAreValid,
	instructionInputIsInt32,
	instructionInputKind,
	instructionResultKind,
} from "../src/compiler/shared/instruction-facts.ts";
import { COMPILER_INT32_RANGE } from "../src/compiler/shared/integer-range.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { nativeInstructionEffects } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { positionTableEntries } from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("independent native instruction facts", () => {
	it.each(["direct-known-call", "core-object-slots"])(
		"flattens %s entry facts without assigning executable sites to liveness markers",
		(fixture) => {
			for (const primordials of ["mutable", "locked"] as const) {
				const image = compileEntrypoint(`tests/local/${fixture}.js`, {
					buildConfig: resolveBuildConfig({ engine: { primordials } }),
					enforcePolicies: false,
				});
				const entries = image.native.functions.flatMap((fn) => fn.directEntries);
				expect(entries.length).toBeGreaterThan(0);
				for (const fn of image.native.functions)
					for (const entry of fn.directEntries)
						for (const fact of entry.instructionFacts ?? []) {
							expect(Number.isInteger(fact.instructionIp)).toBe(true);
							expect(fn.body.instructions[fact.instructionIp]).toBeDefined();
						}
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	it.each([
		["binary", "(flag?!!input:null)<undefined", "BINARY"],
		["unary", "+(flag?!!input:null)", "UNARY"],
		["integer unary", "~(flag?!!input:null)", "UNARY"],
		["negation", "-(flag?!!input:null)", "UNARY"],
	] as const)(
		"uses %s completion effects independently of operand kinds",
		(_name, expression, opcode) => {
			const out = inspectStaticValueFunction(
				`function compute(input,flag){return ${expression};}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findLastIndex(
				(op) => op.opcode === opcode && op.operator !== "!",
			);
			expect(out.native.facts?.[ip]?.effectMask).toBe(0);
			for (const effectMask of [
				0,
				INSTRUCTION_MAY_THROW,
				INSTRUCTION_CALLS_USER_CODE,
				undefined,
			]) {
				const facts = out.native.facts!.with(
					ip,
					effectMask === undefined ? undefined : { effectMask },
				);
				const image = lowerNativeStorage({
					...out.image,
					native: {
						...out.image.native,
						functions: out.image.native.functions.with(out.native.functionIndex, {
							...out.native,
							facts,
						}),
					},
				});
				const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
				const native = restored.native.functions[out.native.functionIndex]!;
				const c = emitCompiledFunction(
					native,
					native.functionIndex,
					"",
					positionTableEntries(restored.runtime.functions[native.functionIndex]!),
				)!.source;
				expect(c).toContain(
					opcode === "BINARY" ? "mal_vm_binary_op(" : "mal_vm_unary_op_fast(",
				);
				expect(c.includes("MAL_THREW()")).toBe(effectMask !== 0);
				expect(c.includes("MAL_FRAME_POS(")).toBe(effectMask !== 0);
			}
		},
	);

	it.each(["&", "|", "^", "<<", ">>", ">>>"])(
		"retains int32 input precision through floating joins for %s without removing right coercion",
		(operator) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other,flag,gate,shift){const n=flag?(input|0):(other>>1);gate(n);return n${operator}shift;}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) =>
					op.opcode === "BINARY" &&
					op.operator === operator &&
					op.right < out.native.body.parameterCount,
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY") throw new Error("Missing final bitwise operation");
			expect(instructionInputIsInt32(out.native.facts?.[ip], op.left)).toBe(true);
			expect(instructionInputIsInt32(out.native.facts?.[ip], op.right)).toBe(false);
			expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!).mayThrow).toBe(
				true,
			);
			expect(out.c.source).not.toContain(`mal_ops_number_to_i32(r${op.left})`);
			expect(out.c.source).not.toContain(`mal_ops_number_value_to_i32(r${op.left})`);
			expect(out.c.source).toContain("MAL_THREW()");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each(["isFinite", "isInteger", "isSafeInteger"])(
		"folds Number.%s for int32 joins even across suspension",
		(method) => {
			for (const generator of [false, true]) {
				const out = inspectStaticValueFunction(
					`function${generator ? "*" : ""} compute(input,other,flag,gate){const n=flag?(input|0):(other>>1);${generator ? "yield n;" : "gate(n);"}return Number.${method}(n);}globalThis.compute=compute;`,
					"compute",
				);
				expect(out.native.storage!.numberPredicates).toEqual([]);
				const result = out.native.body.instructions.find(
					(op) => op.opcode === "CREATE_BOOLEAN" && op.value,
				);
				if (result?.opcode !== "CREATE_BOOLEAN") throw new Error("Missing folded true");
				expect(
					out.native.body.instructions.some(
						(op) => op.opcode === "RETURN" && op.value === result.dst,
					),
				).toBe(true);
				expect(
					out.native.body.instructions.some(
						(op) => op.opcode === (generator ? "YIELD" : "CALL"),
					),
				).toBe(true);
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
					out.image,
				);
			}
		},
	);

	it("keeps an unproved numeric phi outside the int32 refinement", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,other,flag,gate){const n=flag?(input|0):+other;gate(n);return (n&7)+Number.isSafeInteger(n);}globalThis.compute=compute;",
			"compute",
		);
		expect(out.native.storage!.numberPredicates[0]!.mode).toBe("number");
	});

	it("validates int32 refinements against their input kinds and arity", () => {
		for (const [inputIntegerRanges, valid] of [
			[[COMPILER_INT32_RANGE], false],
			[[undefined, COMPILER_INT32_RANGE], true],
			[[COMPILER_INT32_RANGE, undefined], false],
		] as const)
			expect(
				instructionFactsAreValid({
					inputKindMasks: [COMPILER_VALUE_KIND_STRING, COMPILER_VALUE_KIND_NUMBER],
					inputIntegerRanges,
				}),
			).toBe(valid);
		expect(
			instructionInputIsInt32(
				{ registers: [0, 0], inputOffset: 1, inputIntegerRanges: [COMPILER_INT32_RANGE] },
				0,
			),
		).toBe(true);
		expect(
			instructionInputIsInt32(
				{ registers: [-1], inputOffset: 0, inputIntegerRanges: [COMPILER_INT32_RANGE] },
				-1,
			),
		).toBe(false);
	});
	it("distinguishes an input String from its Number result in constrained storage", () => {
		const facts = {
			registers: [0, 0],
			inputOffset: 1,
			inputKindMasks: [COMPILER_VALUE_KIND_STRING],
			resultKindMasks: [COMPILER_VALUE_KIND_NUMBER],
		};
		expect(instructionInputKind(facts, 0)).toBe(COMPILER_VALUE_KIND_STRING);
		expect(instructionResultKind(facts, 0)).toBe(COMPILER_VALUE_KIND_NUMBER);
	});
	it("does not reuse encoded effects when a caller mutates an unfrozen summary", () => {
		const effects = { ...NO_EFFECT_SUMMARY, mayThrow: false };
		expect(encodeInstructionEffects(effects)).toBe(0);
		effects.mayThrow = true;
		expect(encodeInstructionEffects(effects)).toBe(INSTRUCTION_MAY_THROW);
	});

	it("eliminates predicates excluded by a union while retaining its possible typeof result", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,flag){const value=flag?String(input):Symbol('x');return Number.isFinite(value)||(typeof value==='number')||(typeof value==='string');}globalThis.compute=compute;",
			"compute",
		);
		expect(out.native.storage!.numberPredicates).toEqual([]);
		expect(
			out.native.body.instructions
				.filter((op) => op.opcode === "CALL_KNOWN")
				.map((op) => op.operation),
		).toEqual(expect.arrayContaining(["String", "Symbol"]));
		expect(out.c.source).not.toContain("mal_ops_is_number(");
		expect(out.c.source).toContain("mal_value_is_string(");
	});

	it("does not treat immediate placeholders as register identities", () => {
		expect(
			instructionInputKind(
				{
					registers: [-1, -1],
					inputOffset: 0,
					inputKindMasks: [COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_STRING],
				},
				-1,
			),
		).toBeUndefined();
	});

	it.each(EFFECT_DOMAINS)("preserves independent reads and writes of %s", (domain) => {
		const read = encodeInstructionEffects({ ...NO_EFFECT_SUMMARY, reads: [domain] });
		const write = encodeInstructionEffects({ ...NO_EFFECT_SUMMARY, writes: [domain] });
		expect(read & write).toBe(0);
		expect(decodeInstructionEffects(read)).toEqual({
			...NO_EFFECT_SUMMARY,
			reads: [domain],
		});
		expect(decodeInstructionEffects(write)).toEqual({
			...NO_EFFECT_SUMMARY,
			writes: [domain],
		});
	});

	it.each([
		["mayThrow", INSTRUCTION_MAY_THROW],
		["maySuspend", INSTRUCTION_MAY_SUSPEND],
		["mayGc", INSTRUCTION_MAY_GC],
		["callsUserCode", INSTRUCTION_CALLS_USER_CODE],
	] as const)("preserves %s without widening other effect dimensions", (flag, mask) => {
		expect(encodeInstructionEffects({ ...NO_EFFECT_SUMMARY, [flag]: true })).toBe(mask);
		expect(decodeInstructionEffects(mask)).toEqual({
			...NO_EFFECT_SUMMARY,
			[flag]: true,
		});
	});

	it.each([-1, 0.5, NaN, Infinity, 1 << 22, 2 ** 32, 2 ** 32 + 1])(
		"rejects invalid effect mask %s",
		(mask) => {
			expect(instructionEffectMaskIsValid(mask)).toBe(false);
			expect(() => decodeInstructionEffects(mask)).toThrow(/Invalid instruction effects/);
		},
	);

	it("retains input and result kinds alongside range-selected arithmetic", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,flag){const n=(+input)&65535;return flag?(n*3+1)%101:undefined;}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "%",
		);
		expect(out.native.instructions[ip]?.kind).toBe("unsigned-arithmetic");
		expect(out.native.facts?.[ip]).toMatchObject({
			inputKindMasks: [COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_NUMBER],
			resultKindMasks: [COMPILER_VALUE_KIND_NUMBER],
			effectMask: 0,
		});
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("retains Symbol unions and coercive effects at ordinary builtin calls", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,flag){const value=flag?String(input):Symbol('x');return Math.abs(value);}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Math.abs",
		);
		const facts = out.native.facts?.[ip];
		expect(facts?.inputKindMasks?.[1]).toBe(
			COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
		);
		expect(facts?.resultKindMasks).toEqual([COMPILER_VALUE_KIND_NUMBER]);
		expect(decodeInstructionEffects(facts!.effectMask!).mayThrow).toBe(true);
		expect(out.c.source).toContain("MAL_THREW()");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("keeps canonical coercion effects while refining an admitted numeric entry", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right){return left*right;}globalThis.compute=compute;globalThis.result=compute(+globalThis.left,+globalThis.right);",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "BINARY" && op.operator === "*",
		);
		expect(
			decodeInstructionEffects(out.native.facts![ip]!.effectMask!).callsUserCode,
		).toBe(true);
		expect(
			out.native.directEntries.some((entry) =>
				entry.instructionFacts?.some(
					(fact) => fact.instructionIp === ip && fact.effectMask === 0,
				),
			),
		).toBe(true);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("preserves branch operand kinds independently of physical storage", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,gate){const value=+input;gate(value);if(value)return 'yes';return 'no';}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex((op) => op.opcode === "JUMP_IF");
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "JUMP_IF") throw new Error("Missing branch");
		expect(instructionInputKind(out.native.facts?.[ip], op.cond)).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
		expect(out.native.facts?.[ip]?.effectMask).toBe(0);
	});

	it("does not transfer semantic purity to a fallible allocation helper", () => {
		const facts = {
			effectMask: 0,
			inputKindMasks: [COMPILER_VALUE_KIND_TOP, COMPILER_VALUE_KIND_STRING],
		};
		expect(
			nativeInstructionEffects({ opcode: "CREATE_OBJECT", dst: 0 }, facts),
		).toMatchObject({ allocation: true, throwing: true });
		const effects = nativeInstructionEffects(
			{ opcode: "BINARY", operator: "+", dst: 2, left: 0, right: 1 },
			{ effectMask: INSTRUCTION_MAY_THROW | INSTRUCTION_MAY_GC },
		);
		expect(effects).toEqual({
			allocation: true,
			collection: true,
			throwing: true,
			reentry: false,
			invalidation: false,
		});
	});
});
