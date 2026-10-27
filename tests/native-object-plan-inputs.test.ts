import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_THROW,
	instructionInputKind,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const cases = [
	["propertyReadPairs", "const a=receiver.a;const b=receiver.b;return [a,b];"],
	[
		"propertyReadRegions",
		"const a=receiver.a;const b=receiver.b;const c=receiver.c;return [a,b,c];",
	],
	["propertyProjections", "return receiver.a+receiver.b;"],
	["propertyNumericUpdates", "return receiver.count++;"],
	[
		"numberRecordRegions",
		"return receiver.a+receiver.b+receiver.c+receiver.d+receiver.e;",
	],
] as const;

describe("own-slot plan input bounds", () => {
	it.each(cases)("rejects impossible %s without weakening effects", (plan, body) => {
		const out = inspectStaticValueFunction(
			`const pick=function pick(flag,observe){observe(new.target);return flag?'text':42;};function compute(flag,observe){const receiver=pick(flag,observe);${body}}globalThis.pick=pick;globalThis.compute=compute;`,
			"compute",
			{ locked: false },
		);
		for (const fn of [
			out.native,
			deserializeCompilerArtifact(serializeCompilerArtifact(out.image)).native.functions[
				out.native.functionIndex
			]!,
		]) {
			expect(fn.storage![plan]).toEqual([]);
			for (const [ip, op] of fn.body.instructions.entries()) {
				if (op.opcode !== "LOAD_PROPERTY_STATIC" && op.opcode !== "STORE_PROPERTY_STATIC")
					continue;
				expect(instructionInputKind(fn.facts?.[ip], op.object)).toBe(
					COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
				);
				const effects =
					INSTRUCTION_CALLS_USER_CODE | INSTRUCTION_MAY_GC | INSTRUCTION_MAY_THROW;
				expect((fn.facts?.[ip]?.effectMask ?? 0) & effects).toBe(effects);
			}
		}
	});

	it.each(cases)("keeps %s for Object-containing bounds", (plan, body) => {
		const out = inspectStaticValueFunction(
			`globalThis.compute=function compute(receiver){${body}};`,
			"compute",
			{ locked: false },
		);
		expect(out.native.storage![plan]).toHaveLength(1);
		for (const [mask, admitted] of [
			[COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING, false],
			[COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_OBJECT, false],
			[COMPILER_VALUE_KIND_OBJECT, true],
			[COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_STRING, true],
			[COMPILER_VALUE_KIND_TOP, true],
		] as const) {
			const facts = out.native.facts!.map((facts, ip) => {
				const op = out.native.body.instructions[ip]!;
				if (op.opcode !== "LOAD_PROPERTY_STATIC" && op.opcode !== "STORE_PROPERTY_STATIC")
					return facts;
				return {
					...facts,
					inputKindMasks: facts!.inputKindMasks!.map((kind, index) =>
						facts!.registers![facts!.inputOffset! + index] === op.object ? mask : kind,
					),
				};
			});
			const lowered = lowerNativeFunctionStorage({ ...out.native, facts });
			expect(lowered.storage![plan].length, String(mask)).toBe(admitted ? 1 : 0);
			expect(lowered.facts?.map((facts) => facts?.effectMask)).toEqual(
				out.native.facts?.map((facts) => facts?.effectMask),
			);
			if (!admitted)
				expect(() =>
					serializeCompilerArtifact({
						...out.image,
						native: {
							...out.image.native,
							functions: out.image.native.functions.with(out.native.functionIndex, {
								...out.native,
								facts,
							}),
						},
					}),
				).toThrow(/invalid or stale storage plan/);
		}
	});
});
