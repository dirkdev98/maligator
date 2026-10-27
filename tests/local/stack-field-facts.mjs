function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
const collect = () => globalThis.gc?.();
const payload = "payload".repeat(100);

function numberField(value, observe, materialize) {
	const object = { x: 1.5, keep: 2, flag: true, payload };
	if (typeof value === "number") object.x = value;
	observe();
	if (materialize) return object;
	return object === value ? null : object.x;
}
function booleanField(value, observe, materialize) {
	const object = { x: true, keep: 2, payload };
	if (typeof value === "boolean") object.x = value;
	observe();
	if (materialize) return object;
	return object === value ? null : object.x;
}
function stringField(value, observe, materialize) {
	const object = { x: "old", keep: 2, payload };
	if (typeof value === "string") object.x = value;
	observe();
	if (materialize) return object;
	return object === value ? null : object.x;
}
function observedNumber(value, observe) {
	const object = { x: 1.5, keep: 2 };
	if (typeof value === "number") object.x = value;
	observe(object);
	if (typeof value === "number") object.x = value;
	return object.x;
}
function mixedField(value, observe) {
	const object = { x: 1.5, keep: 2 };
	object.x = value;
	observe();
	return object === value ? null : object.x;
}
Object.assign(globalThis, {
	numberField,
	booleanField,
	stringField,
	observedNumber,
	mixedField,
});

const marker = { value: payload };
const hostile = {
	valueOf() {
		throw marker;
	},
	toString() {
		throw marker;
	},
};
const inputs = [
	-0,
	NaN,
	Infinity,
	-Infinity,
	2147483648,
	Number.MAX_SAFE_INTEGER,
	true,
	false,
	"heap".repeat(100),
	undefined,
	null,
	2n ** 60n + 3n,
	Symbol("field"),
	hostile,
];
for (const value of inputs) {
	for (const [fn, type, initial] of [
		[numberField, "number", 1.5],
		[booleanField, "boolean", true],
		[stringField, "string", "old"],
	]) {
		const expected = typeof value === type ? value : initial;
		check(fn(value, collect, false), expected, `${type} virtual field`);
		const object = fn(value, collect, true);
		collect();
		check(object.x, expected, `${type} materialized field`);
		check(object.keep, 2, "sibling integer field");
		check(object.payload, payload, "sibling heap field");
	}
	check(mixedField(value, collect), value, "unknown writer remains boxed");
}

const events = [];
const installAccessor = (object) => {
	collect();
	Object.defineProperty(object, "x", {
		get() {
			events.push("get");
			collect();
			return marker;
		},
		set(value) {
			events.push(value);
			collect();
		},
		configurable: true,
	});
};
check(observedNumber(-0, installAccessor), marker, "materialized accessor read");
check(events.length, 2, "materialized setter and getter effects");
check(events[0], -0, "materialized setter retains signed zero");
check(events[1], "get", "materialized accessor order");
check(
	observedNumber(hostile, (object) => {
		object.x = marker;
		collect();
	}),
	marker,
	"observer changes field kind",
);
try {
	observedNumber(7, () => {
		collect();
		throw marker;
	});
	throw new Error("missing observer exception");
} catch (error) {
	check(error, marker, "observer exception identity");
}
console.log("stack-field-facts PASS");
