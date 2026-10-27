import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import type { NativeFunctionPlan } from "../src/compiler/target/program-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function returned(out: ReturnType<typeof inspectStaticValueFunction>) {
	return out.fn.instructions.findIndex((op) => op.opcode === "RETURN");
}

describe("native constructor completion plans", () => {
	it.each(["value ? null : false", "value ? 'text' : undefined", "{value}"])(
		"preserves storage ownership when selecting the completion for %s",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function probe(value,observe){const result=${expression};observe();return result;}globalThis.probe=probe;`,
				"probe",
			);
			expect(out.native.instructions[returned(out)]?.kind).toBe("return-completion");
			const ordinary = {
				...out.native,
				instructions: out.native.instructions.map((plan) =>
					plan?.kind === "return-completion" ? undefined : plan,
				),
			};
			const lower = (native: NativeFunctionPlan) =>
				lowerNativeFunctionStorage(native, new Map(), out.image.runtime.stringConstants);
			expect(lower(out.native).storage).toEqual(lower(ordinary).storage);
		},
	);

	it("uses a branch-local Symbol bound through boxed storage and a collecting call", () => {
		const out = inspectStaticValueFunction(
			"function probe(value){if(typeof value!=='symbol')throw value;globalThis.collect();return value;}globalThis.probe=probe;",
			"probe",
			{ locked: false },
		);
		const ip = returned(out);
		expect(out.native.instructions[ip]).toEqual({
			kind: "return-completion",
			result: "primitive",
		});
		const op = out.fn.instructions[ip]!;
		if (op.opcode !== "RETURN") throw new Error("missing return");
		expect(out.native.registerRepresentations[op.value]).toBe("boxed");
	});
	it.each([
		["{}", "object"],
		["() => value", "object"],
		["value ? 'text' : 7", "primitive"],
		["+value", "primitive"],
		["value", undefined],
		["value ? {} : 7", undefined],
	] as const)("plans the independent return bound for %s", (expression, result) => {
		const out = inspectStaticValueFunction(
			`function probe(value){return ${expression};}globalThis.probe=probe;`,
			"probe",
			{ locked: false },
		);
		const ip = returned(out);
		expect(out.native.instructions[ip]).toEqual(
			result === undefined ? undefined : { kind: "return-completion", result },
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("keeps derived primitive checks and discharges known Object completions", () => {
		for (const [expression, result] of [
			["{}", "object"],
			["7", undefined],
			["undefined", undefined],
			["value", undefined],
		] as const) {
			const out = inspectStaticValueFunction(
				`class Parent{};class Child extends Parent{constructor(value){return ${expression};}}globalThis.Child=Child;`,
				"Child",
				{ locked: false },
			);
			expect(out.native.instructions[returned(out)]).toEqual(
				result === undefined ? undefined : { kind: "return-completion", result },
			);
			const helpers = out.c.source.match(/mal_vm_op_derived_construct_return\(/g) ?? [];
			expect(helpers).toHaveLength(result === "object" ? 1 : 2);
		}
	});

	it("rejects a return plan after its Object bound is withdrawn", () => {
		const out = inspectStaticValueFunction(
			"function probe(){return {};}globalThis.probe=probe;",
			"probe",
		);
		const ip = returned(out);
		const stale = {
			...out.native,
			facts: out.native.facts!.map((fact, index) =>
				index === ip
					? {
							...fact!,
							inputKindMasks: [
								COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNDEFINED,
							],
						}
					: fact,
			),
		};
		expect(() => validateNativeStorage(stale)).toThrow(/return completion proof/);
	});

	it.each([
		"function probe(value){return value;}",
		"class Parent{};class probe extends Parent{constructor(value){return 7;}}",
	])("rejects an unproven completion strategy in %s", (source) => {
		const out = inspectStaticValueFunction(`${source}globalThis.probe=probe;`, "probe");
		const ip = returned(out);
		const forged: NativeFunctionPlan = {
			...out.native,
			instructions: Array.from(out.native.instructions, (plan, index) =>
				index === ip
					? {
							kind: "return-completion",
							result: out.fn.isDerivedConstructor ? "primitive" : "object",
						}
					: plan,
			),
		};
		expect(() => validateNativeStorage(forged)).toThrow(/return completion proof/);
	});
});
