function assert(condition, message) {
	if (!condition) throw new Error(message);
}
assert(Array.isArray(Array.prototype), "Array.prototype brand");
assert(!Array.isArray(Object.prototype), "Object.prototype brand");
const contains = (xs, x) => xs.includes(x);
function staticContains(x) {
	return contains(
		[
			0,
			1,
			2,
			3,
			4,
			5,
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			20,
			21,
			22,
			23,
			24,
			25,
			26,
			27,
			28,
			29,
			30,
			NaN,
		],
		x,
	);
}
function readArray(key) {
	return [10, 20][key];
}
function readObject(key) {
	return { a: 1, b: 2 }[key];
}
for (const key of [0, -0, "0", 1, 2, -1, 0.5, NaN, Infinity, "length"]) {
	assert(Object.is(readArray(key), [10, 20][key]), `array key ${key}`);
}
for (const key of ["a", "b", "c", "toString", "__proto__", Symbol.iterator]) {
	assert(readObject(key) === { a: 1, b: 2 }[key], "object key");
}
let conversions = 0;
const key = {
	[Symbol.toPrimitive](hint) {
		assert(hint === "string", "key hint");
		conversions++;
		return "a";
	},
};
assert(readObject(key) === 1 && conversions === 1, "single key conversion");
assert(staticContains(19) && staticContains(NaN) && !staticContains(33), "static helper");
assert(contains([5, 6], 6) && !contains([5, 6], 7), "mixed helper");
const firstIndex = (xs, x) => xs.indexOf(x);
const lastIndex = (xs, x) => xs.lastIndexOf(x);
function searchFirst(x) {
	return firstIndex(
		[
			,
			undefined,
			NaN,
			-0,
			1n,
			"needle",
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			20,
			21,
			22,
			23,
			24,
			25,
			26,
			27,
			28,
			29,
			"needle",
			undefined,
		],
		x,
	);
}
function searchLast(x) {
	return lastIndex(
		[
			,
			undefined,
			NaN,
			-0,
			1n,
			"needle",
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			20,
			21,
			22,
			23,
			24,
			25,
			26,
			27,
			28,
			29,
			"needle",
			undefined,
		],
		x,
	);
}
globalThis.firstIndex = firstIndex;
globalThis.lastIndex = lastIndex;
for (const [value, first, last] of [
	[undefined, 1, 31],
	[NaN, -1, -1],
	[0, 3, 3],
	[-0, 3, 3],
	[1n, 4, 4],
	[1, -1, -1],
	["needle", 5, 30],
	["absent", -1, -1],
	[Symbol("needle"), -1, -1],
	[
		{
			toString() {
				throw new Error("search must not coerce");
			},
		},
		-1,
		-1,
	],
]) {
	assert(searchFirst(value) === first, "first static helper index");
	assert(searchLast(value) === last, "last static helper index");
}
assert(firstIndex([9, 8, 9], 9) === 0, "original first-index helper remains callable");
assert(lastIndex([9, 8, 9], 9) === 2, "original last-index helper remains callable");
const firstFrom = (xs, x) => xs.indexOf(x, -3.9);
const lastFrom = (xs, x) => xs.lastIndexOf(x, -3.9);
const containsFrom = (xs, x) => xs.includes(x, -3.9);
const lastFromUndefined = (xs, x) => xs.lastIndexOf(x, undefined);
function firstFromStatic(x) {
	return firstFrom(
		[
			7,
			undefined,
			2,
			3,
			4,
			5,
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			20,
			21,
			22,
			23,
			24,
			25,
			26,
			27,
			28,
			7,
			,
			7,
		],
		x,
	);
}
function lastFromStatic(x) {
	return lastFrom(
		[
			7,
			undefined,
			2,
			3,
			4,
			5,
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			20,
			21,
			22,
			23,
			24,
			25,
			26,
			27,
			28,
			7,
			,
			7,
		],
		x,
	);
}
function containsFromStatic(x) {
	return containsFrom(
		[
			7,
			undefined,
			2,
			3,
			4,
			5,
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			20,
			21,
			22,
			23,
			24,
			25,
			26,
			27,
			28,
			7,
			,
			7,
		],
		x,
	);
}
function lastFromUndefinedStatic(x) {
	return lastFromUndefined(
		[
			7,
			undefined,
			2,
			3,
			4,
			5,
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
			15,
			16,
			17,
			18,
			19,
			20,
			21,
			22,
			23,
			24,
			25,
			26,
			27,
			28,
			7,
			,
			7,
		],
		x,
	);
}
globalThis.firstFrom = firstFrom;
globalThis.lastFrom = lastFrom;
globalThis.containsFrom = containsFrom;
globalThis.lastFromUndefined = lastFromUndefined;
assert(firstFromStatic(7) === 29, "first helper truncates a negative fractional offset");
assert(firstFromStatic(undefined) === -1, "first helper skips a hole after its offset");
assert(lastFromStatic(7) === 29, "last helper starts at a negative fractional offset");
assert(lastFromStatic(undefined) === 1, "last helper keeps indexes before its offset");
assert(containsFromStatic(undefined), "includes helper reads a hole after its offset");
assert(!containsFromStatic(28), "includes helper excludes entries before its offset");
assert(lastFromUndefinedStatic(7) === 0, "explicit undefined starts lastIndexOf at zero");
assert(
	lastFromUndefinedStatic(undefined) === -1,
	"explicit undefined differs from omission",
);
let offsetConversions = 0;
const observedOffsetArray = [9, 0, 9];
const observedOffset = {
	valueOf() {
		offsetConversions++;
		observedOffsetArray[2] = 0;
		return 2;
	},
};
const lastFromDynamic = (xs, x, start) => xs.lastIndexOf(x, start);
assert(
	lastFromDynamic(observedOffsetArray, 9, observedOffset) === 0 &&
		offsetConversions === 1,
	"dynamic helper offset keeps coercion and its mutation",
);
const symbol = Symbol("x"),
	other = Symbol("x");
