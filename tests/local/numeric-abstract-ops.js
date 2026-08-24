const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function throws(errorType, fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof errorType;
	}
	return false;
}

function forceGc() {
	if (typeof $262 !== "undefined") $262.gc();
	else if (typeof gc === "function") gc();
}

check("integer NaN", (12.4).toFixed(NaN) === "12");
check("integer negative zero", "x".repeat(-0) === "");
check("integer truncates toward zero", "x".repeat(2.9) === "xx");
check(
	"string to number fast integer and fallback grammar",
	Number("17") === 17 &&
		Number("+17") === 17 &&
		Number("-23") === -23 &&
		Object.is(Number("-0"), -0) &&
		Number(" 42 ") === 42 &&
		Number("9007199254740991") === 9007199254740991 &&
		Number("9007199254740993") === 9007199254740992 &&
		Number("1.25e2") === 125 &&
		Number("0".repeat(70)) === 0 &&
		Number.isNaN(Number("12x")),
);
check(
	"Boolean call, construct, and receiver methods",
	Boolean(0) === false &&
		Boolean(1) === true &&
		Boolean(new Boolean(false)) === true &&
		new Boolean(false).valueOf() === false &&
		new Boolean(true).toString() === "true" &&
		Boolean.prototype.toString.call(false) === "false",
);
check(
	"Number call and construct preserve primitive values",
	Number() === 0 &&
		Number(42) === 42 &&
		Number(1n) === 1 &&
		Number(Object(1n)) === 1 &&
		Object.is(Number(-0), -0) &&
		new Number(42).valueOf() === 42 &&
		Object.is(new Number(-0).valueOf(), -0),
);
const numberBigIntCoercionOrder = [];
const numberFromBigIntObject = Number({
	valueOf() {
		numberBigIntCoercionOrder.push("valueOf");
		forceGc();
		return 2n;
	},
	toString() {
		numberBigIntCoercionOrder.push("toString");
		return "99";
	},
});
check(
	"Number object coercion accepts BigInt after ordered forced-GC ToNumeric",
	numberFromBigIntObject === 2 && numberBigIntCoercionOrder.join(",") === "valueOf",
);
function constructWithGcPrototype(constructor, argument, label) {
	const newTarget = new Proxy(function () {}, {
		get(target, key, receiver) {
			if (key === "prototype") {
				const prototype = { label };
				forceGc();
				return prototype;
			}
			return Reflect.get(target, key, receiver);
		},
	});
	return Reflect.construct(constructor, [argument], newTarget);
}
const gcBooleanWrapper = constructWithGcPrototype(Boolean, true, "boolean");
const gcNumberWrapper = constructWithGcPrototype(Number, 42, "number");
check(
	"Boolean and Number constructors root custom prototypes",
	Object.getPrototypeOf(gcBooleanWrapper).label === "boolean" &&
		Boolean.prototype.valueOf.call(gcBooleanWrapper) === true &&
		Object.getPrototypeOf(gcNumberWrapper).label === "number" &&
		Number.prototype.valueOf.call(gcNumberWrapper) === 42,
);
check(
	"Number static predicates and parsers",
	Number.isNaN(NaN) &&
		!Number.isNaN("NaN") &&
		Number.isFinite(42) &&
		!Number.isFinite("42") &&
		Number.isInteger(-0) &&
		!Number.isInteger(1.5) &&
		Number.isSafeInteger(Number.MAX_SAFE_INTEGER) &&
		!Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1) &&
		Number.parseInt("ff", 16) === 255 &&
		Number.parseFloat("  -12.5tail") === -12.5 &&
		Number.parseFloat("1.e2tail") === 100 &&
		Number.parseFloat(".5e+") === 0.5 &&
		Number.parseFloat("0x10") === 0 &&
		Number.parseFloat("+Infinity-tail") === Infinity &&
		Object.is(Number.parseFloat("-0tail"), -0) &&
		Number.parseFloat({
			toString() {
				return String.fromCharCode(49, 50, 46, 53, 116, 97, 105, 108);
			},
		}) === 12.5,
);
check(
	"Number.parseInt roots a fresh ToString result across radix coercion",
	Number.parseInt(
		{
			toString() {
				return String.fromCharCode(49, 50, 51, 52, 53);
			},
		},
		{
			valueOf() {
				forceGc();
				return 10;
			},
		},
	) === 12345,
);
check(
	"Number shortest decimal formatting",
	String(Number.MIN_VALUE) === "5e-324" &&
		String(Number.MAX_VALUE) === "1.7976931348623157e+308" &&
		String(-(553675004028197 / 16)) === "-34604687751762.312" &&
		String(553675004028199 / 16) === "34604687751762.438" &&
		String(1e20) === "100000000000000000000" &&
		String(1e21) === "1e+21" &&
		String(1e-6) === "0.000001" &&
		String(1e-7) === "1e-7",
);
check(
	"Number fixed, exponential, and precision formatting",
	(2.5).toFixed(0) === "3" &&
		(1.25).toFixed(1) === "1.3" &&
		(1.005).toFixed(2) === "1.00" &&
		(-42).toFixed(2) === "-42.00" &&
		(-0).toFixed(2) === "0.00" &&
		Number.MAX_SAFE_INTEGER.toFixed(3) === "9007199254740991.000" &&
		(1000000000000000100).toFixed(2) === "1000000000000000128.00" &&
		(77).toExponential() === "7.7e+1" &&
		(25).toExponential(0) === "3e+1" &&
		(123).toPrecision(5) === "123.00" &&
		Number.MIN_VALUE.toPrecision(5) === "4.9407e-324",
);
check(
	"Number locale and safe-integer radix formatting",
	(1234.5).toLocaleString() === "1,234.5" &&
		(255).toString(16) === "ff" &&
		Number.MAX_SAFE_INTEGER.toString(2) ===
			"11111111111111111111111111111111111111111111111111111",
);
const defaultNumberFormatter = new Intl.NumberFormat();
let defaultLocaleMatchesConstructor = true;
for (const value of [-0, 0.0001, 1.2345, 999.9999, 1234567.89, Number.MAX_VALUE]) {
	defaultLocaleMatchesConstructor &&=
		value.toLocaleString() === defaultNumberFormatter.format(value);
}
check(
	"Number default locale fast path matches Intl.NumberFormat",
	defaultLocaleMatchesConstructor &&
		(-0).toLocaleString() === "-0" &&
		(1.2345).toLocaleString() === "1.235" &&
		(999.9999).toLocaleString() === "1,000",
);
const customNumberLocaleOptions = {
	maximumFractionDigits: 2,
	useGrouping: false,
};
const customNumberFormatter = new Intl.NumberFormat("de-DE", customNumberLocaleOptions);
check(
	"Number custom locale and options retain the generic plan",
	(1234.567).toLocaleString("de-DE", customNumberLocaleOptions) === "1234,57" &&
		(1234.567).toLocaleString("de-DE", customNumberLocaleOptions) ===
			customNumberFormatter.format(1234.567),
);

