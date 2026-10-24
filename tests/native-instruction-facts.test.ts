import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
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
	instructionInputKind,
	instructionResultKind,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeInstructionEffects } from "../src/compiler/target/program-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("independent native instruction facts", () => {
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
		expect(out.native.storage!.numberPredicates[0]!.mode).toBe("non-number");
		expect(out.c.source).not.toContain("mal_ops_is_number(");
		expect(out.c.source).toContain("mal_vm_typeof_compare(");
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
			COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL,
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
