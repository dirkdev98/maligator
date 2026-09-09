import { describe, expect, it } from "vitest";
import {
	constantCallProfiles,
	constantCallProfileSource,
} from "./helpers/constant-call-profiles.ts";
import {
	dynamicNumericCallCases,
	dynamicNumericCallSource,
	dynamicNumericProfiles,
	numericCallCases,
} from "./helpers/numeric-call-profiles.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("partially static numeric call profiles", () => {
	for (const profile of dynamicNumericProfiles) {
		it.each(dynamicNumericCallCases)(
			`resolves %s through ${profile} after one conversion`,
			(...entry) => {
				const output = inspectStaticValueFunction(
					dynamicNumericCallSource(entry, profile),
					"probe",
				);
				expect(output.structure.genericLookups).toBe(0);
				expect(output.structure.allocations).toBe(0);
				if (
					profile !== "suspension" &&
					![
						"isNaN",
						"isFinite",
						"BigInt.asIntN",
						"BigInt.asUintN",
						"parseInt",
						"Number.parseInt",
					].includes(entry[0])
				) {
					expect(output.c.source).not.toContain("mal_vm_call_known_native(");
				}
				expect(
					output.core.filter(
						(op) => op.opcode === "unary" && op.attributes.operator === "+",
					),
				).toHaveLength(1);
			},
		);
		it.each(dynamicNumericCallCases)(
			`retains mutable partial %s through ${profile}`,
			(...entry) => {
				const output = inspectStaticValueFunction(
					dynamicNumericCallSource(entry, profile),
					"probe",
					{ locked: false },
				);
				expect(output.structure.genericLookups).toBeGreaterThan(0);
				expect(output.structure.genericCalls).toBeGreaterThan(0);
			},
		);
	}
	it.each(["Math.abs", "Math.min", "Math.max", "Math.round"])(
		"keeps typed %s operations through coroutine storage",
		(callee) => {
			const entry = dynamicNumericCallCases.find(([name]) => name === callee)!;
			const output = inspectStaticValueFunction(
				dynamicNumericCallSource(entry, "suspension"),
				"probe",
			);
			expect(
				output.core.some(
					(op) => op.opcode === "mathUnaryNumber" || op.opcode === "mathBinaryNumber",
				),
			).toBe(true);
			expect(output.c.source).not.toContain("mal_vm_call_known_native(");
		},
	);

	it.each([
		"isNaN(x)",
		"isFinite(x)",
		"BigInt.asIntN(x,-1n)",
		"BigInt.asUintN(x,-1n)",
		"parseInt('123',x)",
	])("retains coercion of unproved numeric operands in %s", (expression) => {
		const output = inspectStaticValueFunction(
			`function probe(x){return ${expression};}globalThis.probe=probe;`,
			"probe",
		);
		expect(output.c.source).toContain("mal_vm_call_known_native(");
	});
});

describe("certified numeric and symbol call profiles", () => {
	for (const profile of constantCallProfiles) {
		it.each(numericCallCases)(
			`folds %s through ${profile} while retaining effects`,
			(...entry) => {
				const output = inspectStaticValueFunction(
					constantCallProfileSource(entry, profile),
					"probe",
				);
				expect(output.structure.genericLookups).toBe(0);
				expect(output.structure.genericCalls).toBe(
					profile === "effects" || profile === "unused" ? 2 : 1,
				);
				expect(output.structure.allocations).toBe(0);
				expect(output.structure.coercions).toBe(0);
				expect(
					output.core.filter(
						(op) =>
							op.opcode === "callKnown" ||
							op.opcode === "builtinError" ||
							op.opcode === "mathUnaryNumber" ||
							op.opcode === "mathBinaryNumber",
					),
				).toEqual([]);
			},
		);
		it.each(numericCallCases)(`retains mutable %s through ${profile}`, (...entry) => {
			const output = inspectStaticValueFunction(
				constantCallProfileSource(entry, profile),
				"probe",
				{ locked: false },
			);
			expect(output.structure.genericLookups).toBeGreaterThan(0);
			expect(output.structure.genericCalls).toBeGreaterThan(
				profile === "effects" || profile === "unused" ? 2 : 1,
			);
		});
	}
	it.each([
		"Reflect.apply(BigInt.asIntN,undefined,[8,-1n])",
		"Reflect.apply(BigInt.asUintN,undefined,[8,~0n])",
		"Number.apply(undefined,[-1n])",
		"String.apply(undefined,[-1n])",
	])("expands the argument list after folding its elements in %s", (expression) => {
		const output = inspectStaticValueFunction(
			`function probe(){return ${expression};}globalThis.probe=probe;`,
			"probe",
		);
		expect(output.structure.allocations).toBe(0);
		expect(output.core.some((op) => op.opcode === "callKnown")).toBe(false);
	});
	it.each([
		"x",
		"{get length(){return x();},0:8,1:-1n}",
		"{length:2,0:8,get 1(){return x();}}",
		"new Proxy([8,-1n],x)",
		"Object.defineProperty([8,-1n],'1',{get:x})",
		"Object.assign([8,-1n],x)",
	])("retains the argument-list protocol for %s", (list) => {
		const output = inspectStaticValueFunction(
			`function probe(x){return Reflect.apply(BigInt.asUintN,undefined,${list});}globalThis.probe=probe;`,
			"probe",
		);
		expect(
			output.core.some(
				(op) =>
					op.opcode === "callKnown" &&
					op.attributes.operation === "BigInt.asUintN" &&
					op.attributes.argumentMode === "array-like",
			),
		).toBe(true);
	});
});
