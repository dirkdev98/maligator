const results = [];
function record(label, action) {
	try {
		const value = action(),
			kind = typeof value;
		results.push(
			label +
				":" +
				kind +
				":" +
				(kind === "number"
					? Object.is(value, -0)
						? "-0"
						: String(value)
					: kind === "bigint"
						? String(value)
						: kind === "symbol"
							? value.toString()
							: JSON.stringify(value)),
		);
	} catch (error) {
		results.push(label + ":error:" + error.name);
	}
}

let effects = 0;
globalThis.sink = () => effects++;
const parameter0 = "abcdefgh";
function parameterProbe0(x) {
	globalThis.sink(parameter0, x);
	return parameter0.charAt(+x);
}
globalThis.parameterProbe0 = parameterProbe0;
record("String.prototype.charAt", () => globalThis.parameterProbe0(3));
const parameter1 = "abcdefgh";
function parameterProbe1(x) {
	globalThis.sink(parameter1, x);
	return parameter1.charCodeAt(+x);
}
globalThis.parameterProbe1 = parameterProbe1;
record("String.prototype.charCodeAt", () => globalThis.parameterProbe1(3));
const parameter2 = "abcdefgh";
function parameterProbe2(x) {
	globalThis.sink(parameter2, x);
	return parameter2.codePointAt(+x);
}
globalThis.parameterProbe2 = parameterProbe2;
record("String.prototype.codePointAt", () => globalThis.parameterProbe2(3));
const parameter3 = "abcdefgh";
function parameterProbe3(x) {
	globalThis.sink(parameter3, x);
	return parameter3.at(+x);
}
globalThis.parameterProbe3 = parameterProbe3;
record("String.prototype.at", () => globalThis.parameterProbe3(3));
const parameter4 = "abcdefgh";
function parameterProbe4(x) {
	globalThis.sink(parameter4, x);
	return parameter4.indexOf(String(x));
}
globalThis.parameterProbe4 = parameterProbe4;
record("String.prototype.indexOf", () => globalThis.parameterProbe4(3));
const parameter5 = "abcdefgh";
function parameterProbe5(x) {
	globalThis.sink(parameter5, x);
	return parameter5.lastIndexOf(String(x));
}
globalThis.parameterProbe5 = parameterProbe5;
record("String.prototype.lastIndexOf", () => globalThis.parameterProbe5(3));
const parameter6 = "abcdefgh";
function parameterProbe6(x) {
	globalThis.sink(parameter6, x);
	return parameter6.includes(String(x));
}
globalThis.parameterProbe6 = parameterProbe6;
record("String.prototype.includes", () => globalThis.parameterProbe6(3));
const parameter7 = "abcdefgh";
function parameterProbe7(x) {
	globalThis.sink(parameter7, x);
	return parameter7.startsWith(String(x));
}
globalThis.parameterProbe7 = parameterProbe7;
record("String.prototype.startsWith", () => globalThis.parameterProbe7(3));
const parameter8 = "abcdefgh";
function parameterProbe8(x) {
	globalThis.sink(parameter8, x);
	return parameter8.endsWith(String(x));
}
globalThis.parameterProbe8 = parameterProbe8;
record("String.prototype.endsWith", () => globalThis.parameterProbe8(3));
const parameter9 = "abcdefgh";
function parameterProbe9(x) {
	globalThis.sink(parameter9, x);
	return parameter9.slice(+x, 6);
}
globalThis.parameterProbe9 = parameterProbe9;
record("String.prototype.slice", () => globalThis.parameterProbe9(3));
const parameter10 = "abcdefgh";
function parameterProbe10(x) {
	globalThis.sink(parameter10, x);
	return parameter10.substring(+x, 6);
}
globalThis.parameterProbe10 = parameterProbe10;
record("String.prototype.substring", () => globalThis.parameterProbe10(3));
const parameter11 = "abcdefgh";
function parameterProbe11(x) {
	globalThis.sink(parameter11, x);
	return parameter11.substr(+x, 6);
}
globalThis.parameterProbe11 = parameterProbe11;
record("String.prototype.substr", () => globalThis.parameterProbe11(3));
const parameter12 = 2;
function parameterProbe12(x) {
	globalThis.sink(parameter12, x);
	return (+x).toFixed(parameter12);
}
globalThis.parameterProbe12 = parameterProbe12;
record("Number.prototype.toFixed", () => globalThis.parameterProbe12(3));
const parameter13 = 2;
function parameterProbe13(x) {
	globalThis.sink(parameter13, x);
	return (+x).toExponential(parameter13);
}
globalThis.parameterProbe13 = parameterProbe13;
record("Number.prototype.toExponential", () => globalThis.parameterProbe13(3));
const parameter14 = 2;
function parameterProbe14(x) {
	globalThis.sink(parameter14, x);
	return (+x).toPrecision(parameter14);
}
globalThis.parameterProbe14 = parameterProbe14;
record("Number.prototype.toPrecision", () => globalThis.parameterProbe14(3));
const parameter15 = 16;
function parameterProbe15(x) {
	globalThis.sink(parameter15, x);
	return (+x).toString(parameter15);
}
globalThis.parameterProbe15 = parameterProbe15;
record("Number.prototype.toString", () => globalThis.parameterProbe15(3));
const parameter16 = 8;
function parameterProbe16(x) {
	globalThis.sink(parameter16, x);
	return BigInt.asIntN(parameter16, x);
}
globalThis.parameterProbe16 = parameterProbe16;
record("BigInt.asIntN", () => globalThis.parameterProbe16(258n));
const parameter17 = 8;
function parameterProbe17(x) {
	globalThis.sink(parameter17, x);
	return BigInt.asUintN(parameter17, x);
}
globalThis.parameterProbe17 = parameterProbe17;
record("BigInt.asUintN", () => globalThis.parameterProbe17(258n));
const parameter18 = 16;
function parameterProbe18(x) {
	globalThis.sink(parameter18, x);
	return BigInt(x).toString(parameter18);
}
globalThis.parameterProbe18 = parameterProbe18;
record("BigInt.prototype.toString", () => globalThis.parameterProbe18(3));
const parameter19 = 16;
function parameterProbe19(x) {
	globalThis.sink(parameter19, x);
	return parseInt(String(x), parameter19);
}
globalThis.parameterProbe19 = parameterProbe19;
record("parseInt", () => globalThis.parameterProbe19(3));
const parameter20 = "12.5suffix";
function parameterProbe20(x) {
	globalThis.sink(parameter20, x);
	return parseFloat(parameter20, x);
}
globalThis.parameterProbe20 = parameterProbe20;
record("parseFloat", () => globalThis.parameterProbe20(3));
const parameter21 = 3;
function parameterProbe21(x) {
	globalThis.sink(parameter21, x);
	return String(x).repeat(parameter21);
}
globalThis.parameterProbe21 = parameterProbe21;
record("String.prototype.repeat", () => globalThis.parameterProbe21(3));
const parameter22 = 12;
function parameterProbe22(x) {
	globalThis.sink(parameter22, x);
	return String(x).padStart(parameter22, "_");
}
globalThis.parameterProbe22 = parameterProbe22;
record("String.prototype.padStart", () => globalThis.parameterProbe22(3));
const parameter23 = 12;
function parameterProbe23(x) {
	globalThis.sink(parameter23, x);
	return String(x).padEnd(parameter23, "_");
}
globalThis.parameterProbe23 = parameterProbe23;
record("String.prototype.padEnd", () => globalThis.parameterProbe23(3));
const parameter24 = "NFD";
function parameterProbe24(x) {
	globalThis.sink(parameter24, x);
	return String(x).normalize(parameter24);
}
globalThis.parameterProbe24 = parameterProbe24;
record("String.prototype.normalize", () => globalThis.parameterProbe24(3));
const parameter25 = "en-US";
function parameterProbe25(x) {
	globalThis.sink(parameter25, x);
	return String(x).toLocaleUpperCase(parameter25);
}
globalThis.parameterProbe25 = parameterProbe25;
record("String.prototype.toLocaleUpperCase", () => globalThis.parameterProbe25(3));
const parameter26 = "en-US";
function parameterProbe26(x) {
	globalThis.sink(parameter26, x);
	return String(x).toLocaleLowerCase(parameter26);
}
globalThis.parameterProbe26 = parameterProbe26;
record("String.prototype.toLocaleLowerCase", () => globalThis.parameterProbe26(3));
const parameter27 = 2;
function parameterProbe27(x) {
	globalThis.sink(parameter27, x);
	return Math.pow(+x, parameter27);
}
globalThis.parameterProbe27 = parameterProbe27;
record("Math.pow", () => globalThis.parameterProbe27(3));
const parameter28 = 2;
function parameterProbe28(x) {
	globalThis.sink(parameter28, x);
	return Math.atan2(+x, parameter28);
}
globalThis.parameterProbe28 = parameterProbe28;
record("Math.atan2", () => globalThis.parameterProbe28(3));
const parameter29 = 3;
function parameterProbe29(x) {
	globalThis.sink(parameter29, x);
	return Math.hypot(+x, parameter29);
}
globalThis.parameterProbe29 = parameterProbe29;
record("Math.hypot", () => {
	const result = globalThis.parameterProbe29(3);
	if (!(Math.abs(result - 4.242640687119285) <= 8 * Number.EPSILON))
		throw new Error("Incorrect hypot approximation");
	return "within tolerance";
});
const parameter30 = 0;
function parameterProbe30(x) {
	globalThis.sink(parameter30, x);
	return Math.max(+x, parameter30);
}
globalThis.parameterProbe30 = parameterProbe30;
record("Math.max", () => globalThis.parameterProbe30(3));
const parameter31 = 0;
function parameterProbe31(x) {
	globalThis.sink(parameter31, x);
	return Math.min(+x, parameter31);
}
globalThis.parameterProbe31 = parameterProbe31;
record("Math.min", () => globalThis.parameterProbe31(3));
const parameter32 = 65;
function parameterProbe32(x) {
	globalThis.sink(parameter32, x);
	return String.fromCharCode(parameter32, +x);
}
globalThis.parameterProbe32 = parameterProbe32;
record("String.fromCharCode", () => globalThis.parameterProbe32(3));
const parameter33 = 65;
function parameterProbe33(x) {
	globalThis.sink(parameter33, x);
	return String.fromCodePoint(parameter33, +x);
}
globalThis.parameterProbe33 = parameterProbe33;
record("String.fromCodePoint", () => globalThis.parameterProbe33(3));
if (results.some((result) => result.includes(":error:")))
	throw new Error("Unexpected positive parameter failure");

