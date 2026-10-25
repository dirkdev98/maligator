const events = [];
const failure = { marker: "call failure" };
function collectGarbage() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}
function hook(value) {
	events.push(value === failure ? "caught" : "hook");
	collectGarbage();
}
const integer = function integer(value, callback) {
	try {
		callback();
		return value | 0;
	} catch (error) {
		callback(error);
		throw error;
	}
};
const numeric = function numeric(value, callback) {
	try {
		callback();
		return -value;
	} catch (error) {
		callback(error);
		throw error;
	}
};
const optional = function optional(value, callback) {
	try {
		callback();
		if (value) return value | 0;
	} catch (error) {
		callback(error);
		throw error;
	}
};
const identity = function identity(value, callback) {
	try {
		callback();
		return value;
	} catch (error) {
		throw error;
	}
};
function compute(value, callback) {
	const result = integer(value, callback);
	collectGarbage();
	return result + 1;
}
function concat(value, callback) {
	const result = numeric(value, callback);
	collectGarbage();
	return ":" + result;
}
function maybe(value, callback) {
	const result = optional(value, callback);
	collectGarbage();
	return ":" + result;
}
function closed(value, callback) {
	const result = identity(+value, callback);
	collectGarbage();
	return result + 1;
}
function spread(values) {
	const result = integer(...values);
	collectGarbage();
	return result + 1;
}
function rest(...values) {
	const result = integer(...values);
	collectGarbage();
	return result + 1;
}
function* resume(value, callback) {
	const before = integer(value, callback);
	yield before;
	const after = integer(value, callback);
	collectGarbage();
	return before + after;
}
function guarded(value, callback) {
	const result = globalThis.replaced(value, callback);
	collectGarbage();
	return result + 1;
}
globalThis.integer = integer;
globalThis.numeric = numeric;
globalThis.optional = optional;
globalThis.compute = compute;
globalThis.concat = concat;
globalThis.maybe = maybe;
globalThis.closed = closed;
globalThis.spread = spread;
globalThis.rest = rest;
globalThis.resume = resume;
globalThis.guarded = guarded;
globalThis.replaced = integer;

function capture(run) {
	try {
		const value = run();
		return Object.is(value, -0) ? "-0" : String(value);
	} catch (error) {
		return error === failure ? "same failure" : error.name;
	}
}
const inputs = [
	0,
	-0,
	3,
	NaN,
	Infinity,
	"7",
	null,
	undefined,
	true,
	17n,
	Symbol("input"),
	{
		valueOf() {
			events.push("valueOf");
			collectGarbage();
			return 9;
		},
	},
	{
		[Symbol.toPrimitive](hint) {
			events.push(hint);
			collectGarbage();
			throw failure;
		},
	},
];
for (const value of inputs) {
	console.log(
		capture(() => compute(value, hook)),
		capture(() => concat(value, hook)),
	);
	console.log(
		capture(() => maybe(value, hook)),
		capture(() => closed(value, hook)),
	);
	console.log(
		capture(() => spread([value, hook])),
		capture(() => rest(value, hook)),
	);
	console.log(
		capture(() => {
			const iterator = resume(value, hook);
			const first = iterator.next();
			collectGarbage();
			return String(first.value) + "," + iterator.next().value;
		}),
	);
	console.log(capture(() => guarded(value, hook)));
}
for (const replacement of [
	() => "text",
	() => 7n,
	() => Symbol("result"),
	() => ({
		valueOf() {
			collectGarbage();
			return "object";
		},
	}),
]) {
	globalThis.replaced = replacement;
	console.log(capture(() => guarded(3, hook)));
}
console.log(events.join(","));
