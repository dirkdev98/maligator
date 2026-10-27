function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
const collect = () => globalThis.gc?.();
function freezeValue(value, observe) {
	const result = Object.freeze(value);
	observe();
	return result;
}
function freezeIdentity(value, observe) {
	const result = Object.freeze(value);
	observe();
	return Object.is(result, value);
}
function freezePrefix(value, args, observe) {
	const result = Object.freeze(value, ...args);
	observe();
	return Object.is(result, value);
}
function freezeList(value, args, observe) {
	const result = Object.freeze.apply(null, args);
	observe();
	return Object.is(result, value);
}
function mapIdentity(value, key, other, observe) {
	const result = Map.prototype.set.call(value, key, other);
	observe();
	return Object.is(result, value);
}
function assignValue(value, other, observe) {
	const result = Object.assign(value, other);
	observe();
	return result;
}
function unboxIdentity(value, observe) {
	const result = Number.prototype.valueOf.call(value);
	observe();
	return Object.is(result, value);
}
function numeric(value, observe) {
	const number = value >>> 0;
	const result = Object.freeze(number);
	observe();
	return result;
}
function* suspended(value, observe) {
	const result = Object.freeze(value);
	yield 1;
	observe();
	return Object.is(result, value);
}
async function resumed(value, observe) {
	const result = Object.freeze(value);
	await 0;
	observe();
	return result;
}
Object.assign(globalThis, {
	freezeValue,
	freezeIdentity,
	freezePrefix,
	freezeList,
	mapIdentity,
	assignValue,
	unboxIdentity,
	numeric,
	suspended,
	resumed,
});

const assignForward = function assignForward(value, other, observe) {
	const result = Object.assign(value, other);
	for (let i = 0; i < 3; i++) observe();
	return result;
};
const numberForward = function numberForward(value, observe) {
	const result = Number.prototype.valueOf.call(value);
	for (let i = 0; i < 3; i++) observe();
	return result;
};
const mixedForward = function mixedForward(value, flag, observe) {
	const result = flag ? value : Object.assign(value, {});
	for (let i = 0; i < 3; i++) observe();
	return result;
};
function conditionalObject(flag, other, observe) {
	const target = flag ? {} : [];
	const result = assignForward(target, other, observe);
	observe();
	return [Object.is(result, target), result.marker];
}
function conditionalUnbox(value, observe) {
	const result = numberForward(value, observe);
	observe();
	return result;
}
function conditionalMixed(value, flag, observe) {
	const result = mixedForward(value, flag, observe);
	observe();
	return Object.is(result, value);
}
function* conditionalSuspended(flag, other, observe) {
	const target = flag ? {} : [];
	const result = assignForward(target, other, observe);
	yield result;
	observe();
	return Object.is(result, target);
}
Object.assign(globalThis, {
	conditionalObject,
	conditionalUnbox,
	conditionalMixed,
	conditionalSuspended,
});

for (const value of [
	undefined,
	null,
	false,
	NaN,
	-0,
	Infinity,
	"heap".repeat(100),
	3n,
	Symbol("alias"),
	{ field: 3 },
]) {
	check(freezeValue(value, collect), value, "freeze preserves the input value");
	check(freezeIdentity(value, collect), true, "freeze normal-result identity");
	const iterator = suspended(value, collect);
	check(iterator.next().value, 1, "yield before observing the alias");
	collect();
	check(iterator.next().value, true, "alias identity survives suspension");
	check(await resumed(value, collect), value, "alias survives await and collection");
}
check(numeric(-1, collect), 4294967295, "uint32 range is not narrowed to int32");
check(Object.freeze(), undefined, "omitted argument is undefined");
check(unboxIdentity(NaN, collect), true, "unboxed NaN uses SameValue");
check(unboxIdentity(-0, collect), true, "unboxed negative zero is preserved");
check(
	unboxIdentity(new Number(7), collect),
	false,
	"boxed receiver differs from its payload",
);

