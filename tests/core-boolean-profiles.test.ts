import { describe, expect, it } from "vitest";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const conversions = [
	"Boolean(x)",
	"new Boolean(x)",
	"Boolean.prototype.valueOf.call(!!x)",
] as const;

const ignoredProfiles = [
	["unused", (expression: string) => `${expression};return 1;`],
	["branch", (expression: string) => `if(y){${expression};}return 1;`],
	["loop", (expression: string) => `for(let i=0;i<y;i++){${expression};}return 1;`],
	["finally", (expression: string) => `try{${expression};}finally{y();}return 1;`],
	["suspension", (expression: string) => `yield y();${expression};return 1;`],
	["repeated", (expression: string) => `${`${expression};`.repeat(32)}return 1;`],
] as const;

function inspect(body: string, locked = true, generator = false) {
	return inspectStaticValueFunction(
		`function${generator ? "*" : ""} target(x,y){${body}}globalThis.target=target;`,
		"target",
		{ locked },
	);
}

describe("Boolean method observation profiles", () => {
	it.each(["valueOf", "toString"])(
		"resolves the canonical %s function from a dynamic Boolean receiver",
		(method) => {
			const output = inspect(`return (!!x).${method};`);
			expect(output.core).toHaveLength(1);
			expect(output.core[0]!.opcode).toBe("loadPrimordial");
			expect(
				getPrimordialCatalog().nodes[output.core[0]!.attributes.nodeIndex as number]?.[0],
			).toBe(`Boolean.prototype.${method}`);
			const mutable = inspect(`return (!!x).${method};`, false);
			expect(mutable.structure.genericLookups).toBeGreaterThan(0);
		},
	);

	it.each(["valueOf", "toString"])(
		"folds %s on a static receiver after evaluating an ignored dynamic argument",
		(method) => {
			const output = inspect(`return Boolean.prototype.${method}.call(false,x());`);
			expect(output.structure.genericCalls).toBe(1);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.structure.allocations).toBe(0);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			expect(
				output.core.filter(
					(operation) =>
						operation.opcode ===
						(method === "valueOf" ? "createBoolean" : "createString"),
				),
			).toHaveLength(1);
			const mutable = inspect(
				`return Boolean.prototype.${method}.call(false,x());`,
				false,
			);
			expect(mutable.structure.genericCalls).toBeGreaterThan(1);
		},
	);

	it.each(["valueOf", "toString"])(
		"specializes dynamic Boolean %s while preserving argument effects",
		(method) => {
			const output = inspect(`return (!!x).${method}(y());`);
			expect(output.structure.genericCalls).toBe(1);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.structure.allocations).toBe(0);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			const unknown = inspect(`return x.${method}(y());`);
			expect(unknown.structure.genericCalls).toBe(2);
			expect(unknown.structure.genericLookups).toBeGreaterThan(0);
		},
	);
});

describe("Boolean dead result profiles", () => {
	for (const [profile, body] of ignoredProfiles) {
		it.each(conversions)(`removes ignored ${profile} conversion %s`, (expression) => {
			const output = inspect(body(expression), true, profile === "suspension");
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "unary" && operation.attributes.operator === "!",
				),
			).toBe(false);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "callKnown" || operation.opcode === "construct",
				),
			).toBe(false);
			expect(output.structure.genericCalls).toBe(
				profile === "finally" || profile === "suspension" ? 1 : 0,
			);
			expect(output.structure.allocations).toBe(0);
		});
	}

	it.each(conversions)("retains effectful inputs to ignored %s", (expression) => {
		const output = inspect(`${expression.replaceAll("x", "x()")};y();return 1;`);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "!",
			),
		).toBe(false);
		expect(output.structure.genericCalls).toBe(2);
	});

	it.each(conversions)("retains mutable targets for ignored %s", (expression) => {
		const output = inspect(`${expression};return 1;`, false);
		expect(
			output.structure.genericCalls +
				output.core.filter((operation) => operation.opcode === "construct").length,
		).toBeGreaterThan(0);
	});

	it.each([
		"Boolean.prototype.valueOf.call(x)",
		"Boolean.prototype.toString.call(x)",
		"+x",
		"-x",
		"~x",
	])("retains brand checks or numeric coercion in ignored %s", (expression) => {
		const output = inspect(`${expression};return 1;`);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "callKnown" ||
					operation.opcode === "unary" ||
					operation.opcode === "toNumber",
			),
		).toBe(true);
	});

	it("retains the TDZ check when discarding an unread truthiness result", () => {
		const output = inspect("!value;let value=x;return 1;");
		expect(output.core.some((operation) => operation.opcode === "throwIfTdz")).toBe(true);
		expect(output.core.some((operation) => operation.opcode === "unary")).toBe(false);
	});

	it("retains a demanded logical negation", () => {
		const output = inspect("return !x;");
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "!",
			),
		).toBe(true);
	});
});

