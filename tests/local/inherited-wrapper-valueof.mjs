const events = [],
	results = [];
function assert(value) {
	if (!value) throw new Error("inherited valueOf invariant");
}
function booleanObject(x) {
	return Boolean.prototype.valueOf.call(
		Object.prototype.valueOf.call(new Boolean(x), events.push("extra")),
	);
}
function numberObject(x) {
	return Number.prototype.valueOf.call(Object.prototype.valueOf.call(new Number(+x)));
}
function stringObject(x) {
	return String.prototype.valueOf.call(
		Object.prototype.valueOf.call(new String(String(x))),
	);
}
function bigintObject(x) {
	return BigInt.prototype.valueOf.call(Object.prototype.valueOf.call(Object(BigInt(x))));
}
function symbolObject(x) {
	return Symbol.prototype.valueOf.call(
		Object.prototype.valueOf.call(Object(Symbol.for(x))),
	);
}
function booleanPrimitive(x) {
	return Boolean.prototype.valueOf.call(Object.prototype.valueOf.call(!!x));
}
function numberPrimitive(x) {
	return Number.prototype.valueOf.call(Object.prototype.valueOf.call(+x));
}
function stringPrimitive(x) {
	return String.prototype.valueOf.call(Object.prototype.valueOf.call(String(x)));
}
function bigintPrimitive(x) {
	return BigInt.prototype.valueOf.call(Object.prototype.valueOf.call(BigInt(x)));
}
function symbolPrimitive(x) {
	return Symbol.prototype.valueOf.call(Object.prototype.valueOf.call(Symbol.for(x)));
}
const methods = [
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
globalThis.methods = methods;
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
		"x",
		9007199254740993n,
		Symbol.iterator,
		coercible,
	]) {
		try {
			const value = method(input);
			results.push(
				Object.is(value, -0) ? "number:-0" : typeof value + ":" + String(value),
			);
		} catch (error) {
			results.push(error.name);
		}
	}
}
function escape(x) {
	return Object.prototype.valueOf.call(!!x);
}
globalThis.escapeBox = escape;
const first = globalThis.escapeBox(false),
	second = globalThis.escapeBox(false);
assert(first !== second && typeof first === "object");
assert(
	Boolean.prototype.valueOf.call(first) === false &&
		Object.getPrototypeOf(first) === Boolean.prototype,
);
function existing(x) {
	const value = {
		note: x,
		get [Symbol.toPrimitive]() {
			throw new Error("unexpected coercion lookup");
		},
	};
	return Object.prototype.valueOf.call(value, events.push("identity")) === value;
}
globalThis.existing = existing;
assert(globalThis.existing(4));
const boxedText = Object.prototype.valueOf.call("abc");
assert(boxedText.length === 3 && boxedText[1] === "b");
assert(!Object.getOwnPropertyDescriptor(boxedText, "0").writable);
const revoked = Proxy.revocable({}, {});
revoked.revoke();
assert(Object.prototype.valueOf.call(revoked.proxy) === revoked.proxy);
for (const receiver of [null, undefined]) {
	try {
		Object.prototype.valueOf.call(receiver, events.push("nullish extra"));
		throw new Error("accepted nullish receiver");
	} catch (error) {
		assert(error instanceof TypeError);
	}
}
const argumentsList = {
	get length() {
		events.push("length");
		return 1;
	},
	get 0() {
		events.push("argument");
		return 9;
	},
};
assert(Reflect.apply(Object.prototype.valueOf, first, argumentsList) === first);
try {
	new Object.prototype.valueOf(events.push("construct extra"));
	throw new Error("constructed valueOf");
} catch (error) {
	assert(error instanceof TypeError);
}
if (!Object.isFrozen(Object.prototype)) {
	const valueOf = Object.prototype.valueOf,
		sentinel = {};
	Object.prototype.valueOf = function () {
		return sentinel;
	};
	try {
		assert(globalThis.escapeBox(false) === sentinel);
	} finally {
		Object.prototype.valueOf = valueOf;
	}
}
console.log(JSON.stringify({ results, events }));
