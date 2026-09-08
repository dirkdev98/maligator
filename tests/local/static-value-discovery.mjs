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
console.log("static value discovery passed");