assert(symbol !== other && Symbol.for("x") === Symbol.for("x"), "symbol identity");
assert(
	Symbol.keyFor(symbol) === undefined && Symbol.keyFor(Symbol.for("x")) === "x",
	"symbol registry",
);
let throws = false;
try {
	void (symbol + "");
} catch (error) {
	throws = error instanceof TypeError;
}
assert(throws && String(symbol) === "Symbol(x)", "symbol coercion");
function primitives(x) {
	return [undefined, , null, true, false, -0, NaN, Infinity, 1n, "\ud800\u0000"].includes(
		x,
	);
}
assert(
	primitives(undefined) && primitives(-0) && primitives(NaN) && primitives(1n),
	"primitive template",
);
function graph(value) {
	const child = { value };
	const result = { a: child, b: child };
	result.self = result;
	return result;
}
const first = graph(1),
	second = graph(1);
assert(
	first.a === first.b && first.self === first && first !== second && first.a !== second.a,
	"graph identity",
);
first.a.value = 8;
assert(first.b.value === 8 && second.a.value === 1, "graph mutation");
const object = {
	z: 0,
	10: 1,
	2: 2,
	get value() {
		return this.z;
	},
	set value(v) {
		this.z = v;
	},
	[symbol]: 3,
	__proto__: null,
};
object.value = 7;
assert(object.value === 7 && Object.getPrototypeOf(object) === null, "descriptors");
assert(
	Reflect.ownKeys(object).slice(0, 3).join() === "2,10,z" && object[symbol] === 3,
	"key order",
);
const explicit = [undefined, , 2];
assert(Object.hasOwn(explicit, 0) && !Object.hasOwn(explicit, 1), "hole presence");
function branch(flag) {
	const child = {};
	const value = flag ? { a: 10, child } : { a: 10, child };
	return [value.a, value.child === child, value];
}
const left = branch(true),
	right = branch(false);
