function assert(condition, message) {
	if (!condition) throw new Error(message);
}
function date(input) {
	return new Date(input).getTime();
}
function typed(input) {
	return new Uint8Array(input).subarray(1);
}
function size(input) {
	return new Set(input).size;
}
function borrowed(input) {
	return Date.prototype.getTime.call(input);
}
function captured(input) {
	const value = new Date(input);
	const method = value.getTime;
	return method.call(value, (value.getTime = () => -1));
}
function shadow(input) {
	const value = new Date(input);
	value.getTime = () => 91;
	return value.getTime();
}
function customPrototype(input) {
	const value = new Date(input);
	Object.setPrototypeOf(value, {
		getTime() {
			return 81;
		},
	});
	return value.getTime();
}
for (let i = 0; i < 8; i++) {
	assert(date(i) === i, "dynamic Date receiver");
	assert(typed([1, i, 3]).join() === `${i},3`, "inherited typed-array method");
	assert(size([i, i, i + 1]) === 2, "native accessor");
	assert(captured(i) === i, "callee captured before argument mutation");
	assert(shadow(i) === 91, "own method shadows primordial");
	assert(customPrototype(i) === 81, "nonstandard prototype");
	assert(borrowed(new Date(i)) === i, "borrowed method");
}
let wrongBrand = false;
for (let i = 0; i < 8; i++) {
	const error = new Error(`value ${i}`, { cause: i });
	assert(
		error.toString() === `Error: value ${i}` &&
			error.message === `value ${i}` &&
			error.cause === i,
		"Error method and own payload",
	);
	const target = { i };
	assert(
		new WeakRef(target).deref() === target,
		"weak receiver retains its target during the job",
	);
	const stack = new DisposableStack();
	let disposed = 0;
	stack.defer(() => {
		disposed++;
	});
	stack.dispose();
	assert(disposed === 1 && stack.disposed, "disposable receiver state");
	const promised = new Promise((resolve) => resolve(i));
	assert(
		promised.then((value) => assert(value === i, "Promise callback value")) instanceof
			Promise,
		"Promise method allocates a distinct result",
	);
}
try {
	borrowed({});
} catch (error) {
	wrongBrand = error instanceof TypeError;
}
assert(wrongBrand, "borrowed method checks its receiver");
let calls = 0;
const proxy = new Proxy(new Date(5), {
	get(target, key) {
		calls++;
		return Reflect.get(target, key);
	},
});
try {
	proxy.getTime();
} catch (error) {
	assert(error instanceof TypeError, "proxy brand check");
}
assert(calls === 1, "proxy lookup happens once");

function applyMax(receiver, list) {
	return Math.max.apply(receiver, list);
}
function reflectMax(receiver, list) {
	return Reflect.apply(Math.max, receiver, list);
}
function boundMax(list) {
	return Math.max.bind(null, 7)(...list);
}
function reflectDate(list, target) {
	return Reflect.construct(Date, list, target);
}
function spreadDate(list) {
	return new Date(...list);
}
const events = [];
const argumentList = new Proxy(
	{ length: 2, 0: 3, 1: 9 },
	{
		get(target, key) {
			events.push(String(key));
			return Reflect.get(target, key);
		},
	},
);
assert(applyMax(null, argumentList) === 9, "apply dynamic argument list");
assert(events.join() === "length,0,1", "apply observes each argument getter once");
events.length = 0;
assert(reflectMax(null, argumentList) === 9, "Reflect.apply dynamic argument list");
assert(events.join() === "length,0,1", "Reflect.apply getter order");
assert(applyMax(null, null) === -Infinity, "Function.apply accepts null list");
let rejected = false;
try {
	reflectMax(null, null);
} catch (error) {
	rejected = error instanceof TypeError;
}
assert(rejected, "Reflect.apply rejects null list");
events.length = 0;
try {
	reflectDate(argumentList, () => {});
} catch (error) {
	assert(error instanceof TypeError, "newTarget is a constructor");
}
assert(events.length === 0, "Reflect.construct validates before reading its list");
assert(reflectDate([11], Date).getTime() === 11, "Reflect.construct target");
function Custom() {}
const constructed = reflectDate([12], Custom);
assert(
	Object.getPrototypeOf(constructed) === Custom.prototype,
	"custom newTarget prototype",
);
assert(
	Date.prototype.getTime.call(constructed) === 12,
	"custom prototype preserves brand",
);
let iterations = 0;
const iterable = {
	*[Symbol.iterator]() {
		iterations++;
		yield 2;
		yield 5;
	},
};
assert(boundMax(iterable) === 7, "bound leading arguments precede dynamic spread");
assert(iterations === 1, "custom spread iterator is consumed once");
assert(spreadDate([13]).getTime() === 13, "constructor spread");

let optionalArguments = 0;
function optionalDate(input) {
	const value = input ? new Date(input) : null;
	return value?.getTime(optionalArguments++);
}
assert(
	optionalDate(0) === undefined && optionalArguments === 0,
	"optional receiver skips arguments",
);
assert(
	optionalDate(17) === 17 && optionalArguments === 1,
	"optional receiver calls once",
);
const ownAdapter = (value) => value;
ownAdapter.call = () => 23;
assert(ownAdapter.call(null, 11) === 23, "own call adapter override");
let recursiveCoercions = 0;
function recurseKnown(depth) {
	return Math.max(0, {
		valueOf() {
			recursiveCoercions++;
			const retained = Array.from({ length: 64 }, (_, index) => ({ index }));
			return depth === 0 ? retained[1].index : recurseKnown(depth - 1) + 1;
		},
	});
}
assert(
	recurseKnown(8) === 9 && recursiveCoercions === 9,
	"recursive native callback frames and roots",
);

function includes(input) {
	return [1, NaN, undefined, -0].includes(input);
}
for (const [input, expected] of [
	[1, true],
	[NaN, true],
	[undefined, true],
	[0, true],
	[2, false],
	[{}, false],
]) {
	assert(includes(input) === expected, "SameValueZero includes");
}
function includesFrom(input) {
	return [3, 2, 1].includes(input, -1);
}
assert(includesFrom(1) && !includesFrom(3), "negative includes offset");
let coercions = 0;
const from = {
	valueOf() {
		coercions++;
		return 0;
	},
};
[1].includes(1, from);
assert(coercions === 1, "unused includes preserves coercion");
[].includes(1, from);
assert(coercions === 1, "empty includes skips coercion");
let callbacks = 0;
[1, 2].map((value) => {
	callbacks++;
	return value;
});
[2, 1].toSorted((left, right) => {
	callbacks++;
	return left - right;
});
assert(callbacks === 3, "unused fresh results preserve callbacks");
function fractionalIncludes(input) {
	return [-0, 2.5, 5n].includes(input);
}
assert(
	fractionalIncludes(2.5) && !fractionalIncludes(2) && fractionalIncludes(0),
	"materialized IEEE numeric constants",
);
function sliceNumber(input) {
	return Number(input.slice(1));
}
function regexpNumber(input) {
	const match = /(\d+)x/.exec(input);
	return match === null ? 0 : Number(match[1]);
}
function regexpNumbers(input) {
	let total = 0;
	for (const match of input.matchAll(/(\d+)x/g)) total += Number(match[1]);
	return total;
}
for (let i = 0; i < 10; i++) {
	assert(sliceNumber(`x${i}`) === i, "slice Number fusion");
	assert(
		regexpNumber(`${i}x`) === i && regexpNumber("none") === 0,
		"RegExp Number projection",
	);
	assert(regexpNumbers(`${i}x,2x`) === i + 2, "RegExp iterator Number projection");
}
console.log("known operations passed");
