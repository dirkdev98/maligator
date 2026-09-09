const events = [],
	results = [];
function assert(value) {
	if (!value) throw new Error("inherited toLocaleString invariant");
}
function booleanObject(x) {
	return Object.prototype.toLocaleString.call(new Boolean(x), events.push("extra"));
}
function numberObject(x) {
	return Object.prototype.toLocaleString.call(
		new Number(+x),
		16,
		events.push("number-extra"),
	);
}
function stringObject(x) {
	return Object.prototype.toLocaleString.call(new String(String(x)));
}
function bigintObject(x) {
	return Object.prototype.toLocaleString.call(Object(BigInt(x)));
}
function symbolObject(x) {
	return Object.prototype.toLocaleString.call(Object(Symbol.for(x)));
}
function booleanPrimitive(x) {
	return Object.prototype.toLocaleString.call(!!x);
}
function numberPrimitive(x) {
	return Object.prototype.toLocaleString.call(+x);
}
function stringPrimitive(x) {
	return Object.prototype.toLocaleString.call(String(x));
}
function bigintPrimitive(x) {
	return Object.prototype.toLocaleString.call(BigInt(x));
}
function symbolPrimitive(x) {
	return Object.prototype.toLocaleString.call(Symbol.for(x));
}
globalThis.methods = [
	booleanObject,
	numberObject,
	stringObject,
	bigintObject,
	symbolObject,
	booleanPrimitive,
	numberPrimitive,
	stringPrimitive,
	bigintPrimitive,
	symbolPrimitive,
];
const coercible = {
	[Symbol.toPrimitive](hint) {
		events.push(hint);
		return "17";
	},
};
for (const method of globalThis.methods) {
	for (const input of [
		false,
		0,
		-0,
		NaN,
		Infinity,
		"",
		"17",
		"text",
		9007199254740993n,
		Symbol.iterator,
		coercible,
	]) {
		try {
			const value = method(input);
			results.push(typeof value + ":" + value);
		} catch (error) {
			results.push(error.name);
		}
	}
}
const sentinel = {};
const custom = new Boolean(false);
Object.defineProperty(custom, "toString", {
	get() {
		events.push("getter");
		return function () {
			events.push("call:" + arguments.length);
			assert(this === custom);
			return sentinel;
		};
	},
});
assert(
	Object.prototype.toLocaleString.call(custom, events.push("before-get")) === sentinel,
);
const changing = new Boolean(false);
assert(
	Object.prototype.toLocaleString.call(
		changing,
		Object.defineProperty(changing, "toString", {
			value() {
				assert(this === changing && arguments.length === 0);
				return sentinel;
			},
		}),
	) === sentinel,
);
const proxy = new Proxy(new Boolean(false), {
	get(target, key, receiver) {
		events.push("proxy:" + key);
		assert(receiver === proxy && key === "toString");
		return function () {
			assert(this === proxy && arguments.length === 0);
			return sentinel;
		};
	},
});
assert(
	Object.prototype.toLocaleString.call(proxy, events.push("before-proxy")) === sentinel,
);
for (const value of [null, undefined, { toString: 1 }]) {
	let threw = false;
	try {
		Object.prototype.toLocaleString.call(value, events.push("before-error"));
	} catch (error) {
		threw = error instanceof TypeError;
	}
	assert(threw);
}
const throwing = {
	get toString() {
		events.push("throw-getter");
		throw sentinel;
	},
};
try {
	Object.prototype.toLocaleString.call(throwing, events.push("before-throw-getter"));
	throw new Error("missing getter throw");
} catch (error) {
	assert(error === sentinel);
}
assert(
	Reflect.apply(Object.prototype.toLocaleString, custom, {
		get length() {
			events.push("length");
			return 1;
		},
		get 0() {
			events.push("argument");
			return 17;
		},
	}) === sentinel,
);
let constructed = false;
try {
	new Object.prototype.toLocaleString(events.push("before-construct-error"));
} catch (error) {
	constructed = error instanceof TypeError;
}
assert(constructed);
if (!Object.isFrozen(Object.prototype)) {
	const originalLocale = Object.prototype.toLocaleString,
		originalString = Boolean.prototype.toString;
	try {
		Boolean.prototype.toString = function () {
			assert(arguments.length === 0);
			return sentinel;
		};
		assert(globalThis.methods[5](false) === sentinel);
		Object.prototype.toLocaleString = function () {
			return "overridden";
		};
		assert(globalThis.methods[5](false) === "overridden");
	} finally {
		Object.prototype.toLocaleString = originalLocale;
		Boolean.prototype.toString = originalString;
	}
}
console.log(JSON.stringify({ results, events }));