const map = new Map();
const marker = { payload: "retained".repeat(100) };
for (const flag of [false, true]) {
	const conditional = conditionalObject(flag, { marker }, collect);
	check(conditional[0], true, "conditional alias with an Object input");
	check(conditional[1], marker, "conditional result retains assigned fields");
	check(
		conditionalMixed(7, flag, collect),
		flag,
		"every return path constrains identity",
	);
	const suspended = conditionalSuspended(flag, { marker }, collect);
	check(suspended.next().value.marker, marker, "conditional result survives yield");
	collect();
	check(suspended.next().value, true, "conditional alias survives resume");
}
for (const value of [NaN, -0, 4294967295, new Number(7)]) {
	check(
		conditionalUnbox(value, collect),
		Number.prototype.valueOf.call(value),
		"conditional number return",
	);
}
let invalidUnbox = false;
try {
	conditionalUnbox({}, collect);
} catch (error) {
	invalidUnbox = error instanceof TypeError;
}
check(invalidUnbox, true, "conditional unboxing still checks the receiver");
check(mapIdentity(map, "key", marker, collect), true, "Map.set returns its receiver");
check(map.get("key"), marker, "Map.set mutation remains observable");
let caught = false;
try {
	mapIdentity({}, "key", marker, collect);
} catch (error) {
	caught = error instanceof TypeError;
}
check(caught, true, "invalid Map receiver still throws");

const target = { before: 1 };
const assigned = assignValue(target, { before: 2, marker }, collect);
check(assigned, target, "Object assignment aliases an Object target");
check(assigned.before, 2, "assignment invalidates earlier field contents");
check(assigned.marker, marker, "assignment retains reference fields");
const boxed = assignValue(7, { marker }, collect);
check(Object.is(boxed, 7), false, "primitive assignment allocates a wrapper");
check(boxed.marker, marker, "boxed result stays rooted");
const reversed = Array.prototype.reverse.call(7);
check(typeof reversed, "object", "Array mutators box primitive receivers");
const typed = new Int8Array([1, 2, 3]);
check(typed.reverse(), typed, "typed mutation returns receiver");
check(typed[0], 3, "typed mutation remains observable");

const events = [];
const proxy = new Proxy(
	{},
	{
		preventExtensions(value) {
			events.push("prevent");
			collect();
			return Reflect.preventExtensions(value);
		},
		ownKeys(value) {
			events.push("keys");
			return Reflect.ownKeys(value);
		},
	},
);
check(
	freezeIdentity(proxy, () => events.push("observe")),
	true,
	"proxy return identity",
);
check(events.join(","), "prevent,keys,observe", "freeze traps precede observer");
const failure = {};
const throwing = new Proxy(
	{},
	{
		preventExtensions() {
			throw failure;
		},
	},
);
let observed = false;
try {
	freezeIdentity(throwing, () => {
		observed = true;
	});
} catch (error) {
	check(error, failure, "trap exception identity");
}
check(observed, false, "exception bypasses post-call observers");

const listed = { fromList: true };
let reads = 0;
const args = {
	length: 1,
	get 0() {
		reads++;
		collect();
		return listed;
	},
};
check(
	freezeList(marker, args, collect),
	false,
	"unknown list contents are not a positional argument",
);
check(reads, 1, "array-like getter is evaluated");
check(Object.isFrozen(listed), true, "array-like contents reach the builtin");
const spread = {
	*[Symbol.iterator]() {
		events.push("spread");
		collect();
		yield marker;
	},
};
check(
	freezePrefix(marker, spread, collect),
	true,
	"known prefix survives iterable transport",
);
check(events[events.length - 1], "spread", "iterable effects remain");
const failingSpread = {
	[Symbol.iterator]() {
		throw failure;
	},
};
observed = false;
try {
	freezePrefix(marker, failingSpread, () => {
		observed = true;
	});
} catch (error) {
	check(error, failure, "iterator exception identity");
}
check(observed, false, "iterator failure bypasses post-call observers");

if (process.env.MAL_PRIMORDIALS === "mutable") {
	const original = Object.freeze;
	try {
		Object.freeze = () => marker;
		check(
			freezeValue(7, collect),
			marker,
			"mutable replacement may return an unrelated value",
		);
		check(freezeIdentity(7, collect), false, "mutable spelling does not imply identity");
	} finally {
		Object.freeze = original;
	}
	const originalAssign = Object.assign;
	try {
		Object.assign = () => marker;
		check(
			conditionalMixed({}, false, collect),
			false,
			"mutable assignment cannot certify an alias",
		);
	} finally {
		Object.assign = originalAssign;
	}
}
console.log("builtin aliases ok");
