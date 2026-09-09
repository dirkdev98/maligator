import { describe, expect, it } from "vitest";
import { evaluateConstantBuiltin } from "../src/compiler/shared/constant-builtins.ts";
import { knownBuiltinErrorNames } from "../src/compiler/shared/known-builtin-errors.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import { BYTECODE_OPERATIONS } from "../src/compiler/target/bytecode-operation-spec.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { Writer } from "../src/compiler/target/program-image-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const rejectedPrimitiveConstructors = [
	["BigInt", "bigintConstructor"],
	["BigInt.asIntN", "notConstructor"],
	["BigInt.asUintN", "notConstructor"],
	["BigInt.prototype.toString", "notConstructor"],
	["BigInt.prototype.valueOf", "notConstructor"],
	["Boolean.prototype.toString", "notConstructor"],
	["Boolean.prototype.valueOf", "notConstructor"],
	["Math.abs", "notConstructor"],
	["Math.acos", "notConstructor"],
	["Math.acosh", "notConstructor"],
	["Math.asin", "notConstructor"],
	["Math.asinh", "notConstructor"],
	["Math.atan", "notConstructor"],
	["Math.atan2", "notConstructor"],
	["Math.atanh", "notConstructor"],
	["Math.cbrt", "notConstructor"],
	["Math.ceil", "notConstructor"],
	["Math.clz32", "notConstructor"],
	["Math.cos", "notConstructor"],
	["Math.cosh", "notConstructor"],
	["Math.exp", "notConstructor"],
	["Math.expm1", "notConstructor"],
	["Math.f16round", "notConstructor"],
	["Math.floor", "notConstructor"],
	["Math.fround", "notConstructor"],
	["Math.hypot", "notConstructor"],
	["Math.imul", "notConstructor"],
	["Math.log", "notConstructor"],
	["Math.log10", "notConstructor"],
	["Math.log1p", "notConstructor"],
	["Math.log2", "notConstructor"],
	["Math.max", "notConstructor"],
	["Math.min", "notConstructor"],
	["Math.pow", "notConstructor"],
	["Math.random", "notConstructor"],
	["Math.round", "notConstructor"],
	["Math.sign", "notConstructor"],
	["Math.sin", "notConstructor"],
	["Math.sinh", "notConstructor"],
	["Math.sqrt", "notConstructor"],
	["Math.sumPrecise", "notConstructor"],
	["Math.tan", "notConstructor"],
	["Math.tanh", "notConstructor"],
	["Math.trunc", "notConstructor"],
	["Number.isFinite", "notConstructor"],
	["Number.isInteger", "notConstructor"],
	["Number.isNaN", "notConstructor"],
	["Number.isSafeInteger", "notConstructor"],
	["Number.prototype.toExponential", "notConstructor"],
	["Number.prototype.toFixed", "notConstructor"],
	["Number.prototype.toPrecision", "notConstructor"],
	["Number.prototype.toString", "notConstructor"],
	["Number.prototype.valueOf", "notConstructor"],
	["String.fromCharCode", "notConstructor"],
	["String.fromCodePoint", "notConstructor"],
	["String.prototype.anchor", "notConstructor"],
	["String.prototype.at", "notConstructor"],
	["String.prototype.big", "notConstructor"],
	["String.prototype.blink", "notConstructor"],
	["String.prototype.bold", "notConstructor"],
	["String.prototype.charAt", "notConstructor"],
	["String.prototype.charCodeAt", "notConstructor"],
	["String.prototype.codePointAt", "notConstructor"],
	["String.prototype.concat", "notConstructor"],
	["String.prototype.endsWith", "notConstructor"],
	["String.prototype.fixed", "notConstructor"],
	["String.prototype.fontcolor", "notConstructor"],
	["String.prototype.fontsize", "notConstructor"],
	["String.prototype.includes", "notConstructor"],
	["String.prototype.indexOf", "notConstructor"],
	["String.prototype.isWellFormed", "notConstructor"],
	["String.prototype.italics", "notConstructor"],
	["String.prototype.lastIndexOf", "notConstructor"],
	["String.prototype.link", "notConstructor"],
	["String.prototype.localeCompare", "notConstructor"],
	["String.prototype.normalize", "notConstructor"],
	["String.prototype.padEnd", "notConstructor"],
	["String.prototype.padStart", "notConstructor"],
	["String.prototype.repeat", "notConstructor"],
	["String.prototype.replace", "notConstructor"],
	["String.prototype.replaceAll", "notConstructor"],
	["String.prototype.slice", "notConstructor"],
	["String.prototype.small", "notConstructor"],
	["String.prototype.split", "notConstructor"],
	["String.prototype.startsWith", "notConstructor"],
	["String.prototype.strike", "notConstructor"],
	["String.prototype.sub", "notConstructor"],
	["String.prototype.substr", "notConstructor"],
	["String.prototype.substring", "notConstructor"],
	["String.prototype.sup", "notConstructor"],
	["String.prototype.toLocaleLowerCase", "notConstructor"],
	["String.prototype.toLocaleUpperCase", "notConstructor"],
	["String.prototype.toLowerCase", "notConstructor"],
	["String.prototype.toString", "notConstructor"],
	["String.prototype.toUpperCase", "notConstructor"],
	["String.prototype.toWellFormed", "notConstructor"],
	["String.prototype.trim", "notConstructor"],
	["String.prototype.trimEnd", "notConstructor"],
	["String.prototype.trimStart", "notConstructor"],
	["String.prototype.valueOf", "notConstructor"],
	["String.raw", "notConstructor"],
	["Symbol", "symbolConstructor"],
	["Symbol.for", "notConstructor"],
	["Symbol.keyFor", "notConstructor"],
	["Symbol.prototype.toString", "notConstructor"],
	["Symbol.prototype.valueOf", "notConstructor"],
	["Symbol.prototype[Symbol.toPrimitive]", "notConstructor"],
	["decodeURI", "notConstructor"],
	["decodeURIComponent", "notConstructor"],
	["encodeURI", "notConstructor"],
	["encodeURIComponent", "notConstructor"],
	["globalThis.escape", "notConstructor"],
	["globalThis.unescape", "notConstructor"],
	["isFinite", "notConstructor"],
	["isNaN", "notConstructor"],
	["parseFloat", "notConstructor"],
	["parseInt", "notConstructor"],
];