assert(
	left[0] === 10 && right[0] === 10 && left[1] && right[1] && left[2] !== right[2],
	"branch identity",
);
function mutableKey() {
	const value = { a: 1 };
	const key = {
		toString() {
			value.a = 9;
			return "a";
		},
	};
	return value[key];
}
assert(mutableKey() === 9, "escaped key mutation");
function mutation(callback) {
	const value = [10, 20];
	callback(value);
	return value[0] + value.length;
}
assert(
	mutation((value) => {
		value[0] = 30;
		value.push(2);
	}) === 33,
	"unknown callback",
);
function immutableWrite(value) {
	const object = {};
	Object.defineProperty(object, "a", { value: 4, writable: false });
	try {
		object.a = value;
	} catch {}
	return object.a;
}
assert(immutableWrite(9) === 4, "nonwritable assignment");
let trace = "";
try {
	[10, 20].includex(((trace += "argument"), 1));
} catch (error) {
	assert(error instanceof TypeError, "missing call type");
}
assert(trace === "argument", "missing call order");
if (Object.isExtensible(Array.prototype)) {
	Object.defineProperty(Array.prototype, "0", {
		get() {
			return 41;
		},
		configurable: true,
	});
	try {
		assert([, 1][0] === 41 && [, 1].includes(41), "inherited index");
	} finally {
		delete Array.prototype[0];
	}
}
const entries = {
	*[Symbol.iterator]() {
		yield ["a", 7];
	},
};
assert(new Map(entries).get("a") === 7, "dynamic constructor");
class SubMap extends Map {}
assert(new SubMap().constructor === SubMap, "subclass prototype");
globalThis.staticDiscovery = {
	contains,
	staticContains,
	readArray,
	readObject,
	primitives,
	graph,
	branch,
	mutableKey,
	mutation,
};
const sharedData = [10, 20];
const readShared = () => sharedData[0] + sharedData.length;
assert(readShared() === 12, "private global contents");
function capturedFactory() {
	const data = [10, 20];
	return () => data[0] + data.length;
}
assert(capturedFactory()() === 12, "private captured contents");
function descriptor(value) {
	return Object.getOwnPropertyDescriptor({ a: value }, "a");
}
const descriptorA = descriptor(9),
	descriptorB = descriptor(9);
assert(
	descriptorA !== descriptorB &&
		descriptorA.value === 9 &&
		descriptorA.writable &&
		descriptorA.enumerable &&
		descriptorA.configurable,
	"descriptor result identity",
);
let tdz = false;
try {
	const read = () => later[0];
	read();
	const later = [10];
} catch (error) {
	tdz = error instanceof ReferenceError;
}
assert(tdz, "cross-helper TDZ");
globalThis.staticDiscoveryCells = { readShared, capturedFactory, descriptor };

function expectTdz(run) {
	let caught = false;
	try {
		run();
	} catch (error) {
		caught = error instanceof ReferenceError;
	}
	assert(caught, "lexical block TDZ");
}
expectTdz(() => {
	try {
		const read = () => value;
		read();
		let value = 1;
	} finally {
	}
});
expectTdz(() => {
	try {
		throw 1;
	} catch {
		const read = () => value;
		read();
		let value = 1;
	}
});
expectTdz(() => {
	try {
	} finally {
		const read = () => value;
		read();
		let value = 1;
	}
});

const returnInput = (xs) => xs;
const identityA = returnInput([1, 2]),
	identityB = returnInput([1, 2]);
assert(identityA !== identityB && identityA[0] === 1, "helper returned identity");
const recursiveRead = (xs, depth) => (depth ? recursiveRead(xs, depth - 1) : xs[0]);
assert(recursiveRead([7, 8], 3) === 7, "recursive helper");
let escapedInput;
const exposeInput = (xs, callback) => {
	callback(xs);
	return xs[0];
};
assert(
	exposeInput([10, 20], (value) => {
		escapedInput = value;
		value[0] = 90;
	}) === 90 && escapedInput[0] === 90,
	"escaping helper callback",
);
const firstTextOffset = (xs, x) => xs.indexOf(x, " 0x2 ");
const lastTextOffset = (xs, x) => xs.lastIndexOf(x, "-2");
const includesTextOffset = (xs, x) => xs.includes(x, "bad");
function searchTextOffsets(x) {
	return [
		firstTextOffset([9, 9, 5, 9], x),
		lastTextOffset([9, 9, 5, 9], x),
		includesTextOffset([, 9, 5, 9], x),
	];
}
const textNine = searchTextOffsets(9);
assert(textNine[0] === 3 && textNine[1] === 1 && textNine[2], "helper text offsets");
const textHole = searchTextOffsets(undefined);
assert(textHole[0] === -1 && textHole[1] === -1 && textHole[2], "helper NaN text offset");
const bigintOffset = (xs, x) => xs.indexOf(x, 1n);
let bigintOffsetThrew = false;
try {
	bigintOffset([1, 2], 1);
} catch (error) {
	bigintOffsetThrew = error instanceof TypeError;
}
assert(bigintOffsetThrew && bigintOffset([], 1) === -1, "helper BigInt offset coercion");
globalThis.staticTextOffsetHelpers = {
	firstTextOffset,
	lastTextOffset,
	includesTextOffset,
	searchTextOffsets,
	bigintOffset,
};
function splitSingleton(value) {
	return String(value).split();
}
function splitFirst(value) {
	return String(value).split(undefined, -1)[0];
}
function splitZero(value, separator) {
	return String(value).split(String(separator), 4294967296);
}
const splitText = "\ud800a\ud83d\udca9";
const splitA = splitSingleton(splitText),
	splitB = splitSingleton(splitText);