function before(x) {
	return (+x).toFixed(lateDigits);
}
record("tdz-before", () => before(2));
const lateDigits = 2;
record("tdz-after", () => before(2));
function capture(fail) {
	globalThis.early = probe;
	if (fail) return probe;
	const digits = 2;
	return probe;
	function probe(x) {
		return (+x).toFixed(digits);
	}
}
const uninitialized = capture(true),
	initialized = capture(false);
record("captured-tdz", () => uninitialized(3));
record("captured-initialized", () => initialized(3));
const radix = 16,
	width = 8,
	digits = 2,
	text = "abcdef";
function ordered(input) {
	return input.toFixed(digits, globalThis.sink("extra"));
}
record("coercion-before-call", () =>
	ordered({
		toFixed() {
			effects += 10;
			return "custom";
		},
	}),
);
function numeric(input) {
	return (+input).toFixed(digits);
}
record("numeric-coercion", () =>
	numeric({
		valueOf() {
			effects += 20;
			return 12.5;
		},
	}),
);
record("numeric-coercion-error", () =>
	numeric({
		valueOf() {
			effects += 30;
			throw new RangeError("input");
		},
	}),
);
function widths(input) {
	return BigInt.asIntN(width, input);
}
record("bigint-primitive", () => widths(258n));
record("bigint-coercion", () =>
	widths({
		valueOf() {
			effects += 40;
			return 258n;
		},
	}),
);
record("bigint-number-reject", () => widths(258));
function format(input) {
	return BigInt.prototype.toString.call(input, radix);
}
record("bigint-format", () => format(258n));
record("bigint-wrapper", () => format(Object(258n)));
record("bigint-brand-reject", () => format(258));
function position(input) {
	return text.charCodeAt(input);
}
for (const input of [-Infinity, -1, -0, 0, 5, 6, NaN, Infinity])
	record("position:" + String(input), () => position(input));
record("position-effect", () =>
	position({
		valueOf() {
			effects += 50;
			return 2;
		},
	}),
);
let mutableDigits = 2;
globalThis.changeDigits = (x) => (mutableDigits = x);
function mutable(x) {
	globalThis.changeDigits(3);
	return (+x).toFixed(mutableDigits);
}
record("mutable-parameter", () => mutable(12.5));
const wrapperDigits = {
	valueOf() {
		effects += 60;
		return 2;
	},
};
function wrapper(x) {
	return (+x).toFixed(wrapperDigits);
}
record("wrapper-parameter", () => wrapper(12.5));
const baseFormat = Number.prototype.toFixed;
let changed = false;
try {
	Number.prototype.toFixed = function () {
		effects += 70;
		return "overridden";
	};
	changed = Number.prototype.toFixed !== baseFormat;
} catch {}
if (changed) {
	if (numeric(12.5) !== "overridden") throw new Error("Lost overridden number formatter");
	Number.prototype.toFixed = baseFormat;
	effects -= 70;
}
record("restored-format", () => numeric(12.5));
console.log(JSON.stringify(results));
console.log(effects);
