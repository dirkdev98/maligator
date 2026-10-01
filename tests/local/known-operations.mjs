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
function recordScript(first, second) {
	if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
	return { receiver: this, first, second, count: arguments.length };
}
const scriptTarget = Reflect.get(
	{ recordScript },
	globalThis.__scriptTargetKey ?? "recordScript",
);
function applyScript(target, receiver, first, second) {
	return Reflect.apply(target, receiver, [first, second]);
}
function borrowScript(target, receiver, first, second) {
	return target.apply(receiver, [first, second]);
}
const scriptReceiver = { marker: 42 };
for (const invoke of [applyScript, borrowScript]) {
	const result = invoke(scriptTarget, scriptReceiver, { marker: 7 }, { marker: 9 });
	assert(
		result.receiver === scriptReceiver &&
			result.first.marker === 7 &&
			result.second.marker === 9 &&
			result.count === 2,
		"flattened script arguments retain receiver, count and heap values",
	);
}
let scriptProxyCalls = 0;
const scriptProxy = new Proxy(scriptTarget, {
	apply(target, receiver, args) {
		scriptProxyCalls++;
		return Reflect.apply(target, receiver, args);
	},
});
assert(
	applyScript(scriptProxy, scriptReceiver, 3, 4).first === 3 && scriptProxyCalls === 1,
	"flattened apply preserves a callable proxy trap",
);
const boundScript = scriptTarget.bind(scriptReceiver, 5);
const boundScriptResult = Reflect.apply(boundScript, null, [6]);
assert(
	boundScriptResult.receiver === scriptReceiver &&
		boundScriptResult.first === 5 &&
		boundScriptResult.second === 6,
	"flattened apply preserves bound arguments and receiver",
);
const mutableScriptArgs = [1, 2];
events.length = 0;
const changedScriptResult = Reflect.apply(
	scriptTarget,
	scriptReceiver,
	mutableScriptArgs,
	((mutableScriptArgs[1] = 7), events.push("extra")),
);
assert(
	changedScriptResult.second === 7 && events.join() === "extra",
	"ignored adapter arguments still evaluate before the list snapshot",
);
let throwingExtraObserved = false;
function throwingExtra() {
	throw new Error("ignored argument");
}
try {
	Reflect.apply(scriptProxy, scriptReceiver, [1, 2], throwingExtra());
} catch (error) {
	throwingExtraObserved = error.message === "ignored argument";
}
assert(
	throwingExtraObserved && scriptProxyCalls === 1,
	"an ignored argument can throw before invoking the target",
);
events.length = 0;
const invalidTargetList = {
	get length() {
		events.push("length");
		throw new Error("list must not be inspected");
	},
};
let invalidScriptTargetThrows = false;
try {
	Reflect.apply(0, scriptReceiver, invalidTargetList);
} catch (error) {
	invalidScriptTargetThrows = error instanceof TypeError;
}
assert(
	invalidScriptTargetThrows && events.length === 0,
	"noncallable target validation precedes observable list reads",
);
let classCallThrows = false;
try {
	Reflect.apply(class RequiresConstruction {}, null, [1]);
} catch (error) {
	classCallThrows = error instanceof TypeError;
}
assert(classCallThrows, "flattened apply still rejects a class constructor call");
const inheritedScriptArgs = [, 2];
let inheritedScriptReads = 0;
Object.setPrototypeOf(inheritedScriptArgs, {
	get 0() {
		inheritedScriptReads++;
		return 9;
	},
});
const inheritedScriptResult = Reflect.apply(
	scriptTarget,
	scriptReceiver,
	inheritedScriptArgs,
);
assert(
	inheritedScriptResult.first === 9 &&
		inheritedScriptResult.second === 2 &&
		inheritedScriptReads === 1,
	"argument flattening retains an inherited getter on a hole",
);
function ScriptRecord(value) {
	this.value = value;
	this.observedTarget = new.target;
	if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
}
function constructScript(target, value) {
	return Reflect.construct(target, [value]);
}
const defaultScriptRecord = constructScript(ScriptRecord, { marker: 13 });
const sameScriptRecord = Reflect.construct(ScriptRecord, [14], ScriptRecord);
assert(
	defaultScriptRecord.value.marker === 13 &&
		defaultScriptRecord.observedTarget === ScriptRecord &&
		sameScriptRecord.observedTarget === ScriptRecord,
	"flattened construction preserves default and identical newTarget",
);
const alternateScriptRecord = Reflect.construct(ScriptRecord, [15], Custom);
assert(
	alternateScriptRecord.value === 15 &&
		alternateScriptRecord.observedTarget === Custom &&
		Object.getPrototypeOf(alternateScriptRecord) === Custom.prototype,
	"different newTarget retains Reflect construction semantics",
);
let undefinedNewTargetThrows = false;
try {
	Reflect.construct(ScriptRecord, [16], undefined);
} catch (error) {
	undefinedNewTargetThrows = error instanceof TypeError;
}
assert(
	undefinedNewTargetThrows,
	"explicit undefined newTarget is not an omitted argument",
);
const boundScriptRecord = ScriptRecord.bind(null, { marker: 17 });
const constructedBoundScript = Reflect.construct(boundScriptRecord, []);
assert(
	constructedBoundScript.value.marker === 17 &&
		constructedBoundScript.observedTarget === ScriptRecord,
	"flattened construction resolves a bound target",
);
console.log("known operations passed");
