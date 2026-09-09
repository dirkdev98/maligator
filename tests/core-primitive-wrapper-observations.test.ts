import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const wrappers = [
	["Boolean", "new Boolean(x)", "new Boolean(z)"],
	["Number", "new Number(x)", "new Number(z)"],
	["String", "new String(x)", "new String(z)"],
	["BigInt", "Object(BigInt(x))", "Object(BigInt(z))"],
	["Symbol", "Object(Symbol.for(x))", "Object(Symbol.for(z))"],
] as const;
const keyConsumers = [
	"y[key]",
	"(y[key] = z)",
	"delete y[key]",
	"key in y",
	"y[key]++",
	"({[key]: z})",
	"Object.hasOwn(y, key)",
	"Object.defineProperty(y, key, z)",
	"Object.getOwnPropertyDescriptor(y, key)",
	"Object.prototype.hasOwnProperty.call(y, key)",
	"Object.prototype.propertyIsEnumerable.call(y, key)",
	"Object.prototype.__defineGetter__.call(y, key, z)",
	"Object.prototype.__defineSetter__.call(y, key, z)",
	"Object.prototype.__lookupGetter__.call(y, key)",
	"Object.prototype.__lookupSetter__.call(y, key)",
	"Reflect.get(y, key)",
	"Reflect.set(y, key, z)",
	"Reflect.has(y, key)",
	"Reflect.deleteProperty(y, key)",
	"Reflect.defineProperty(y, key, z)",
	"Reflect.getOwnPropertyDescriptor(y, key)",
] as const;

