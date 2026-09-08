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
	it.each([
		"trim",
		"trimStart",
		"trimEnd",
		"trimLeft",
		"trimRight",
		"isWellFormed",
		"toWellFormed",
		"normalize",
		"toLowerCase",
		"toUpperCase",
		"toLocaleLowerCase",
		"toLocaleUpperCase",
	])(
		"folds certified String %s constants and specializes dynamic receivers",
		(method) => {
			const constant = inspect(
				`${JSON.stringify("  Straße ΟΣ e\u0301 😀\ud800  ")}.${method}()`,
			);
			expect(constant.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			const dynamic = inspect(`String(x).${method}()`);
			const helper = method.startsWith("trim")
				? "trim"
				: method === "normalize"
					? "normalize"
					: method === "isWellFormed"
						? "is_well_formed"
						: method === "toWellFormed"
							? "to_well_formed"
							: "case";
			expect(dynamic.c.source).toContain(`mal_builtin_string_${helper}_known(`);
			expect(inspect(`String(x).${method}()`, false).c.source).not.toContain(
				"mal_builtin_string_case_known(",
			);
		},
	);
	it("prepares normalization forms and locale case parameters for dynamic strings", () => {
		expect(inspect("String(x).normalize('NFKD')").c.source).toContain(
			"mal_builtin_string_normalize_known(",
		);
		for (const method of ["toLocaleUpperCase", "toLocaleLowerCase"])
			for (const locale of ["tr", "az", "lt", "en-US"])
				expect(inspect(`String(x).${method}('${locale}')`).c.source).toContain(
					"mal_builtin_string_case_known(",
				);
		expect(inspect("'I'.toLocaleLowerCase(x)").c.source).toContain(
			"mal_vm_call_known_native(",
		);
		expect(inspect("'e'.normalize(x)").c.source).toContain("mal_vm_call_known_native(");
		expect(inspect("'e'.normalize('bad')").c.source).toContain(
			"mal_vm_call_known_native(",
		);
	});

	it("folds private raw segments and emits ordered substitution conversions", () => {
		for (const expression of [
			"String.raw({raw:['a','b','c']},x,2)",
			"String.raw({raw:['a','b']},1)",
			"String.raw({raw:[]},x)",
		]) {
			const output = inspect(expression);
			expect(
				output.core.some((operation) => operation.attributes.operation === "String.raw"),
			).toBe(false);
			expect(output.structure.allocations).toBe(0);
		}
		const output = inspect("String.raw({raw:['a','b','c']},x,x)");
		expect(
			output.core.filter(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "tostring",
			),
		).toHaveLength(2);
	});

	it.each([
		"String.raw(x,1)",
		"String.raw({get raw(){return x;}},1)",
		"String.raw({raw:['a',,'b']},x)",
	])("retains raw template observations for %s", (expression) => {
		expect(
			inspect(expression).core.some(
				(operation) => operation.attributes.operation === "String.raw",
			),
		).toBe(true);
	});

	it.each(["slice", "substring", "substr"])(
		"selects numeric String %s bounds with guarded receivers",
		(method) => {
			for (const expression of [
				`'a😀z'.${method}(+x, 3)`,
				`String(x).${method}(1, +x)`,
				`String.prototype.${method}.call(x, 1, undefined)`,
			]) {
				expect(inspect(expression).c.source).toContain(
					"mal_builtin_string_range_numeric(",
				);
			}
			expect(inspect(`'abc'.${method}(x)`).c.source).not.toContain(
				"mal_builtin_string_range_numeric(",
			);
			expect(inspect(`'abc'.${method}(+x)`, false).c.source).not.toContain(
				"mal_builtin_string_range_numeric(",
			);
		},
	);

	it.each(["fromCharCode", "fromCodePoint"])(
		"constructs String.%s from unboxed numeric inputs",
		(method) => {
			const output = inspect(`String.${method}(65, +x, 0xd800)`);
			expect(output.c.source).toContain("mal_builtin_string_from_codes_numbers(");
			expect(output.c.source).not.toContain("mal_vm_call_known_native(");
			expect(inspect(`String.${method}(x)`).c.source).not.toContain(
				"mal_builtin_string_from_codes_numbers(",
			);
		},
	);

	it.each(["repeat", "padStart", "padEnd"])(
		"uses the numeric String %s builder without coercing unknown counts",
		(method) => {
			const kernel = method === "repeat" ? "repeat" : "pad";
			for (const expression of [
				`'abc'.${method}(+x, 'ab')`,
				`String.prototype.${method}.call(x, 3, x)`,
			]) {
				expect(inspect(expression).c.source).toContain(
					`mal_builtin_string_${kernel}_numeric(`,
				);
			}
			expect(inspect(`'abc'.${method}(x)`).c.source).not.toContain(
				`mal_builtin_string_${kernel}_numeric(`,
			);
		},
	);

	it("guards primitive concat inputs before its shared builder", () => {
		expect(inspect("'abc'.concat(x, 'def')").c.source).toContain(
			"mal_builtin_string_concat_direct(",
		);
		expect(inspect("'abc'.concat(x, 'def')", false).c.source).not.toContain(
			"mal_builtin_string_concat_direct(",
		);
	});

	it.each([
		["clz32", "+x", "mal_builtin_math_clz32_number"],
		["f16round", "+x", "mal_builtin_math_f16round_number"],
		["imul", "+x, 3", "mal_builtin_math_imul_number"],
		["pow", "2, +x", "mal_builtin_math_pow_number"],
		["atan2", "+x, -0", "atan2"],
		["hypot", "+x, 3, 4", "mal_builtin_math_hypot_numbers"],
		["min", "+x, 3, 4", "mal_builtin_math_min_max_numbers"],
		["max", "+x, 3, 4", "mal_builtin_math_min_max_numbers"],
	])(
		"uses the numeric %s kernel only with proven inputs",
		(method, arguments_, kernel) => {
			const output = inspect(`Math.${method}(${arguments_})`);
			expect(output.c.source).toContain(`${kernel}(`);
			expect(output.c.source).not.toContain("mal_vm_call_known_native(");
			expect(inspect(`Math.${method}(x, x, x)`).c.source).not.toContain(`${kernel}(`);
			expect(inspect(`Math.${method}(${arguments_})`, false).c.source).not.toContain(
				`${kernel}(`,
			);
		},
	);

	it("passes completed numeric results directly into Math kernels", () => {
		const output = inspect("Math.pow(Number(x), Math.f16round(+x))");
		expect(output.c.source).toContain("mal_builtin_math_pow_number(");
		expect(output.c.source).toContain("mal_builtin_math_f16round_number(");
	});

	it("keeps each entropy draw even when the result is unused", () => {
		const output = inspectStaticValueFunction(
			"function probe(){Math.random();Math.random();return 1;}globalThis.probe=probe;",
			"probe",
		);
		expect(output.c.source.match(/mal_builtin_math_random_number\(\)/g)).toHaveLength(2);
	});

	it("retains iterator semantics while bypassing sumPrecise dispatch", () => {
		expect(inspect("Math.sumPrecise(x)").c.source).toContain(
			"mal_builtin_math_sum_precise_known(",
		);
		expect(inspect("Math.sumPrecise(x)", false).c.source).not.toContain(
			"mal_builtin_math_sum_precise_known(",
		);
	});

	it("rounds float16 constants at every finite binade boundary and half-way point", () => {
		for (let exponent = -24; exponent <= 15; exponent++) {
			const step = 2 ** Math.max(exponent - 10, -24);
			for (const magnitude of [
				2 ** exponent,
				2 ** exponent + step / 2,
				2 ** exponent + 1.5 * step,
			]) {
				for (const sign of [-1, 1]) {
					for (const value of [
						sign * magnitude,
						sign * (magnitude - step / 2 ** 20),
						sign * (magnitude + step / 2 ** 20),
					]) {
						expect(
							evaluateConstantBuiltin("Math.f16round", undefined, [
								{ kind: "number", value },
							]),
						).toMatchObject({
							kind: "value",
							value: { kind: "number", value: Math.f16round(value) },
						});
					}
				}
			}
		}
	});

	it.each(["at", "charAt", "codePointAt"])(
		"reads static UTF-16 text at dynamic numeric positions with %s",
		(method) => {
			for (const expression of [
				`'a😀z'.${method}(+x)`,
				`String.prototype.${method}.call(x, 1)`,
			])
				expect(inspect(expression).c.source).toContain(
					"mal_builtin_string_character_direct(",
				);
			expect(inspect(`'a😀z'.${method}(x)`).c.source).not.toContain(
				"mal_builtin_string_character_direct(",
			);
		},
	);

	it.each(["indexOf", "lastIndexOf", "includes", "startsWith", "endsWith"])(
		"selects guarded direct String %s for independent static inputs",
		(method) => {
			for (const expression of [
				`'abc'.${method}(x, +x)`,
				`String(x).${method}('b', +x)`,
				`String.prototype.${method}.call(x, x, 1)`,
			]) {
				const output = inspect(expression);
				expect(output.c.source).toContain("mal_builtin_string_search_direct(");
			}
			const coercive = inspect(`'abc'.${method}('a', x)`);
			expect(coercive.c.source).not.toContain("mal_builtin_string_search_direct(");
		},
	);

	it.each([
		"String(x).slice(1)",
		"String(x).trim()",
		"String(x).repeat(2)",
		"String(x) + x",
		"x + String(x)",
	])("preserves the String result of %s for chained consumers", (expression) => {
		const output = inspect(`(${expression}).charCodeAt(+x)`);
		expect(output.c.source).toContain("mal_builtin_string_char_code_at_number(");
		expect(
			output.core.some(
				(operation) => operation.attributes.operation === "String.prototype.charCodeAt",
			),
		).toBe(true);
	});

	it.each(["replace", "replaceAll", "search", "split", "match", "matchAll"])(
		"keeps custom String %s protocol results untyped",
		(method) => {
			const output = inspect(`String(x).${method}(x).charCodeAt(0)`);
			expect(output.c.source).not.toContain("mal_builtin_string_char_code_at_number(");
			expect(output.structure.genericCalls).toBeGreaterThan(0);
		},
	);

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

	it.each([
		"abs",
		"floor",
		"ceil",
		"trunc",
		"sqrt",
		"cbrt",
		"sign",
		"log",
		"log2",
		"log10",
		"exp",
		"sin",
		"cos",
		"tan",
		"asin",
		"acos",
		"atan",
		"sinh",
		"cosh",
		"tanh",
		"asinh",
		"acosh",
		"atanh",
		"log1p",
		"expm1",
		"fround",
		"round",
	])("uses target Math.%s after one dynamic numeric conversion", (method) => {
		const output = inspect(`Math.${method}(+x)`);
		expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(false);
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
	});

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
