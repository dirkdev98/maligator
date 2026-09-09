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

function booleanMembership(x) {
	const value = new Boolean(x);
	return [
		"valueOf" in value,
		"absentWrapperProperty" in value,
		Object.hasOwn(value, "length"),
		value.hasOwnProperty("length"),
		value.propertyIsEnumerable("0"),
		Reflect.has(value, "valueOf"),
		Object.prototype.hasOwnProperty.call(value, "0"),
		Object.prototype.propertyIsEnumerable.call(value, "0"),
		Reflect.getOwnPropertyDescriptor(value, "absentWrapperProperty"),
		value instanceof Object,
		value instanceof Boolean,
		value instanceof Number,
		value instanceof String,
		value instanceof BigInt,
		value instanceof Symbol,
	];
}
globalThis.booleanMembership = booleanMembership;
function numberMembership(x) {
	const value = new Number(x);
	return [
		"valueOf" in value,
		"absentWrapperProperty" in value,
		Object.hasOwn(value, "length"),
		value.hasOwnProperty("length"),
		value.propertyIsEnumerable("0"),
		Reflect.has(value, "valueOf"),
		Object.prototype.hasOwnProperty.call(value, "0"),
		Object.prototype.propertyIsEnumerable.call(value, "0"),
		Reflect.getOwnPropertyDescriptor(value, "absentWrapperProperty"),
		value instanceof Object,
		value instanceof Boolean,
		value instanceof Number,
		value instanceof String,
		value instanceof BigInt,
		value instanceof Symbol,
	];
}
globalThis.numberMembership = numberMembership;
function stringMembership(x) {
	const value = new String(x);
	return [
		"valueOf" in value,
		"absentWrapperProperty" in value,
		Object.hasOwn(value, "length"),
		value.hasOwnProperty("length"),
		value.propertyIsEnumerable("0"),
		Reflect.has(value, "valueOf"),
		Object.prototype.hasOwnProperty.call(value, "0"),
		Object.prototype.propertyIsEnumerable.call(value, "0"),
		Reflect.getOwnPropertyDescriptor(value, "absentWrapperProperty"),
		value instanceof Object,
		value instanceof Boolean,
		value instanceof Number,
		value instanceof String,
		value instanceof BigInt,
		value instanceof Symbol,
	];
}
globalThis.stringMembership = stringMembership;
function bigintMembership(x) {
	const value = Object(BigInt(x));
	return [
		"valueOf" in value,
		"absentWrapperProperty" in value,
		Object.hasOwn(value, "length"),
		value.hasOwnProperty("length"),
		value.propertyIsEnumerable("0"),
		Reflect.has(value, "valueOf"),
		Object.prototype.hasOwnProperty.call(value, "0"),
		Object.prototype.propertyIsEnumerable.call(value, "0"),
		Reflect.getOwnPropertyDescriptor(value, "absentWrapperProperty"),
		value instanceof Object,
		value instanceof Boolean,
		value instanceof Number,
		value instanceof String,
		value instanceof BigInt,
		value instanceof Symbol,
	];
}
globalThis.bigintMembership = bigintMembership;
function symbolMembership(x) {
	const value = Object(Symbol.for(x));
	return [
		"valueOf" in value,
		"absentWrapperProperty" in value,
		Object.hasOwn(value, "length"),
		value.hasOwnProperty("length"),
		value.propertyIsEnumerable("0"),
		Reflect.has(value, "valueOf"),
		Object.prototype.hasOwnProperty.call(value, "0"),
		Object.prototype.propertyIsEnumerable.call(value, "0"),
		Reflect.getOwnPropertyDescriptor(value, "absentWrapperProperty"),
		value instanceof Object,
		value instanceof Boolean,
		value instanceof Number,
		value instanceof String,
		value instanceof BigInt,
		value instanceof Symbol,
	];
}
globalThis.symbolMembership = symbolMembership;
function stringOwnProperties(x) {
	const value = new String(x);
	return [
		[
			"length" in value,
			Object.hasOwn(value, "length"),
			Reflect.has(value, "length"),
			Object.prototype.propertyIsEnumerable.call(value, "length"),
			Object.getOwnPropertyDescriptor(value, "length"),
			Reflect.getOwnPropertyDescriptor(value, "length"),
		],
		[
			"0" in value,
			Object.hasOwn(value, "0"),
			Reflect.has(value, "0"),
			Object.prototype.propertyIsEnumerable.call(value, "0"),
			Object.getOwnPropertyDescriptor(value, "0"),
			Reflect.getOwnPropertyDescriptor(value, "0"),
		],
		[
			"1" in value,
			Object.hasOwn(value, "1"),
			Reflect.has(value, "1"),
			Object.prototype.propertyIsEnumerable.call(value, "1"),
			Object.getOwnPropertyDescriptor(value, "1"),
			Reflect.getOwnPropertyDescriptor(value, "1"),
		],
		[
			"3" in value,
			Object.hasOwn(value, "3"),
			Reflect.has(value, "3"),
			Object.prototype.propertyIsEnumerable.call(value, "3"),
			Object.getOwnPropertyDescriptor(value, "3"),
			Reflect.getOwnPropertyDescriptor(value, "3"),
		],
		[
			"-0" in value,
			Object.hasOwn(value, "-0"),
			Reflect.has(value, "-0"),
			Object.prototype.propertyIsEnumerable.call(value, "-0"),
			Object.getOwnPropertyDescriptor(value, "-0"),
			Reflect.getOwnPropertyDescriptor(value, "-0"),
		],
		[
			(-0) in value,
			Object.hasOwn(value, -0),
			Reflect.has(value, -0),
			Object.prototype.propertyIsEnumerable.call(value, -0),
			Object.getOwnPropertyDescriptor(value, -0),
			Reflect.getOwnPropertyDescriptor(value, -0),
		],
		[
			"01" in value,
			Object.hasOwn(value, "01"),
			Reflect.has(value, "01"),
			Object.prototype.propertyIsEnumerable.call(value, "01"),
			Object.getOwnPropertyDescriptor(value, "01"),
			Reflect.getOwnPropertyDescriptor(value, "01"),
		],
		[
			(-1) in value,
			Object.hasOwn(value, -1),
			Reflect.has(value, -1),
			Object.prototype.propertyIsEnumerable.call(value, -1),
			Object.getOwnPropertyDescriptor(value, -1),
			Reflect.getOwnPropertyDescriptor(value, -1),
		],
		[
			0.5 in value,
			Object.hasOwn(value, 0.5),
			Reflect.has(value, 0.5),
			Object.prototype.propertyIsEnumerable.call(value, 0.5),
			Object.getOwnPropertyDescriptor(value, 0.5),
			Reflect.getOwnPropertyDescriptor(value, 0.5),
		],
		[
			NaN in value,
			Object.hasOwn(value, NaN),
			Reflect.has(value, NaN),
			Object.prototype.propertyIsEnumerable.call(value, NaN),
			Object.getOwnPropertyDescriptor(value, NaN),
			Reflect.getOwnPropertyDescriptor(value, NaN),
		],
		[
			Infinity in value,
			Object.hasOwn(value, Infinity),
			Reflect.has(value, Infinity),
			Object.prototype.propertyIsEnumerable.call(value, Infinity),
			Object.getOwnPropertyDescriptor(value, Infinity),
			Reflect.getOwnPropertyDescriptor(value, Infinity),
		],
		[
			4294967295 in value,
			Object.hasOwn(value, 4294967295),
			Reflect.has(value, 4294967295),
			Object.prototype.propertyIsEnumerable.call(value, 4294967295),
			Object.getOwnPropertyDescriptor(value, 4294967295),
			Reflect.getOwnPropertyDescriptor(value, 4294967295),
		],
		[
			"9007199254740993" in value,
			Object.hasOwn(value, "9007199254740993"),
			Reflect.has(value, "9007199254740993"),
			Object.prototype.propertyIsEnumerable.call(value, "9007199254740993"),
			Object.getOwnPropertyDescriptor(value, "9007199254740993"),
			Reflect.getOwnPropertyDescriptor(value, "9007199254740993"),
		],
		[
			"valueOf" in value,
			Object.hasOwn(value, "valueOf"),
			Reflect.has(value, "valueOf"),
			Object.prototype.propertyIsEnumerable.call(value, "valueOf"),
			Object.getOwnPropertyDescriptor(value, "valueOf"),
			Reflect.getOwnPropertyDescriptor(value, "valueOf"),
		],
		[
			"absentWrapperProperty" in value,
			Object.hasOwn(value, "absentWrapperProperty"),
			Reflect.has(value, "absentWrapperProperty"),
			Object.prototype.propertyIsEnumerable.call(value, "absentWrapperProperty"),
			Object.getOwnPropertyDescriptor(value, "absentWrapperProperty"),
			Reflect.getOwnPropertyDescriptor(value, "absentWrapperProperty"),
		],
	];
}
globalThis.stringOwnProperties = stringOwnProperties;
function stringDescriptorIdentity(x) {
	const value = new String(x);
	const a = Object.getOwnPropertyDescriptor(value, "0");
	const b = Reflect.getOwnPropertyDescriptor(value, "0");
	if (a) a.value = "changed";
	return [a, b, a === b];
}
globalThis.stringDescriptorIdentity = stringDescriptorIdentity;
function mutatedWrapperOwn(x, mutate) {
	const value = new String(x);
	mutate(value);
	return [
		"changed" in value,
		Object.hasOwn(value, "changed"),
		Object.getOwnPropertyDescriptor(value, "changed"),
		Object.prototype.propertyIsEnumerable.call(value, "changed"),
		value instanceof String,
	];
}
globalThis.mutatedWrapperOwn = mutatedWrapperOwn;
for (const family of ["boolean", "number", "string", "bigint", "symbol"]) {
	capture("membership:" + family, () => globalThis[family + "Membership"]("17"));
}
for (const text of [
	"",
	"a",
	"a😀b",
	"\ud800",
	"\udc00",
	undefined,
	null,
	-0,
	17n,
	Symbol.iterator,
]) {
	capture("string own:" + String(text), () => globalThis.stringOwnProperties(text));
	capture("descriptor identity:" + String(text), () =>
		globalThis.stringDescriptorIdentity(text),
	);
}
capture("own coercion", () =>
	globalThis.stringOwnProperties({
		[Symbol.toPrimitive](hint) {
			events.push("own:" + hint);
			return "a😀b";
		},
	}),
);
capture("own coercion throw", () =>
	globalThis.stringOwnProperties({
		[Symbol.toPrimitive](hint) {
			events.push("own throw:" + hint);
			throw new RangeError("conversion");
		},
	}),
);
capture("own mutation", () =>
	globalThis.mutatedWrapperOwn("abc", (value) => {
		Object.defineProperty(value, "changed", { value: 19, enumerable: true });
		Object.setPrototypeOf(value, null);
	}),
);
function customWrapperInstance(x, constructor) {
	return new Number(x) instanceof constructor;
}
globalThis.customWrapperInstance = customWrapperInstance;
capture("custom instanceof", () =>
	globalThis.customWrapperInstance(17, {
		[Symbol.hasInstance](value) {
			events.push("instance:" + value.valueOf());
			return true;
		},
	}),
);
function strictRead0(x, mutate, z) {
	const a = Boolean.prototype.valueOf.call(x);
	mutate(x);
	const b = Boolean.prototype.valueOf.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead0 = strictRead0;
function strictDistinct0(x, z) {
	const a = Boolean.prototype.valueOf.call(x);
	const b = Boolean.prototype.valueOf.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct0 = strictDistinct0;
function strictRead1(x, mutate, z) {
	const a = Boolean.prototype.toString.call(x);
	mutate(x);
	const b = Boolean.prototype.toString.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead1 = strictRead1;
function strictDistinct1(x, z) {
	const a = Boolean.prototype.toString.call(x);
	const b = Boolean.prototype.toString.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct1 = strictDistinct1;
function strictRead2(x, mutate, z) {
	const a = Number.prototype.valueOf.call(x);
	mutate(x);
	const b = Number.prototype.valueOf.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead2 = strictRead2;
function strictDistinct2(x, z) {
	const a = Number.prototype.valueOf.call(x);
	const b = Number.prototype.valueOf.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct2 = strictDistinct2;
function strictRead3(x, mutate, z) {
	const a = Number.prototype.toString.call(x, 16);
	mutate(x);
	const b = Number.prototype.toString.call(x, 16);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead3 = strictRead3;
function strictDistinct3(x, z) {
	const a = Number.prototype.toString.call(x, 16);
	const b = Number.prototype.toString.call(z, 16);
	return Object.is(a, b);
}
globalThis.strictDistinct3 = strictDistinct3;
function strictRead4(x, mutate, z) {
	const a = Number.prototype.toFixed.call(x, 2);
	mutate(x);
	const b = Number.prototype.toFixed.call(x, 2);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead4 = strictRead4;
function strictDistinct4(x, z) {
	const a = Number.prototype.toFixed.call(x, 2);
	const b = Number.prototype.toFixed.call(z, 2);
	return Object.is(a, b);
}
globalThis.strictDistinct4 = strictDistinct4;
function strictRead5(x, mutate, z) {
	const a = Number.prototype.toExponential.call(x, 3);
	mutate(x);
	const b = Number.prototype.toExponential.call(x, 3);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead5 = strictRead5;
function strictDistinct5(x, z) {
	const a = Number.prototype.toExponential.call(x, 3);
	const b = Number.prototype.toExponential.call(z, 3);
	return Object.is(a, b);
}
globalThis.strictDistinct5 = strictDistinct5;
function strictRead6(x, mutate, z) {
	const a = Number.prototype.toPrecision.call(x, 4);
	mutate(x);
	const b = Number.prototype.toPrecision.call(x, 4);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead6 = strictRead6;
function strictDistinct6(x, z) {
	const a = Number.prototype.toPrecision.call(x, 4);
	const b = Number.prototype.toPrecision.call(z, 4);
	return Object.is(a, b);
}
globalThis.strictDistinct6 = strictDistinct6;
function strictRead7(x, mutate, z) {
	const a = String.prototype.valueOf.call(x);
	mutate(x);
	const b = String.prototype.valueOf.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead7 = strictRead7;
function strictDistinct7(x, z) {
	const a = String.prototype.valueOf.call(x);
	const b = String.prototype.valueOf.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct7 = strictDistinct7;
function strictRead8(x, mutate, z) {
	const a = String.prototype.toString.call(x);
	mutate(x);
	const b = String.prototype.toString.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead8 = strictRead8;
function strictDistinct8(x, z) {
	const a = String.prototype.toString.call(x);
	const b = String.prototype.toString.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct8 = strictDistinct8;
function strictRead9(x, mutate, z) {
	const a = BigInt.prototype.valueOf.call(x);
	mutate(x);
	const b = BigInt.prototype.valueOf.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead9 = strictRead9;
function strictDistinct9(x, z) {
	const a = BigInt.prototype.valueOf.call(x);
	const b = BigInt.prototype.valueOf.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct9 = strictDistinct9;
function strictRead10(x, mutate, z) {
	const a = BigInt.prototype.toString.call(x, 16);
	mutate(x);
	const b = BigInt.prototype.toString.call(x, 16);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead10 = strictRead10;
function strictDistinct10(x, z) {
	const a = BigInt.prototype.toString.call(x, 16);
	const b = BigInt.prototype.toString.call(z, 16);
	return Object.is(a, b);
}
globalThis.strictDistinct10 = strictDistinct10;
function strictRead11(x, mutate, z) {
	const a = Symbol.prototype.valueOf.call(x);
	mutate(x);
	const b = Symbol.prototype.valueOf.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead11 = strictRead11;
function strictDistinct11(x, z) {
	const a = Symbol.prototype.valueOf.call(x);
	const b = Symbol.prototype.valueOf.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct11 = strictDistinct11;
function strictRead12(x, mutate, z) {
	const a = Symbol.prototype.toString.call(x);
	mutate(x);
	const b = Symbol.prototype.toString.call(x);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead12 = strictRead12;
function strictDistinct12(x, z) {
	const a = Symbol.prototype.toString.call(x);
	const b = Symbol.prototype.toString.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct12 = strictDistinct12;
function strictRead13(x, mutate, z) {
	const a = Symbol.prototype[Symbol.toPrimitive].call(x, z);
	mutate(x);
	const b = Symbol.prototype[Symbol.toPrimitive].call(x, z);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead13 = strictRead13;
function strictDistinct13(x, z) {
	const a = Symbol.prototype[Symbol.toPrimitive].call(x, z);
	const b = Symbol.prototype[Symbol.toPrimitive].call(z, z);
	return Object.is(a, b);
}
globalThis.strictDistinct13 = strictDistinct13;
function strictRead14(x, mutate, z) {
	const a = Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get.call(x);
	mutate(x);
	const b = Reflect.apply(
		Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get,
		x,
		[],
	);
	return [
		Object.is(a, b),
		typeof a,
		String(a),
		String(b),
		Object.is(a, -0),
		Object.is(b, -0),
	];
}
globalThis.strictRead14 = strictRead14;
function strictDistinct14(x, z) {
	const a = Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get.call(x);
	const b = Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get.call(z);
	return Object.is(a, b);
}
globalThis.strictDistinct14 = strictDistinct14;

const strictInputs = {
	Boolean: [false, true, new Boolean(false), new Boolean(true), Boolean.prototype],
	Number: [
		-0,
		NaN,
		Infinity,
		-Infinity,
		17.125,
		new Number(-0),
		new Number(NaN),
		new Number(17.125),
		Number.prototype,
	],
	String: ["", "a😀\ud800", new String(""), new String("a😀\ud800"), String.prototype],
	BigInt: [17n, -17n, Object(17n), Object(-17n)],
	Symbol: [
		Symbol(),
		Symbol("undefined"),
		Symbol("same"),
		Symbol.for("same"),
		Object(Symbol("same")),
	],
};
function changeWrapperWithoutChangingItsSlot(value) {
	events.push("strict intervening:" + typeof value);
	if (
		value !== null &&
		typeof value === "object" &&
		value !== Boolean.prototype &&
		value !== Number.prototype &&
		value !== String.prototype &&
		!Object.isFrozen(value)
	) {
		Object.defineProperty(value, "valueOf", {
			value() {
				throw new Error("unexpected hook");
			},
			configurable: true,
		});
		Object.defineProperty(value, "toString", {
			value() {
				throw new Error("unexpected hook");
			},
			configurable: true,
		});
		Object.setPrototypeOf(value, null);
	}
}
const strictCases = [
	[0, "Boolean"],
	[1, "Boolean"],
	[2, "Number"],
	[3, "Number"],
	[4, "Number"],
	[5, "Number"],
	[6, "Number"],
	[7, "String"],
	[8, "String"],
	[9, "BigInt"],
	[10, "BigInt"],
	[11, "Symbol"],
	[12, "Symbol"],
	[13, "Symbol"],
	[14, "Symbol"],
];
const strictDifferentInputs = {
	Boolean: [false, true],
	Number: [17, 19],
	String: ["first", "second"],
	BigInt: [17n, 19n],
	Symbol: [Symbol("same"), Symbol("same")],
};
for (const [id, family] of strictCases) {
	const read = globalThis["strictRead" + id];
	for (const input of strictInputs[family])
		capture("strict read " + id, () =>
			read(input, changeWrapperWithoutChangingItsSlot, "ignored"),
		);
	for (const input of [
		null,
		undefined,
		{},
		[],
		() => 0,
		Object.create(globalThis[family].prototype),
		new Proxy(Object(strictInputs[family][0]), {}),
	])
		capture("strict bad receiver " + id, () =>
			read(input, changeWrapperWithoutChangingItsSlot, "ignored"),
		);
	const pair = strictDifferentInputs[family];
	capture("strict distinct " + id, () =>
		globalThis["strictDistinct" + id](Object(pair[0]), Object(pair[1])),
	);
}
function primitiveDescriptorMetadata() {
	const value = Object.getOwnPropertyDescriptor(Number.prototype, "valueOf");
	const other = Reflect.getOwnPropertyDescriptor(Number.prototype, "valueOf");
	const locked = Object.isFrozen(Number.prototype);
	assert(Object.keys(value).join(",") === "value,writable,enumerable,configurable");
	assert(
		value.value === Number.prototype.valueOf &&
			value.writable === !locked &&
			!value.enumerable &&
			value.configurable === !locked,
	);
	value.value = 17;
	assert(value !== other && other.value === Number.prototype.valueOf);
	const getter = Object.getOwnPropertyDescriptor(Symbol.prototype, "description");
	const second = Reflect.getOwnPropertyDescriptor(Symbol.prototype, "description");
	assert(Object.keys(getter).join(",") === "get,set,enumerable,configurable");
	assert(
		typeof getter.get === "function" &&
			getter.set === undefined &&
			!getter.enumerable &&
			getter.configurable === !Object.isFrozen(Symbol.prototype),
	);
	assert(getter.get.call(Object(Symbol("descriptor"))) === "descriptor");
	getter.get = 19;
	assert(getter !== second && typeof second.get === "function");
	const name = Object.getOwnPropertyDescriptor(Number, "name");
	assert(
		name.value === "Number" &&
			!name.writable &&
			!name.enumerable &&
			name.configurable === !Object.isFrozen(Number),
	);
	const length = Reflect.getOwnPropertyDescriptor(String.prototype, "length");
	assert(
		length.value === 0 && !length.writable && !length.enumerable && !length.configurable,
	);
	const pi = Object.getOwnPropertyDescriptor(Math, "PI");
	assert(pi.value === Math.PI && !pi.writable && !pi.enumerable && !pi.configurable);
	const symbol = Reflect.getOwnPropertyDescriptor(Symbol, "iterator");
	assert(
		symbol.value === Symbol.iterator &&
			!symbol.writable &&
			!symbol.enumerable &&
			!symbol.configurable,
	);
	assert(Object.getOwnPropertyDescriptor(Number, "valueOf") === undefined);
	assert(
		Reflect.getOwnPropertyDescriptor(Number.prototype, Symbol.toPrimitive) === undefined,
	);
	assert(!Object.hasOwn(Number, "valueOf") && Reflect.has(Number, "valueOf"));
	return true;
}
globalThis.primitiveDescriptorMetadata = primitiveDescriptorMetadata;
capture("primitive descriptor metadata", () => globalThis.primitiveDescriptorMetadata());
function wrongWrapperReceiver(effect) {
	return Number.prototype.toFixed.call(
		{ valueOf: effect },
		{
			valueOf() {
				events.push("wrong digits");
				return 2;
			},
		},
	);
}
globalThis.wrongWrapperReceiver = wrongWrapperReceiver;
let firstReceiverError, secondReceiverError;
try {
	globalThis.wrongWrapperReceiver(() => {
		events.push("wrong receiver hook");
		return 1;
	});
} catch (error) {
	firstReceiverError = error;
}
try {
	globalThis.wrongWrapperReceiver(() => {
		events.push("wrong receiver hook");
		return 1;
	});
} catch (error) {
	secondReceiverError = error;
}
assert(
	firstReceiverError instanceof TypeError &&
		secondReceiverError instanceof TypeError &&
		firstReceiverError !== secondReceiverError,
);
function repeatedCoercingRadix(value, radix) {
	return [
		Number.prototype.toString.call(value, radix),
		Number.prototype.toString.call(value, radix),
	];
}
globalThis.repeatedCoercingRadix = repeatedCoercingRadix;
let radixCalls = 0;
capture("repeated coercing radix", () =>
	globalThis.repeatedCoercingRadix(new Number(31), {
		valueOf() {
			events.push("radix:" + ++radixCalls);
			return radixCalls === 1 ? 16 : 2;
		},
	}),
);
function repeatedCoercingReceiver(value) {
	return [String.prototype.trim.call(value), String.prototype.trim.call(value)];
}
globalThis.repeatedCoercingReceiver = repeatedCoercingReceiver;
let receiverCalls = 0;
capture("repeated coercing receiver", () =>
	globalThis.repeatedCoercingReceiver({
		[Symbol.toPrimitive]() {
			events.push("receiver:" + ++receiverCalls);
			return receiverCalls === 1 ? " first " : " second ";
		},
	}),
);
function ignoredSymbolHints(value, hint) {
	const a = Symbol.prototype[Symbol.toPrimitive].call(value, hint());
	const b = Symbol.prototype[Symbol.toPrimitive].call(value, hint());
	return a === b;
}
globalThis.ignoredSymbolHints = ignoredSymbolHints;
capture("ignored hints", () =>
	globalThis.ignoredSymbolHints(Object(Symbol("hint")), () => {
		events.push("hint effect");
		return {};
	}),
);
function mutableDescriptorProxy(key) {
	return Object.getOwnPropertyDescriptor(
		new Proxy(Number.prototype, {
			getOwnPropertyDescriptor(target, key) {
				events.push("descriptor proxy:" + String(key));
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		}),
		key,
	);
}
globalThis.mutableDescriptorProxy = mutableDescriptorProxy;
capture("descriptor proxy", () => {
	const descriptor = globalThis.mutableDescriptorProxy({
		[Symbol.toPrimitive](hint) {
			events.push("descriptor key:" + hint);
			return "valueOf";
		},
	});
	return typeof descriptor.value;
});
function reflectDescription(value, argumentsList) {
	return Reflect.apply(
		Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get,
		value,
		argumentsList,
	);
}
globalThis.reflectDescription = reflectDescription;
for (const value of [Symbol("adapted"), Object(Symbol("wrapped")), {}]) {
	for (const list of [
		null,
		undefined,
		[],
		{
			get length() {
				events.push("adapted length");
				return 1;
			},
			get 0() {
				events.push("adapted argument");
				return {};
			},
		},
		{
			get length() {
				events.push("adapted throwing length");
				throw new RangeError("length");
			},
		},
	])
		capture("reflect description:" + typeof value, () =>
			globalThis.reflectDescription(value, list),
		);
}
function reflectDescriptorConstruct(value, argumentsList, newTarget) {
	return Reflect.construct(
		Object.getOwnPropertyDescriptor(Number.prototype, "constructor").value,
		argumentsList,
		newTarget,
	);
}
globalThis.reflectDescriptorConstruct = reflectDescriptorConstruct;
function CustomNumber() {}
capture("late descriptor construct", () => {
	const value = globalThis.reflectDescriptorConstruct(
		0,
		{
			get length() {
				events.push("construct list length");
				return 1;
			},
			get 0() {
				events.push("construct list argument");
				return 17;
			},
		},
		CustomNumber,
	);
	return [
		Number.prototype.valueOf.call(value),
		Object.getPrototypeOf(value) === CustomNumber.prototype,
	];
});
capture("late descriptor invalid newTarget", () =>
	globalThis.reflectDescriptorConstruct(
		0,
		{
			get length() {
				events.push("invalid newTarget list length");
				return 0;
			},
		},
		{},
	),
);
console.log(JSON.stringify({ results, events }));
