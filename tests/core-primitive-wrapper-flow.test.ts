import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const wrappers = [
	["Boolean", "new Boolean(x)", "new Boolean(y)"],
	["Number", "new Number(x)", "new Number(y)"],
	["String", "new String(x)", "new String(y)"],
	["BigInt", "Object(BigInt(x))", "Object(BigInt(y))"],
	["Symbol", "Object(Symbol.for(x))", "Object(Symbol.for(y))"],
] as const;

function inspect(body: string, locked = true) {
	return inspectStaticValueFunction(
		`function target(x, y, condition) { ${body} } globalThis.target = target;`,
		"target",
		{ locked },
	);
}

function constructors(result: ReturnType<typeof inspect>) {
	return result.core.filter(
		(operation) =>
			operation.attributes.construct === true ||
			operation.attributes.operation === "Object",
	);
}

describe("primitive wrapper control flow", () => {
	it.each(wrappers)(
		"joins %s payloads without creating either wrapper",
		(_name, left, right) => {
			const result = inspect(
				`const value = condition ? ${left} : ${right}; return value.valueOf();`,
			);
			expect(constructors(result)).toEqual([]);
			expect(result.structure.genericCalls).toBe(0);
		},
	);

	it.each(wrappers)("keeps loop-carried %s payloads scalar", (_name, first, next) => {
		const result = inspect(`let value = ${first};
			for (let i = 0; i < condition; i++) value = ${next};
			return value.valueOf();`);
		expect(constructors(result)).toEqual([]);
		expect(result.structure.genericLookups).toBe(0);
		expect(result.structure.genericCalls).toBe(0);
	});

	it.each(wrappers)(
		"resolves loop-carried %s text observations",
		(_name, first, next) => {
			const result = inspect(`let value = ${first};
			for (let i = 0; i < condition; i++) value = ${next};
			return value.toString();`);
			expect(constructors(result)).toEqual([]);
			expect(result.structure.genericLookups).toBe(0);
			expect(result.structure.genericCalls).toBe(0);
		},
	);

	it.each([
		"charAt(0)",
		"indexOf('a')",
		"startsWith('a')",
		"slice(1)",
		"repeat(2)",
		"padEnd(8, '.')",
		"trim()",
		"split(',')",
		"replace('a', 'b')",
	])("consumes loop-carried String data in %s", (method) => {
		const result = inspect(`let value = new String(x);
			for (let i = 0; i < condition; i++) value = new String(y);
			return value.${method};`);
		expect(constructors(result)).toEqual([]);
		expect(result.structure.genericLookups).toBe(0);
		expect(result.structure.genericCalls).toBe(0);
	});

	it.each(["toFixed(2)", "toExponential(3)", "toPrecision(4)", "toString(16)"])(
		"formats loop-carried Number data with %s",
		(method) => {
			const result = inspect(`let value = new Number(x);
				for (let i = 0; i < condition; i++) value = new Number(y);
				return value.${method};`);
			expect(constructors(result)).toEqual([]);
			expect(result.structure.genericCalls).toBe(0);
		},
	);

	it("resolves the description getter for loop-carried Symbol data", () => {
		const result = inspect(`let value = Object(Symbol.for(x));
			for (let i = 0; i < condition; i++) value = Object(Symbol.for(y));
			return value.description;`);
		expect(constructors(result)).toEqual([]);
		expect(result.structure.genericLookups).toBe(0);
		expect(result.structure.genericCalls).toBe(0);
	});

	it.each(["match", "matchAll", "search", "split", "replace", "replaceAll"])(
		"preserves the wrapper passed to a loop-carried String %s protocol",
		(method) => {
			const result = inspect(`let value = new String(x);
				for (let i = 0; i < condition; i++) value = new String(y);
				return value.${method}(x);`);
			expect(constructors(result).length).toBeGreaterThan(0);
		},
	);

	it("retains Boolean wrapper truthiness while carrying false payloads around a loop", () => {
		const result = inspect(`let value = new Boolean(x);
			for (let i = 0; i < condition; i++) value = new Boolean(!value.valueOf());
			return value ? value.valueOf() : 99;`);
		expect(constructors(result)).toEqual([]);
		expect(result.structure.genericCalls).toBe(0);
		expect(result.native.registerRepresentations).toContain("boolean");
	});

	it.each(wrappers)(
		"folds the truthiness of joined %s wrappers",
		(_name, left, right) => {
			const result = inspect(
				`const value = condition ? ${left} : ${right}; return value ? 1 : 0;`,
			);
			expect(constructors(result)).toEqual([]);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "createNumber" && operation.attributes.value === 0,
				),
			).toBe(false);
		},
	);

	it.each([
		"const value = condition ? new Boolean(x) : y; return value.valueOf();",
		"const value = condition ? new Boolean(x) : false; return value.valueOf();",
		"const value = condition ? new Boolean(x) : new Number(y); return value.valueOf();",
		"const value = condition ? new Boolean(x) : new Boolean(y); globalThis.sink(value); return value.valueOf();",
		"const value = condition ? new Boolean(x) : new Boolean(y); value.valueOf = x; return value.valueOf();",
		"const value = condition ? new Boolean(x) : new Boolean(y); Object.setPrototypeOf(value, x); return value.valueOf();",
		"const left = new Boolean(x), right = new Boolean(y); const value = condition ? left : right; return value === left;",
		"let value; try { value = new Boolean(x); if (condition) throw y; value = new Boolean(y); } catch (error) { globalThis.sink(value); } return value.valueOf();",
		"const value = condition ? new Boolean(x) : new Proxy(new Boolean(y), {}); return value.valueOf();",
	])("preserves observable or unproved wrapper identity in %s", (body) => {
		expect(constructors(inspect(body)).length).toBeGreaterThan(0);
	});

	it.each(wrappers)(
		"preserves mutable method lookup around a %s wrapper loop",
		(_name, first, next) => {
			const result = inspect(
				`let value = ${first};
				for (let i = 0; i < condition; i++) value = ${next};
				return value.valueOf();`,
				false,
			);
			expect(result.structure.genericLookups).toBeGreaterThan(0);
			expect(result.structure.genericCalls).toBeGreaterThan(0);
		},
	);

	it.each(wrappers)("preserves escaping %s wrapper identity", (_name, first, next) => {
		const result = inspect(`let value = ${first};
			for (let i = 0; i < condition; i++) value = ${next};
			return value;`);
		expect(constructors(result).length).toBeGreaterThan(0);
	});
});