function coercibleMathValue(order, name, value) {
	return {
		valueOf() {
			order.push(name);
			return value;
		},
	};
}
const minOrder = [];
const minResult = Math.min(
	coercibleMathValue(minOrder, "first", NaN),
	coercibleMathValue(minOrder, "second", 4),
	coercibleMathValue(minOrder, "third", -0),
);
const maxOrder = [];
const maxResult = Math.max(
	coercibleMathValue(maxOrder, "first", NaN),
	coercibleMathValue(maxOrder, "second", -4),
	coercibleMathValue(maxOrder, "third", 0),
);
check(
	"Math min and max coerce every argument before returning NaN",
	Number.isNaN(minResult) &&
		minOrder.join(",") === "first,second,third" &&
		Number.isNaN(maxResult) &&
		maxOrder.join(",") === "first,second,third",
);
check(
	"Math min and max preserve empty and signed-zero results",
	Math.min() === Infinity &&
		Math.max() === -Infinity &&
		Object.is(Math.min(0, -0, 0), -0) &&
		Object.is(Math.max(-0, 0, -0), 0),
);
const hypotOrder = [];
const hypotResult = Math.hypot(
	coercibleMathValue(hypotOrder, "first", NaN),
	coercibleMathValue(hypotOrder, "second", Infinity),
	coercibleMathValue(hypotOrder, "third", 3),
);
const wideHypot = [3, 4];
while (wideHypot.length < 24) wideHypot.push(0);
check(
	"Math hypot preserves coercion order, Infinity priority, and heap spill",
	hypotResult === Infinity &&
		hypotOrder.join(",") === "first,second,third" &&
		Math.hypot(...wideHypot) === 5,
);
const smallHypotOrder = [];
check(
	"Math hypot common arities preserve coercion and edge results",
	Math.hypot(
		coercibleMathValue(smallHypotOrder, "first", 3),
		coercibleMathValue(smallHypotOrder, "second", 4),
	) === 5 &&
		smallHypotOrder.join(",") === "first,second" &&
		Object.is(Math.hypot(), 0) &&
		Object.is(Math.hypot(-0), 0) &&
		Math.hypot(NaN, Infinity) === Infinity &&
		Number.isNaN(Math.hypot(NaN, 1)),
);
check(
	"Math sumPrecise keeps exact small accumulations",
	Math.sumPrecise([1, 1e100, 1, -1e100, 3.5, -0]) === 5.5 &&
		Object.is(Math.sumPrecise([]), -0),
);
const minimumBinary = Number.MIN_VALUE.toString(2);
check(
	"Number arbitrary-radix formatting is shortest and covers binary boundaries",
	(0.1).toString(3) === "0.0022002200220022002200220022002201" &&
		Math.PI.toString(16) === "3.243f6a8885a3" &&
		(9007199254740992).toString(16) === "20000000000000" &&
		minimumBinary.length === 1076 &&
		minimumBinary.startsWith("0.") &&
		minimumBinary.endsWith("1"),
);
const radixSpecBits = new DataView(new ArrayBuffer(8));
radixSpecBits.setUint32(0, 0xa20e9fd5, true);
radixSpecBits.setUint32(4, 0x4f74e2cf, true);
const radixSpecValue = radixSpecBits.getFloat64(0, true);
check(
	"Number radix formatting selects the shortest round-tripping candidate",
	radixSpecValue.toString(3) === "201200221102210002021221110210012" + "0".repeat(124),
);
check("repeat negative fraction becomes zero", "x".repeat(-0.5) === "");
check(
	"integer infinity range",
	throws(RangeError, () => (1).toFixed(Infinity)),
);
check(
	"integer huge magnitude range",
	throws(RangeError, () => (1).toPrecision(1e100)),
);

