const gc = globalThis.__mal_collect_garbage ?? (() => {});

function numericWorkerLoop(value, count) {
	for (let index = 0; index < count; index++) value = value * 1.25 - 0.5;
	return value;
}
function numericWorkerCollatz(value) {
	let steps = 0;
	while (value > 1) {
		value = (value & 1) === 0 ? value / 2 : value * 3 + 1;
		steps++;
	}
	return steps;
}
function numericWorkerSpin(value) {
	while (value > 0) value++;
	return value;
}
function numericWorkerSpinCaller() {
	try {
		return numericWorkerSpin(1);
	} catch {
		return 99;
	}
}
function numericWorkerPayload(value, count) {
	const payload = { value: String(value) };
	const result = numericWorkerLoop(value, count);
	gc();
	return `${payload.value}:${String(result)}`;
}
globalThis.numericWorkerLoop = numericWorkerLoop;
globalThis.numericWorkerCollatz = numericWorkerCollatz;
globalThis.numericWorkerSpinCaller = numericWorkerSpinCaller;

if (numericWorkerLoop(3, 0) !== 3 || numericWorkerLoop(3, 1) !== 3.25)
	throw new Error("numeric loop iteration mismatch");
if (numericWorkerCollatz(1) !== 0 || numericWorkerCollatz(27) !== 111)
	throw new Error("numeric collatz mismatch");
for (const value of [
	-0,
	0,
	NaN,
	Infinity,
	-Infinity,
	Number.MIN_VALUE,
	Number.MAX_SAFE_INTEGER,
	7,
]) {
	for (const count of [0, 1, 2, 32, NaN, -Infinity]) {
		let expected = value;
		for (let index = 0; index < count; index++) expected = expected * 1.25 - 0.5;
		const result = numericWorkerLoop(value, count);
		if (!Object.is(result, expected)) throw new Error("numeric loop IEEE mismatch");
		if (numericWorkerPayload(value, count) !== `${String(value)}:${String(expected)}`)
			throw new Error("numeric loop caller root mismatch");
	}
}
const loopPayload = numericWorkerPayload(2, 4096);
if (loopPayload !== "2:2") throw new Error("numeric long loop root mismatch");
console.log("native-numeric-workers PASS");
