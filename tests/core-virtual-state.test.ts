import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("virtual local state", () => {
	it.each(["[x()]", "({value:x()})", "({[x()]:1})"])(
		"discards private initializer storage after preserving effects in %s",
		(expression) => {
			const inspected = inspectStaticValueFunction(
				`function probe(x) { ${expression}; return 0; } globalThis.probe=probe;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBe(0);
			expect(inspected.structure.genericCalls).toBe(1);
			if (expression.includes("[x()]:"))
				expect(
					inspected.core.some((operation) => operation.opcode === "toPropertyKey"),
				).toBe(true);
		},
	);
	it("retains initializer storage exposed to a producer's later observation", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { const value = [x()]; x(value); return 0; } globalThis.probe=probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBe(1);
		expect(inspected.structure.genericCalls).toBe(2);
	});
	it.each([
		"const a = [1, 2]; a.push(x); const last = a.pop(); return last + a.length;",
		"const a = [1, 2]; a[0] = x; delete a[1]; a.length = 1; return a[0];",
		"const a = {x: 1}; const b = a; b.x = x; delete b.x; return b.x;",
		"const a = {v: 1}; if (x) a.v = 2; else a.v = 3; return a.v;",
		"let sum = 0; for (let i = 0; i < 3; i++) { const a = [i]; a.push(x); sum += a.pop(); } return sum;",
	])("erases the private storage after local transitions: %s", (body) => {
		const inspected = inspectStaticValueFunction(
			`function probe(x) { ${body} } globalThis.probe = probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBe(0);
		expect(inspected.structure.operations).toHaveLength(0);
	});

	it("materializes the current state at an escaping call", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x, sink) { const a = [1, 2]; a.push(x); a.pop(); a[0] = x; sink(a); return a; } globalThis.probe = probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBe(1);
		expect(inspected.structure.operations).toHaveLength(0);
		expect(inspected.structure.pooledMaterializations).toBe(0);
	});
});
