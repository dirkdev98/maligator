import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("virtual local state", () => {
	it.each([
		"new Boolean(x)",
		"new Number(x)",
		"new Number(+x)",
		"new String(x)",
		"Object(String(x))",
		"Object(!!x)",
		"Object(+x)",
		"Object(BigInt(x))",
		"Object(Symbol.for(x))",
	])("eliminates private own-property transitions on %s", (producer) => {
		const inspected = inspectStaticValueFunction(
			`function probe(x) {
				const box = ${producer};
				const alias = box;
				box.note = x;
				alias.note = 7;
				delete box.note;
				box.other = x;
				return (box.note === undefined) + alias.other;
			} globalThis.probe = probe;`,
			"probe",
		);
		expect(
			inspected.core.some(
				(op) =>
					op.opcode === "callKnown" &&
					(op.attributes.construct || op.attributes.operation === "Object"),
			),
		).toBe(false);
		expect(
			inspected.core.some((op) =>
				["storePropertyStatic", "loadPropertyStatic", "deleteProperty"].includes(
					op.opcode,
				),
			),
		).toBe(false);
	});
	it.each([
		"new Boolean(x)",
		"new Number(x)",
		"new Number(+x)",
		"new String(x)",
		"Object(String(x))",
		"Object(BigInt(x))",
	])(
		"materializes the current own state and primitive slot of %s at escape",
		(producer) => {
			const inspected = inspectStaticValueFunction(
				`function probe(x) {
					const box = ${producer};
					box.note = x;
					delete box.note;
					box.other = x;
					return box;
				} globalThis.probe = probe;`,
				"probe",
			);
			expect(
				inspected.core.filter(
					(op) =>
						op.opcode === "callKnown" &&
						(op.attributes.construct || op.attributes.operation === "Object"),
				),
			).toHaveLength(1);
			expect(inspected.core.filter((op) => op.opcode === "defineProperty")).toHaveLength(
				1,
			);
			expect(inspected.core.some((op) => op.opcode === "deleteProperty")).toBe(false);
		},
	);
	it.each(["Object(x)", "Reflect.construct(Boolean, [x], globalThis.Target)"])(
		"retains conversion, exotic state or newTarget behavior in %s",
		(producer) => {
			const inspected = inspectStaticValueFunction(
				`function probe(x) { const box = ${producer}; box.note = x; return box.note; }
			globalThis.probe = probe;`,
				"probe",
			);
			expect(inspected.core.some((op) => op.opcode === "storePropertyStatic")).toBe(true);
		},
	);
	it.each(["Number", "String"])(
		"preserves %s conversion while discarding initializer state",
		(brand) => {
			const result = inspectStaticValueFunction(
				`function probe(x) { const box = new ${brand}(x()); box.note = 17; return 0; } globalThis.probe=probe;`,
				"probe",
			);
			expect(result.structure.allocations).toBe(0);
			expect(result.core.some((op) => op.attributes.construct)).toBe(false);
			expect(result.structure.genericCalls).toBe(1);
			expect(
				result.core.filter((op) =>
					brand === "Number"
						? op.attributes.operation === "Number"
						: op.attributes.operator === "tostring",
				),
			).toHaveLength(1);
		},
	);
	it.each(["new String(x)", "Object(String(x))"])(
		"retains String exotic state after named writes in %s",
		(producer) => {
			for (const observation of [
				"box[0] = 'z';",
				"box.length = 0;",
				"delete box[0];",
				"Object.defineProperty(box, '0', {value:'z'});",
			]) {
				const result = inspectStaticValueFunction(
					`function probe(x) { const box = ${producer}; box.note = 1; delete box.note; ${observation} return box; } globalThis.probe=probe;`,
					"probe",
				);
				expect(
					result.core.some(
						(op) => op.attributes.construct || op.attributes.operation === "Object",
					),
				).toBe(true);
			}
		},
	);
	it("retains inherited setters and nonconfigurable wrapper properties", () => {
		for (const body of [
			"box.__proto__ = x; return box.__proto__;",
			"Object.defineProperty(box, 'note', {value:x}); delete box.note; return 0;",
		]) {
			const inspected = inspectStaticValueFunction(
				`function probe(x) { const box = new Boolean(x); ${body} } globalThis.probe = probe;`,
				"probe",
			);
			expect(inspected.core.some((op) => op.attributes.construct)).toBe(true);
		}
	});
	it("retains mutable prototype observations during wrapper state updates", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { const box = new Boolean(x); box.note = x; return box.note; } globalThis.probe = probe;",
			"probe",
			{ locked: false },
		);
		expect(inspected.core.some((op) => op.opcode === "construct")).toBe(true);
		expect(inspected.core.some((op) => op.opcode === "storePropertyStatic")).toBe(true);
	});
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
