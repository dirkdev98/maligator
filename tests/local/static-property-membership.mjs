function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function ownPresence(value) {
	const record = { present: value };
	return "present" in record;
}

function accessorPresence(value) {
	const record = {
		get present() {
			throw value;
		},
	};
	return "present" in record;
}

function arrayLengthPresence(value, observe) {
	const array = [value];
	observe(array);
	return "length" in array;
}

function deletedPresence(value) {
	const record = { present: value };
	delete record.present;
	return "present" in record;
}

function coercedPresence(value, observe) {
	const record = { present: value };
	const key = {
		[Symbol.toPrimitive](hint) {
			assert(hint === "string", "membership key hint");
			observe(record);
			return "present";
		},
	};
	return key in record;
}

function* privateGenerator(value) {
	const record = { present: value };
	yield 1;
	return "present" in record;
}

function* escapingGenerator(value) {
	const record = { present: value };
	yield record;
	return "present" in record;
}

async function privateAsync(value) {
	const record = { present: value };
	await 1;
	return "present" in record;
}

async function escapingAsync(value, observe) {
	const record = { present: value };
	await observe(record);
	return "present" in record;
}

async function* privateAsyncGenerator(value) {
	const record = { present: value };
	yield 1;
	return "present" in record;
}

async function* escapingAsyncGenerator(value) {
	const record = { present: value };
	yield record;
	return "present" in record;
}

globalThis.membershipProbes = {
	ownPresence,
	accessorPresence,
	arrayLengthPresence,
	deletedPresence,
	coercedPresence,
	privateGenerator,
	escapingGenerator,
	privateAsync,
	escapingAsync,
	privateAsyncGenerator,
	escapingAsyncGenerator,
};

const marker = { value: 42 };
assert(ownPresence(marker) && accessorPresence(marker), "own data and accessor presence");
assert(1 in { 1: marker } && 1n in { 1: marker }, "numeric keys");
assert((-0) in { 0: marker } && true in { true: marker }, "converted primitive keys");
assert(null in { null: marker } && undefined in { undefined: marker }, "nullish keys");
assert(1 in [, marker] && !(0 in [, marker]), "Array holes");
const symbol = Symbol("own");
assert(symbol in { [symbol]: marker }, "Symbol identity");
assert(Symbol.iterator in { [Symbol.iterator]: marker }, "well-known Symbol key");
assert(!("missing" in { __proto__: null }), "null prototype absence");

const order = [];
const left = () => {
	order.push("left");
	return "present";
};
const right = () => {
	order.push("right");
	return marker;
};
assert(left() in { present: right() }, "effectful operands");
assert(order.join(",") === "left,right", "operand evaluation order");

let conversions = 0;
assert(
	!coercedPresence(marker, (record) => {
		conversions++;
		delete record.present;
		globalThis.gc?.();
	}),
	"key conversion before presence",
);
assert(conversions === 1, "single key conversion");
try {
	coercedPresence(marker, () => {
		throw marker;
	});
	assert(false, "throwing key accepted");
} catch (error) {
	assert(error === marker, "key exception identity");
}

for (const value of [null, undefined, 1, false, 1n, Symbol.iterator, "text"]) {
	const key = {
		[Symbol.toPrimitive]() {
			conversions++;
			return "present";
		},
	};
	try {
		key in value;
		assert(false, "primitive receiver accepted");
	} catch (error) {
		assert(error instanceof TypeError, "primitive receiver throws first");
	}
}
assert(conversions === 1, "receiver check precedes key conversion");

let traps = 0;
const proxy = new Proxy(
	{ present: marker },
	{
		has(_target, key) {
			assert(key === "present", "Proxy key");
			traps++;
			return false;
		},
	},
);
assert(!("present" in proxy) && traps === 1, "Proxy has trap");
const throwingProxy = new Proxy(
	{},
	{
		has() {
			throw marker;
		},
	},
);
try {
	"present" in throwingProxy;
	assert(false, "throwing Proxy accepted");
} catch (error) {
	assert(error === marker, "Proxy exception identity");
}
assert(
	arrayLengthPresence(marker, (array) => {
		array.length = 0;
		Object.setPrototypeOf(array, throwingProxy);
		globalThis.gc?.();
	}),
	"genuine Array length survives mutation and prototype replacement",
);

if (process.env.MAL_PRIMORDIALS === "mutable") {
	Object.prototype.present = 1;
	try {
		assert(deletedPresence(marker), "deleted own property can be inherited");
	} finally {
		delete Object.prototype.present;
	}
}
assert(!deletedPresence(marker), "deleted property absence");

const generator = privateGenerator(marker);
assert(generator.next().value === 1, "private generator yields");
globalThis.gc?.();
assert(generator.next().value === true, "private generator presence");
const escaping = escapingGenerator(marker);
delete escaping.next().value.present;
globalThis.gc?.();
assert(escaping.next().value === false, "yielded record mutation");
assert(await privateAsync(marker), "private async presence");
assert(
	!(await escapingAsync(marker, async (record) => {
		delete record.present;
		globalThis.gc?.();
	})),
	"async escaped record mutation",
);
const asyncGenerator = privateAsyncGenerator(marker);
assert((await asyncGenerator.next()).value === 1, "private async generator yields");
globalThis.gc?.();
assert((await asyncGenerator.next()).value === true, "private async generator presence");
const asyncEscaping = escapingAsyncGenerator(marker);
delete (await asyncEscaping.next()).value.present;
globalThis.gc?.();
assert((await asyncEscaping.next()).value === false, "async yielded record mutation");
console.log("static property membership semantics passed");
