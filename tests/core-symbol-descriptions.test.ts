import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const observations = [
	["value.description", "Symbol.prototype.description<get>"],
	["value.toString()", "Symbol.prototype.toString"],
	["String(value)", "String"],
] as const;

describe("escaping Symbol description capture", () => {
	it("captures an optional description once while preserving the escaping allocation", () => {
		const output = inspectStaticValueFunction(
			`function target(input, sink) {
				try {
					const value = Symbol(input, sink("extra"));
					sink(value);
					return [value.description, value.toString(), String(value)];
				} finally { sink("finally"); }
			} globalThis.target = target;`,
			"target",
		);
		expect(
			output.core.filter((instruction) => instruction.attributes.operation === "Symbol"),
		).toHaveLength(1);
		expect(
			output.core.filter((instruction) =>
				observations.some(
					([, operation]) => instruction.attributes.operation === operation,
				),
			),
		).toEqual([]);
		expect(
			output.core.filter(
				(instruction) =>
					instruction.opcode === "unary" &&
					instruction.attributes.operator === "tostring",
			),
		).toHaveLength(1);
	});

	it.each([
		"const input = {toString(){return x;}};",
		"const input = [x];",
		"const input = function(){}; input.toString = () => x;",
	])("captures object-valued descriptions at creation for %s", (setup) => {
		for (const [expression, operation] of observations) {
			const output = inspectStaticValueFunction(
				`function target(x, sink) {
					${setup}
					const value = Symbol(input);
					sink(value);
					return ${expression};
				} globalThis.target = target;`,
				"target",
			);
			expect(
				output.core.some((instruction) => instruction.attributes.operation === "Symbol"),
			).toBe(true);
			expect(
				output.core.some((instruction) => instruction.attributes.operation === operation),
			).toBe(false);
		}
	});

	it("shares captured registry text across metadata consumers without removing registration", () => {
		const output = inspectStaticValueFunction(
			`function target(x, sink) {
				const value = Symbol.for(x);
				sink(value);
				return [value.description, value.toString(), String(value), Symbol.keyFor(value)];
			} globalThis.target = target;`,
			"target",
		);
		expect(
			output.core.filter(
				(instruction) => instruction.attributes.operation === "Symbol.for",
			),
		).toHaveLength(1);
		expect(
			output.core.filter((instruction) =>
				[
					"Symbol.prototype.description<get>",
					"Symbol.prototype.toString",
					"String",
					"Symbol.keyFor",
				].includes(instruction.attributes.operation as string),
			),
		).toEqual([]);
		expect(
			output.core.filter(
				(instruction) =>
					instruction.opcode === "unary" &&
					instruction.attributes.operator === "tostring",
			),
		).toHaveLength(1);
	});

	it("retains captured text across suspension while yielding the original symbol", () => {
		const output = inspectStaticValueFunction(
			`function* target(x) {
				const value = Symbol({toString(){return x;}});
				yield value;
				return value.toString();
			} globalThis.target = target;`,
			"target",
		);
		expect(
			output.core.some((instruction) => instruction.attributes.operation === "Symbol"),
		).toBe(true);
		expect(
			output.core.some(
				(instruction) => instruction.attributes.operation === "Symbol.prototype.toString",
			),
		).toBe(false);
	});

	it("retains mutable metadata dispatch after symbol escape", () => {
		const output = inspectStaticValueFunction(
			`function target(x, sink) {
				const value = Symbol({toString(){return x;}});
				sink(value);
				return value.toString();
			} globalThis.target = target;`,
			"target",
			{ locked: false },
		);
		expect(output.structure.genericLookups).toBeGreaterThan(0);
		expect(output.structure.genericCalls).toBeGreaterThan(0);
	});
});
