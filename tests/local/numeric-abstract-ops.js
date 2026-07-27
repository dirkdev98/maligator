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

check("integer NaN", (12.4).toFixed(NaN) === "12");
check("integer negative zero", "x".repeat(-0) === "");
check("integer truncates toward zero", "x".repeat(2.9) === "xx");
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