check("string negative relative index", "abcdef".slice(-3, -1) === "de");
check("string at truncates", "abc".at(-1.9) === "c" && "abc".at(Infinity) === undefined);
check("string positions do not count from end", "abc".startsWith("b", -2) === false);
check("array negative relative index", [1, 2, 3, 4].slice(-2)[0] === 3);
check("array at infinity", [1, 2, 3].at(Infinity) === undefined);

function indexedLoad(object, key) {
	return object[key];
}

const indexed = [10, 20];
indexed[1.5] = 15;
const indexedSymbol = Symbol("indexed");
indexed[indexedSymbol] = 30;
let indexedCoercions = 0;
const indexedObjectKey = {
	[Symbol.toPrimitive]() {
		indexedCoercions++;
		return "0";
	},
};
check(
	"guarded numeric property key",
	indexedLoad(indexed, 1) === 20 &&
		indexedLoad(indexed, -0) === 10 &&
		indexedLoad(indexed, 1.5) === 15 &&
		indexedLoad(indexed, "1") === 20 &&
		indexedLoad(indexed, indexedSymbol) === 30 &&
		indexedLoad(indexed, indexedObjectKey) === 10 &&
		indexedCoercions === 1,
);

function indexedStore(object, key, value) {
	object[key] = value;
	return value;
}

const indexedStored = [];
const indexedStoreOrder = [];
indexedStore(indexedStored, 0, 10);
indexedStore(
	indexedStored,
	{
		[Symbol.toPrimitive]() {
			indexedStoreOrder.push("key");
			return "2";
		},
	},
	(indexedStoreOrder.push("value"), 30),
);
check(
	"guarded numeric property store",
	indexedStored[0] === 10 &&
		indexedStored[2] === 30 &&
		indexedStoreOrder.join(",") === "value,key",
);

function fusedArithmetic(a, b, c) {
	return a * b + c;
}

check("fused numeric arithmetic", fusedArithmetic(2, 3, 4) === 10);
check("fused bigint fallback", fusedArithmetic(2n, 3n, 4n) === 10n);
const fusionOrder = [];
function coercibleNumber(name, value) {
	return {
		valueOf() {
			fusionOrder.push(name);
			return value;
		},
	};
}
check(
	"fused arithmetic coercion order",
	fusedArithmetic(
		coercibleNumber("left", 2),
		coercibleNumber("right", 3),
		coercibleNumber("outer", 4),
	) === 10 && fusionOrder.join(",") === "left,right,outer",
);

function recursiveNumeric(value, depth, recurse) {
	const alias = value;
	if (depth === 0) return alias * alias;
	return recurse(depth === 2 ? "3" : alias - 1, depth - 1, recurse);
}
check(
	"recursive numeric entry promotion and fallback",
	recursiveNumeric(5, 3, recursiveNumeric) === 4 &&
		recursiveNumeric(4n, 0, recursiveNumeric) === 16n,
);

