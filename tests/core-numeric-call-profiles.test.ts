import { describe, expect, it } from "vitest";
import {
	numericCallCases,
	numericCallProfiles,
	numericCallProfileSource,
} from "./helpers/numeric-call-profiles.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("certified numeric and symbol call profiles", () => {
	for (const profile of numericCallProfiles) {
		it.each(numericCallCases)(
			`folds %s through ${profile} while retaining effects`,
			(...entry) => {
				const output = inspectStaticValueFunction(
					numericCallProfileSource(entry, profile),
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
				numericCallProfileSource(entry, profile),
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