assert(
	splitA !== splitB && splitA.length === 1 && splitA[0] === splitText,
	"partial split fresh singleton",
);
splitA[0] = "changed";
assert(
	splitB[0] === splitText && splitFirst(splitText) === splitText,
	"partial split independent payloads",
);
const splitDescriptor = Object.getOwnPropertyDescriptor(splitB, "0");
assert(
	splitDescriptor.writable && splitDescriptor.enumerable && splitDescriptor.configurable,
	"partial split own data element",
);
assert(
	splitSingleton("").length === 1 && splitSingleton(undefined)[0] === "undefined",
	"partial split empty and undefined receiver text",
);
const splitEmptyA = splitZero("a,b", ","),
	splitEmptyB = splitZero("a,b", ",");
assert(
	splitEmptyA !== splitEmptyB &&
		splitEmptyA.length === 0 &&
		!Object.hasOwn(splitEmptyA, 0),
	"partial split fresh empty result",
);
let splitTrace = "";
const splitSource = {
	toString() {
		splitTrace += "source;";
		return "a,b";
	},
};
const splitSeparator = {
	toString() {
		splitTrace += "separator;";
		return ",";
	},
};
assert(
	splitZero(splitSource, splitSeparator).length === 0 &&
		splitTrace === "source;separator;",
	"partial split retains source and separator evaluation",
);
function splitExtra(value) {
	return String(value).split(undefined, 1, (splitTrace += "extra;"))[0];
}
splitTrace = "";
assert(
	splitExtra(splitSource) === "a,b" && splitTrace === "source;extra;",
	"partial split ignored argument evaluation",
);
splitTrace = "";
const splitMarker = {};
let splitReceiverThrew = false;
try {
	splitExtra({
		toString() {
			throw splitMarker;
		},
	});
} catch (error) {
	assert(error === splitMarker, "partial split receiver exception");
	splitReceiverThrew = true;
}
assert(
	splitReceiverThrew && splitTrace === "",
	"partial split receiver exception precedes arguments",
);
function splitProtocol(value, separator) {
	return String(value).split(separator, 0);
}
const splitProtocolResult = ["protocol"];
const customSplitter = {
	[Symbol.split](value, limit) {
		assert(value === "a,b" && limit === 0, "split protocol arguments");
		return splitProtocolResult;
	},
};
assert(
	splitProtocol("a,b", customSplitter) === splitProtocolResult,
	"zero split retains custom protocol",
);
let splitSymbolThrew = false;
try {
	splitProtocol("a,b", Symbol("separator"));
} catch (error) {
	splitSymbolThrew = error instanceof TypeError;
}
assert(splitSymbolThrew, "zero split retains Symbol separator error");
function splitLimit(value, limit) {
	return String(value).split(undefined, limit);
}
splitTrace = "";
assert(
	splitLimit("a,b", {
		valueOf() {
			splitTrace += "limit;";
			return 0;
		},
	}).length === 0 && splitTrace === "limit;",
	"split retains object limit conversion",
);
let splitBigIntThrew = false;
try {
	splitLimit("a,b", 0n);
} catch (error) {
	splitBigIntThrew = error instanceof TypeError;
}
assert(splitBigIntThrew, "split retains BigInt limit error");
globalThis.staticSplitHelpers = {
	splitSingleton,
	splitFirst,
	splitZero,
	splitExtra,
	splitProtocol,
	splitLimit,
};
console.log("static value discovery passed");
