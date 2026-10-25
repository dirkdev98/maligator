const events = [];
function collect() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}
function refined(value, flag) {
	if (flag === flag) return value * 1.25 - 0.5;
	return +globalThis.refinedFallback(value);
}
globalThis.refined = refined;
function discard(input, result) {
	+input;
	~input;
	input + 1;
	input < 0;
	return result;
}
globalThis.discard = discard;
globalThis.refinedFallback = function (value) {
	events.push(`fallback:${String(value)}`);
	collect();
	return {
		valueOf() {
			events.push("convert");
			collect();
			return value + 10;
		},
	};
};
for (const value of [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, 3]) {
	for (const flag of [false, true]) {
		const result = refined(+value, !!flag);
		if (!Object.is(result, value * 1.25 - 0.5)) throw new Error("leaf IEEE mismatch");
	}
}
if (events.length !== 0) throw new Error("leaf entered its dead fallback");
for (const value of [-0, NaN, Infinity, 3])
	if (discard(+value, 7) !== 7) throw new Error("discarded numeric operation");
const observed = {
	valueOf() {
		events.push("unused:convert");
		collect();
		return 2;
	},
};
if (globalThis.discard(observed, 7) !== 7) throw new Error("discarded result");
for (const value of [Symbol("unused"), 1n]) {
	try {
		globalThis.discard(value, 7);
		throw new Error("discarded throwing operation");
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		events.push(`unused:${typeof value}:${error.name}`);
	}
}
for (const value of [-0, NaN, Infinity, 3]) {
	const result = globalThis.refined(value, NaN);
	if (!Object.is(result, value + 10)) throw new Error("canonical fallback mismatch");
}
Object.defineProperty(globalThis, "refinedFallback", {
	get() {
		events.push("get:throw");
		collect();
		throw new RangeError("fallback");
	},
});
if (refined(2, !!globalThis.flag) !== 2) throw new Error("leaf observed fallback getter");
try {
	globalThis.refined(2, NaN);
	throw new Error("missing canonical throw");
} catch (error) {
	if (!(error instanceof RangeError)) throw error;
	events.push(error.name);
}
console.log(events.join("\n"));