describe("noncoercing unary reuse", () => {
	it.each(["!x", "typeof x", "Boolean(x)"])(
		"reuses %s across an intervening callback",
		(expression) => {
			const output = inspect(
				`const first=${expression};y();return y(first,${expression});`,
			);
			const operations = output.core.filter((operation) => operation.opcode === "unary");
			expect(operations).toHaveLength(expression === "Boolean(x)" ? 2 : 1);
			expect(output.structure.genericCalls).toBe(2);
			const calls = output.core.filter((operation) => operation.opcode === "call");
			expect(calls.at(-1)!.inputs.slice(-2)[0]).toBe(calls.at(-1)!.inputs.slice(-2)[1]);
		},
	);

	it.each(["-x", "+x", "~x"])(
		"does not reuse coercing %s across a callback",
		(expression) => {
			const output = inspect(
				`const first=${expression};y();return y(first,${expression});`,
			);
			const calls = output.core.filter((operation) => operation.opcode === "call");
			expect(calls.at(-1)!.inputs.slice(-2)[0]).not.toBe(
				calls.at(-1)!.inputs.slice(-2)[1],
			);
		},
	);

	it("keeps separate Boolean inputs and mutable conversion calls", () => {
		const distinct = inspect("return y(Boolean(x),Boolean(y));");
		expect(
			distinct.core.filter((operation) => operation.opcode === "unary"),
		).toHaveLength(4);
		const mutable = inspect(
			"const first=Boolean(x);y();return y(first,Boolean(x));",
			false,
		);
		expect(mutable.structure.genericCalls).toBe(4);
	});
});

describe("Boolean constant observations", () => {
	for (const expression of [
		"Boolean(x)",
		"new Boolean(x).valueOf()",
		"Boolean.prototype.valueOf.call(!!x)",
		"(!!x).valueOf()",
	]) {
		it.each(["===", "!==", "==", "!="])(
			`folds repeated ${expression} observations with %s`,
			(operator) => {
				const output = inspect(
					`const first=${expression};y();return first${operator}${expression};`,
				);
				expect(output.structure.genericCalls).toBe(1);
				expect(output.structure.allocations).toBe(0);
				expect(
					output.core.some((operation) =>
						["unary", "binary", "callKnown", "construct"].includes(operation.opcode),
					),
				).toBe(false);
				expect(
					output.core
						.filter((operation) => operation.opcode === "createBoolean")
						.map((operation) => operation.attributes.value),
				).toEqual([operator === "===" || operator === "=="]);
			},
		);
	}

	it.each(["Boolean(x)", "String(x)"])(
		"retains mutable %s self-comparisons that may observe NaN",
		(expression) => {
			const output = inspect(`const value=${expression};return value===value;`, false);
			expect(output.structure.genericCalls).toBeGreaterThan(0);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "===",
				),
			).toBe(true);
		},
	);

	it.each(["x", "+x", "Number(x)", "x?true:NaN"])(
		"retains the possible NaN result of %s",
		(expression) => {
			const output = inspect(`const value=${expression};return value===value;`);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "===",
				),
			).toBe(true);
		},
	);

	it("folds a string self-comparison while retaining its input conversion", () => {
		const output = inspect("const value=String(x);y();return value===value;");
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "callKnown" && operation.attributes.operation === "String",
			),
		).toBe(true);
		expect(output.structure.genericCalls).toBe(1);
		expect(output.core.some((operation) => operation.opcode === "binary")).toBe(false);
	});

	it("folds a Boolean self-comparison across suspension", () => {
		const output = inspect(
			"const value=Boolean(x);yield y();return value===value;",
			true,
			true,
		);
		expect(output.core.some((operation) => operation.opcode === "yield")).toBe(true);
		expect(output.core.some((operation) => operation.opcode === "unary")).toBe(false);
		expect(output.structure.genericCalls).toBe(1);
	});

	it.each([
		"{value:!!x}",
		"[!!x]",
		"{value:x()}",
		"[x()]",
		"{first:x(),second:y()}",
		"[x(),y()]",
	])("consumes only the truthiness of %s without materialization", (expression) => {
		const output = inspect(`return Boolean(${expression});`);
		expect(output.structure.allocations).toBe(0);
		expect(
			output.core.some(
				(operation) => operation.opcode === "unary" || operation.opcode === "callKnown",
			),
		).toBe(false);
		expect(output.structure.genericCalls).toBe(
			(expression.match(/[xy]\(\)/g) ?? []).length,
		);
		expect(
			output.core
				.filter((operation) => operation.opcode === "createBoolean")
				.map((operation) => operation.attributes.value),
		).toEqual([true]);
	});

	it.each(["{value:!!x}", "[!!x]"])(
		"retains escaped %s identity and mutable conversion targets",
		(expression) => {
			const escaped = inspect(
				`const value=${expression};y(value);return Boolean(value);`,
			);
			expect(escaped.structure.allocations).toBe(1);
			expect(escaped.structure.genericCalls).toBe(1);
			const mutable = inspect(`return Boolean(${expression});`, false);
			expect(mutable.structure.allocations).toBe(1);
			expect(mutable.structure.genericCalls).toBe(1);
		},
	);
});