function inspect(body: string, locked = true) {
	return inspectStaticValueFunction(
		`function target(x, y, z) { ${body} } globalThis.target = target;`,
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

for (const [family, allocation, another] of wrappers) {
	describe(`${family} wrapper observations`, () => {
		it.each(keyConsumers)("consumes the wrapper as a property key in %s", (consumer) => {
			const result = inspect(`const key = ${allocation}; return ${consumer};`);
			expect(constructors(result)).toEqual([]);
		});

		it.each(keyConsumers)("retains mutable key conversion in %s", (consumer) => {
			const result = inspect(`const key = ${allocation}; return ${consumer};`, false);
			expect(
				result.core.some(
					(operation) => operation.opcode === "construct" || operation.opcode === "call",
				),
			).toBe(true);
		});

		it.each([
			["value === value", true],
			["value !== value", false],
			["value == value", true],
			["value != value", false],
			["Object.is(value, value)", true],
			["value === null", false],
			["value !== false", true],
			["value == null", false],
			["value != undefined", true],
			["Object.is(value, 0)", false],
			["Object.is(value)", false],
		] as const)(
			"folds object identity at %s without comparing its payload",
			(expression, expected) => {
				const result = inspect(`const value = ${allocation}; return ${expression};`);
				expect(constructors(result)).toEqual([]);
				expect(result.core).toContainEqual(
					expect.objectContaining({
						opcode: "createBoolean",
						attributes: { value: expected },
					}),
				);
			},
		);

		it.each(["===", "!==", "==", "!=", "Object.is"])(
			"distinguishes fresh wrappers at %s",
			(operator) => {
				const expression =
					operator === "Object.is" ? "Object.is(left, right)" : `left ${operator} right`;
				const result = inspect(
					`const left = ${allocation}, right = ${another}; return ${expression};`,
				);
				expect(constructors(result)).toEqual([]);
				expect(result.core).toContainEqual(
					expect.objectContaining({
						opcode: "createBoolean",
						attributes: { value: operator.startsWith("!") },
					}),
				);
			},
		);

		it.each(["0", "false", "'x'", "0n", "Symbol.iterator"])(
			"compares a wrapper with the primitive %s using its payload",
			(other) => {
				const result = inspect(`const value = ${allocation}; return value == ${other};`);
				expect(constructors(result)).toEqual([]);
			},
		);

		it("keeps an uncertain identity comparison after a branch", () => {
			const result = inspect(
				`const left = ${allocation}, right = ${another}; const value = y ? left : right; return Object.is(value, left);`,
			);
			expect(constructors(result).length).toBeGreaterThan(0);
		});

		it("preserves custom property-key conversion and its receiver", () => {
			const result = inspect(
				`const key = ${allocation}; key[Symbol.toPrimitive] = z; return y[key];`,
			);
			expect(constructors(result).length).toBeGreaterThan(0);
		});

		it("preserves a wrapper that also becomes the property value", () => {
			const result = inspect(`const key = ${allocation}; y[key] = key; return y;`);
			expect(constructors(result).length).toBeGreaterThan(0);
		});

		it("preserves the original receiver supplied to Reflect.get", () => {
			const result = inspect(
				`const key = ${allocation}; return Reflect.get(y, key, key);`,
			);
			expect(constructors(result).length).toBeGreaterThan(0);
		});

		it("preserves an unknown identity comparator", () => {
			const result = inspect(`const value = ${allocation}; return Object.is(value, y);`);
			expect(constructors(result).length).toBeGreaterThan(0);
		});
	});
}

describe("String wrapper numeric property reads", () => {
	it("reads numeric loop indexes without creating String wrappers", () => {
		const result = inspect(
			"let result; for (let i = 0; i < z; i++) result = new String(x)[i & 3]; return result;",
		);
		expect(constructors(result)).toEqual([]);
	});
	it.each([
		"+y",
		"-1",
		"0.5",
		"NaN",
		"Infinity",
		"-Infinity",
		"'-0'",
		"4294967295",
		"'9007199254740993'",
	])("reads the primitive String data at %s", (index) => {
		const result = inspect(`const value = new String(x); return value[${index}];`);
		expect(constructors(result)).toEqual([]);
	});

	it("uses static String data with a dynamic numeric index", () => {
		const result = inspect("const value = new String('a😀b'); return value[+y];");
		expect(constructors(result)).toEqual([]);
		expect(
			result.core.some((operation) => operation.attributes.operation === "String"),
		).toBe(false);
	});

	it("reads joined String payloads at a dynamic numeric index", () => {
		const result = inspect(
			"const value = x ? new String('abc') : new String('xyz'); return value[+y];",
		);
		expect(constructors(result)).toEqual([]);
	});

	it.each(["y", "Object(y)"])(
		"retains the String wrapper for an unproved property key %s",
		(key) => {
			const result = inspect(`const value = new String(x); return value[${key}];`);
			expect(constructors(result).length).toBeGreaterThan(0);
		},
	);

	it("retains a String wrapper exposed by key coercion", () => {
		const result = inspect(
			"const value = new String(x); const key = {[Symbol.toPrimitive](){ y(value); return 0; }}; return value[+key];",
		);
		expect(constructors(result).length).toBeGreaterThan(0);
	});

	it("retains mutable constructor and inherited numeric lookup", () => {
		const result = inspect("const value = new String(x); return value[+y];", false);
		expect(result.core.some((operation) => operation.opcode === "construct")).toBe(true);
	});
});

describe("primitive data joins", () => {
	it.each([
		["Boolean", "false", "true"],
		["Number", "-0", "NaN"],
		["String", "'a'", "'b'"],
		["BigInt", "17n", "19n"],
		["Symbol", "Symbol.iterator", "Symbol.toStringTag"],
	] as const)(
		"keeps the %s kind while selecting distinct primitive data",
		(_family, left, right) => {
			const result = inspect(
				`const value = x ? ${left} : ${right}; const key = Object(value); return y[key];`,
			);
			expect(constructors(result)).toEqual([]);
		},
	);

	it("retains the selected Symbol's own description", () => {
		const result = inspect(
			"const value = x ? Symbol.iterator : Symbol.toStringTag; return Object(value).description;",
		);
		expect(constructors(result)).toEqual([]);
		expect(
			result.core.some(
				(operation) =>
					operation.attributes.operation === "Symbol.prototype.description<get>",
			),
		).toBe(true);
	});

	it.each(["0", "{}", "y"])(
		"does not assign the Symbol kind to a mixed join with %s",
		(other) => {
			const result = inspect(
				`const value = x ? Symbol.iterator : ${other}; const key = Object(value); return y[key];`,
			);
			expect(constructors(result).length).toBeGreaterThan(0);
		},
	);
});
