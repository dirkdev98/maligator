function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
function objectFrozen(value, observe) {
	const result = Object.isFrozen(value);
	observe();
	return result;
}
function reflectDefine(value, key, descriptor, observe) {
	const result = Reflect.defineProperty(value, key, descriptor);
	observe();
	return result;
}
function reflectHas(value, key, observe) {
	const result = Reflect.has(value, key);
	observe();
	return result;
}
function reflectSet(value, key, other, observe) {
	const result = Reflect.set(value, key, other);
	observe();
	return result;
}
function reflectList(list, observe) {
	const result = Reflect.has.apply(null, list);
	observe();
	return result;
}
function reflectSpread(list, observe) {
	const result = Reflect.has(...list);
	observe();
	return result;
}
function* predicateFrame(value) {
	const result = Object.isFrozen(value);
	yield 1;
	return result;
}
async function predicateAwait(value, key) {
	const result = Reflect.has(value, key);
	await 0;
	return result;
}
async function* predicateAsyncFrame(value, key, other) {
	const result = Reflect.set(value, key, other);
	yield 1;
	await 0;
	return result;
}
Object.assign(globalThis, {
	objectFrozen,
	reflectDefine,
	reflectHas,
	reflectSet,
	reflectList,
	reflectSpread,
	predicateFrame,
	predicateAwait,
	predicateAsyncFrame,
});
const collect = () => globalThis.gc?.();
const marker = { marker: 42 };
for (const value of [undefined, null, 0, -0, NaN, "text", true, 3n, Symbol.iterator]) {
	check(objectFrozen(value, collect), true, "primitive frozen state");
}
const target = { present: marker };
const events = [];
const proxy = new Proxy(target, {
	isExtensible(object) {
		events.push("extensible");
		collect();
		return Reflect.isExtensible(object);
	},
	ownKeys(object) {
		events.push("keys");
		collect();
		return Reflect.ownKeys(object);
	},
	getOwnPropertyDescriptor(object, key) {
		events.push("descriptor");
		collect();
		return Reflect.getOwnPropertyDescriptor(object, key);
	},
	defineProperty() {
		events.push("define");
		collect();
		return marker;
	},
	has(object, key) {
		events.push("has");
		collect();
		return Reflect.has(object, key);
	},
	set(object, key, value) {
		events.push("set");
		collect();
		return Reflect.set(object, key, value);
	},
});
check(objectFrozen(proxy, collect), false, "Proxy frozen state");
const descriptorEvents = [];
check(
	reflectDefine(
		proxy,
		"added",
		{
			get enumerable() {
				descriptorEvents.push("enumerable");
				collect();
				return true;
			},
			get value() {
				descriptorEvents.push("value");
				collect();
				return marker;
			},
			configurable: true,
		},
		collect,
	),
	true,
	"descriptor and truthy Proxy completion",
);
check(descriptorEvents.join(":"), "enumerable:value", "descriptor getter order");
check(events.includes("define"), true, "define trap executed");
check(reflectHas(proxy, "present", collect), true, "Proxy membership");
check(reflectSet(proxy, "written", marker, collect), true, "Proxy write");
check(target.written, marker, "write survived callback collection");
const listEvents = [];
check(
	reflectList(
		{
			get length() {
				listEvents.push("length");
				collect();
				return 2;
			},
			get 0() {
				listEvents.push("target");
				collect();
				return proxy;
			},
			get 1() {
				listEvents.push("key");
				collect();
				return "present";
			},
		},
		collect,
	),
	true,
	"array-like arguments",
);
check(listEvents.join(":"), "length:target:key", "array-like getter order");
check(
	reflectSpread(
		(function* () {
			collect();
			yield proxy;
			collect();
			yield "present";
		})(),
		collect,
	),
	true,
	"iterable arguments",
);
Object.freeze(target);
check(objectFrozen(proxy, collect), true, "frozen Proxy descriptors");
check(
	events.includes("keys") && events.includes("descriptor"),
	true,
	"integrity traps executed",
);
check(
	reflectSet(proxy, "present", 17, collect),
	false,
	"failed write stays Boolean false",
);
for (const invoke of [
	() =>
		reflectHas(
			new Proxy(
				{},
				{
					has() {
						collect();
						throw marker;
					},
				},
			),
			"x",
			collect,
		),
	() =>
		reflectDefine(
			{},
			"x",
			{
				get value() {
					collect();
					throw marker;
				},
			},
			collect,
		),
	() =>
		objectFrozen(
			new Proxy(
				{},
				{
					isExtensible() {
						collect();
						throw marker;
					},
				},
			),
			collect,
		),
]) {
	try {
		invoke();
		throw new Error("missing callback exception");
	} catch (error) {
		check(error, marker, "callback exception identity");
	}
}
for (const invoke of [
	() => reflectHas(17, "x", collect),
	() => reflectSet(null, "x", marker, collect),
]) {
	let threw = false;
	try {
		invoke();
	} catch (error) {
		threw = error instanceof TypeError;
	}
	check(threw, true, "target validation precedes normal result decoding");
}
const frame = predicateFrame(proxy);
check(frame.next().value, 1, "Boolean frame suspension");
collect();
check(frame.next().value, true, "Boolean frame restore");
check(await predicateAwait(proxy, "present"), true, "Boolean await restore");
const asyncFrame = predicateAsyncFrame(proxy, "present", 17);
check((await asyncFrame.next()).value, 1, "Boolean async generator suspension");
collect();
check((await asyncFrame.next()).value, false, "Boolean async generator restore");
if (process.env.MAL_PRIMORDIALS === "mutable") {
	for (const [owner, key, invoke] of [
		[Object, "isFrozen", () => objectFrozen(target, collect)],
		[Reflect, "defineProperty", () => reflectDefine(target, "x", {}, collect)],
		[Reflect, "has", () => reflectHas(target, "x", collect)],
		[Reflect, "set", () => reflectSet(target, "x", marker, collect)],
	]) {
		const original = owner[key];
		try {
			owner[key] = function () {
				collect();
				return marker;
			};
			check(invoke(), marker, "mutable callee result");
		} finally {
			owner[key] = original;
		}
	}
}
console.log("object-predicate-results PASS");
