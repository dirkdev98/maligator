const events = [];
function assert(value) {
	if (!value) throw new Error("primitive wrapper observation mismatch");
}
function keyName(key) {
	return typeof key === "symbol" ? "symbol:" + Symbol.keyFor(key) : "string:" + key;
}
function getter() {
	events.push("getter");
	return 31;
}
function setter(value) {
	events.push("setter:" + value);
}
function targetProxy() {
	const target = Object.create(null);
	return new Proxy(target, {
		get(target, key, receiver) {
			events.push("get:" + keyName(key));
			return Reflect.get(target, key, receiver);
		},
		set(target, key, value, receiver) {
			events.push("set:" + keyName(key));
			return Reflect.set(target, key, value, receiver);
		},
		has(target, key) {
			events.push("has:" + keyName(key));
			return Reflect.has(target, key);
		},
		deleteProperty(target, key) {
			events.push("delete:" + keyName(key));
			return Reflect.deleteProperty(target, key);
		},
		defineProperty(target, key, descriptor) {
			events.push("define:" + keyName(key));
			return Reflect.defineProperty(target, key, descriptor);
		},
		getOwnPropertyDescriptor(target, key) {
			events.push("descriptor:" + keyName(key));
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
}

function booleanKeys(x, target) {
	const key = new Boolean(x);
	target[key] = 10;
	const results = [
		target[key],
		key in target,
		Object.hasOwn(target, key),
		Object.getOwnPropertyDescriptor(target, key).value,
	];
	results.push(target[key]++, target[key]);
	Object.defineProperty(target, key, {
		value: 17,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	results.push(
		Reflect.get(target, key),
		Reflect.has(target, key),
		Reflect.set(target, key, 23),
	);
	results.push(
		Reflect.defineProperty(target, key, { value: 29 }),
		Reflect.getOwnPropertyDescriptor(target, key).value,
	);
	results.push(
		Object.prototype.hasOwnProperty.call(target, key),
		Object.prototype.propertyIsEnumerable.call(target, key),
	);
	Object.prototype.__defineGetter__.call(target, key, getter);
	Object.prototype.__defineSetter__.call(target, key, setter);
	results.push(
		Object.prototype.__lookupGetter__.call(target, key) === getter,
		Object.prototype.__lookupSetter__.call(target, key) === setter,
	);
	target[key] = 41;
	results.push(target[key], delete target[key], key in target);
	target[key] = 47;
	results.push(Reflect.deleteProperty(target, key), Reflect.has(target, key));
	return results;
}
function booleanIdentity(x, y) {
	const left = new Boolean(x),
		right = new Boolean(y);
	return [
		left === left,
		left !== left,
		left == left,
		left != left,
		Object.is(left, left),
		left === right,
		left !== right,
		left == right,
		left != right,
		Object.is(left, right),
		left === 0,
		left !== 0,
		Object.is(left, 0),
		left == 0,
		left != 0,
		left == null,
		left != undefined,
		Object.is(left),
	];
}
function booleanReadKey(x, target) {
	const key = new Boolean(x);
	return target[key];
}
globalThis.booleanKeys = booleanKeys;
globalThis.booleanIdentity = booleanIdentity;
globalThis.booleanReadKey = booleanReadKey;

function numberKeys(x, target) {
	const key = new Number(x);
	target[key] = 10;
	const results = [
		target[key],
		key in target,
		Object.hasOwn(target, key),
		Object.getOwnPropertyDescriptor(target, key).value,
	];
	results.push(target[key]++, target[key]);
	Object.defineProperty(target, key, {
		value: 17,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	results.push(
		Reflect.get(target, key),
		Reflect.has(target, key),
		Reflect.set(target, key, 23),
	);
	results.push(
		Reflect.defineProperty(target, key, { value: 29 }),
		Reflect.getOwnPropertyDescriptor(target, key).value,
	);
	results.push(
		Object.prototype.hasOwnProperty.call(target, key),
		Object.prototype.propertyIsEnumerable.call(target, key),
	);
	Object.prototype.__defineGetter__.call(target, key, getter);
	Object.prototype.__defineSetter__.call(target, key, setter);
	results.push(
		Object.prototype.__lookupGetter__.call(target, key) === getter,
		Object.prototype.__lookupSetter__.call(target, key) === setter,
	);
	target[key] = 41;
	results.push(target[key], delete target[key], key in target);
	target[key] = 47;
	results.push(Reflect.deleteProperty(target, key), Reflect.has(target, key));
	return results;
}
function numberIdentity(x, y) {
	const left = new Number(x),
		right = new Number(y);
	return [
		left === left,
		left !== left,
		left == left,
		left != left,
		Object.is(left, left),
		left === right,
		left !== right,
		left == right,
		left != right,
		Object.is(left, right),
		left === 0,
		left !== 0,
		Object.is(left, 0),
		left == 0,
		left != 0,
		left == null,
		left != undefined,
		Object.is(left),
	];
}
function numberReadKey(x, target) {
	const key = new Number(x);
	return target[key];
}
globalThis.numberKeys = numberKeys;
globalThis.numberIdentity = numberIdentity;
globalThis.numberReadKey = numberReadKey;

function stringKeys(x, target) {
	const key = new String(x);
	target[key] = 10;
	const results = [
		target[key],
		key in target,
		Object.hasOwn(target, key),
		Object.getOwnPropertyDescriptor(target, key).value,
	];
	results.push(target[key]++, target[key]);
	Object.defineProperty(target, key, {
		value: 17,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	results.push(
		Reflect.get(target, key),
		Reflect.has(target, key),
		Reflect.set(target, key, 23),
	);
	results.push(
		Reflect.defineProperty(target, key, { value: 29 }),
		Reflect.getOwnPropertyDescriptor(target, key).value,
	);
	results.push(
		Object.prototype.hasOwnProperty.call(target, key),
		Object.prototype.propertyIsEnumerable.call(target, key),
	);
	Object.prototype.__defineGetter__.call(target, key, getter);
	Object.prototype.__defineSetter__.call(target, key, setter);
	results.push(
		Object.prototype.__lookupGetter__.call(target, key) === getter,
		Object.prototype.__lookupSetter__.call(target, key) === setter,
	);
	target[key] = 41;
	results.push(target[key], delete target[key], key in target);
	target[key] = 47;
	results.push(Reflect.deleteProperty(target, key), Reflect.has(target, key));
	return results;
}
function stringIdentity(x, y) {
	const left = new String(x),
		right = new String(y);
	return [
		left === left,
		left !== left,
		left == left,
		left != left,
		Object.is(left, left),
		left === right,
		left !== right,
		left == right,
		left != right,
		Object.is(left, right),
		left === 0,
		left !== 0,
		Object.is(left, 0),
		left == 0,
		left != 0,
		left == null,
		left != undefined,
		Object.is(left),
	];
}
function stringReadKey(x, target) {
	const key = new String(x);
	return target[key];
}
globalThis.stringKeys = stringKeys;
globalThis.stringIdentity = stringIdentity;
globalThis.stringReadKey = stringReadKey;

function bigintKeys(x, target) {
	const key = Object(BigInt(x));
	target[key] = 10;
	const results = [
		target[key],
		key in target,
		Object.hasOwn(target, key),
		Object.getOwnPropertyDescriptor(target, key).value,
	];
	results.push(target[key]++, target[key]);
	Object.defineProperty(target, key, {
		value: 17,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	results.push(
		Reflect.get(target, key),
		Reflect.has(target, key),
		Reflect.set(target, key, 23),
	);
	results.push(
		Reflect.defineProperty(target, key, { value: 29 }),
		Reflect.getOwnPropertyDescriptor(target, key).value,
	);
	results.push(
		Object.prototype.hasOwnProperty.call(target, key),
		Object.prototype.propertyIsEnumerable.call(target, key),
	);
	Object.prototype.__defineGetter__.call(target, key, getter);
	Object.prototype.__defineSetter__.call(target, key, setter);
	results.push(
		Object.prototype.__lookupGetter__.call(target, key) === getter,
		Object.prototype.__lookupSetter__.call(target, key) === setter,
	);
	target[key] = 41;
	results.push(target[key], delete target[key], key in target);
	target[key] = 47;
	results.push(Reflect.deleteProperty(target, key), Reflect.has(target, key));
	return results;
}
function bigintIdentity(x, y) {
	const left = Object(BigInt(x)),
		right = Object(BigInt(y));
	return [
		left === left,
		left !== left,
		left == left,
		left != left,
		Object.is(left, left),
		left === right,
		left !== right,
		left == right,
		left != right,
		Object.is(left, right),
		left === 0,
		left !== 0,
		Object.is(left, 0),
		left == 0,
		left != 0,
		left == null,
		left != undefined,
		Object.is(left),
	];
}
function bigintReadKey(x, target) {
	const key = Object(BigInt(x));
	return target[key];
}
globalThis.bigintKeys = bigintKeys;
globalThis.bigintIdentity = bigintIdentity;
globalThis.bigintReadKey = bigintReadKey;

function symbolKeys(x, target) {
	const key = Object(Symbol.for(x));
	target[key] = 10;
	const results = [
		target[key],
		key in target,
		Object.hasOwn(target, key),
		Object.getOwnPropertyDescriptor(target, key).value,
	];
	results.push(target[key]++, target[key]);
	Object.defineProperty(target, key, {
		value: 17,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	results.push(
		Reflect.get(target, key),
		Reflect.has(target, key),
		Reflect.set(target, key, 23),
	);
	results.push(
		Reflect.defineProperty(target, key, { value: 29 }),
		Reflect.getOwnPropertyDescriptor(target, key).value,
	);
	results.push(
		Object.prototype.hasOwnProperty.call(target, key),
		Object.prototype.propertyIsEnumerable.call(target, key),
	);
	Object.prototype.__defineGetter__.call(target, key, getter);
	Object.prototype.__defineSetter__.call(target, key, setter);
	results.push(
		Object.prototype.__lookupGetter__.call(target, key) === getter,
		Object.prototype.__lookupSetter__.call(target, key) === setter,
	);
	target[key] = 41;
	results.push(target[key], delete target[key], key in target);
	target[key] = 47;
	results.push(Reflect.deleteProperty(target, key), Reflect.has(target, key));
	return results;
}
function symbolIdentity(x, y) {
	const left = Object(Symbol.for(x)),
		right = Object(Symbol.for(y));
	return [
		left === left,
		left !== left,
		left == left,
		left != left,
		Object.is(left, left),
		left === right,
		left !== right,
		left == right,
		left != right,
		Object.is(left, right),
		left === 0,
		left !== 0,
		Object.is(left, 0),
		left == 0,
		left != 0,
		left == null,
		left != undefined,
		Object.is(left),
	];
}
function symbolReadKey(x, target) {
	const key = Object(Symbol.for(x));
	return target[key];
}
globalThis.symbolKeys = symbolKeys;
globalThis.symbolIdentity = symbolIdentity;
globalThis.symbolReadKey = symbolReadKey;

function numericIndex(value, index) {
	const wrapper = new String(value);
	return wrapper[+index];
}
function joinedIndex(condition, index) {
	const wrapper = condition ? new String("a😀b") : new String("x\ud800y");
	return wrapper[+index];
}
function numericSpelling(value, kind) {
	const wrapper = new String(value);
	return kind ? wrapper[-1] : wrapper["-0"];
}
function customKey(value, target) {
	const key = new String(value);
	key[Symbol.toPrimitive] = function (hint) {
		events.push("own-key:" + hint + ":" + (this === key));
		return "override";
	};
	return target[key];
}
function escapedKey(value, target) {
	const key = new String(value);
	target[key] = key;
	return key;
}
function explicitReceiver(value, target) {
	const key = new String(value);
	return Reflect.get(target, key, key);
}
function uncertainIdentity(x, y, condition) {
	const left = new Number(x),
		right = new Number(y);
	const value = condition ? left : right;
	return Object.is(value, left);
}
globalThis.numericIndex = numericIndex;
globalThis.joinedIndex = joinedIndex;
globalThis.numericSpelling = numericSpelling;
globalThis.customKey = customKey;
globalThis.escapedKey = escapedKey;
globalThis.explicitReceiver = explicitReceiver;
globalThis.uncertainIdentity = uncertainIdentity;
const coercible = {
	[Symbol.toPrimitive](hint) {
		events.push("coerce:" + hint);
		return 17;
	},
};
const throwing = {
	[Symbol.toPrimitive](hint) {
		events.push("throw:" + hint);
		throw new RangeError("sentinel");
	},
};
const familyInputs = [
	["boolean", [false, true, 0, "", coercible, throwing, Symbol.iterator]],
	["number", [-0, 17, NaN, Infinity, "12", 7n, coercible, throwing, Symbol.iterator]],
	["string", ["", "alpha", 17, NaN, 12n, coercible, throwing, Symbol.iterator]],
	["bigint", [17n, -1n, "12", "0x11", 1.5, coercible, throwing, Symbol.iterator]],
	["symbol", ["alpha", "", 1, undefined, coercible, throwing, Symbol.iterator]],
];
const results = [];
function capture(name, action) {
	try {
		const value = action();
		results.push([name, value === undefined ? ["undefined"] : value]);
	} catch (error) {
		results.push([name, ["throw", error.name]]);
	}
}
for (const [family, inputs] of familyInputs) {
	for (let index = 0; index < inputs.length; index++) {
		const x = inputs[index];
		capture(family + ":keys:" + index, () =>
			globalThis[family + "Keys"](x, targetProxy()),
		);
		capture(family + ":identity:" + index, () => globalThis[family + "Identity"](x, x));
		capture(family + ":null:" + index, () => globalThis[family + "ReadKey"](x, null));
	}
}
const stringInputs = ["", "a😀\ud800b", "x\udc00y", coercible, throwing, Symbol.iterator];
const indices = [
	-0,
	0,
	1,
	2,
	3,
	4,
	7,
	-1,
	0.5,
	NaN,
	Infinity,
	-Infinity,
	4294967295,
	coercible,
	throwing,
	1n,
];
for (let input = 0; input < stringInputs.length; input++) {
	for (let index = 0; index < indices.length; index++) {
		capture("index:" + input + ":" + index, () =>
			globalThis.numericIndex(stringInputs[input], indices[index]),
		);
	}
	capture("numeric spelling:" + input, () =>
		globalThis.numericSpelling(stringInputs[input], true),
	);
}
for (const condition of [false, true])
	for (let index = 0; index < indices.length; index++)
		capture("joined:" + condition + ":" + index, () =>
			globalThis.joinedIndex(condition, indices[index]),
		);
assert(globalThis.customKey("unused", { override: 53 }) === 53);
const escapedTarget = {};
const escaped = globalThis.escapedKey("saved", escapedTarget);
assert(
	escapedTarget.saved === escaped &&
		typeof escaped === "object" &&
		escaped.valueOf() === "saved",
);
const explicit = globalThis.explicitReceiver("saved", {
	get saved() {
		return this;
	},
});
assert(typeof explicit === "object" && explicit.valueOf() === "saved");
assert(globalThis.uncertainIdentity(NaN, NaN, true));
assert(!globalThis.uncertainIdentity(NaN, NaN, false));
if (!Object.isFrozen(String.prototype)) {
	const numericDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "99");
	Object.defineProperty(String.prototype, "99", {
		get() {
			return this;
		},
		configurable: true,
	});
	try {
		const observed = globalThis.numericIndex("abc", 99);
		assert(typeof observed === "object" && observed.valueOf() === "abc");
	} finally {
		if (numericDescriptor)
			Object.defineProperty(String.prototype, "99", numericDescriptor);
		else delete String.prototype[99];
	}
}
for (const [family, prototype, input] of [
	["boolean", Boolean.prototype, false],
	["number", Number.prototype, 17],
	["string", String.prototype, "abc"],
	["bigint", BigInt.prototype, 17n],
	["symbol", Symbol.prototype, "abc"],
]) {
	if (Object.isFrozen(prototype)) continue;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.toPrimitive);
	let seen = 0;
	Object.defineProperty(prototype, Symbol.toPrimitive, {
		value(hint) {
			assert(hint === "string" && typeof this === "object");
			seen++;
			return "overridden";
		},
		configurable: true,
	});
	try {
		assert(globalThis[family + "ReadKey"](input, { overridden: 59 }) === 59);
		assert(seen === 1);
	} finally {
		if (descriptor) Object.defineProperty(prototype, Symbol.toPrimitive, descriptor);
		else delete prototype[Symbol.toPrimitive];
	}
}
function booleanJoinedKey(condition, target) {
	const value = condition ? false : true;
	return target[Object(value)];
}
globalThis.booleanJoinedKey = booleanJoinedKey;
function numberJoinedKey(condition, target) {
	const value = condition ? -0 : NaN;
	return target[Object(value)];
}
globalThis.numberJoinedKey = numberJoinedKey;
function stringJoinedKey(condition, target) {
	const value = condition ? "a" : "b";
	return target[Object(value)];
}
globalThis.stringJoinedKey = stringJoinedKey;
function bigintJoinedKey(condition, target) {
	const value = condition ? 17n : 19n;
	return target[Object(value)];
}
globalThis.bigintJoinedKey = bigintJoinedKey;
function symbolJoinedKey(condition, target) {
	const value = condition ? Symbol.iterator : Symbol.toStringTag;
	return target[Object(value)];
}
globalThis.symbolJoinedKey = symbolJoinedKey;
function loopIndex(value, count) {
	const result = [];
	for (let i = 0; i < count; i++) result.push(new String(value)[i & 3]);
	return result;
}
function joinedSymbolDescription(condition) {
	const value = condition ? Symbol.iterator : Symbol.toStringTag;
	return Object(value).description;
}
function mixedKey(condition, value, target) {
	const key = Object(condition ? Symbol.iterator : value);
	return target[key];
}
globalThis.loopIndex = loopIndex;
globalThis.joinedSymbolDescription = joinedSymbolDescription;
globalThis.mixedKey = mixedKey;
const joinedTarget = {
	true: 3,
	false: 5,
	0: 7,
	NaN: 11,
	a: 13,
	b: 17,
	17: 23,
	19: 29,
	[Symbol.iterator]: 31,
	[Symbol.toStringTag]: 37,
	custom: 41,
};
for (const family of ["boolean", "number", "string", "bigint", "symbol"]) {
	for (const condition of [false, true])
		capture("joined key:" + family + ":" + condition, () =>
			globalThis[family + "JoinedKey"](condition, joinedTarget),
		);
}
assert(globalThis.joinedSymbolDescription(true) === "Symbol.iterator");
assert(globalThis.joinedSymbolDescription(false) === "Symbol.toStringTag");
const mixedValue = {
	[Symbol.toPrimitive](hint) {
		events.push("mixed:" + hint);
		return "custom";
	},
};
assert(globalThis.mixedKey(false, mixedValue, joinedTarget) === 41);
assert(globalThis.mixedKey(true, mixedValue, joinedTarget) === 31);
for (const count of [0, 1, 4, 9])
	capture("loop index:" + count, () => globalThis.loopIndex("a😀b", count));

function booleanObjectObservations(x, count, z) {
	let value = new Boolean(x);
	for (let i = 0; i < count; i++) value = new Boolean(z);
	return [
		Object(value).valueOf() === value.valueOf(),
		Object.is(new Object(value).valueOf(), value.valueOf()),
		Object.getPrototypeOf(value) === Boolean.prototype,
		Reflect.getPrototypeOf(value) === Boolean.prototype,
		value.__proto__ === Boolean.prototype,
		value.constructor === Boolean,
		value.hasOwnProperty === Object.prototype.hasOwnProperty,
		value.absentWrapperProperty === undefined,
		Object.isExtensible(value),
		Reflect.isExtensible(value),
		Object.isFrozen(value),
		Object.isSealed(value),
		Object.prototype.isPrototypeOf.call(Object.prototype, value),
		Boolean.prototype.isPrototypeOf(value),
	];
}
globalThis.booleanObjectObservations = booleanObjectObservations;
function numberObjectObservations(x, count, z) {
	let value = new Number(x);
	for (let i = 0; i < count; i++) value = new Number(z);
	return [
		Object(value).valueOf() === value.valueOf(),
		Object.is(new Object(value).valueOf(), value.valueOf()),
		Object.getPrototypeOf(value) === Number.prototype,
		Reflect.getPrototypeOf(value) === Number.prototype,
		value.__proto__ === Number.prototype,
		value.constructor === Number,
		value.hasOwnProperty === Object.prototype.hasOwnProperty,
		value.absentWrapperProperty === undefined,
		Object.isExtensible(value),
		Reflect.isExtensible(value),
		Object.isFrozen(value),
		Object.isSealed(value),
		Object.prototype.isPrototypeOf.call(Object.prototype, value),
		Number.prototype.isPrototypeOf(value),
	];
}
globalThis.numberObjectObservations = numberObjectObservations;
function stringObjectObservations(x, count, z) {
	let value = new String(x);
	for (let i = 0; i < count; i++) value = new String(z);
	return [
		Object(value).valueOf() === value.valueOf(),
		Object.is(new Object(value).valueOf(), value.valueOf()),
		Object.getPrototypeOf(value) === String.prototype,
		Reflect.getPrototypeOf(value) === String.prototype,
		value.__proto__ === String.prototype,
		value.constructor === String,
		value.hasOwnProperty === Object.prototype.hasOwnProperty,
		value.absentWrapperProperty === undefined,
		Object.isExtensible(value),
		Reflect.isExtensible(value),
		Object.isFrozen(value),
		Object.isSealed(value),
		Object.prototype.isPrototypeOf.call(Object.prototype, value),
		String.prototype.isPrototypeOf(value),
	];
}
globalThis.stringObjectObservations = stringObjectObservations;
function bigintObjectObservations(x, count, z) {
	let value = Object(BigInt(x));
	for (let i = 0; i < count; i++) value = Object(BigInt(z));
	return [
		Object(value).valueOf() === value.valueOf(),
		Object.is(new Object(value).valueOf(), value.valueOf()),
		Object.getPrototypeOf(value) === BigInt.prototype,
		Reflect.getPrototypeOf(value) === BigInt.prototype,
		value.__proto__ === BigInt.prototype,
		value.constructor === BigInt,
		value.hasOwnProperty === Object.prototype.hasOwnProperty,
		value.absentWrapperProperty === undefined,
		Object.isExtensible(value),
		Reflect.isExtensible(value),
		Object.isFrozen(value),
		Object.isSealed(value),
		Object.prototype.isPrototypeOf.call(Object.prototype, value),
		BigInt.prototype.isPrototypeOf(value),
	];
}
globalThis.bigintObjectObservations = bigintObjectObservations;
function symbolObjectObservations(x, count, z) {
	let value = Object(Symbol.for(x));
	for (let i = 0; i < count; i++) value = Object(Symbol.for(z));
	return [
		Object(value).valueOf() === value.valueOf(),
		Object.is(new Object(value).valueOf(), value.valueOf()),
		Object.getPrototypeOf(value) === Symbol.prototype,
		Reflect.getPrototypeOf(value) === Symbol.prototype,
		value.__proto__ === Symbol.prototype,
		value.constructor === Symbol,
		value.hasOwnProperty === Object.prototype.hasOwnProperty,
		value.absentWrapperProperty === undefined,
		Object.isExtensible(value),
		Reflect.isExtensible(value),
		Object.isFrozen(value),
		Object.isSealed(value),
		Object.prototype.isPrototypeOf.call(Object.prototype, value),
		Symbol.prototype.isPrototypeOf(value),
	];
}
globalThis.symbolObjectObservations = symbolObjectObservations;

for (const family of ["boolean", "number", "string", "bigint", "symbol"]) {
	for (const count of [0, 1, 3]) {
		capture("object observations:" + family + ":" + count, () =>
			globalThis[family + "ObjectObservations"]("17", count, "23"),
		);
	}
	const input = {
		[Symbol.toPrimitive](hint) {
			events.push("observations:" + family + ":" + hint);
			return "17";
		},
	};
	capture("object observations coercion:" + family, () =>
		globalThis[family + "ObjectObservations"](input, 2, input),
	);
	const throwing = {
		[Symbol.toPrimitive]() {
			events.push("observations throw:" + family);
			throw new RangeError("conversion");
		},
	};
	capture("object observations throw:" + family, () =>
		globalThis[family + "ObjectObservations"](throwing, 0, "23"),
	);
}
for (const value of [NaN, -0, Infinity, -Infinity])
	capture("number object observations:" + String(value), () =>
		globalThis.numberObjectObservations(value, 0, 0),
	);
for (const value of ["", "😀", "\ud800", Symbol.iterator])
	capture("string object observations:" + String(value), () =>
		globalThis.stringObjectObservations(value, 0, "a"),
	);

function objectAliasState(value, mutate) {
	const alias = Object(value);
	mutate(alias);
	return [
		alias === value,
		Object.getPrototypeOf(value),
		Object.isExtensible(value),
		Object.isFrozen(value),
		Object.isSealed(value),
	];
}
function customObjectConstruction(value, target) {
	return Reflect.construct(Object, [value], target);
}
function wrapperUnknownPrototype(x, receiver) {
	return Object.prototype.isPrototypeOf.call(receiver, new Number(x));
}
globalThis.objectAliasState = objectAliasState;
globalThis.customObjectConstruction = customObjectConstruction;
globalThis.wrapperUnknownPrototype = wrapperUnknownPrototype;
for (const make of [
	() => new Boolean(false),
	() => new Number(0),
	() => new String("😀"),
	() => Object(17n),
	() => Object(Symbol.iterator),
]) {
	const value = make(),
		prototype = {};
	const state = globalThis.objectAliasState(value, (alias) => {
		Object.setPrototypeOf(alias, prototype);
		Object.freeze(alias);
	});
	assert(state[0] && state[1] === prototype && !state[2] && state[3] && state[4]);
}
function CustomObject() {}
const boxed = new Number(17);
const constructed = globalThis.customObjectConstruction(boxed, CustomObject);
assert(
	constructed !== boxed && Object.getPrototypeOf(constructed) === CustomObject.prototype,
);
assert(globalThis.customObjectConstruction(boxed, Object) === boxed);
for (const receiver of [null, undefined, 1, "x", {}, Number.prototype, Object.prototype])
	capture("unknown prototype:" + String(receiver), () =>
		globalThis.wrapperUnknownPrototype(17, receiver),
	);

console.log(JSON.stringify({ results, events }));
