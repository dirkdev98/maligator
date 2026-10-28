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
function arrayBrand(value, observe) {
	const result = Array.isArray(value, observe());
	observe();
	return result;
}
function viewBrand(value, observe) {
	const result = ArrayBuffer.isView(value, observe());
	observe();
	return result;
}
function rawBrand(value, observe) {
	const result = JSON.isRawJSON(value, observe());
	observe();
	return result;
}
function* suspendedBrand(value) {
	const result = Array.isArray(value);
	yield 1;
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
	arrayBrand,
	viewBrand,
	rawBrand,
	suspendedBrand,
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
let observations = 0;
const observeBrand = () => {
	observations++;
	collect();
};
const brandedProxy = Proxy.revocable([], {
	get() {
		throw new Error("brand predicate invoked get");
	},
	getPrototypeOf() {
		throw new Error("brand predicate invoked getPrototypeOf");
	},
});
const nestedProxy = new Proxy(brandedProxy.proxy, {});
check(
	arrayBrand(nestedProxy, observeBrand),
	true,
	"IsArray unwraps nested proxies without traps",
);
check(observations, 2, "ignored argument and later observer both run");
check(viewBrand(new Uint8Array(1), collect), true, "TypedArray view brand");
check(viewBrand(new DataView(new ArrayBuffer(1)), collect), true, "DataView brand");
check(
	viewBrand(new Proxy(new Uint8Array(1), {}), collect),
	false,
	"Proxy has no view slots",
);
const raw = JSON.rawJSON("42");
check(rawBrand(raw, collect), true, "raw JSON internal slot");
check(rawBrand(new Proxy(raw, {}), collect), false, "Proxy has no raw JSON slot");
check(
	rawBrand({ rawJSON: "42" }, collect),
	false,
	"rawJSON property does not confer brand",
);
brandedProxy.revoke();
try {
	arrayBrand(nestedProxy, collect);
	throw new Error("missing revoked Proxy exception");
} catch (error) {
	check(error instanceof TypeError, true, "IsArray revoked Proxy exception");
}
check(
	viewBrand(brandedProxy.proxy, collect),
	false,
	"isView accepts revoked Proxy without traps",
);
check(
	rawBrand(brandedProxy.proxy, collect),
	false,
	"isRawJSON accepts revoked Proxy without traps",
);
const brandFrame = suspendedBrand([]);
check(brandFrame.next().value, 1, "brand result suspension");
collect();
check(brandFrame.next().value, true, "Boolean brand result restored after suspension");
check(Array.isArray(), false, "missing array argument");
check(ArrayBuffer.isView(), false, "missing view argument");
check(JSON.isRawJSON(), false, "missing raw JSON argument");
if (process.env.MAL_PRIMORDIALS === "mutable") {
	for (const [owner, key, invoke] of [
		[Array, "isArray", arrayBrand],
		[ArrayBuffer, "isView", viewBrand],
		[JSON, "isRawJSON", rawBrand],
	]) {
		const original = owner[key];
		try {
			owner[key] = () => marker;
			check(
				invoke([], collect),
				marker,
				"mutable brand callee returns arbitrary heap value",
			);
		} finally {
			owner[key] = original;
		}
	}
	const original = Object.getPrototypeOf;
	try {
		Object.getPrototypeOf = () => false;
		check(prototype(proxy, collect), false, "mutable callee has an arbitrary result");
	} finally {
		Object.getPrototypeOf = original;
	}
}
console.log("object-normal-results PASS");