const primitiveFunctionData = [
	["BigInt.asUintN", "BigInt.asUintN"],
	["BigInt.asIntN", "BigInt.asIntN"],
	["BigInt.prototype.toString", "BigInt.prototype.toString"],
	["BigInt.prototype.valueOf", "BigInt.prototype.valueOf"],
	["Boolean.prototype.toString", "Boolean.prototype.toString"],
	["Boolean.prototype.valueOf", "Boolean.prototype.valueOf"],
	["Math.abs", "Math.abs"],
	["Math.floor", "Math.floor"],
	["Math.ceil", "Math.ceil"],
	["Math.round", "Math.round"],
	["Math.trunc", "Math.trunc"],
	["Math.sqrt", "Math.sqrt"],
	["Math.cbrt", "Math.cbrt"],
	["Math.sign", "Math.sign"],
	["Math.log", "Math.log"],
	["Math.log2", "Math.log2"],
	["Math.log10", "Math.log10"],
	["Math.exp", "Math.exp"],
	["Math.sin", "Math.sin"],
	["Math.cos", "Math.cos"],
	["Math.tan", "Math.tan"],
	["Math.asin", "Math.asin"],
	["Math.acos", "Math.acos"],
	["Math.atan", "Math.atan"],
	["Math.sinh", "Math.sinh"],
	["Math.cosh", "Math.cosh"],
	["Math.tanh", "Math.tanh"],
	["Math.asinh", "Math.asinh"],
	["Math.acosh", "Math.acosh"],
	["Math.atanh", "Math.atanh"],
	["Math.log1p", "Math.log1p"],
	["Math.expm1", "Math.expm1"],
	["Math.fround", "Math.fround"],
	["Math.f16round", "Math.f16round"],
	["Math.clz32", "Math.clz32"],
	["Math.imul", "Math.imul"],
	["Math.atan2", "Math.atan2"],
	["Math.pow", "Math.pow"],
	["Math.hypot", "Math.hypot"],
	["Math.min", "Math.min"],
	["Math.max", "Math.max"],
	["Math.sumPrecise", "Math.sumPrecise"],
	["Math.random", "Math.random"],
	["Number.isNaN", "Number.isNaN"],
	["Number.isFinite", "Number.isFinite"],
	["Number.isInteger", "Number.isInteger"],
	["Number.isSafeInteger", "Number.isSafeInteger"],
	["Number.parseInt", "parseInt"],
	["Number.parseFloat", "parseFloat"],
	["Number.prototype.toString", "Number.prototype.toString"],
	["Number.prototype.toFixed", "Number.prototype.toFixed"],
	["Number.prototype.toExponential", "Number.prototype.toExponential"],
	["Number.prototype.toPrecision", "Number.prototype.toPrecision"],
	["Number.prototype.valueOf", "Number.prototype.valueOf"],
	["String.fromCharCode", "String.fromCharCode"],
	["String.fromCodePoint", "String.fromCodePoint"],
	["String.raw", "String.raw"],
	["String.prototype.charAt", "String.prototype.charAt"],
	["String.prototype.charCodeAt", "String.prototype.charCodeAt"],
	["String.prototype.codePointAt", "String.prototype.codePointAt"],
	["String.prototype.at", "String.prototype.at"],
	["String.prototype.indexOf", "String.prototype.indexOf"],
	["String.prototype.lastIndexOf", "String.prototype.lastIndexOf"],
	["String.prototype.includes", "String.prototype.includes"],
	["String.prototype.startsWith", "String.prototype.startsWith"],
	["String.prototype.endsWith", "String.prototype.endsWith"],
	["String.prototype.slice", "String.prototype.slice"],
	["String.prototype.substring", "String.prototype.substring"],
	["String.prototype.substr", "String.prototype.substr"],
	["String.prototype.anchor", "String.prototype.anchor"],
	["String.prototype.big", "String.prototype.big"],
	["String.prototype.blink", "String.prototype.blink"],
	["String.prototype.bold", "String.prototype.bold"],
	["String.prototype.fixed", "String.prototype.fixed"],
	["String.prototype.fontcolor", "String.prototype.fontcolor"],
	["String.prototype.fontsize", "String.prototype.fontsize"],
	["String.prototype.italics", "String.prototype.italics"],
	["String.prototype.link", "String.prototype.link"],
	["String.prototype.small", "String.prototype.small"],
	["String.prototype.strike", "String.prototype.strike"],
	["String.prototype.sub", "String.prototype.sub"],
	["String.prototype.sup", "String.prototype.sup"],
	["String.prototype.concat", "String.prototype.concat"],
	["String.prototype.localeCompare", "String.prototype.localeCompare"],
	["String.prototype.normalize", "String.prototype.normalize"],
	["String.prototype.repeat", "String.prototype.repeat"],
	["String.prototype.trim", "String.prototype.trim"],
	["String.prototype.trimStart", "String.prototype.trimStart"],
	["String.prototype.trimEnd", "String.prototype.trimEnd"],
	["String.prototype.trimLeft", "String.prototype.trimStart"],
	["String.prototype.trimRight", "String.prototype.trimEnd"],
	["String.prototype.toUpperCase", "String.prototype.toUpperCase"],
	["String.prototype.toLowerCase", "String.prototype.toLowerCase"],
	["String.prototype.toLocaleUpperCase", "String.prototype.toLocaleUpperCase"],
	["String.prototype.toLocaleLowerCase", "String.prototype.toLocaleLowerCase"],
	["String.prototype.isWellFormed", "String.prototype.isWellFormed"],
	["String.prototype.toWellFormed", "String.prototype.toWellFormed"],
	["String.prototype.split", "String.prototype.split"],
	["String.prototype.replace", "String.prototype.replace"],
	["String.prototype.replaceAll", "String.prototype.replaceAll"],
	["String.prototype.padStart", "String.prototype.padStart"],
	["String.prototype.padEnd", "String.prototype.padEnd"],
	["String.prototype.toString", "String.prototype.toString"],
	["String.prototype.valueOf", "String.prototype.valueOf"],
	["Symbol.for", "Symbol.for"],
	["Symbol.keyFor", "Symbol.keyFor"],
	["Symbol.prototype.toString", "Symbol.prototype.toString"],
	["Symbol.prototype.valueOf", "Symbol.prototype.valueOf"],
	["Symbol.prototype[Symbol.toPrimitive]", "Symbol.prototype[%Symbol.toPrimitive%]"],
	["globalThis.parseInt", "parseInt"],
	["globalThis.parseFloat", "parseFloat"],
	["globalThis.isNaN", "isNaN"],
	["globalThis.isFinite", "isFinite"],
	["globalThis.decodeURI", "decodeURI"],
	["globalThis.decodeURIComponent", "decodeURIComponent"],
	["globalThis.encodeURI", "encodeURI"],
	["globalThis.encodeURIComponent", "encodeURIComponent"],
	["globalThis.escape", "globalThis.escape"],
	["globalThis.unescape", "globalThis.unescape"],
];

const primitiveDataExpressions = [
	"Math.PI",
	"Math.E",
	"Math.LN2",
	"Math.LN10",
	"Math.LOG2E",
	"Math.LOG10E",
	"Math.SQRT2",
	"Math.SQRT1_2",
	"Number.MAX_SAFE_INTEGER",
	"Number.MIN_SAFE_INTEGER",
	"Number.EPSILON",
	"Number.MAX_VALUE",
	"Number.MIN_VALUE",
	"Number.POSITIVE_INFINITY",
	"Number.NEGATIVE_INFINITY",
	"Number.NaN",
	"Symbol.iterator",
	"Symbol.asyncIterator",
	"Symbol.toStringTag",
	"Symbol.hasInstance",
	"Symbol.toPrimitive",
	"Symbol.species",
	"Symbol.isConcatSpreadable",
	"Symbol.match",
	"Symbol.matchAll",
	"Symbol.replace",
	"Symbol.search",
	"Symbol.split",
	"Symbol.unscopables",
	"Symbol.dispose",
	"Symbol.asyncDispose",
];

const fixedPrimitiveExpressions = [
	"'x'.big('a\\\"b')",
	"'x'.blink('a\\\"b')",
	"'x'.fixed('a\\\"b')",
	"'x'.fontcolor('a\\\"b')",
	"'x'.fontsize('a\\\"b')",
	"'x'.italics('a\\\"b')",
	"'x'.link('a\\\"b')",
	"'x'.small('a\\\"b')",
	"'x'.strike('a\\\"b')",
	"'x'.sub('a\\\"b')",
	"'x'.sup('a\\\"b')",
	"Symbol.keyFor(Symbol.iterator)",
	"Boolean.prototype.valueOf.call(true)",
	"Number.prototype.valueOf.call(1)",
	"String.prototype.valueOf.call('x')",
	"String.prototype.toString.call('x')",
	"Symbol.prototype.valueOf.call(Symbol.iterator)",
	"Symbol.prototype[Symbol.toPrimitive].call(Symbol.iterator,'string')",
	"encodeURIComponent('a/b')",
	"decodeURI('%20')",
	"'a'.toUpperCase()",
	"'A'.toLowerCase()",
	"'e\\u0301'.normalize()",
	"String.raw({raw:['a','b']},'x')",
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
];

const fixedMathExpressions = [
	"Math.abs(-3)",
	"Math.round(-0.5)",
	"Math.min(0,-0)",
	"Math.max(-0,0)",
	"Math.trunc(-0.5)",
	"Math.ceil(-0.1)",
	"Math.floor(0.1)",
	"Math.sign(-0)",
	"Math.imul(0xffffffff,5)",
	"Math.clz32(1)",
	"Math.fround(1.1)",
	"Math.f16round(1.1)",
	"Math.sumPrecise([1e20,1,-1e20])",
	"Math.sin(-0)",
	"Math.sin(Infinity)",
	"Math.cos(0)",
	"Math.cos(-Infinity)",
	"Math.tan(-0)",
	"Math.tan(Infinity)",
	"Math.asin(-0)",
	"Math.asin(2)",
	"Math.acos(1)",
	"Math.acos(-2)",
	"Math.atan(-0)",
	"Math.atan(NaN)",
	"Math.asinh(-Infinity)",
	"Math.sinh(-0)",
	"Math.cosh(-Infinity)",
	"Math.tanh(-Infinity)",
	"Math.acosh(1)",
	"Math.acosh(0)",
	"Math.atanh(-1)",
	"Math.atanh(2)",
	"Math.cbrt(-0)",
	"Math.cbrt(Infinity)",
	"Math.sqrt(-0)",
	"Math.sqrt(-1)",
	"Math.log(1)",
	"Math.log(-0)",
	"Math.log2(-1)",
	"Math.log10(Infinity)",
	"Math.log1p(-0)",
	"Math.log1p(-1)",
	"Math.exp(-Infinity)",
	"Math.expm1(-Infinity)",
	"Math.expm1(-0)",
	"Math.exp(0)",
	"Math.hypot()",
	"Math.hypot(-0,0)",
	"Math.hypot(NaN,Infinity,2)",
	"Math.hypot(NaN,0)",
	"Math.hypot(-2)",
	"Math.atan2(-0,1)",
	"Math.atan2(-1,Infinity)",
	"Math.atan2(NaN,0)",
	"Math.pow(NaN,0)",
	"Math.pow(-0,3)",
	"Math.pow(-0,-3)",
	"Math.pow(-Infinity,-3)",
	"Math.pow(-1,Infinity)",
	"Math.pow(-1,3)",
	"Math.pow(-2,0.5)",
	"Math.pow(2,-1074)",
];

