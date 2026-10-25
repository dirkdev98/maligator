import { describe, expect, it } from "vitest";
import { evaluateConstantBuiltin } from "../src/compiler/shared/constant-builtins.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(body: string, locked = true) {
	return inspectStaticValueFunction(
		`function compute(input,other,gate){${body}}globalThis.compute=compute;`,
		"compute",
		{ locked },
	);
}

function sameValueCalls(out: ReturnType<typeof inspect>) {
	return out.core.filter(
		(op) => op.opcode === "callKnown" && op.attributes.operation === "Object.is",
	);
}

describe("Core identity observations", () => {
	it.each([
		"return Object.is(input,input);",
		"const alias=other?input:input;return Object.is(input,alias);",
		"const value=+input;return Object.is(value,value);",
		"return Object.is.call(null,input,input);",
		"const same=Object.is.bind(null);return same(input,input);",
	])("folds a shared identity without a Number restriction: %s", (body) => {
		const out = inspect(body);
		expect(sameValueCalls(out)).toEqual([]);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === true,
			),
		).toBe(true);
	});

	it("unlocks scalar replacement after a shaped identity observation", () => {
		const out = inspect(
			"const item={value:gate(input)};return Object.is(item,item)?item.value:0;",
		);
		expect(sameValueCalls(out)).toEqual([]);
		expect(out.core.some((op) => op.opcode === "createObjectShaped")).toBe(false);
		expect(out.core.filter((op) => op.opcode === "call")).toHaveLength(1);
	});

	it.each([
		["Object.is(left,right)", false],
		["left===right", false],
		["left==right", false],
		["left!==right", true],
	] as const)("uses distinct allocation identities for %s", (expression, expected) => {
		const out = inspect(`const left={};const right={};return ${expression};`);
		expect(sameValueCalls(out)).toEqual([]);
		expect(out.core.some((op) => op.opcode === "binary")).toBe(false);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === expected,
			),
		).toBe(true);
	});

	it("keeps producers and extra arguments when input types prove inequality", () => {
		const out = inspect("return Object.is(+input,String(other),gate());");
		expect(sameValueCalls(out)).toEqual([]);
		expect(
			out.core.some((op) => op.opcode === "unary" && op.attributes.operator === "+"),
		).toBe(true);
		expect(
			out.core.some(
				(op) => op.opcode === "callKnown" && op.attributes.operation === "String",
			),
		).toBe(true);
		expect(out.core.filter((op) => op.opcode === "call")).toHaveLength(1);
	});

	it.each(["===", "!==", "==", "!="])(
		"uses integer bounds to exclude NaN in reflexive %s",
		(operator) => {
			const out = inspect(`const value=input>>>0;return value${operator}value;`);
			expect(
				out.core.some(
					(op) => op.opcode === "binary" && op.attributes.operator === operator,
				),
			).toBe(false);
			expect(
				out.core.some(
					(op) =>
						op.opcode === "createBoolean" &&
						op.attributes.value === (operator === "===" || operator === "=="),
				),
			).toBe(true);
		},
	);

	it.each([
		"return Object.is(+input,+other);",
		"return Object.is(input,other);",
		"const item=other?{}:input;return Object.is(item,input);",
		"const item={};let previous=input;for(let i=0;i<2;i++){const current={};if(Object.is(current,previous))return true;previous=current;}return false;",
	])("retains uncertain identities and Number comparisons: %s", (body) => {
		expect(sameValueCalls(inspect(body)).length).toBeGreaterThan(0);
	});

	it.each(["===", "!=="])(
		"does not assume unknown Numbers exclude NaN for %s",
		(operator) => {
			const out = inspect(`const value=+input;return value${operator}value;`);
			expect(
				out.core.some(
					(op) => op.opcode === "binary" && op.attributes.operator === operator,
				),
			).toBe(true);
		},
	);

	it.each([
		"return new Object.is(input,input);",
		"return Object.is(...input);",
		"return Object.is.apply(null,input);",
	])("retains construction and argument expansion for %s", (body) => {
		const out = inspect(body);
		expect(
			sameValueCalls(out).length > 0 ||
				out.core.some((op) => op.opcode === "builtinError"),
		).toBe(true);
	});

	it("keeps mutable primordial invocation observable", () => {
		const out = inspect("return Object.is(input,input);", false);
		expect(out.core.some((op) => op.opcode === "call")).toBe(true);
	});

	it.each([
		["Object.is(-0,0)", false],
		["Object.is(7,8)", false],
		["Object.is('a','b')", false],
		["Object.is(undefined)", true],
	] as const)("folds constant SameValue invocation %s", (expression, expected) => {
		const out = inspect(`return ${expression};`);
		expect(sameValueCalls(out)).toEqual([]);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === expected,
			),
		).toBe(true);
	});

	it.each([
		["Object.is(Symbol.for('identity'),Symbol.for('identity'))", true],
		["Object.is(Symbol.iterator,Symbol.asyncIterator)", false],
		["Object.is(Math.max,Math.min)", false],
		["Object.is(Symbol('same'),Symbol('same'))", false],
		["Object.is(new Date(input),new Date(input))", false],
		["Object.is(function first(){},function second(){})", false],
		["Object.is(Object.prototype,Array.prototype)", false],
	] as const)(
		"consumes static Symbol and intrinsic identities for %s",
		(expression, expected) => {
			const out = inspect(`return ${expression};`);
			expect(sameValueCalls(out)).toEqual([]);
			expect(
				out.core.some(
					(op) => op.opcode === "createBoolean" && op.attributes.value === expected,
				),
			).toBe(true);
		},
	);

	it("distinguishes missing constant arguments from unknown values and signed zero", () => {
		for (const [args, expected] of [
			[[], true],
			[[{ kind: "undefined" }], true],
			[
				[
					{ kind: "number", value: NaN },
					{ kind: "number", value: NaN },
				],
				true,
			],
			[
				[
					{ kind: "number", value: -0 },
					{ kind: "number", value: 0 },
				],
				false,
			],
			[
				[
					{ kind: "number", value: 7 },
					{ kind: "bigint", value: 7n },
				],
				false,
			],
			[
				[
					{ kind: "string", value: "a" },
					{ kind: "string", value: "a" },
				],
				true,
			],
		] as const) {
			expect(evaluateConstantBuiltin("Object.is", undefined, args)).toMatchObject({
				kind: "value",
				value: { kind: "boolean", value: expected },
			});
		}
		expect(
			evaluateConstantBuiltin("Object.is", undefined, [undefined, undefined]),
		).toMatchObject({ kind: "unsupported" });
	});
});
