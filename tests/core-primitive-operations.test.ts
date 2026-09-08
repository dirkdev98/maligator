import { describe, expect, it } from "vitest";
import { evaluateConstantBuiltin } from "../src/compiler/shared/constant-builtins.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(expression: string, locked = true) {
	return inspectStaticValueFunction(
		`function probe(x){return ${expression};} globalThis.probe=probe;`,
		"probe",
		{ locked },
	);
}

describe("primitive operation results", () => {
	it.each(["isFinite", "isInteger", "isSafeInteger"])(
		"specializes Number.%s without coercing unknown inputs",
		(method) => {
			const unknown = inspect(`Number.${method}.call(null,x)`);
			expect(unknown.c.source).not.toContain("mal_vm_call_known_native");
			const numeric = inspect(`Number.${method}(+x)`);
			expect(numeric.c.source).toContain("isfinite(");
			expect(numeric.c.source).not.toContain("_known(");
			const unused = inspectStaticValueFunction(
				`function probe(x){Number.${method}(x());} globalThis.probe=probe;`,
				"probe",
				{ locked: true },
			);
			expect(
				unused.core.some(
					(operation) => operation.attributes.operation === `Number.${method}`,
				),
			).toBe(false);
			expect(unused.structure.genericCalls).toBe(1);
		},
	);

	it.each([
		["toString(16)", "string"],
		["toFixed(2)", "fixed"],
		["toExponential()", "exponential"],
		["toExponential(100)", "exponential"],
		["toPrecision(3)", "precision"],
		["toPrecision()", "precision"],
	])("uses a typed target kernel for dynamic numbers with %s", (call, kernel) => {
		const output = inspect(`(+x).${call}`);
		expect(output.c.source).toContain(`mal_builtin_number_to_${kernel}_numeric(vm, r`);
		expect(output.c.source).not.toContain("mal_vm_call_known_native");
	});

	it.each(["toFixed(x)", "toString(1)", "toPrecision(0)", "toExponential(101)"])(
		"retains option validation and coercion for %s",
		(call) => {
			const output = inspect(`(+x).${call}`);
			expect(output.c.source).not.toContain("_numeric(vm,");
			expect(output.c.source).toContain("mal_vm_call_known_native");
		},
	);

	it.each(["Boolean", "Number", "String"])(
		"eliminates %s wrappers observed only by truthiness and typeof",
		(constructor) => {
			for (const expression of [
				`!new ${constructor}(x)`,
				`typeof new ${constructor}(x)`,
				`typeof new ${constructor}(x) === 'object'`,
			]) {
				const output = inspect(expression);
				expect(output.core.some((operation) => operation.attributes.construct)).toBe(
					false,
				);
			}
		},
	);

	it.each([
		"Number.MAX_VALUE",
		"Number.MIN_VALUE.toString()",
		"Math.PI",
		"Boolean.name",
		"true.toString()",
		"String.prototype.repeat.length",
		"Symbol('x').description",
		"Symbol().description",
		"Symbol().toString()",
		"Symbol('a')===Symbol('a')",
		"Symbol.iterator.description",
		"String(Symbol('x'))",
		"(1.25).toFixed(2)",
		"(0.1).toString()",
		"(5e-324).toString()",
		"(1.005).toPrecision(3)",
		"(1.25).toExponential(1)",
		"(255).toString(16)",
		"(0.1).toString(3)",
		"Number.MIN_VALUE.toString(2)",
		"Number.MAX_VALUE.toString(2)",
		"BigInt('0xff')",
		"Number(123n)",
		"Object(1n).valueOf()",
		"(-255n).toString(16)",
		"parseInt('  -0xfz')",
		"Number.parseFloat('1.25e+2x')",
		"isNaN('x')",
		"'aba'.replace('a','$$$&')",
		"'aba'.replaceAll('a','x')",
		"'ab'.replaceAll('', '-')",
		"'x'.bold()",
		"'x'.anchor('a\"b')",
		"encodeURI('a b?x=😀')",
		"decodeURIComponent('%F0%9F%98%80')",
		"escape('😀')",
		"unescape('%uD800')",
		"Boolean(null)",
		"Number()",
		"Number('123')",
		"String(false)",
		"Number.isNaN(NaN)",
		"Number.isFinite(Infinity)",
		"Number.isInteger(1.5)",
		"Number.isSafeInteger(9007199254740992)",
		"isNaN(undefined)",
		"isFinite(null)",
		"BigInt.asIntN(8,255n)",
		"BigInt.asUintN(8,-1n)",
		"String.fromCodePoint(128512,55296)",
		"String.fromCharCode(65537,-1)",
		"'abc'.at(-1)",
		"'abc'.charAt(Infinity)",
		"'abc'.charCodeAt(-1)",
		"'😀'.codePointAt(0)",
		"'abc'.includes('b')",
		"'aba'.lastIndexOf('a')",
		"'abc'.endsWith('b',2)",
		"'abc'.startsWith('b',1)",
		"'abc'.indexOf('b',NaN)",
		"'abcdef'.slice(-3,-1)",
		"'abcdef'.substring(4,1)",
		"'abcdef'.substr(-3,2)",
		"'a'.concat('b',null,1)",
		"'ab'.repeat(3)",
		"'a'.padStart(4,'xy')",
		"'a'.padEnd(4,'xy')",
		"'\\ufeff a\\u2028'.trim()",
		"' a '.trimStart()",
		"' a '.trimEnd()",
		"'\\ud800x'.isWellFormed()",
		"'\\ud800x'.toWellFormed()",
	])("folds the observable result of %s", (expression) => {
		const output = inspect(expression);
		expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(false);
		expect(output.structure.genericCalls).toBe(0);
	});

	it.each(["Boolean", "Number", "String"])(
		"removes a contained %s wrapper while retaining conversion",
		(constructor) => {
			const output = inspect(`new ${constructor}(x).valueOf()`);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
			expect(
				output.core.some(
					(operation) =>
						operation.attributes.operation === `${constructor}.prototype.valueOf`,
				),
			).toBe(false);
			if (constructor === "Number")
				expect(
					output.core.some((operation) => operation.attributes.operation === "Number"),
				).toBe(true);
		},
	);

	it.each(["new Boolean(x)", "new Number(x)", "new String(x)"])(
		"retains the required wrapper or Symbol conversion for %s",
		(expression) => {
			expect(
				inspect(expression).core.some((operation) => operation.attributes.construct),
			).toBe(true);
		},
	);
	it.each(["match", "matchAll", "search", "split", "replace", "replaceAll"])(
		"retains the String wrapper that a custom %s protocol can observe",
		(method) => {
			const output = inspect(`new String('abc').${method}(x)`);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(true);
		},
	);
	it("still eliminates a String wrapper when split has a primitive separator", () => {
		const output = inspect("new String('a,b').split(',').includes(x)");
		expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
		expect(output.structure.allocations).toBe(0);
	});

	it("removes a certified String wrapper and noncoercing predicate dispatch", () => {
		expect(inspect("new String('abc').valueOf()").structure.operations).toEqual([]);
		expect(
			inspect("Number.isNaN(x)").core.some(
				(operation) => operation.opcode === "callKnown",
			),
		).toBe(false);
	});

	it.each(["'abc'.slice(1)", "Boolean(x)", "new Number(x).valueOf()"])(
		"retains mutable method lookup for %s",
		(expression) => {
			const output = inspect(expression, false);
			expect(output.structure.genericCalls).toBeGreaterThan(0);
		},
	);

	it.each([
		"'abc'.includes(x)",
		"'abc'.repeat(-1)",
		"String.fromCodePoint(1114112)",
		"'abc'.normalize()",
		"'I'.toLocaleLowerCase()",
		"Math.random()",
		"Math.sin(1)",
	])("keeps uncertified or effectful work at its call site for %s", (expression) => {
		const output = inspect(expression);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "callKnown" || operation.opcode === "mathUnaryNumber",
			),
		).toBe(true);
	});

	it.each(["Math.round(-0.5)", "Math.min(0,-0)", "Math.max(-0,0)", "Math.trunc(-0.5)"])(
		"folds exact binary64 Math result %s",
		(expression) => {
			const output = inspect(expression);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "mathUnaryNumber" ||
						operation.opcode === "mathBinaryNumber" ||
						operation.opcode === "callKnown",
				),
			).toBe(false);
		},
	);

	it.each(["sin", "round", "exp"])(
		"uses target Math.%s after one dynamic numeric conversion",
		(method) => {
			const output = inspect(`Math.${method}(+x)`);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			expect(
				output.core.filter(
					(operation) =>
						operation.opcode === "unary" && operation.attributes.operator === "+",
				),
			).toHaveLength(1);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "mathUnaryNumber" &&
						operation.attributes.operation === `Math.${method}`,
				),
			).toBe(true);
		},
	);

	it("limits output and search work before producing a constant", () => {
		const receiver = { kind: "string", value: "abc" } as const;
		expect(
			evaluateConstantBuiltin("String.prototype.repeat", receiver, [
				{ kind: "number", value: 1e9 },
			]),
		).toMatchObject({ kind: "unsupported", reason: "work-limit" });
		expect(
			evaluateConstantBuiltin(
				"String.prototype.includes",
				{ kind: "string", value: "a".repeat(100) },
				[{ kind: "string", value: "b".repeat(100) }],
			),
		).toMatchObject({ kind: "unsupported", reason: "work-limit" });
	});

	it("eliminates the split array for a scalar consumer and retains fresh escaping results", () => {
		const consumed = inspect("'a,b'.split(',').includes(x)");
		expect(consumed.structure.allocations).toBe(0);
		expect(consumed.structure.genericCalls).toBe(0);
		expect(consumed.core.some((operation) => operation.opcode === "callKnown")).toBe(
			false,
		);
		const escaped = inspect("'a,b'.split(',')");
		expect(escaped.structure.allocations).toBe(1);
		expect(escaped.structure.pooledMaterializations).toBe(0);
	});

	it("retains registry access and escaping symbol identity", () => {
		const registry = inspect("Symbol.keyFor(Symbol.for('x'))");
		expect(
			registry.core.some((operation) => operation.attributes.operation === "Symbol.for"),
		).toBe(true);
		expect(
			registry.core.some(
				(operation) => operation.attributes.operation === "Symbol.keyFor",
			),
		).toBe(false);
		expect(
			inspect("Symbol('x')").core.some(
				(operation) => operation.attributes.operation === "Symbol",
			),
		).toBe(true);
	});

	it("reads a contained String wrapper's own length through the primitive string path", () => {
		const output = inspect("new String(x).length");
		expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
		expect(
			output.native.instructions.some(
				(operation) => operation?.kind === "primitive-string-length",
			),
		).toBe(true);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "createNumber" && operation.attributes.value === 0,
			),
		).toBe(false);
	});
});
