export const numericCallCases = [
	["Boolean", "undefined", "null"],
	["Number", "undefined", "123n"],
	["BigInt", "undefined", "'0xff'"],
	["Number.isFinite", "undefined", "Infinity"],
	["Number.isInteger", "undefined", "1.5"],
	["Number.isNaN", "undefined", "NaN"],
	["Number.isSafeInteger", "undefined", "9007199254740992"],
	["isFinite", "undefined", "null"],
	["isNaN", "undefined", "'x'"],
	["parseInt", "undefined", "'  -0xfz'"],
	["parseFloat", "undefined", "'1.25e+2x'"],
	["Number.parseInt", "undefined", "'-0',10"],
	["Number.parseFloat", "undefined", "'1.25e+2x'"],
	["Boolean.prototype.valueOf", "false", ""],
	["Boolean.prototype.toString", "false", ""],
	["Number.prototype.valueOf", "-0", ""],
	["Number.prototype.toString", "255", "16"],
	["Number.prototype.toFixed", "1.25", "2"],
	["Number.prototype.toPrecision", "1.005", "3"],
	["Number.prototype.toExponential", "1.25", "1"],
	["BigInt.asIntN", "undefined", "8,255n"],
	["BigInt.asUintN", "undefined", "8,-1n"],
	["BigInt.prototype.valueOf", "17n", ""],
	["BigInt.prototype.toString", "-255n", "16"],
	["Symbol.keyFor", "undefined", "Symbol.iterator"],
	["Symbol.prototype.valueOf", "Symbol.iterator", ""],
	["Symbol.prototype[Symbol.toPrimitive]", "Symbol.iterator", "'string'"],
	["Symbol.prototype.toString", "Symbol.iterator", ""],
	["Math.abs", "undefined", "-3"],
	["Math.acos", "undefined", "1"],
	["Math.acosh", "undefined", "1"],
	["Math.asin", "undefined", "-0"],
	["Math.asinh", "undefined", "-Infinity"],
	["Math.atan", "undefined", "-0"],
	["Math.atan2", "undefined", "-0,1"],
	["Math.atanh", "undefined", "-1"],
	["Math.cbrt", "undefined", "-0"],
	["Math.ceil", "undefined", "-0.1"],
	["Math.clz32", "undefined", "1"],
	["Math.cos", "undefined", "0"],
	["Math.cosh", "undefined", "-Infinity"],
	["Math.exp", "undefined", "-Infinity"],
	["Math.expm1", "undefined", "-0"],
	["Math.f16round", "undefined", "1.1"],
	["Math.floor", "undefined", "0.1"],
	["Math.fround", "undefined", "1.1"],
	["Math.hypot", "undefined", "NaN,Infinity,2"],
	["Math.imul", "undefined", "0xffffffff,5"],
	["Math.log", "undefined", "-0"],
	["Math.log10", "undefined", "Infinity"],
	["Math.log1p", "undefined", "-0"],
	["Math.log2", "undefined", "-1"],
	["Math.max", "undefined", "-0,0"],
	["Math.min", "undefined", "0,-0"],
	["Math.pow", "undefined", "NaN,0"],
	["Math.round", "undefined", "-0.5"],
	["Math.sign", "undefined", "-0"],
	["Math.sin", "undefined", "-0"],
	["Math.sinh", "undefined", "-0"],
	["Math.sqrt", "undefined", "-0"],
	["Math.tan", "undefined", "-0"],
	["Math.tanh", "undefined", "-Infinity"],
	["Math.trunc", "undefined", "-0.5"],
] as const;

export const dynamicNumericCallCases: ReadonlyArray<readonly [string, string, string]> = [
	...numericCallCases
		.filter(([callee]) => callee.startsWith("Math."))
		.map(([callee]): readonly [string, string, string] => [
			callee,
			"undefined",
			callee === "Math.hypot"
				? "value,3,4"
				: ["Math.pow", "Math.imul"].includes(callee)
					? "value,3"
					: callee === "Math.atan2"
						? "value,1"
						: ["Math.min", "Math.max"].includes(callee)
							? "value,0"
							: "value",
		]),
	["Boolean", "undefined", "value"],
	["Number", "undefined", "value"],
	["Boolean.prototype.valueOf", "!!value", ""],
	["Boolean.prototype.toString", "!!value", ""],
	["Number.prototype.valueOf", "value", ""],
	["Number.prototype.toString", "value", "16"],
	["Number.prototype.toFixed", "value", "2"],
	["Number.prototype.toExponential", "value", "1"],
	["Number.prototype.toPrecision", "value", "3"],
	["Number.isNaN", "undefined", "value"],
	["Number.isFinite", "undefined", "value"],
	["Number.isInteger", "undefined", "value"],
	["Number.isSafeInteger", "undefined", "value"],
	["isNaN", "undefined", "value"],
	["isFinite", "undefined", "value"],
	["parseInt", "undefined", "'123',value"],
	["Number.parseInt", "undefined", "'123',value"],
	["BigInt.asIntN", "undefined", "value,-1n"],
	["BigInt.asUintN", "undefined", "value,-1n"],
];

export const dynamicNumericProfiles = [
	"typed",
	"consumer",
	"escape",
	"loop",
	"suspension",
	"apply",
	"unused",
] as const;

export function dynamicNumericCallSource(
	[callee, receiver, args]: readonly [string, string, string],
	profile: (typeof dynamicNumericProfiles)[number],
	name = "probe",
) {
	const call = `${callee}.call(${receiver}${args ? `,${args}` : ""})`;
	let body: string;
	switch (profile) {
		case "typed":
			body = `return ${call};`;
			break;
		case "consumer":
			body = `return typeof ${call};`;
			break;
		case "escape":
			body = `const result=${call};effect(result);return result;`;
			break;
		case "loop":
			body = `let result;for(let i=0;i<n;i++){result=${call};effect(result);}return result;`;
			break;
		case "suspension":
			body = `yield effect(value);return ${call};`;
			break;
		case "apply":
			body = `return Reflect.apply(${callee},${receiver},[${args}]);`;
			break;
		case "unused":
			body = `${call};return 17;`;
			break;
	}
	return `function${profile === "suspension" ? "*" : ""} ${name}(x,effect,n){const value=+x;${body}}globalThis.${name}=${name};`;
}
