import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("primitive union container lifetimes", () => {
	it.each([
		"flag ? 17 : undefined",
		"flag ? null : 'text' + suffix",
		"flag ? 3n : undefined",
		"flag ? true : null",
		"flag ? 17 : 'text' + suffix",
	])("does not extend the lifetime of %s through an overwritten field", (expression) => {
		const out = inspectStaticValueFunction(
			`function compute(flag,suffix,callback){const value=${expression};const record={value};callback();record.value=19;return record.value;}globalThis.compute=compute;`,
			"compute",
		);
		expect(out.structure.allocations).toBe(0);
		expect(out.structure.genericCalls).toBe(1);
		expect(out.core.some(({ opcode }) => opcode === "rootUse")).toBe(false);
	});

	it.each(["flag ? input : 17", "flag ? Symbol('held') : undefined"])(
		"retains the old field's lifetime when it can hold %s",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(flag,input,callback){const value=${expression};const record={value};callback();record.value=19;return record.value;}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.core.some(({ opcode }) => opcode === "rootUse")).toBe(true);
		},
	);

	it.each(["yield 1", "await callback()"])(
		"does not preserve overwritten primitive fields across %s",
		(suspend) => {
			const declaration = suspend.startsWith("yield") ? "function*" : "async function";
			const out = inspectStaticValueFunction(
				`${declaration} compute(flag,suffix,callback){const value=flag?undefined:'text'+suffix;const record={value};${suspend};record.value=19;return record.value;}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.core.some(({ opcode }) => opcode === "rootUse")).toBe(false);
		},
	);
});
