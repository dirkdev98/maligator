// Inherited-property lookup benchmark. The four phases distinguish an existing
// runtime-owned prototype, the common one-/two-link userland chains, and the
// steady state after a prototype method is replaced. The result identities keep
// the loads observable without adding call-dispatch cost to the measurement.

const iterations = 20_000_000;
const warmupIterations = Math.min(iterations, 20_000);
const minimumPhaseMs = 25;

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
let fourLinkReceiver = holder;
for (let depth = 0; depth < 4; depth++) {
	fourLinkReceiver = Object.create(fourLinkReceiver);
}
let eightLinkReceiver = holder;
for (let depth = 0; depth < 8; depth++) {
	eightLinkReceiver = Object.create(eightLinkReceiver);
}

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

function loadFourLinks(receiver, count) {
	let value;
	for (let index = 0; index < count; index++) value = receiver.method;
	return value;
}

function loadEightLinks(receiver, count) {
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
loadFourLinks(fourLinkReceiver, warmupIterations);
loadEightLinks(eightLinkReceiver, warmupIterations);

function measure(load, receiver) {
	let result;
	const start = Date.now();
	let calls = 0;
	let elapsed;
	do {
		result = load(receiver, iterations);
		calls++;
		elapsed = Date.now() - start;
	} while (elapsed < minimumPhaseMs);
	return [result, elapsed / calls, calls];
}

const [runtimeResult, runtimeMs, runtimeCalls] = measure(loadRuntime, runtimeReceiver);
const [directResult, userlandDirectMs, userlandDirectCalls] = measure(
	loadDirect,
	directReceiver,
);
const [deepResult, userlandDeepMs, userlandDeepCalls] = measure(loadDeep, deepReceiver);
const [fourLinkResult, userlandFourLinkMs, userlandFourLinkCalls] = measure(
	loadFourLinks,
	fourLinkReceiver,
);
const [eightLinkResult, userlandEightLinkMs, userlandEightLinkCalls] = measure(
	loadEightLinks,
	eightLinkReceiver,
);

holder.method = replacementMethod;
if (
	directReceiver.method !== replacementMethod ||
	deepReceiver.method !== replacementMethod ||
	fourLinkReceiver.method !== replacementMethod ||
	eightLinkReceiver.method !== replacementMethod
) {
	throw new Error("prototype-cache mutation probe failed");
}
loadAfterMutation(deepReceiver, warmupIterations);

const [mutationResult, postMutationMs, postMutationCalls] = measure(
	loadAfterMutation,
	deepReceiver,
);

if (
	runtimeResult !== Array.prototype.values ||
	directResult !== originalMethod ||
	deepResult !== originalMethod ||
	fourLinkResult !== originalMethod ||
	eightLinkResult !== originalMethod ||
	mutationResult !== replacementMethod
) {
	throw new Error("prototype-cache result probe failed");
}

console.log(
	JSON.stringify({
		iterations,
		measuredCalls:
			runtimeCalls +
			userlandDirectCalls +
			userlandDeepCalls +
			userlandFourLinkCalls +
			userlandEightLinkCalls +
			postMutationCalls,
		runtimeMs,
		userlandDirectMs,
		userlandDeepMs,
		userlandFourLinkMs,
		userlandEightLinkMs,
		postMutationMs,
	}),
);
