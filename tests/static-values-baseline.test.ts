import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(method: string, observable: boolean, locked = true, profile = false) {
	return inspectStaticValueFunction(
		`function probe(x, from) { ${observable ? "return " : ""}["foo", "bar"].${method}(x, from); }
		globalThis.probe = probe;`,
		"probe",
		{ locked, profile },
	);
}

describe("static-value baseline witnesses", () => {
	it.each([false, true])(
		"keeps observable and discarded results distinct (profile=%s)",
		(profile) => {
			for (const observable of [false, true]) {
				const included = inspect("includes", observable, true, profile);
				expect(included.structure.operations).toMatchObject([
					{ receiver: "array", key: "includes" },
				]);
				expect(included.structure.pooledMaterializations).toBe(1);
				expect(included.structure.allocations).toBe(1);
				expect(included.c.source).toContain("mal_vm_instantiate_literal_template");
				expect(included.c.source).toContain("mal_vm_call_literal_method");
				expect(
					included.core.some(
						(operation) => operation.opcode === "instantiateLiteralTemplate",
					),
				).toBe(true);
				const absent = inspect("includex", observable, true, profile);
				expect(absent.structure.operations).toHaveLength(0);
				expect(absent.structure.genericCalls).toBeGreaterThan(0);
				expect(absent.structure.genericLookups).toBeGreaterThan(0);
			}
		},
	);
	it("detects removal of the locked-world transform before native DCE", () => {
		const optimized = inspect("includes", true);
		const rejected = inspect("includes", true, false);
		expect(rejected.structure.operations).toHaveLength(0);
		expect(rejected.structure.pooledMaterializations).toBe(0);
		expect(rejected.structure.genericCalls).toBeGreaterThan(
			optimized.structure.genericCalls,
		);
	});
});