function inspect(expression: string, locked = true) {
	return inspectStaticValueFunction(
		`function probe(x){return ${expression};} globalThis.probe=probe;`,
		"probe",
		{ locked },
	);
}

function onlyConstantResults(output: ReturnType<typeof inspect>) {
	return output.core.every((operation) =>
		[
			"createNumber",
			"createF64",
			"createString",
			"createBoolean",
			"createBigint",
			"createUndefined",
			"createNull",
			"loadPrimordial",
		].includes(operation.opcode),
	);
}

describe("primitive operation results", () => {
	it.each([3, 8, 16, 32, 64])(
		"consumes %i dynamic Numbers through the exact sum kernel",
		(count) => {
			const output = inspect(`Math.sumPrecise([${Array(count).fill("+x").join(",")}])`);
			expect(output.structure.allocations).toBe(0);
			expect(
				output.core
					.filter((operation) => operation.opcode === "preciseNumberSum")
					.map((operation) => operation.inputs.length),
			).toEqual([count]);
			expect(
				output.core.some(
					(operation) => operation.attributes.operation === "Math.sumPrecise",
				),
			).toBe(false);
			expect(output.c.source).toContain("mal_builtin_math_sum_precise_numbers(");
			expect(output.c.source).not.toContain("mal_builtin_math_sum_precise_known(");
			const restored = deserializeCompilerArtifact(
				serializeCompilerArtifact(output.image),
			);
			expect(
				restored.runtime.functions
					.flatMap((fn) => fn.instructions)
					.filter((instruction) => instruction.opcode === "PRECISE_NUMBER_SUM")
					.map((instruction) => instruction.arguments.length),
			).toEqual([count]);
		},
	);
	it("retains a sum input beyond the numeric kernel's bounded operand list", () => {
		const output = inspect(`Math.sumPrecise([${Array(65).fill("+x").join(",")}])`);
		expect(output.structure.allocations).toBeGreaterThan(0);
		expect(output.core.some((operation) => operation.opcode === "preciseNumberSum")).toBe(
			false,
		);
	});
	it("propagates an exact sum result into primitive wrapper consumers", () => {
		const output = inspect("Object(Math.sumPrecise([1e20,+x,-1e20])).valueOf()");
		expect(output.structure.allocations).toBe(0);
		expect(output.core.some((operation) => operation.opcode === "preciseNumberSum")).toBe(
			true,
		);
		expect(
			output.core.some((operation) =>
				["Object", "Number.prototype.valueOf"].includes(
					operation.attributes.operation as string,
				),
			),
		).toBe(false);
	});
	it.each(rejectedPrimitiveConstructors)(
		"residualizes rejected construction of %s without argument materialization",
		(expression, error) => {
			const output = inspect(`new (${expression})([x()],x())`);
			expect(
				output.core
					.filter((operation) => operation.opcode === "builtinError")
					.map((operation) => operation.attributes.error),
			).toEqual([error]);
			expect(output.structure.allocations).toBe(0);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.structure.genericCalls).toBe(2);
		},
	);
	it.each(rejectedPrimitiveConstructors)(
		"keeps the runtime exception for constant construction of %s",
		(expression, error) => {
			const output = inspect(`new (${expression})(1)`);
			expect(
				output.core
					.filter((operation) => operation.opcode === "builtinError")
					.map((operation) => operation.attributes.error),
			).toEqual([error]);
			expect(output.structure.allocations).toBe(0);
		},
	);
	it.each(rejectedPrimitiveConstructors)(
		"retains a mutable construction target at %s",
		(expression) => {
			const output = inspect(`new (${expression})([x()],x())`, false);
			expect(output.core.some((operation) => operation.opcode === "builtinError")).toBe(
				false,
			);
			expect(output.structure.allocations).toBeGreaterThan(0);
		},
	);
	it.each(primitiveFunctionData)(
		"reads the exact canonical function at %s",
		(expression, canonical) => {
			const output = inspect(expression);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.structure.genericCalls).toBe(0);
			expect(output.core.map((operation) => operation.opcode)).toEqual([
				"loadPrimordial",
			]);
			expect(
				getPrimordialCatalog().nodes[output.core[0]!.attributes.nodeIndex as number]?.[0],
			).toBe(canonical);
		},
	);
	it.each(primitiveFunctionData)(
		"retains mutable canonical function lookup at %s",
		(expression) => {
			const output = inspect(expression, false);
			expect(output.structure.genericLookups).toBeGreaterThan(0);
			expect(output.core.some((operation) => operation.opcode === "loadPrimordial")).toBe(
				false,
			);
			const comparison = inspectStaticValueFunction(
				`function probe(x){const before=${expression};x();return before===${expression};}globalThis.probe=probe;`,
				"probe",
				{ locked: false },
			);
			expect(
				comparison.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "===",
				),
			).toBe(true);
		},
	);
	it.each(primitiveFunctionData)(
		"reuses canonical function identity across effects at %s",
		(expression) => {
			const output = inspectStaticValueFunction(
				`function probe(x){const before=${expression};x();return before===${expression};}globalThis.probe=probe;`,
				"probe",
			);
			expect(output.structure.genericCalls).toBe(1);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.core.some((operation) => operation.opcode === "loadPrimordial")).toBe(
				false,
			);
			expect(
				output.core
					.filter((operation) => operation.opcode === "createBoolean")
					.map((operation) => operation.attributes.value),
			).toEqual([true]);
		},
	);
	it.each(primitiveFunctionData)(
		"discards unused canonical function reads at %s",
		(expression) => {
			const output = inspectStaticValueFunction(
				`function probe(x){x();${expression};x();return 1;}globalThis.probe=probe;`,
				"probe",
			);
			expect(output.structure.genericCalls).toBe(2);
			expect(output.structure.genericLookups).toBe(0);
			expect(
				output.core.some((operation) =>
					["loadPrimordial", "loadIntrinsic"].includes(operation.opcode),
				),
			).toBe(false);
		},
	);
	it.each([
		["String.prototype.trimLeft", "String.prototype.trimStart", true],
		["String.prototype.trimRight", "String.prototype.trimEnd", true],
		["Number.parseInt", "parseInt", true],
		["Number.parseFloat", "parseFloat", true],
		["String.prototype.toString", "String.prototype.valueOf", false],
		["Symbol.prototype.valueOf", "Symbol.prototype[Symbol.toPrimitive]", false],
	] as const)(
		"distinguishes canonical function identity for %s and %s",
		(left, right, same) => {
			for (const operator of ["===", "!==", "==", "!="]) {
				const output = inspect(`${left}${operator}${right}`);
				expect(
					output.core.map((operation) => [operation.opcode, operation.attributes.value]),
				).toEqual([["createBoolean", operator.startsWith("!") ? !same : same]]);
			}
		},
	);
	it.each([
		"Symbol(x).description",
		"Symbol(x).toString()",
		"String(Symbol(x))",
		"Object(Symbol(x)).description",
		"Symbol(String(x)).description",
		"Symbol(+x).description",
		"Symbol({toString(){return x();}}).description",
		"Symbol(String(x)).toString()",
		"String(Symbol(String(x)))",
		"Object(Symbol(String(x))).description",
	])(
		"consumes a dynamic symbol description without its identity for %s",
		(expression) => {
			const output = inspect(expression);
			expect(output.core.some((op) => op.attributes.operation === "Symbol")).toBe(false);
			expect(
				output.core.some((op) =>
					["Symbol.prototype.description<get>", "Symbol.prototype.toString"].includes(
						op.attributes.operation as string,
					),
				),
			).toBe(false);
		},
	);
	it.each(["Symbol(x)", "Symbol.for(String(x)).description"])(
		"retains escaping or registered symbol identity at %s",
		(expression) => {
			expect(
				inspect(expression).core.some((op) =>
					["Symbol", "Symbol.for"].includes(op.attributes.operation as string),
				),
			).toBe(true);
		},
	);
	it("shares one conditional Symbol coercion across description and text consumers", () => {
		const output = inspectStaticValueFunction(
			"function probe(x,after){const s=Symbol(x);after();return [s.description,s.toString(),String(s)];}globalThis.probe=probe;",
			"probe",
		);
		expect(
			output.core.filter(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "tostring",
			),
		).toHaveLength(1);
		expect(
			output.core.some((operation) => operation.attributes.operation === "Symbol"),
		).toBe(false);
		expect(
			output.core.some(
				(operation) =>
					operation.attributes.operation === "Symbol.prototype.description<get>",
			),
		).toBe(false);
	});
	it("retains conditional Symbol coercion in a catch and finally region", () => {
		const output = inspectStaticValueFunction(
			"function probe(x,after){try{const s=Symbol(x);after();return s.description;}catch(error){return error;}finally{after();}}globalThis.probe=probe;",
			"probe",
		);
		expect(
			output.core.some((operation) => operation.attributes.operation === "Symbol"),
		).toBe(false);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "tostring",
			),
		).toBe(true);
	});
	it("eliminates per-iteration Symbol identities while preserving loop-carried descriptions", () => {
		const output = inspectStaticValueFunction(
			"function probe(values){let text='';for(let i=0;i<values.length;i++){const s=Symbol(values[i]);text+=s.description;}return text;}globalThis.probe=probe;",
			"probe",
		);
		expect(
			output.core.some((operation) => operation.attributes.operation === "Symbol"),
		).toBe(false);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "tostring",
			),
		).toBe(true);
	});
	it("retains a dynamic symbol whose identity escapes before its description", () => {
		const output = inspectStaticValueFunction(
			"function probe(x){const s=Symbol(String(x)); x(s); return s.description;}globalThis.probe=probe;",
			"probe",
		);
		expect(output.core.some((op) => op.attributes.operation === "Symbol")).toBe(true);
	});
	it("retains mutable dynamic symbol description dispatch", () => {
		for (const expression of [
			"Symbol(String(x)).description",
			"Symbol(x).description",
			"Symbol(x).toString()",
			"String(Symbol(x))",
		]) {
			const output = inspect(expression, false);
			expect(output.structure.genericCalls).toBeGreaterThan(0);
			if (expression === "String(Symbol(x))")
				expect(output.structure.genericCalls).toBe(2);
			else expect(output.structure.genericLookups).toBeGreaterThan(0);
		}
	});
	it.each(primitiveDataExpressions)(
		"reads certified primitive data without a runtime lookup for %s",
		(expression) => {
			const output = inspect(expression);
			expect(onlyConstantResults(output)).toBe(true);
			expect(output.core).toHaveLength(1);
			expect(output.structure.allocations).toBe(0);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.structure.genericCalls).toBe(0);
		},
	);
	it.each(primitiveDataExpressions)(
		"retains mutable lookup for primitive data %s",
		(expression) => {
			const output = inspect(expression, false);
			expect(output.structure.genericLookups).toBe(1);
			expect(onlyConstantResults(output)).toBe(false);
		},
	);
	it.each(primitiveDataExpressions)(
		"shares stable primitive data across an effect for %s",
		(expression) => {
			const output = inspectStaticValueFunction(
				`function probe(x){const before=${expression};x();return before===${expression};}globalThis.probe=probe;`,
				"probe",
			);
			expect(output.structure.genericCalls).toBe(1);
			expect(output.structure.genericLookups).toBe(0);
			expect(
				output.core
					.filter((instruction) => instruction.opcode === "createBoolean")
					.map((instruction) => instruction.attributes.value),
			).toEqual([expression !== "Number.NaN"]);
		},
	);
	it.each(primitiveDataExpressions)(
		"discards unused primitive data while retaining surrounding effects for %s",
		(expression) => {
			const output = inspectStaticValueFunction(
				`function probe(x){x();${expression};x();return 1;}globalThis.probe=probe;`,
				"probe",
			);
			expect(output.structure.genericCalls).toBe(2);
			expect(output.structure.genericLookups).toBe(0);
			expect(
				output.core.some(
					(instruction) =>
						instruction.opcode === "loadPrimordial" ||
						instruction.opcode === "loadIntrinsic",
				),
			).toBe(false);
		},
	);
	it.each([...fixedPrimitiveExpressions, ...fixedMathExpressions])(
		"retains mutable lookup for the constant witness %s",
		(expression) => {
			expect(onlyConstantResults(inspect(expression, false))).toBe(false);
		},
	);
	it.each(["[1e20,1,-1e20]", "[]", "[-0,-0]", "[+x]", "[+x,1]", "[+x,+x]", "[+x,1,2]"])(
		"eliminates a proved numeric sum input %s",
		(array) => {
			const output = inspect(`Math.sumPrecise(${array})`);
			expect(
				output.core.some((op) => op.attributes.operation === "Math.sumPrecise"),
			).toBe(false);
			expect(output.structure.allocations).toBe(0);
		},
	);
	it.each([
		"x",
		"[x]",
		"[x,1,2]",
		"Array(65).fill(1)",
		"Object.assign([1],{[Symbol.iterator]:x})",
	])("retains unproved sum iteration for %s", (array) => {
		expect(
			inspect(`Math.sumPrecise(${array})`).core.some(
				(op) => op.attributes.operation === "Math.sumPrecise",
			),
		).toBe(true);
	});
	it.each([
		"[1,'2']",
		"[NaN,'2']",
		"[+x,false]",
		"[1,{}]",
		"[Symbol.iterator]",
		"[1n]",
		"[1,,2]",
	])(
		"rejects a proved non-Number sum element without input materialization in %s",
		(array) => {
			const output = inspect(`Math.sumPrecise(${array})`);
			expect(output.structure.allocations).toBe(0);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			expect(output.core).toContainEqual(
				expect.objectContaining({
					opcode: "builtinError",
					inputs: [],
					attributes: { error: "sumNumber" },
				}),
			);
			expect(
				inspect(`Math.sumPrecise(${array})`, false).structure.genericCalls,
			).toBeGreaterThan(0);
		},
	);
	it("retains mutable-world sum lookup and iteration", () => {
		const output = inspect("Math.sumPrecise([1,2])", false);
		expect(output.c.source).not.toContain("mal_math_sum_precise");
		expect(output.structure.allocations).toBeGreaterThan(0);
	});
	it.each(fixedMathExpressions)(
		"folds the target-independent Math special case %s",
		(expression) => {
			const output = inspect(expression);
			expect(onlyConstantResults(output)).toBe(true);
			expect(
				output.core.some(
					(op) =>
						op.opcode === "callKnown" ||
						op.opcode === "mathUnaryNumber" ||
						op.opcode === "mathBinaryNumber",
				),
			).toBe(false);
		},
	);
	it.each(["Math.pow(+x,0)", "Math.hypot(+x)"])(
		"specializes a fixed Math parameter in %s",
		(expression) => {
			const output = inspect(expression);
			expect(
				output.core.some((op) =>
					["Math.pow", "Math.hypot"].includes(op.attributes.operation as string),
				),
			).toBe(false);
			expect(
				output.core.some((op) => op.opcode === "unary" && op.attributes.operator === "+"),
			).toBe(true);
		},
	);
	it.each(["Math.pow(x,0)", "Math.pow(1,x)", "Math.hypot(x,Infinity)"])(
		"retains coercion and possible failure in %s",
		(expression) => {
			expect(inspect(expression).core.some((op) => op.opcode === "callKnown")).toBe(true);
		},
	);
	it.each(["replace", "replaceAll"])(
		"lowers static %s matches into residual callbacks",
		(method) => {
			const output = inspect(
				`'aba'.${method}('a',(match,position,source)=>x(match,position,source))`,
			);
			expect(
				output.core.some(
					(op) => op.attributes.operation === `String.prototype.${method}`,
				),
			).toBe(false);
			expect(output.core.filter((op) => op.opcode === "call")).toHaveLength(
				method === "replace" ? 1 : 2,
			);
		},
	);
	it("removes a nonmatching replacement without invoking its callback", () => {
		const output = inspect("'aba'.replaceAll('z',()=>x())");
		expect(
			output.core.some(
				(op) =>
					op.opcode === "call" ||
					op.attributes.operation === "String.prototype.replaceAll",
			),
		).toBe(false);
	});
	it.each([
		"'aba'.replaceAll('a',x)",
		"String(x).replaceAll('a',()=>x())",
		"'aba'.replaceAll(x,()=>x())",
	])("retains dynamic replacement semantics for %s", (expression) => {
		expect(
			inspect(expression).core.some(
				(op) => op.attributes.operation === "String.prototype.replaceAll",
			),
		).toBe(true);
	});
	it("retains mutable replacement dispatch", () => {
		const output = inspect("'aba'.replaceAll('a',()=>x())", false);
		expect(output.structure.genericCalls).toBeGreaterThan(0);
	});
	it.each([
		["const s=String(x); const a=s.trim(); return a+s.trim();", "String.prototype.trim"],
		[
			"const s=String(x); const a=s.slice(1); return a+s.slice(1);",
			"String.prototype.slice",
		],
		[
			"const s=String(x); const a=s.replace('a','b'); return a+s.replace('a','b');",
			"String.prototype.replace",
		],
		[
			"const n=Number(x); const a=n.toFixed(2); return a+n.toFixed(2);",
			"Number.prototype.toFixed",
		],
		["const a=Number.isFinite(x); return a+Number.isFinite(x);", "Number.isFinite"],
		["const n=+x; const a=Math.hypot(n,2,3); return a+Math.hypot(n,2,3);", "Math.hypot"],
		[
			"const b=BigInt(x); const a=BigInt.asIntN(8,b); return a+BigInt.asIntN(8,b);",
			"BigInt.asIntN",
		],
		["const s=String(x); const a=encodeURI(s); return a+encodeURI(s);", "encodeURI"],
		["const s=String(x); const a=escape(s); return a+escape(s);", "globalThis.escape"],
	])("reuses the completed immutable result of %s", (body, operation) => {
		const output = inspectStaticValueFunction(
			`function probe(x){${body}}globalThis.probe=probe;`,
			"probe",
		);
		expect(
			output.core.filter(
				(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
			),
		).toHaveLength(1);
	});
	it.each([
		["Number(x)+Number(x)", "Number"],
		["parseFloat(x)+parseFloat(x)", "parseFloat"],
		["Math.random()+Math.random()", "Math.random"],
		["String(x).replace('a',x)+String(x).replace('a',x)", "String.prototype.replace"],
	])(
		"retains repeated coercion, callback or entropy work for %s",
		(expression, operation) => {
			expect(
				inspect(expression).core.filter(
					(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
				),
			).toHaveLength(2);
		},
	);
	it.each([
		["const a=String(x),b=String(x);return a.trim()+b.trim();", "String.prototype.trim"],
		[
			"let a=Number(x);const b=a.toFixed(2);a++;return b+a.toFixed(2);",
			"Number.prototype.toFixed",
		],
	])(
		"does not confuse equal result-kind descriptions with equal values in %s",
		(body, operation) => {
			const output = inspectStaticValueFunction(
				`function probe(x){${body}}globalThis.probe=probe;`,
				"probe",
			);
			expect(
				output.core.filter(
					(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
				),
			).toHaveLength(2);
		},
	);
	it.each([
		["(Number(x)+1).toFixed(2)", "Number.prototype.toFixed"],
		["(-Number(x)).toFixed(2)", "Number.prototype.toFixed"],
		["(BigInt(x)+1n).toString(16)", "BigInt.prototype.toString"],
		["(~BigInt(x)).toString(16)", "BigInt.prototype.toString"],
	])("keeps the numeric result kind through %s", (expression, operation) => {
		expect(
			inspect(expression).core.some(
				(op) => op.opcode === "callKnown" && op.attributes.operation === operation,
			),
		).toBe(true);
	});
	it("does not select Number formatting for an unknown numeric increment", () => {
		const output = inspectStaticValueFunction(
			"function probe(x){x++;return x.toFixed(2);}globalThis.probe=probe;",
			"probe",
		);
		expect(
			output.core.some(
				(op) =>
					op.opcode === "callKnown" &&
					op.attributes.operation === "Number.prototype.toFixed",
			),
		).toBe(false);
	});
	it("retains separate fresh split results", () => {
		const output = inspectStaticValueFunction(
			"function probe(x){const s=String(x);return s.split(',')===s.split(',');}globalThis.probe=probe;",
			"probe",
		);
		expect(
			output.core.filter(
				(op) =>
					op.opcode === "callKnown" &&
					op.attributes.operation === "String.prototype.split",
			),
		).toHaveLength(2);
	});
	it.each([
		[
			"const s=String(x); s.trim(); s.slice(1); s.includes('a'); s.split(',');",
			[
				"String.prototype.trim",
				"String.prototype.slice",
				"String.prototype.includes",
				"String.prototype.split",
			],
		],
		[
			"const n=Number(x); n.toFixed(2); Math.hypot(n,2); isNaN(n);",
			["Number.prototype.toFixed", "Math.hypot", "isNaN"],
		],
		[
			"const s=String(x); parseInt(s,16); parseFloat(s); escape(s);",
			["parseInt", "parseFloat", "globalThis.escape"],
		],
		[
			"Number.isInteger(x); Number.isSafeInteger(x);",
			["Number.isInteger", "Number.isSafeInteger"],
		],
	])("removes unused certified nonthrowing calls in %s", (body, operations) => {
		const output = inspectStaticValueFunction(
			`function probe(x){${body}return x;}globalThis.probe=probe;`,
			"probe",
		);
		expect(
			output.core.filter(
				(op) =>
					op.opcode === "callKnown" &&
					operations.includes(op.attributes.operation as string),
			),
		).toEqual([]);
	});
	it.each([
		"String(x).repeat(x)",
		"BigInt(x)",
		"encodeURI(String(x))",
		"Math.random()",
		"String(x).replace('a',x)",
		"Number(x)",
	])("keeps unused coercions, exceptions and callbacks at %s", (expression) => {
		const output = inspectStaticValueFunction(
			`function probe(x){${expression};return x;}globalThis.probe=probe;`,
			"probe",
		);
		expect(output.core.some((op) => op.opcode === "callKnown")).toBe(true);
	});
	it.each([
		"new BigInt(x)",
		"new Symbol(x)",
		"new Math.abs(x)",
		"new String.prototype.trim(x)",
		"new parseInt(x)",
	])("residualizes nonconstructable primitive identity at %s", (expression) => {
		const output = inspect(expression);
		expect(output.c.source).toContain("mal_vm_throw_error(");
		expect(output.c.source).not.toContain("mal_vm_call_known_native(");
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(output.image));
		expect(
			restored.runtime.functions
				.flatMap((fn) => fn.instructions)
				.filter((instruction) => instruction.opcode === "BUILTIN_ERROR")
				.map((instruction) => instruction.error),
		).toEqual([
			expression.startsWith("new BigInt")
				? "bigintConstructor"
				: expression.startsWith("new Symbol")
					? "symbolConstructor"
					: "notConstructor",
		]);
		expect(inspect(expression, false).c.source).not.toContain("mal_vm_throw_error(");
	});
	it.each([
		["Number(Symbol.iterator)", "symbolNumber"],
		["new Number(Symbol.iterator)", "symbolNumber"],
		["new String(Symbol.iterator)", "symbolString"],
		["BigInt(Symbol.iterator)", "bigintValue"],
		["Symbol(Symbol.iterator)", "symbolString"],
		["Symbol.for(Symbol.iterator)", "symbolString"],
		["Math.sin(Symbol.iterator)", "symbolNumber"],
		["Math.max(NaN,1n)", "bigintNumberConversion"],
		["Math.hypot(1,Symbol.iterator)", "symbolNumber"],
		["String.fromCharCode(1,1n)", "bigintNumberConversion"],
		["String.fromCodePoint(65,1n)", "bigintNumberConversion"],
		["(1).toFixed(1n)", "bigintNumberConversion"],
		["BigInt.asIntN(Symbol.iterator,1n)", "symbolNumber"],
		["BigInt.asIntN(0,Symbol.iterator)", "bigintValue"],
		["parseInt('1',1n)", "bigintNumberConversion"],
		["parseFloat(Symbol.iterator)", "symbolString"],
		["encodeURI(Symbol.iterator)", "symbolString"],
		["String.raw(null)", "readNullish"],
		["Math.sumPrecise(1)", "notIterable"],
		["Math.sumPrecise()", "readNullish"],
		["String.prototype.replace.call(null,x,'')", "stringReplaceNullish"],
		["String.prototype.replaceAll.call(null,x,'')", "stringReplaceAllNullish"],
		["String.prototype.split.call(null,x)", "stringSplitNullish"],
		["String.prototype.matchAll.call(null,x)", "stringMatchAllNullish"],
		["String.prototype.trim.call(null)", "stringNullish"],
		["String.prototype.replace.call(Symbol.iterator,'a',x)", "symbolString"],
		["Number.prototype.valueOf.call(Symbol.iterator)", "numberReceiver"],
		["Symbol.prototype[Symbol.toPrimitive].call(1)", "symbolReceiver"],
		["Number.prototype.toString.call(true,x)", "numberReceiver"],
		["Boolean.prototype.valueOf.call(1)", "booleanReceiver"],
		["String.prototype.valueOf.call(1)", "stringReceiver"],
		["BigInt.prototype.toString.call(1,x)", "bigintReceiver"],
		["Symbol.prototype.toString.call(1)", "symbolReceiver"],
		["Symbol.keyFor(1)", "symbolKey"],
		["(1).toString(1)", "numberRadix"],
		["(1n).toString(37)", "numberRadix"],
		["(Infinity).toFixed(101)", "numberFixed"],
		["(1).toExponential(-1)", "numberExponential"],
		["(1).toPrecision(0)", "numberPrecision"],
		["BigInt(1.5)", "bigintNumber"],
		["BigInt(null)", "bigintValue"],
		["BigInt('12x')", "bigintString"],
		["BigInt.asIntN(-1,x)", "bigintWidth"],
		["BigInt.asUintN(0,1)", "bigintValue"],
		["String.fromCodePoint(-1,x)", "codePoint"],
		["'a'.repeat(-1)", "repeatCount"],
		["'a'.normalize('invalid')", "normalization"],
		["decodeURIComponent('%xx')", "uri"],
		["encodeURI('\\ud800')", "uri"],
	])("residualizes the known failure at %s", (expression, error) => {
		const output = inspect(expression);
		const plans = output.image.runtime.functions
			.flatMap((fn) => fn.instructions)
			.filter((plan) => plan.opcode === "BUILTIN_ERROR");
		expect(plans.map((plan) => plan.error)).toEqual([error]);
		expect(output.c.source).toContain("mal_vm_throw_error(");
		expect(output.c.source).not.toContain("mal_vm_call_known_native(");
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(output.image));
		expect(
			restored.runtime.functions
				.flatMap((fn) => fn.instructions)
				.filter((plan) => plan.opcode === "BUILTIN_ERROR"),
		).toEqual(plans);
		expect(inspect(expression, false).c.source).not.toContain("mal_vm_throw_error(");
	});
	it.each([
		"Math.max(x,1n)",
		"BigInt.asIntN(+x,Symbol.iterator)",
		"String.fromCodePoint(+x,1n)",
		"parseInt(x,1n)",
		"String.prototype.replace.call(Symbol.iterator,x,'')",
		"Number.prototype.valueOf.call(1,Symbol.iterator)",
		"BigInt.prototype.valueOf.call(1n,Symbol.iterator)",
		"Number.isFinite(Symbol.iterator)",
		"Math.random(Symbol.iterator)",
		"Reflect.construct(Number,[Symbol.iterator],x)",
	])(
		"does not skip an earlier effect or invent an ignored conversion in %s",
		(expression) => {
			expect(
				inspect(expression)
					.image.runtime.functions.flatMap((fn) => fn.instructions)
					.some((plan) => plan.opcode === "BUILTIN_ERROR"),
			).toBe(false);
		},
	);
	it.each([
		"Object(Symbol.iterator)[Symbol.toPrimitive]('string')===Symbol.iterator",
		"Symbol.prototype[Symbol.toPrimitive].call(Symbol.iterator,x)===Symbol.iterator",
	])("extracts a primitive Symbol through its canonical protocol in %s", (expression) => {
		const output = inspect(expression);
		expect(output.core.some((op) => op.opcode === "callKnown")).toBe(false);
		expect(output.structure.allocations).toBe(0);
	});
	it("rejects unknown residual error identities when loading artifacts", () => {
		const output = inspect("'a'.normalize('invalid')");
		const wire = serializeCompilerArtifact(output.image);
		const bytes = Buffer.from(wire);
		const error = output.fn.instructions.find(
			(instruction) => instruction.opcode === "BUILTIN_ERROR",
		)!;
		const writer = new Writer();
		writer.u8(BYTECODE_OPERATIONS.indexOf("BUILTIN_ERROR"));
		writer.i32(error.dst);
		writer.u8(knownBuiltinErrorNames.indexOf(error.error));
		const payload = Buffer.from(writer.finish());
		const offset = bytes.indexOf(payload);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(bytes.indexOf(payload, offset + payload.length)).toBe(-1);
		bytes[offset + payload.length - 1] = 255;
		expect(() => deserializeCompilerArtifact(bytes)).toThrow(/invalid builtin error/);
	});
	it.each([
		"new Math.abs({value:x()})",
		"new BigInt([x()])",
		"new Symbol({[x()]:1})",
		"(1).toString(1,{value:x()})",
		"String.fromCodePoint(-1,[x()])",
		"'a'.repeat(-1,{value:x()})",
	])(
		"discards unused error inputs while retaining producer effects in %s",
		(expression) => {
			const output = inspect(expression);
			expect(output.structure.allocations).toBe(0);
			expect(output.structure.genericCalls).toBe(1);
			expect(
				output.core.filter((operation) => operation.opcode === "builtinError"),
			).toHaveLength(1);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
		},
	);
	it.each([
		"Number.prototype.toFixed.call(x,101)",
		"(1).toFixed(x)",
		"String.fromCodePoint(x,-1)",
		"String.prototype.repeat.call(x,-1)",
		"BigInt.asIntN(x,1)",
		"'a'.normalize(x)",
		"decodeURI(x)",
		"Infinity.toExponential(101)",
		"NaN.toPrecision(0)",
	])(
		"preserves an earlier coercion or successful nonfinite result for %s",
		(expression) => {
			expect(
				inspect(expression)
					.image.runtime.functions.flatMap((fn) => fn.instructions)
					.filter((plan) => plan.opcode === "BUILTIN_ERROR"),
			).toEqual([]);
		},
	);
	it.each([
		["parseInt(String(x),16)", "mal_builtin_parse_int_string("],
		["Number.parseInt(String(x),+x)", "mal_builtin_parse_int_string("],
		["parseFloat(String(x))", "mal_builtin_parse_float_string("],
		["Number.parseFloat(String(x))", "mal_builtin_parse_float_string("],
		["BigInt.asIntN(8,x)", "mal_builtin_bigint_width_number("],
		["BigInt.asUintN(+x,255n)", "mal_builtin_bigint_width_number("],
		["BigInt.prototype.toString.call(x,16.9)", "mal_builtin_bigint_to_string_radix("],
		["isNaN(+x)", "isnan("],
		["isFinite(+x)", "isfinite("],
	])("uses numeric parameter kernels for %s", (expression, kernel) => {
		expect(inspect(expression).c.source).toContain(kernel);
		expect(inspect(expression, false).c.source).not.toContain(kernel);
	});
	it.each([
		["parseInt(String(x),x)", "mal_builtin_parse_int_string("],
		["BigInt.asIntN(x,1n)", "mal_builtin_bigint_width_number("],
		["BigInt.prototype.toString.call(x,1)", "mal_builtin_bigint_to_string_radix("],
		["BigInt.prototype.toString.call(x,x)", "mal_builtin_bigint_to_string_radix("],
		["isNaN(x)", "isnan("],
		["isFinite(x)", "isfinite("],
	])("retains runtime coercion and invalid parameters for %s", (expression, kernel) => {
		const source = inspect(expression).c.source;
		expect(source).toContain(kernel);
		expect(source).toContain("mal_vm_call_known_native(");
		expect(source).toContain("if (");
	});
	it.each([
		"String(x).localeCompare()",
		"String(x).localeCompare('a')",
		"String(x).localeCompare('a','sv')",
		"String.prototype.localeCompare.call(x,'a','de')",
		"String(x).localeCompare('a','en-US',{numeric:true,sensitivity:'base',caseFirst:'upper'})",
		"String(x).localeCompare('a','tr',{sensitivity:'case'})",
		"String(x).localeCompare('a','en-US',{numeric:1n,caseFirst:'lower'})",
		"String(x).localeCompare('a','en-US',{numeric:true,unused:x()})",
		"Object(String(x).localeCompare('a','sv')).valueOf()",
	])("prepares immutable target collation for %s", (expression) => {
		const output = inspect(expression);
		expect(output.c.source).toContain("mal_builtin_string_locale_compare_prepared(");
		expect(output.c.source).not.toContain(
			"mal_known_native_mal_builtin_string_prototype_locale_compare",
		);
		expect(output.structure.allocations).toBe(0);
		const plans = output.image.runtime.functions
			.flatMap((fn) => fn.instructions)
			.filter((plan) => plan.opcode === "PREPARED_STRING_COMPARE");
		expect(plans.length).toBeGreaterThan(0);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(output.image));
		expect(
			restored.runtime.functions
				.flatMap((fn) => fn.instructions)
				.filter((plan) => plan.opcode === "PREPARED_STRING_COMPARE"),
		).toEqual(plans);
	});
	it("rejects malformed collation plans in compiler artifacts", () => {
		for (const plan of [
			{ locale: "en", options: 3 },
			{ locale: "en", options: 5 },
			{ locale: "en", options: 48 },
			{ locale: "en", options: NaN },
			{ locale: "é", options: 2 },
			{ locale: "a".repeat(129), options: 2 },
		]) {
			const output = inspect("String(x).localeCompare('a','en')");
			const image = {
				...output.image,
				runtime: {
					...output.image.runtime,
					stringConstants: [
						...output.image.runtime.stringConstants,
						Array.from(plan.locale, (character) => character.charCodeAt(0)),
					],
					functions: output.image.runtime.functions.map((fn) => ({
						...fn,
						instructions: fn.instructions.map((instruction) =>
							instruction.opcode === "PREPARED_STRING_COMPARE"
								? {
										...instruction,
										stringIndex: output.image.runtime.stringConstants.length,
										options: plan.options,
									}
								: instruction,
						),
					})),
				},
			};
			expect(() => serializeCompilerArtifact(image)).toThrow(/string collation plan/);
		}
	});
	it("rejects corrupt precise sum side data while loading an artifact", () => {
		const output = inspect("Math.sumPrecise([1e20,+x,-1e20])");
		const instruction = output.fn.instructions.find(
			(instruction) => instruction.opcode === "PRECISE_NUMBER_SUM",
		)!;
		const writer = new Writer();
		writer.u8(BYTECODE_OPERATIONS.indexOf(instruction.opcode));
		writer.i32(instruction.dst);
		writer.i32(instruction.arguments.length);
		writer.i32Array(instruction.arguments);
		const payload = Buffer.from(writer.finish());
		const bytes = Buffer.from(serializeCompilerArtifact(output.image));
		const offset = bytes.indexOf(payload);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(bytes.indexOf(payload, offset + payload.length)).toBe(-1);
		bytes[offset + payload.length - 1] = 1;
		expect(() => deserializeCompilerArtifact(bytes)).toThrow(
			/invalid precise sum operands/,
		);
	});
	it("rejects corrupt prepared collation options while loading an artifact", () => {
		const output = inspect("String(x).localeCompare('a','sv')");
		const instruction = output.fn.instructions.find(
			(instruction) => instruction.opcode === "PREPARED_STRING_COMPARE",
		)!;
		const writer = new Writer();
		writer.u8(BYTECODE_OPERATIONS.indexOf(instruction.opcode));
		writer.i32(instruction.dst);
		writer.i32(instruction.left);
		writer.i32(instruction.right);
		writer.u32(instruction.stringIndex);
		writer.u8(instruction.options);
		const payload = Buffer.from(writer.finish());
		const bytes = Buffer.from(serializeCompilerArtifact(output.image));
		const offset = bytes.indexOf(payload);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(bytes.indexOf(payload, offset + payload.length)).toBe(-1);
		bytes[offset + payload.length - 1] = 255;
		expect(() => deserializeCompilerArtifact(bytes)).toThrow(/string collation plan/);
	});
	it.each([
		"String(x).localeCompare('a',x)",
		"String(x).localeCompare('a','en',x)",
		"String(x).localeCompare('a','en',{get numeric(){return x;}})",
		"String.prototype.localeCompare.call(x,'a','en',{numeric:true})",
		"String(x).localeCompare('a','en',{usage:'search'})",
		"String(x).localeCompare('a','en',{sensitivity:'invalid'})",
	])("retains generic collation obligations for %s", (expression) => {
		expect(inspect(expression).c.source).not.toContain(
			"mal_builtin_string_locale_compare_prepared(",
		);
	});
	it("retains mutable collation identity and option reentrancy", () => {
		expect(inspect("String(x).localeCompare('a','sv')", false).c.source).not.toContain(
			"mal_builtin_string_locale_compare_prepared(",
		);
		const output = inspectStaticValueFunction(
			"function probe(x){const options={numeric:false};const receiver={toString(){options.numeric=true;return '10';}};return String.prototype.localeCompare.call(receiver,x,'en',options);}globalThis.probe=probe;",
			"probe",
		);
		expect(output.c.source).not.toContain("mal_builtin_string_locale_compare_prepared(");
	});
	it("consumes private collation options while preserving unused property and extra argument effects", () => {
		const output = inspect(
			"String(x).localeCompare('a','en',{numeric:true,unused:x()},x())",
		);
		expect(output.structure.allocations).toBe(0);
		expect(output.structure.genericCalls).toBe(2);
		expect(
			output.core.filter((instruction) => instruction.opcode === "preparedStringCompare"),
		).toHaveLength(1);
	});
	it("propagates the prepared comparison's Number result into primitive consumers", () => {
		const output = inspect("Object(String(x).localeCompare('a','sv')).valueOf()");
		expect(output.structure.allocations).toBe(0);
		expect(
			output.core.some(
				(instruction) =>
					instruction.opcode === "callKnown" &&
					["Object", "Number.prototype.valueOf"].includes(
						instruction.attributes.operation as string,
					),
			),
		).toBe(false);
		expect(
			output.core.filter((instruction) => instruction.opcode === "preparedStringCompare"),
		).toHaveLength(1);
	});

	it.each(["replace", "replaceAll"])(
		"uses plain-string %s kernels while retaining callback work",
		(method) => {
			for (const expression of [
				`String(x).${method}('a', x)`,
				`'ab'.${method}(String(x), '$&')`,
				`'ab'.${method}('a', x)`,
			]) {
				const output = inspect(expression);
				expect(output.c.source).toContain("mal_builtin_string_replace_known(");
				expect(output.c.source).not.toContain(
					"mal_known_native_mal_builtin_string_prototype_replace",
				);
			}
			expect(inspect(`'ab'.${method}(x, 'c')`).c.source).toContain(
				"mal_vm_call_known_native(",
			);
			expect(inspect(`String(x).${method}('a', 'b')`, false).c.source).not.toContain(
				"mal_builtin_string_replace_known(",
			);
		},
	);
	it.each([
		"anchor",
		"big",
		"blink",
		"bold",
		"fixed",
		"fontcolor",
		"fontsize",
		"italics",
		"link",
		"small",
		"strike",
		"sub",
		"sup",
	])("folds legacy %s constants and directly builds dynamic strings", (method) => {
		expect(
			inspect(`'a<&'.${method}('b"c')`).core.some((op) => op.opcode === "callKnown"),
		).toBe(false);
		const output = inspect(`String(x).${method}(x)`);
		expect(output.c.source).toContain("mal_builtin_string_html_known(");
		expect(output.c.source).not.toContain(
			`mal_known_native_mal_builtin_string_prototype_${method}`,
		);
		expect(inspect(`String(x).${method}(x)`, false).c.source).not.toContain(
			"mal_builtin_string_html_known(",
		);
	});
	it.each([
		"encodeURI",
		"encodeURIComponent",
		"decodeURI",
		"decodeURIComponent",
		"escape",
		"unescape",
	])("lowers canonical %s on primitive strings", (operation) => {
		const helper = operation.startsWith("encode")
			? "encode"
			: operation.startsWith("decode")
				? "decode"
				: operation;
		const output = inspect(`${operation}(String(x))`);
		expect(output.c.source).toContain(`mal_builtin_uri_${helper}_known(`);
		const callback = operation
			.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
			.replace("_u_r_i", "_uri");
		expect(output.c.source).not.toContain(`mal_known_native_mal_builtin_${callback}`);
		expect(inspect(`${operation}(x)`).c.source).toContain("mal_vm_call_known_native(");
		expect(inspect(`${operation}(String(x))`, false).c.source).not.toContain(
			`mal_builtin_uri_${helper}_known(`,
		);
	});

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
				`mal_builtin_string_${helper}_known(`,
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
		expect(inspect("'e'.normalize('bad')").c.source).toContain("mal_vm_throw_error(");
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
			expect(
				inspect(`Number.${method}.call(null,x)`, false).structure.genericCalls,
			).toBeGreaterThan(0);
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

	it.each(fixedPrimitiveExpressions)(
		"folds the observable result of %s",
		(expression) => {
			const output = inspect(expression);
			expect(onlyConstantResults(output)).toBe(true);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			expect(output.structure.genericCalls).toBe(0);
		},
	);

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

	it.each(
		["isNaN", "isFinite", "isInteger", "isSafeInteger"].flatMap((predicate) =>
			[
				"new Number(x)",
				"new Boolean(x)",
				"new String(x)",
				"Object(1n)",
				"Object(Symbol.iterator)",
			].map((wrapper) => `Number.${predicate}(${wrapper})`),
		),
	)("discards the contained wrapper for %s", (expression) => {
		const output = inspect(expression);
		expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
		expect(
			output.core.some((operation) => operation.attributes.operation === "Object"),
		).toBe(false);
		expect(
			output.core.some(
				(operation) =>
					typeof operation.attributes.operation === "string" &&
					operation.attributes.operation.startsWith("Number.is"),
			),
		).toBe(false);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "createBoolean" && operation.attributes.value === false,
			),
		).toBe(true);
	});

	it.each(["===", "!=="])(
		"folds a contained wrapper's strict self-comparison %s",
		(operator) => {
			const output = inspectStaticValueFunction(
				`function probe(x) { const wrapper = new Number(x); return wrapper ${operator} wrapper; } globalThis.probe = probe;`,
				"probe",
			);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "createBoolean" &&
						operation.attributes.value === (operator === "==="),
				),
			).toBe(true);
		},
	);

	it.each([
		"Number.isFinite.call(new Number(x), 1)",
		"Number.isInteger(1, new String(x))",
	])(
		"discards a wrapper passed through an ignored predicate operand in %s",
		(expression) => {
			const output = inspect(expression);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "createBoolean" && operation.attributes.value === true,
				),
			).toBe(true);
		},
	);

	it("retains conversion before discarding a Number predicate's wrapper", () => {
		const output = inspect("Number.isFinite(new Number(x))");
		expect(
			output.core.some(
				(operation) =>
					operation.attributes.operation === "Number" &&
					operation.attributes.construct === false,
			),
		).toBe(true);
		const string = inspect("Number.isInteger(new String(x))");
		expect(
			string.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "tostring",
			),
		).toBe(true);
	});

	it("retains a wrapper whose identity escapes beside a predicate consumer", () => {
		const output = inspectStaticValueFunction(
			"function probe(x) { const wrapper = new Number(x); globalThis.wrapper = wrapper; return Number.isFinite(wrapper); } globalThis.probe = probe;",
			"probe",
		);
		expect(output.core.some((operation) => operation.attributes.construct)).toBe(true);
	});

	it("retains mutable constructor and predicate lookup around a wrapper", () => {
		const output = inspect("Number.isFinite(new Number(x))", false);
		expect(
			output.core.some(
				(operation) => operation.opcode === "construct" || operation.attributes.construct,
			),
		).toBe(true);
		expect(output.structure.genericLookups).toBeGreaterThan(0);
	});

	it.each(
		["new Number(x)", "new Boolean(x)", "new String(x)", "Object(BigInt(x))"].flatMap(
			(wrapper) => [
				...["+", "-", "~"].map((operator) => `${operator}(${wrapper})`),
				...[
					"+",
					"-",
					"*",
					"/",
					"%",
					"**",
					"&",
					"|",
					"^",
					"<<",
					">>",
					">>>",
					"<",
					"<=",
					">",
					">=",
				].map((operator) => `(${wrapper}) ${operator} x`),
			],
		),
	)("consumes a contained wrapper through primitive coercion in %s", (expression) => {
		const output = inspect(expression);
		expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
		expect(
			output.core.some((operation) => operation.attributes.operation === "Object"),
		).toBe(false);
	});

	it.each(
		["Boolean", "Number", "String", "BigInt", "isNaN", "isFinite"].flatMap((consumer) =>
			["new Number(x)", "new Boolean(x)", "new String(x)", "Object(BigInt(x))"].map(
				(wrapper) => `${consumer}(${wrapper})`,
			),
		),
	)(
		"eliminates wrapper input materialization for the exact conversion in %s",
		(expression) => {
			const output = inspect(expression);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
			expect(
				output.core.some((operation) => operation.attributes.operation === "Object"),
			).toBe(false);
		},
	);

	it.each(
		[
			"Math.abs",
			"Math.floor",
			"Math.ceil",
			"Math.round",
			"Math.trunc",
			"Math.sqrt",
			"Math.cbrt",
			"Math.sign",
			"Math.log",
			"Math.log2",
			"Math.log10",
			"Math.exp",
			"Math.sin",
			"Math.cos",
			"Math.tan",
			"Math.asin",
			"Math.acos",
			"Math.atan",
			"Math.sinh",
			"Math.cosh",
			"Math.tanh",
			"Math.asinh",
			"Math.acosh",
			"Math.atanh",
			"Math.log1p",
			"Math.expm1",
			"Math.fround",
			"Math.atan2",
			"Math.pow",
			"Math.imul",
			"Math.clz32",
			"Math.hypot",
			"Math.min",
			"Math.max",
			"Math.f16round",
		].flatMap((consumer) =>
			["new Number(x)", "new Boolean(x)", "new String(x)", "Object(BigInt(x))"].map(
				(wrapper) => `${consumer}(${wrapper}, 2)`,
			),
		),
	)("eliminates contained wrapper inputs to numeric Math calls in %s", (expression) => {
		const output = inspect(expression);
		expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
		expect(
			output.core.some((operation) => operation.attributes.operation === "Object"),
		).toBe(false);
	});

	it.each([
		"const wrapper = new Number(x); globalThis.wrapper = wrapper; return Math.abs(wrapper);",
		"const wrapper = new Number(x); wrapper[Symbol.toPrimitive] = () => 9; return Math.abs(wrapper);",
		"return Math.min(...[new Number(x)]);",
		"return Math.sumPrecise(new Number(x));",
	])(
		"retains wrapper materialization outside the numeric consumer proof in %s",
		(body) => {
			const output = inspectStaticValueFunction(
				`function probe(x) {${body}} globalThis.probe = probe;`,
				"probe",
			);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(true);
		},
	);

	it("retains mutable Math and wrapper prototype lookup", () => {
		const output = inspect("Math.abs(new Number(x))", false);
		expect(output.core.some((operation) => operation.opcode === "construct")).toBe(true);
		expect(output.structure.genericLookups).toBeGreaterThan(0);
	});

	it("retains ordinary ToString when String consumes a Symbol wrapper", () => {
		const output = inspect("String(Object(Symbol.iterator))");
		expect(
			output.core.some((operation) =>
				["String", "Object"].includes(operation.attributes.operation as string),
			),
		).toBe(false);
		expect(
			output.core.some(
				(operation) =>
					(operation.opcode === "unary" &&
						operation.attributes.operator === "tostring") ||
					operation.opcode === "builtinError",
			),
		).toBe(true);
	});

	it.each([
		"const wrapper=new Number(x);globalThis.wrapper=wrapper;return +wrapper;",
		"const wrapper=new Number(x);wrapper[Symbol.toPrimitive]=()=>99;return +wrapper;",
		"const wrapper=new Number(x);return wrapper+x(wrapper);",
		"const wrapper=new Number(x);return wrapper==x;",
		"const wrapper=new Number(x);return wrapper===x;",
	])(
		"retains wrapper identity when coercion cannot substitute its payload in %s",
		(body) => {
			const output = inspectStaticValueFunction(
				`function probe(x){${body}}globalThis.probe=probe;`,
				"probe",
			);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(true);
		},
	);

	it("retains mutable prototype dispatch for wrapper arithmetic", () => {
		const output = inspect("+new Number(x)", false);
		expect(output.core.some((operation) => operation.opcode === "construct")).toBe(true);
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
					operation.opcode === "callKnown" ||
					operation.opcode === "builtinError" ||
					operation.opcode === "mathUnaryNumber",
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
		for (const output of [
			inspect(`Math.${method}(x)`),
			inspect(`Math.${method}(+x)`, false),
		])
			expect(
				output.core.some((operation) => operation.opcode === "mathUnaryNumber"),
			).toBe(false);
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
	it.each(["0", "1", "2", "99", "-0", "4294967294"])(
		"eliminates a contained String wrapper for the numeric property %s",
		(index) => {
			const expression = `new String(x)[${index}]`;
			const output = inspect(expression);
			expect(output.core.some((operation) => operation.attributes.construct)).toBe(false);
			expect(
				output.core.filter(
					(operation) =>
						operation.opcode === "unary" && operation.attributes.operator === "tostring",
				),
			).toHaveLength(1);
			expect(
				inspect(expression, false).fn.instructions.some(
					(operation) => operation.opcode === "CONSTRUCT",
				),
			).toBe(true);
		},
	);
	it("retains String wrapper identity across key coercion and escape", () => {
		const output = inspectStaticValueFunction(
			"function probe(x){const wrapper=new String('abc');const key={toString(){x(wrapper);return '0';}};return wrapper[key];}globalThis.probe=probe;",
			"probe",
		);
		expect(output.core.some((operation) => operation.attributes.construct)).toBe(true);
	});
});
