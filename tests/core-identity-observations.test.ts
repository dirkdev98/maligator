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

function forwarded(
	body: string,
	options: { leaf?: string; locked?: boolean; script?: boolean; preamble?: string } = {},
) {
	return inspectStaticValueFunction(
		`${options.preamble ?? ""}const leaf=${options.leaf ?? "function leaf(value,hook){try{hook();return value;}catch(error){throw error;}}"};function compute(input,other,gate){${body}}globalThis.leaf=leaf;globalThis.compute=compute;`,
		"compute",
		{ locked: options.locked, script: options.script },
	);
}

describe("Core identity observations", () => {
	it("folds disjoint normal-return intervals without removing the effectful call", () => {
		const out = forwarded(
			"const result=leaf(input,gate);return Object.is(result,(other&255)+1024);",
			{
				leaf: "function leaf(value,hook){try{hook();return value&255;}catch(error){throw error;}}",
			},
		);
		expect(sameValueCalls(out)).toEqual([]);
		expect(out.core.some((op) => op.opcode === "call")).toBe(true);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === false,
			),
		).toBe(true);
	});

	it.each(["value?-0:0", "value?NaN:0"])(
		"retains SameValue for an unbounded normal return %s",
		(expression) => {
			const out = forwarded("const result=leaf(input,gate);return Object.is(result,0);", {
				leaf: `function leaf(value,hook){try{hook();return ${expression};}catch(error){throw error;}}`,
			});
			expect(sameValueCalls(out).length).toBeGreaterThan(0);
		},
	);

	it.each([false, true])(
		"preserves forwarding and invocation authority with locked primordials %s",
		(locked) => {
			const out = forwarded(
				"const result=leaf(input,gate);gate();return Object.is(result,input);",
				{ locked },
			);
			expect(sameValueCalls(out)).toEqual([]);
			expect(out.core.filter((op) => op.opcode === "call").length).toBeGreaterThanOrEqual(
				2,
			);
			if (locked)
				expect(
					out.core.some(
						(op) => op.opcode === "createBoolean" && op.attributes.value === true,
					),
				).toBe(true);
			else {
				const call = out.core.find(
					(op) =>
						op.opcode === "call" &&
						(op.attributes.knownBuiltinCall as { operation?: string } | undefined)
							?.operation === "Object.is",
				)!;
				expect(call).toBeDefined();
				expect(call.inputs[2]).toBe(call.inputs[3]);
			}
		},
	);

	it.each([
		"const first=leaf(input,gate);const result=leaf(first,gate);return Object.is(result,input);",
		"const result=other?leaf(input,gate):leaf(input,gate);return Object.is(result,input);",
		"const result=leaf(input,...other);gate();return Object.is(result,input);",
		"const value=+input;const result=leaf(value,gate);return Object.is(result,value);",
		"let result=input;for(let i=0;i<2;i++)result=leaf(result,gate);return Object.is(result,input);",
	])("resolves forwarded identities through %s", (body) => {
		const out = forwarded(body);
		expect(sameValueCalls(out)).toEqual([]);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === true,
			),
		).toBe(true);
		expect(
			out.core.some((op) => ["call", "callSpreadIterable"].includes(op.opcode)),
		).toBe(true);
	});

	it.each([true, false])(
		"joins every finite callee's forwarding alternative (same=%s)",
		(same) => {
			const out = forwarded(
				`const callee=other?leaf:second;const result=callee(input,${same ? "input" : "other"},gate);return Object.is(result,input);`,
				{
					leaf: "function leaf(value,ignored,hook){try{hook();return value;}catch(error){throw error;}}",
					preamble:
						"const second=function second(ignored,value,hook){try{hook();return value;}catch(error){throw error;}};",
				},
			);
			if (same) expect(sameValueCalls(out)).toEqual([]);
			else expect(sameValueCalls(out).length).toBeGreaterThan(0);
		},
	);

	it.each(["===", "!==", "==", "!="])(
		"uses forwarded integer bounds in %s without assuming arbitrary Numbers exclude NaN",
		(operator) => {
			const bounded = forwarded(
				`const value=input&255;const result=leaf(value,gate);return result${operator}value;`,
			);
			const number = forwarded(
				`const value=+input;const result=leaf(value,gate);return result${operator}value;`,
			);
			expect(
				bounded.core.some(
					(op) => op.opcode === "binary" && op.attributes.operator === operator,
				),
			).toBe(false);
			expect(
				number.core.some(
					(op) => op.opcode === "binary" && op.attributes.operator === operator,
				),
			).toBe(true);
			const comparison = number.core.find(
				(op) => op.opcode === "binary" && op.attributes.operator === operator,
			)!;
			expect(comparison.inputs[0]).toBe(comparison.inputs[1]);
		},
	);

	it.each([
		["Object.is(result,second)", false],
		["result===second", false],
		["result==second", false],
		["result!==second", true],
	] as const)("uses a forwarded fresh allocation in %s", (expression, expected) => {
		const out = forwarded(
			`const value={};const second={};const result=leaf(value,gate);return ${expression};`,
		);
		expect(sameValueCalls(out)).toEqual([]);
		expect(out.core.some((op) => op.opcode === "binary")).toBe(false);
		expect(out.core.some((op) => op.opcode === "call")).toBe(true);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === expected,
			),
		).toBe(true);
	});

	it.each(["async function", "function*", "async function*"])(
		"does not equate a %s completion with its body return",
		(kind) => {
			const out = forwarded(
				"const result=leaf(input,gate);return Object.is(result,input);",
				{
					leaf: `${kind} leaf(value,hook){try{hook();return value;}catch(error){throw error;}}`,
				},
			);
			expect(sameValueCalls(out).length).toBeGreaterThan(0);
		},
	);

	it("retains a mapped argument mutation", () => {
		const out = forwarded(
			"const result=leaf(input,gate);return Object.is(result,input);",
			{
				script: true,
				leaf: "function leaf(value,hook){try{hook(arguments);return value;}catch(error){throw error;}}",
			},
		);
		expect(sameValueCalls(out).length).toBeGreaterThan(0);
	});

	it("retains constructor return substitution", () => {
		const out = forwarded(
			"const result=new leaf(input,gate);return Object.is(result,input);",
		);
		expect(sameValueCalls(out).length).toBeGreaterThan(0);
	});

	it("retains an opaque callable alternative", () => {
		const out = forwarded(
			"const callee=other?leaf:gate;const result=callee(input,gate);return Object.is(result,input);",
		);
		expect(sameValueCalls(out).length).toBeGreaterThan(0);
	});

	it("retains a default initializer's result", () => {
		const out = forwarded("const result=leaf(gate);return Object.is(result,input);", {
			leaf: "function leaf(hook,value=7){try{hook();return value;}catch(error){throw error;}}",
		});
		expect(sameValueCalls(out).length).toBeGreaterThan(0);
	});

	it("uses a strict method's forwarded receiver", () => {
		const out = forwarded(
			"const holder={pass:leaf};const result=holder.pass(gate);return Object.is(result,holder);",
			{ leaf: "function leaf(hook){try{hook();return this;}catch(error){throw error;}}" },
		);
		expect(sameValueCalls(out)).toEqual([]);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === true,
			),
		).toBe(true);
	});

	it("retains captured parameter mutation through an escaping setter", () => {
		const out = forwarded(
			"const result=leaf(input,gate);return Object.is(result,input);",
			{
				leaf: "function leaf(value,hook){try{hook(next=>value=next);return value;}catch(error){throw error;}}",
			},
		);
		expect(sameValueCalls(out).length).toBeGreaterThan(0);
	});

	it.each(["===", "!==", "==", "!="])(
		"keeps normalized operands live when forwarding calls inline beside %s",
		(operator) => {
			const out = forwarded(
				`const value=+input;const result=leaf(value,gate);return result${operator}value;`,
				{ leaf: "function leaf(value){return value;}" },
			);
			const comparison = out.core.find(
				(op) => op.opcode === "binary" && op.attributes.operator === operator,
			)!;
			expect(comparison).toBeDefined();
			expect(comparison.inputs[0]).toBe(comparison.inputs[1]);
		},
	);

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