let inheritedScalarWrites = 0;
Object.defineProperty(Object.prototype, "freshScalarKey", {
	configurable: true,
	get() {
		return 41;
	},
	set() {
		inheritedScalarWrites++;
	},
});
function inheritedScalarStore() {
	const object = { own: 1 };
	object.freshScalarKey = 9;
	return object.freshScalarKey === 41 && !Object.hasOwn(object, "freshScalarKey");
}
check(
	"mutable scalar replacement preserves inherited setters",
	inheritedScalarStore() && inheritedScalarWrites === 1,
);
delete Object.prototype.freshScalarKey;

const typed = new Uint8Array([1, 2, 3, 4]);
check("typed array negative relative index", typed.slice(-2)[0] === 3);
check("typed array at infinity", typed.at(Infinity) === undefined);

const slicedBuffer = new Uint8Array(new Uint8Array([7, 8, 9, 10]).buffer.slice(-2));
check(
	"array buffer negative relative index",
	slicedBuffer.length === 2 && slicedBuffer[0] === 9,
);

check("string split infinity limit", "a,b".split(",", Infinity).length === 0);
check("regexp split infinity limit", "a,b".split(/,/, Infinity).length === 0);
check("split NaN limit", "a,b".split(",", NaN).length === 0);
check("split negative limit wraps", "a,b".split(",", -1).length === 2);
check("split explicit undefined limit", "a,b".split(",", undefined).length === 2);

check(
	"uint32 conversion",
	Math.clz32(NaN) === 32 &&
		Math.imul(Infinity, 3) === 0 &&
		Math.imul(4294967295, 2) === -2,
);

function int32BitwiseAnd(left, right) {
	return left & right;
}

check(
	"int32 bitwise AND",
	int32BitwiseAnd(-1, 1) === 1 &&
		int32BitwiseAnd(-2147483648, 31) === 0 &&
		int32BitwiseAnd(2147483647, -2147483648) === 0,
);
check(
	"int32 decimal formatting",
	String(0) === "0" &&
		String(-1) === "-1" &&
		String(-2147483648) === "-2147483648" &&
		String(2147483647) === "2147483647",
);
check(
	"array length infinity",
	throws(RangeError, () => new Array(Infinity)),
);
check(
	"array length assignment infinity",
	throws(RangeError, () => ([].length = Infinity)),
);
check(
	"array buffer allocation cap",
	throws(RangeError, () => new ArrayBuffer(Number.MAX_SAFE_INTEGER)),
);

check(
	"uint16 modular conversion",
	String.fromCharCode(NaN).charCodeAt(0) === 0 &&
		String.fromCharCode(Infinity).charCodeAt(0) === 0 &&
		String.fromCharCode(0x10041).charCodeAt(0) === 65,
);
const codePointOrder = [];
const coercedCodePoints = String.fromCodePoint(
	{
		valueOf() {
			codePointOrder.push("first");
			return 0x1f600;
		},
	},
	{
		[Symbol.toPrimitive](hint) {
			codePointOrder.push(hint);
			return 65;
		},
	},
);
check(
	"fromCodePoint uses ordered ToNumber coercion",
	coercedCodePoints === "\ud83d\ude00A" &&
		codePointOrder.join(",") === "first,number" &&
		throws(TypeError, () => String.fromCodePoint(1n)) &&
		throws(TypeError, () => String.fromCodePoint(Symbol())),
);

const dataBuffer = new ArrayBuffer(8);
const dataView = new DataView(dataBuffer);
dataView.setUint32(0, Infinity);
dataView.setInt8(4, -257);
check(
	"data view modular conversion",
	dataView.getUint32(0) === 0 && dataView.getInt8(4) === -1,
);

const modularTyped = new Int8Array([Infinity, NaN, -257, 257]);
check(
	"typed array modular conversion",
	modularTyped[0] === 0 &&
		modularTyped[1] === 0 &&
		modularTyped[2] === -1 &&
		modularTyped[3] === 1,
);

const shared = new SharedArrayBuffer(4);
const atomic = new Int32Array(shared);
Atomics.store(atomic, 0, Infinity);
check("atomics modular conversion", Atomics.load(atomic, 0) === 0);
check(
	"atomics index infinity",
	throws(RangeError, () => Atomics.load(atomic, Infinity)),
);

check("bigint ToIndex NaN", BigInt.asUintN(NaN, 7n) === 0n);
const identityBigInt = 123456789n;
check(
	"BigInt identity conversions preserve primitive values",
	BigInt(identityBigInt) === identityBigInt &&
		BigInt.prototype.valueOf.call(identityBigInt) === identityBigInt &&
		BigInt.prototype.valueOf.call(Object(identityBigInt)) === identityBigInt,
);
check(
	"bigint ToIndex infinity",
	throws(RangeError, () => BigInt.asUintN(Infinity, 7n)),
);
check(
	"number and bigint radix infinity",
	throws(RangeError, () => (1).toString(Infinity)) &&
		throws(RangeError, () => 1n.toString(Infinity)),
);

