import { describe, expect, it } from "vitest";
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
