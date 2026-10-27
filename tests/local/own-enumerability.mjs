function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
function enumerableData(value, key) {
	return { present: value }.propertyIsEnumerable(key);
}
function enumerableAccessor(value, key) {
	return {
		get present() {
			throw value;
		},
	}.propertyIsEnumerable(key);
}
function enumerableArray(value, key) {
	return [, value].propertyIsEnumerable(key);
}
function joinedEnumerable(value, flag) {
	const record = flag ? { present: value, left: 1 } : { present: value, right: 2 };
	return record.propertyIsEnumerable("present");
}
function coercedEnumerable(value, observe) {
	const record = { present: value };
	const key = {
		[Symbol.toPrimitive](hint) {
			check(hint, "string", "property key hint");
			observe();
			delete record.present;
			return "present";
		},
	};
	return record.propertyIsEnumerable(key);
}
function booleanReflection(value, key, observe) {
	const result = Object.prototype.propertyIsEnumerable.call(value, key);
	observe();
	return result;
}
function prototypeReflection(value, other, observe) {
	const result = Object.prototype.isPrototypeOf.call(value, other);
	observe();
	return result;
}
function stringReflection(value, observe) {
	const result = Object.prototype.toString.call(value);
	observe();
	return result;
}
function* enumerableFrame(value, key) {
	const record = { present: value };
	yield 1;
	return record.propertyIsEnumerable(key);
}
function* booleanReflectionFrame(value, key) {
	const result = Object.prototype.propertyIsEnumerable.call(value, key);
	yield 1;
	return result;
}
function* stringReflectionFrame(value) {
	const result = Object.prototype.toString.call(value);
	yield 1;
	return result;
}
async function booleanReflectionAwait(value, key) {
	const result = Object.prototype.propertyIsEnumerable.call(value, key);
	await 0;
	return result;
}
async function enumerableAwait(value, key) {
	await 0;
	return { present: value }.propertyIsEnumerable(key);
}
async function* enumerableAsyncFrame(value, key) {
	yield 1;
	await 0;
	return { present: value }.propertyIsEnumerable(key);
}
Object.assign(globalThis, {
	enumerableData,
	enumerableAccessor,
	enumerableArray,
	joinedEnumerable,
	booleanReflection,
	prototypeReflection,
	stringReflection,
	enumerableFrame,
	booleanReflectionFrame,
	stringReflectionFrame,
	booleanReflectionAwait,
	enumerableAwait,
	enumerableAsyncFrame,
});
const marker = { marker: 42 };
const collect = () => globalThis.gc?.();
for (const key of [
	"present",
	"missing",
	"toString",
	undefined,
	0,
	-0,
	0n,
	Symbol.iterator,
]) {
	check(enumerableData(marker, key), key === "present", "data enumerability");
	check(enumerableAccessor(marker, key), key === "present", "accessor enumerability");
}
for (const key of ["0", "1", "length", 0, 1, 1n, Symbol.iterator]) {
	check(
		enumerableArray(marker, key),
		key === "1" || key === 1 || key === 1n,
		"Array enumerability",
	);
}
for (const flag of [false, true])
	check(joinedEnumerable(marker, flag), true, "joined descriptor");
check(Math.propertyIsEnumerable("abs"), false, "primordial nonenumerable");
check(Math.propertyIsEnumerable("toString"), false, "inherited primordial method");
const inherited = Object.create({ inherited: marker });
check(inherited.propertyIsEnumerable("inherited"), false, "inherited field");
const descriptors = Object.defineProperties(
	{},
	{
		visible: { value: marker, enumerable: true },
		hidden: { value: marker, enumerable: false },
	},
);
check(descriptors.propertyIsEnumerable("visible"), true, "explicit enumerable field");
check(descriptors.propertyIsEnumerable("hidden"), false, "explicit nonenumerable field");
const symbol = Symbol("own");
const symbolRecord = { [symbol]: marker, [Symbol.iterator]: marker };
check(symbolRecord.propertyIsEnumerable(symbol), true, "fresh Symbol field");
check(
	symbolRecord.propertyIsEnumerable(Symbol.iterator),
	true,
	"well-known Symbol field",
);
check(symbolRecord.propertyIsEnumerable(Symbol("own")), false, "distinct Symbol field");
let coercions = 0;
check(
	coercedEnumerable(marker, () => {
		coercions++;
		collect();
	}),
	false,
	"coercing key mutation",
);
check(coercions, 1, "single key coercion");
const order = [];
const receiver = {
	present: marker,
	get propertyIsEnumerable() {
		order.push("method");
		return Object.prototype.propertyIsEnumerable;
	},
};
check(
	receiver.propertyIsEnumerable(
		(order.push("argument"),
		{
			toString() {
				order.push("key");
				collect();
				return "present";
			},
		}),
	),
	true,
	"loaded getter method",
);
check(order.join(":"), "method:argument:key", "invocation order");
const nullishOrder = [];
try {
	Object.prototype.propertyIsEnumerable.call(null, {
		toString() {
			nullishOrder.push("key");
			throw marker;
		},
	});
	throw new Error("missing abrupt key conversion");
} catch (error) {
	check(error, marker, "key conversion precedes nullish receiver failure");
}
check(nullishOrder.join(":"), "key", "nullish key conversion");
let traps = 0;
const proxy = new Proxy(
	{ present: marker },
	{
		getOwnPropertyDescriptor(target, key) {
			traps++;
			collect();
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	},
);
check(booleanReflection(proxy, "present", collect), true, "Proxy result");
check(traps, 1, "Proxy descriptor trap");
const replaced = {
	propertyIsEnumerable() {
		collect();
		return marker;
	},
};
check(replaced.propertyIsEnumerable("present"), marker, "own replacement return value");
const prototype = {};
const child = Object.create(prototype);
check(prototypeReflection(prototype, child, collect), true, "prototype Boolean result");
check(prototypeReflection(prototype, 17, collect), false, "primitive prototype query");
const tagged = {
	get [Symbol.toStringTag]() {
		collect();
		return "custom";
	},
};
check(stringReflection(tagged, collect), "[object custom]", "tag getter and String root");
for (const [iterator, expected] of [
	[booleanReflectionFrame(proxy, "present"), true],
	[stringReflectionFrame(tagged), "[object custom]"],
]) {
	check(iterator.next().value, 1, "normal-result suspension");
	collect();
	check(iterator.next().value, expected, "normal-result resume");
}
check(await booleanReflectionAwait(proxy, "present"), true, "normal-result await");
check(traps, 3, "resumable Proxy descriptor traps");
for (const key of ["present", "missing"]) {
	const iterator = enumerableFrame(marker, key);
	check(iterator.next().value, 1, "generator suspension");
	collect();
	check(iterator.next().value, key === "present", "generator enumerability");
	check(await enumerableAwait(marker, key), key === "present", "async enumerability");
	const asyncIterator = enumerableAsyncFrame(marker, key);
	check((await asyncIterator.next()).value, 1, "async generator suspension");
	collect();
	check(
		(await asyncIterator.next()).value,
		key === "present",
		"async generator enumerability",
	);
}
if (process.env.MAL_PRIMORDIALS === "mutable") {
	const original = Object.prototype.propertyIsEnumerable;
	try {
		Object.prototype.propertyIsEnumerable = function () {
			collect();
			return marker;
		};
		check(enumerableData(marker, "present"), marker, "mutable primordial return value");
		check(
			booleanReflection(marker, "present", collect),
			marker,
			"mutable exact-call fallback",
		);
	} finally {
		Object.prototype.propertyIsEnumerable = original;
	}
}
console.log("own-enumerability PASS");