const arrayLike = { 0: "a", 1: "b", length: 2.9 };
check("array-like ToLength", Array.prototype.slice.call(arrayLike).join("") === "ab");

const reflected = [];
const reflectArgs = {
	get length() {
		reflected.push("length");
		return {
			valueOf() {
				reflected.push("valueOf");
				return 1.9;
			},
		};
	},
	get 0() {
		reflected.push("zero");
		return 42;
	},
};
check(
	"reflect ToLength order",
	Reflect.apply((value) => value, undefined, reflectArgs) === 42 &&
		reflected.join(",") === "length,valueOf,zero",
);

const splitOrder = [];
const splitResult = String.prototype.split.call(
	{
		toString() {
			splitOrder.push("this");
			return "a,b";
		},
	},
	{
		toString() {
			splitOrder.push("separator");
			return ",";
		},
	},
	{
		valueOf() {
			splitOrder.push("limit");
			return 1.9;
		},
	},
);
check(
	"split coercion order",
	splitResult.length === 1 &&
		splitResult[0] === "a" &&
		splitOrder.join(",") === "this,limit,separator",
);

const indexOrder = [];
check(
	"relative coercion order",
	[1, 2, 3].slice(
		{
			valueOf() {
				indexOrder.push("start");
				return -2.9;
			},
		},
		{
			valueOf() {
				indexOrder.push("end");
				return -0;
			},
		},
	).length === 0 && indexOrder.join(",") === "start,end",
);

check(
	"symbol index exception",
	throws(TypeError, () => "x".slice(Symbol())),
);
check(
	"throwing index exception",
	throws(Error, () =>
		typed.slice({
			valueOf() {
				throw new Error("index");
			},
		}),
	),
);

const detached = new ArrayBuffer(4);
check(
	"array buffer post-coercion detach",
	throws(TypeError, () =>
		detached.slice({
			valueOf() {
				detached.transfer();
				return 0;
			},
		}),
	),
);

const detachedDataBuffer = new ArrayBuffer(4);
const detachedDataView = new DataView(detachedDataBuffer);
check(
	"data view post-coercion detach",
	throws(TypeError, () =>
		detachedDataView.setUint8(
			{
				valueOf() {
					detachedDataBuffer.transfer();
					return 0;
				},
			},
			1,
		),
	),
);

function target(a, b) {}
Object.defineProperty(target, "length", { value: Infinity, configurable: true });
check("bound function infinity length", target.bind(null, 1).length === Infinity);

const regexp = /a/g;
regexp.lastIndex = Infinity;
check("regexp ToLength infinity", regexp.exec("a") === null && regexp.lastIndex === 0);

check("date integer fields", Date.UTC(2020.9, 1.9, 2.9) === Date.UTC(2020, 1, 2));

check(
	"strict update expressions preserve numeric domains and abrupt coercion",
	(function () {
		"use strict";
		let negativeZero = -0;
		const oldZero = negativeZero++;
		let fraction = 1.5;
		const oldFraction = fraction--;
		let nan = NaN;
		++nan;
		let positiveInfinity = Infinity;
		--positiveInfinity;
		let negativeInfinity = -Infinity;
		++negativeInfinity;
		let bigint = 4n;
		const oldBigint = bigint++;
		const marker = {};
		const abrupt = {
			[Symbol.toPrimitive]() {
				throw marker;
			},
		};
		let abruptValue = abrupt;
		let sawMarker = false;
		try {
			abruptValue++;
		} catch (error) {
			sawMarker = error === marker;
		}
		let coercions = 0;
		const holder = {
			value: {
				[Symbol.toPrimitive]() {
					coercions++;
					return 9;
				},
			},
		};
		const oldObject = holder.value++;
		return (
			Object.is(oldZero, -0) &&
			negativeZero === 1 &&
			oldFraction === 1.5 &&
			fraction === 0.5 &&
			Number.isNaN(nan) &&
			positiveInfinity === Infinity &&
			negativeInfinity === -Infinity &&
			oldBigint === 4n &&
			bigint === 5n &&
			throws(TypeError, () => {
				let symbol = Symbol();
				symbol++;
			}) &&
			sawMarker &&
			abruptValue === abrupt &&
			coercions === 1 &&
			oldObject === 9 &&
			holder.value === 10
		);
	})(),
);

for (const [name, passed] of results) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
);
