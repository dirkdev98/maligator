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
const byte = function byte(value, callback) {
	try {
		callback();
		return value & 255;
	} catch (error) {
		callback(error);
		throw error;
	}
};
const unsigned = function unsigned(value, callback) {
	try {
		callback();
		return value >>> 0;
	} catch (error) {
		callback(error);
		throw error;
	}
};
const boundedFloating = function boundedFloating(value, callback) {
	try {
		callback();
		return (value & 255) + 1;
	} catch (error) {
		callback(error);
		throw error;
	}
};
const signedZero = function signedZero(value, callback) {
	try {
		callback();
		return value ? -0 : value & 255;
	} catch (error) {
		callback(error);
		throw error;
	}
};
const byteRelay = function byteRelay(value, callback) {
	try {
		callback();
		return byte(value, callback) + 1;
	} catch (error) {
		throw error;
	}
};
const recursiveByte = function recursiveByte(depth, value, callback) {
	try {
		callback();
		if (depth <= 0) return value & 255;
		return recursiveByte(depth - 1, value, callback);
	} catch (error) {
		throw error;
	}
};
const recursiveCount = function recursiveCount(depth, value, callback) {
	try {
		callback();
		if (depth <= 0) return value & 255;
		return recursiveCount(depth - 1, value, callback) + 1;
	} catch (error) {
		throw error;
	}
};
function chainedRemainder(value, callback) {
	const result = byteRelay(value, callback);
	collectGarbage();
	return result % 10;
}
function recursiveRemainder(depth, value, callback) {
	const result = recursiveByte(depth, value, callback);
	collectGarbage();
	return result % 10;
}
function recursiveGrowingRemainder(depth, value, callback) {
	const result = recursiveCount(depth, value, callback);
	collectGarbage();
	return result % 10;
}
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
function identityBounded(value, callback) {
	const result = identity((value & 255) + 1, callback);
	collectGarbage();
	return result ^ 7;
}
function identityText(value, callback) {
	const result = identity(":" + value, callback);
	collectGarbage();
	return result.length;
}
function identityPrefix(value, iterable) {
	const result = identity((value & 255) + 1, ...iterable);
	collectGarbage();
	return result ^ 7;
}
function identityTextPrefix(value, iterable) {
	const result = identity(":" + value, ...iterable);
	collectGarbage();
	return result.length;
}
function identitySame(value, callback) {
	const result = identity(value, callback);
	collectGarbage();
	return Object.is(result, value);
}
function identityDisjoint(value, callback) {
	const result = identity(value & 255, callback);
	collectGarbage();
	return Object.is(result, (value & 255) + 1024);
}
function identityStrict(value, callback) {
	const result = identity(value, callback);
	collectGarbage();
	return result === value;
}
function identitySameChain(value, callback) {
	const first = identity(value, callback);
	const result = identity(first, callback);
	collectGarbage();
	return Object.is(result, value);
}
function identitySamePrefix(value, iterable) {
	const result = identity(value, ...iterable);
	collectGarbage();
	return Object.is(result, value);
}
function* identitySameResume(value, callback) {
	const result = identity(value, callback);
	yield 0;
	collectGarbage();
	return Object.is(result, value);
}
const receiverIdentity = function receiverIdentity(callback) {
	"use strict";
	try {
		callback();
		return this;
	} catch (error) {
		throw error;
	}
};
function identitySameReceiver(callback) {
	const holder = { pass: receiverIdentity };
	const result = holder.pass(callback);
	collectGarbage();
	return Object.is(result, holder);
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
function byteRemainder(value, callback) {
	const result = byte(value, callback);
	collectGarbage();
	return result % 10;
}
function positiveRemainder(value, divisor, callback) {
	const result = unsigned(value, callback);
	const bound = (divisor & 65535) + 1;
	collectGarbage();
	return result % bound;
}
function unsignedRemainder(value, divisor, callback) {
	const result = unsigned(value, callback);
	const bound = unsigned(divisor, callback);
	collectGarbage();
	return result % bound;
}
function floatingResult(value, callback) {
	const result = boundedFloating(value, callback);
	collectGarbage();
	return result ^ 7;
}
function zeroResult(value, callback) {
	const result = signedZero(value, callback);
	collectGarbage();
	return result % 10;
}
function* resumeRange(value, callback) {
	yield 0;
	const result = byte(value, callback);
	yield result;
	collectGarbage();
	return result % 10;
}
globalThis.integer = integer;
globalThis.numeric = numeric;
globalThis.optional = optional;
globalThis.compute = compute;
globalThis.concat = concat;
globalThis.maybe = maybe;
globalThis.closed = closed;
globalThis.identityBounded = identityBounded;
globalThis.identityText = identityText;
globalThis.identityPrefix = identityPrefix;
globalThis.identityTextPrefix = identityTextPrefix;
globalThis.identitySame = identitySame;
globalThis.identityDisjoint = identityDisjoint;
globalThis.identityStrict = identityStrict;
globalThis.identitySameChain = identitySameChain;
globalThis.identitySamePrefix = identitySamePrefix;
globalThis.identitySameResume = identitySameResume;
globalThis.receiverIdentity = receiverIdentity;
globalThis.identitySameReceiver = identitySameReceiver;
globalThis.spread = spread;
globalThis.rest = rest;
globalThis.resume = resume;
globalThis.guarded = guarded;
globalThis.replaced = integer;
globalThis.byte = byte;
globalThis.unsigned = unsigned;
globalThis.boundedFloating = boundedFloating;
globalThis.signedZero = signedZero;
globalThis.byteRemainder = byteRemainder;
globalThis.positiveRemainder = positiveRemainder;
globalThis.unsignedRemainder = unsignedRemainder;
globalThis.floatingResult = floatingResult;
globalThis.zeroResult = zeroResult;
globalThis.resumeRange = resumeRange;
globalThis.byteRelay = byteRelay;
globalThis.recursiveByte = recursiveByte;
globalThis.recursiveCount = recursiveCount;
globalThis.chainedRemainder = chainedRemainder;
globalThis.recursiveRemainder = recursiveRemainder;
globalThis.recursiveGrowingRemainder = recursiveGrowingRemainder;

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
	"😀é\0",
	"\ud800",
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
		capture(() => identityBounded(value, hook)),
		capture(() => identityText(value, hook)),
		capture(() => identityPrefix(value, [hook])),
		capture(() => identityTextPrefix(value, [hook])),
	);
	console.log(
		capture(() => identitySame(value, hook)),
		capture(() => identityDisjoint(value, hook)),
		capture(() => identityStrict(value, hook)),
		capture(() => identitySameChain(value, hook)),
		capture(() => identitySamePrefix(value, [hook])),
	);
	console.log(
		capture(() => identitySameReceiver(hook)),
		capture(() => {
			const iterator = identitySameResume(value, hook);
			iterator.next();
			collectGarbage();
			return iterator.next().value;
		}),
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
	console.log(
		capture(() => byteRemainder(value, hook)),
		capture(() => floatingResult(value, hook)),
		capture(() => zeroResult(value, hook)),
	);
	console.log(
		capture(() => chainedRemainder(value, hook)),
		capture(() => recursiveRemainder(3, value, hook)),
		capture(() => recursiveGrowingRemainder(3, value, hook)),
	);
	console.log(
		capture(() => {
			const iterator = resumeRange(value, hook);
			iterator.next();
			const second = iterator.next();
			collectGarbage();
			return String(second.value) + "," + iterator.next().value;
		}),
	);
}
for (const value of [
	0, -0, -1, 255, 65536, 2147483647, 2147483648, 4294967295, 4294967296, 9007199254740991,
]) {
	for (const divisor of [0, -1, 1, 2, 65535, 2147483648, 4294967295])
		console.log(
			capture(() => positiveRemainder(value, divisor, hook)),
			capture(() => unsignedRemainder(value, divisor, hook)),
		);
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
