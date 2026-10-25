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
function narrowNumber(input, flag) {
	if (flag !== flag) return globalThis.abiFallback;
	return +input;
}
function narrowBoolean(input, flag) {
	if (flag !== flag) return globalThis.abiFallback;
	return !!input;
}
function narrowString(input, flag) {
	if (flag !== flag) return globalThis.abiFallback;
	return String(input);
}
globalThis.narrowNumber = narrowNumber;
globalThis.narrowBoolean = narrowBoolean;
globalThis.narrowString = narrowString;
function phiNumber(input, flag) {
	const value = flag === flag ? 7 : input;
	return value + 1;
}
function phiText(input, flag) {
	const value = flag === flag ? "prefix" : input;
	return value + ":";
}
function phiCascade(input, flag) {
	const first = flag === flag ? "prefix" : input;
	const value = Number.isNaN(first) ? input : 7;
	return value + 1;
}
function phiNumberFromString(input, flag) {
	const value = flag === flag ? 7 : input;
	return value + 1;
}
function phiTextFromNumber(input, flag) {
	const value = flag === flag ? "prefix" : input;
	return value + ":";
}
function phiBoolean(input, flag) {
	const value = flag === flag ? false : input;
	return value;
}
globalThis.phiNumber = phiNumber;
globalThis.phiText = phiText;
globalThis.phiCascade = phiCascade;
globalThis.phiNumberFromString = phiNumberFromString;
globalThis.phiTextFromNumber = phiTextFromNumber;
globalThis.phiBoolean = phiBoolean;
globalThis.abiFallback = { marker: "fallback" };
const abiEvents = [];
const convertible = {
	valueOf() {
		abiEvents.push("abi:number");
		collect();
		return 7;
	},
	toString() {
		abiEvents.push("abi:string");
		collect();
		return "converted";
	},
};
if (narrowNumber(convertible, !!globalThis.flag) !== 7) throw new Error("Number ABI");
for (const value of [-0, NaN, Infinity, -Infinity])
	if (!Object.is(narrowNumber(+value, !!globalThis.flag), value))
		throw new Error("Number ABI IEEE value");
if (narrowBoolean(convertible, !!globalThis.flag) !== true)
	throw new Error("Boolean ABI");
if (narrowString(convertible, !!globalThis.flag) !== "converted")
	throw new Error("String ABI");
for (const fn of [
	globalThis.narrowNumber,
	globalThis.narrowBoolean,
	globalThis.narrowString,
])
	if (fn(convertible, NaN) !== globalThis.abiFallback) throw new Error("canonical ABI");
try {
	narrowNumber(Symbol("abi"), !!globalThis.flag);
	throw new Error("Number ABI swallowed conversion throw");
} catch (error) {
	if (!(error instanceof TypeError)) throw error;
	abiEvents.push(`abi:${error.name}`);
}
const beforePhi = abiEvents.length;
if (phiNumber(convertible, !!globalThis.flag) !== 8) throw new Error("phi Number");
if (phiText(convertible, !!globalThis.flag) !== "prefix:") throw new Error("phi String");
if (phiCascade(convertible, !!globalThis.flag) !== 8) throw new Error("phi cascade");
if (phiNumberFromString(String(globalThis.input), !!globalThis.flag) !== 8)
	throw new Error("String to Number phi");
if (phiTextFromNumber(+globalThis.input, !!globalThis.flag) !== "prefix:")
	throw new Error("Number to String phi");
if (phiBoolean(String(globalThis.input), !!globalThis.flag) !== false)
	throw new Error("String to Boolean phi");
if (abiEvents.length !== beforePhi) throw new Error("typed phi coerced dead input");
if (globalThis.phiNumber(convertible, NaN) !== 8) throw new Error("canonical phi Number");
if (globalThis.phiText(convertible, NaN) !== "7:")
	throw new Error("canonical phi String");
if (!Number.isNaN(globalThis.phiCascade(NaN, NaN))) throw new Error("canonical phi NaN");
if (globalThis.phiNumberFromString("input", NaN) !== "input1")
	throw new Error("canonical String phi");
if (globalThis.phiTextFromNumber(5, NaN) !== "5:")
	throw new Error("canonical Number phi");
if (globalThis.phiBoolean(convertible, NaN) !== convertible)
	throw new Error("canonical Boolean phi");
for (const fn of [globalThis.phiNumber, globalThis.phiText]) {
	try {
		fn(Symbol("phi"), NaN);
		throw new Error("canonical phi lost Symbol throw");
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		abiEvents.push(`phi:${error.name}`);
	}
}
try {
	globalThis.phiNumber(1n, NaN);
	throw new Error("canonical phi lost BigInt throw");
} catch (error) {
	if (!(error instanceof TypeError)) throw error;
	abiEvents.push(`phi:bigint:${error.name}`);
}
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
console.log([...abiEvents, ...events].join("\n"));
