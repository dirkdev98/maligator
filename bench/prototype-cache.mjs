// Inherited-property lookup benchmark. The four phases distinguish an existing
// runtime-owned prototype, the common one-/two-link userland chains, and the
// steady state after a prototype method is replaced. The result identities keep
// the loads observable without adding call-dispatch cost to the measurement.

const iterations = 20_000_000;
const warmupIterations = Math.min(iterations, 20_000);

function originalMethod(value) {
	return value + 1;
}

function replacementMethod(value) {
	return value + 2;
}

const runtimeReceiver = [];
const holder = Object.create(null);
holder.method = originalMethod;
const directReceiver = Object.create(holder);
const middle = Object.create(holder);
const deepReceiver = Object.create(middle);

function loadRuntime(receiver, count) {
	let value;
	for (let index = 0; index < count; index++) value = receiver.values;
	return value;
}

function loadDirect(receiver, count) {
	let value;
	for (let index = 0; index < count; index++) value = receiver.method;
	return value;
}

function loadDeep(receiver, count) {
	let value;
	for (let index = 0; index < count; index++) value = receiver.method;
	return value;
}

function loadAfterMutation(receiver, count) {
	let value;
	for (let index = 0; index < count; index++) value = receiver.method;
	return value;
}

loadRuntime(runtimeReceiver, warmupIterations);
loadDirect(directReceiver, warmupIterations);
loadDeep(deepReceiver, warmupIterations);

let start = Date.now();
const runtimeResult = loadRuntime(runtimeReceiver, iterations);
const runtimeMs = Date.now() - start;

start = Date.now();
const directResult = loadDirect(directReceiver, iterations);
const userlandDirectMs = Date.now() - start;

start = Date.now();
const deepResult = loadDeep(deepReceiver, iterations);
const userlandDeepMs = Date.now() - start;

holder.method = replacementMethod;
if (
	directReceiver.method !== replacementMethod ||
	deepReceiver.method !== replacementMethod
) {
	throw new Error("prototype-cache mutation probe failed");
}
loadAfterMutation(deepReceiver, warmupIterations);

start = Date.now();
const mutationResult = loadAfterMutation(deepReceiver, iterations);
const postMutationMs = Date.now() - start;

if (
	runtimeResult !== Array.prototype.values ||
	directResult !== originalMethod ||
	deepResult !== originalMethod ||
	mutationResult !== replacementMethod
) {
	throw new Error("prototype-cache result probe failed");
}

console.log(
	JSON.stringify({
		iterations,
		runtimeMs,
		userlandDirectMs,
		userlandDeepMs,
		postMutationMs,
	}),
);
