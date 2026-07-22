let checksum = 0;

function* sequence(seed) {
	let value = arguments[0];
	for (let i = 0; i < 3; i++) {
		value = value * 3 + i;
		yield value;
	}
}

const resultMetadata = sequence(1).next();
const resultKeys = Reflect.ownKeys(resultMetadata);
const valueDescriptor = Object.getOwnPropertyDescriptor(resultMetadata, "value");
const doneDescriptor = Object.getOwnPropertyDescriptor(resultMetadata, "done");
if (
	resultKeys.length !== 2 ||
	resultKeys[0] !== "value" ||
	resultKeys[1] !== "done" ||
	!valueDescriptor.writable ||
	!valueDescriptor.enumerable ||
	!valueDescriptor.configurable ||
	!doneDescriptor.writable ||
	!doneDescriptor.enumerable ||
	!doneDescriptor.configurable
) {
	throw new Error("iterator result metadata");
}

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("coroutine-pool requires MAL_HOST_GC=1");
}

// A yield must keep owning its frame. Force a collection while these generators
// remain reachable, then verify their locals and resume points are still intact.
const suspended = [];
for (let i = 0; i < 64; i++) {
	const generator = sequence(i);
	const first = generator.next();
	if (first.done || first.value !== i * 3) throw new Error("suspended first yield " + i);
	suspended.push(generator);
}
gc();
gc();
for (let i = 0; i < suspended.length; i++) {
	const second = suspended[i].next();
	if (second.done || second.value !== i * 9 + 1) {
		throw new Error("suspended frame resumed incorrectly " + i);
	}
}

// The interpreter owns a separate argument buffer when the arguments object
// escapes. This one exceeds the 64 KiB per-buffer policy and must never be pooled.
function* wideArguments() {
	const captured = arguments;
	yield captured.length;
}
const wideValues = new Array(9000).fill(1);
for (let i = 0; i < 4; i++) {
	const generator = wideArguments(...wideValues);
	const first = generator.next();
	if (first.done || first.value !== wideValues.length) throw new Error("wide arguments");
	const returned = generator.return("wide");
	if (!returned.done || returned.value !== "wide") throw new Error("wide return");
}

for (let i = 0; i < 2000; i++) {
	for (const value of sequence(i)) checksum = (checksum + value) % 1000000007;

	const returned = sequence(i).return(i + 10);
	if (!returned.done || returned.value !== i + 10) throw new Error("unstarted return");

	const thrown = sequence(i);
	try {
		thrown.throw(i + 20);
		throw new Error("unstarted throw did not throw");
	} catch (error) {
		if (error !== i + 20) throw error;
	}
}

async function* queued(count) {
	for (let i = 0; i < count; i++) yield await Promise.resolve(i * 7);
}

const iterator = queued(96);
const requests = [];
for (let i = 0; i <= 96; i++) requests.push(iterator.next());

gc();
gc();

Promise.all(requests).then((results) => {
	for (let i = 0; i < 96; i++) {
		if (results[i].done || results[i].value !== i * 7) {
			throw new Error("async-generator request order at " + i);
		}
		checksum = (checksum + results[i].value) % 1000000007;
	}
	if (!results[96].done || results[96].value !== undefined) {
		throw new Error("async-generator completion");
	}
	if (checksum !== 78004920) throw new Error("coroutine checksum " + checksum);
	console.log("coroutine-pool PASS");
});
