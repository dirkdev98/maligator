const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") throw new Error("MAL_HOST_GC=1 is required");

function assert(condition) {
	if (!condition) throw new Error("Boolean wrapper lifetime invariant");
}
function objectInput() {
	const input = {
		[Symbol.toPrimitive]() {
			throw new Error("Boolean must not invoke ToPrimitive");
		},
	};
	globalThis.reference = new WeakRef(input);
	return input;
}
function symbolInput() {
	const input = Symbol("input");
	globalThis.reference = new WeakRef(input);
	return input;
}
globalThis.sink = function (wrapper) {
	globalThis.wrapper = wrapper;
	Object.setPrototypeOf(wrapper, null);
};
function* suspendedGenerator() {
	const wrapper = new Boolean(globalThis.makeInput());
	globalThis.sink(wrapper);
	yield 0;
	return (
		Boolean.prototype.toString.call(wrapper) +
		":" +
		Boolean.prototype.valueOf.call(wrapper)
	);
}
async function suspendedAsync() {
	const wrapper = new Boolean(globalThis.makeInput());
	globalThis.sink(wrapper);
	await new Promise((resolve) => {
		globalThis.resume = resolve;
	});
	return (
		Boolean.prototype.toString.call(wrapper) +
		":" +
		Boolean.prototype.valueOf.call(wrapper)
	);
}
globalThis.suspendedGenerator = suspendedGenerator;
globalThis.suspendedAsync = suspendedAsync;
function convertedInput() {
	const input = {
		[Symbol.toPrimitive]() {
			return 17;
		},
	};
	globalThis.reference = new WeakRef(input);
	return input;
}
function* suspendedNumberGenerator() {
	const wrapper = new Number(globalThis.makeInput());
	globalThis.sink(wrapper);
	yield 0;
	return (
		Number.prototype.toString.call(wrapper) + ":" + Number.prototype.valueOf.call(wrapper)
	);
}
globalThis.suspendedNumberGenerator = suspendedNumberGenerator;
async function suspendedNumberAsync() {
	const wrapper = new Number(globalThis.makeInput());
	globalThis.sink(wrapper);
	await new Promise((resolve) => {
		globalThis.resume = resolve;
	});
	return (
		Number.prototype.toString.call(wrapper) + ":" + Number.prototype.valueOf.call(wrapper)
	);
}
globalThis.suspendedNumberAsync = suspendedNumberAsync;
function* suspendedStringGenerator() {
	const wrapper = new String(globalThis.makeInput());
	globalThis.sink(wrapper);
	yield 0;
	return (
		String.prototype.toString.call(wrapper) + ":" + String.prototype.valueOf.call(wrapper)
	);
}
globalThis.suspendedStringGenerator = suspendedStringGenerator;
async function suspendedStringAsync() {
	const wrapper = new String(globalThis.makeInput());
	globalThis.sink(wrapper);
	await new Promise((resolve) => {
		globalThis.resume = resolve;
	});
	return (
		String.prototype.toString.call(wrapper) + ":" + String.prototype.valueOf.call(wrapper)
	);
}
globalThis.suspendedStringAsync = suspendedStringAsync;
let scenario = 0;
let previous;
function finish(value) {
	assert(value === (scenario < 4 ? "true:true" : "17:17"));
	assert(globalThis.wrapper !== previous);
	previous = globalThis.wrapper;
	scenario++;
	setTimeout(start, 0);
}
function start() {
	if (scenario === 8) {
		console.log("boolean wrapper lifetime PASS");
		return;
	}
	globalThis.makeInput =
		scenario < 4 ? (scenario % 2 === 0 ? objectInput : symbolInput) : convertedInput;
	const generator =
		scenario < 4
			? globalThis.suspendedGenerator
			: scenario < 6
				? globalThis.suspendedNumberGenerator
				: globalThis.suspendedStringGenerator;
	const asyncOperation =
		scenario < 4
			? globalThis.suspendedAsync
			: scenario < 6
				? globalThis.suspendedNumberAsync
				: globalThis.suspendedStringAsync;
	const isGenerator = scenario < 4 ? scenario < 2 : scenario % 2 === 0;
	if (isGenerator) {
		globalThis.iterator = generator();
		assert(globalThis.iterator.next().value === 0);
	} else {
		globalThis.pending = asyncOperation();
		globalThis.pending.then(finish);
	}
	setTimeout(() => {
		// The prior task checkpoint clears WeakRef's kept objects before forced collection.
		gc();
		assert(globalThis.reference.deref() === undefined);
		if (scenario < 4) assert(Boolean.prototype.valueOf.call(globalThis.wrapper) === true);
		else if (scenario < 6)
			assert(Number.prototype.valueOf.call(globalThis.wrapper) === 17);
		else assert(String.prototype.valueOf.call(globalThis.wrapper) === "17");
		if (isGenerator) {
			const result = globalThis.iterator.next();
			assert(result.done);
			finish(result.value);
		} else globalThis.resume();
	}, 0);
}
setTimeout(start, 0);
