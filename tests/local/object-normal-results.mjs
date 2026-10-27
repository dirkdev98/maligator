function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
const collect = () => globalThis.gc?.();
function descriptor(value, key, observe) {
	const result = Object.getOwnPropertyDescriptor(value, key);
	observe();
	return result;
}
function prototype(value, observe) {
	const result = Object.getPrototypeOf(value);
	observe();
	return result;
}
function clear(value, observe) {
	const result = Map.prototype.clear.call(value);
	observe();
	return result;
}
function weak(value, observe) {
	const result = WeakRef.prototype.deref.call(value);
	observe();
	return result;
}
function split(value, separator, observe) {
	const result = String.prototype.split.call(value, separator);
	observe();
	return result;
}
function caught(value, observe) {
	const result = Promise.prototype.catch.call(value, () => 0);
	observe();
	return result;
}
function* suspendedPrototype(value) {
	const result = Object.getPrototypeOf(value);
	yield 1;
	return result;
}
Object.assign(globalThis, {
	descriptor,
	prototype,
	clear,
	weak,
	split,
	caught,
	suspendedPrototype,
});

const marker = { payload: "heap".repeat(100) };
const assigned = Object.assign(7, { field: marker });
check(typeof assigned, "object", "primitive assignment target is boxed");
collect();
check(assigned.field, marker, "boxed assignment result survives collection");
let traps = 0;
const proxy = new Proxy(
	{ field: marker },
	{
		getOwnPropertyDescriptor(target, key) {
			traps++;
			collect();
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		getPrototypeOf(target) {
			traps++;
			collect();
			return Reflect.getPrototypeOf(target);
		},
	},
);
check(
	descriptor(proxy, "field", collect).value,
	marker,
	"descriptor survives collection",
);
check(descriptor(proxy, "missing", collect), undefined, "absent descriptor");
const ordinaryPrototype = prototype(proxy, collect);
check(ordinaryPrototype, Object.prototype, "Object prototype result");
check(traps, 3, "Proxy observations retained");
check(prototype(Object.create(null), collect), null, "null prototype result");
const callable = () => 42;
const withCallablePrototype = Object.create(callable);
check(
	typeof prototype(withCallablePrototype, collect),
	"function",
	"Object bound permits callable values",
);
const frame = suspendedPrototype(withCallablePrototype);
check(frame.next().value, 1, "prototype suspension");
collect();
check(frame.next().value, callable, "prototype survives frame restore");

const map = new Map([[marker, marker]]);
check(clear(map, collect), undefined, "undefined mutator completion");
check(map.size, 0, "mutator effect retained");
let visits = 0;
check(
	Array.prototype.forEach.call([1, 2], () => {
		visits++;
		collect();
		return marker;
	}),
	undefined,
	"callback result is not forEach result",
);
check(visits, 2, "all callback effects retained");
check(weak(new WeakRef(marker), collect), marker, "weak object result");
const symbol = Symbol("weak");
check(weak(new WeakRef(symbol), collect), symbol, "weak Symbol result");

const splitter = {
	[Symbol.split]() {
		collect();
		return marker;
	},
};
check(split("text", splitter, collect), marker, "arbitrary split result");
check(
	caught(
		{
			then() {
				collect();
				return marker;
			},
		},
		collect,
	),
	marker,
	"arbitrary then protocol result",
);
check(
	Array.prototype.toString.call({
		join() {
			collect();
			return false;
		},
	}),
	false,
	"arbitrary join result",
);
const speciesInput = [marker];
speciesInput.constructor = {
	[Symbol.species]: class {
		constructor() {
			return function () {};
		}
	},
};
const mapped = Array.prototype.map.call(speciesInput, (value) => {
	collect();
	return value;
});
check(typeof mapped, "function", "species may return a callable object");
check(mapped[0], marker, "species writes retained");

try {
	descriptor(
		new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					collect();
					throw marker;
				},
			},
		),
		"field",
		collect,
	);
	throw new Error("missing descriptor exception");
} catch (error) {
	check(error, marker, "descriptor exception identity");
}
if (process.env.MAL_PRIMORDIALS === "mutable") {
	const original = Object.getPrototypeOf;
	try {
		Object.getPrototypeOf = () => false;
		check(prototype(proxy, collect), false, "mutable callee has an arbitrary result");
	} finally {
		Object.getPrototypeOf = original;
	}
}
console.log("object-normal-results PASS");
