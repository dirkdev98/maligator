const gc = globalThis.__mal_collect_garbage ?? (() => {});
function boxedTrue(gate) {
	const value = true;
	gate();
	return value;
}
function boxedFalse(gate) {
	const value = false;
	gate();
	return value;
}
function boxedNull(gate) {
	const value = null;
	gate();
	return value;
}
function boxedUndefined(gate) {
	const value = undefined;
	gate();
	return value;
}
function boxedInteger(gate) {
	const value = 37;
	gate();
	return value;
}
function boxedFraction(gate) {
	const value = 1.5;
	gate();
	return value;
}
function boxedNegativeZero(gate) {
	const value = -0;
	gate();
	return value;
}
function boxedNaN(gate) {
	const value = 0 / 0;
	gate();
	return value;
}
function boxedPositiveInfinity(gate) {
	const value = 1 / 0;
	gate();
	return value;
}
function boxedNegativeInfinity(gate) {
	const value = -1 / 0;
	gate();
	return value;
}
function boxedBigInt(gate) {
	const value = 123456789012345678901234567890n;
	gate();
	return value;
}
globalThis.boxedLiteralKernels = [
	boxedTrue,
	boxedFalse,
	boxedNull,
	boxedUndefined,
	boxedInteger,
	boxedFraction,
	boxedNegativeZero,
	boxedNaN,
	boxedPositiveInfinity,
	boxedNegativeInfinity,
	boxedBigInt,
];
const expected = [
	true,
	false,
	null,
	undefined,
	37,
	1.5,
	-0,
	NaN,
	Infinity,
	-Infinity,
	123456789012345678901234567890n,
];
for (let round = 0; round < 16; round++) {
	for (let index = 0; index < expected.length; index++) {
		const actual = globalThis.boxedLiteralKernels[index](gc);
		if (!Object.is(actual, expected[index]) || typeof actual !== typeof expected[index])
			throw new Error("boxed literal lost its tag or IEEE value");
	}
}
const defined = [globalThis.boxedLiteralKernels[3](gc)];
if (!(0 in defined) || defined[0] !== undefined || 0 in new Array(1))
	throw new Error("undefined literal became a hole");
let mixedBigIntThrew = false;
try {
	globalThis.boxedLiteralKernels[10](gc) + 1;
} catch (error) {
	mixedBigIntThrew = error instanceof TypeError;
}
if (!mixedBigIntThrew) throw new Error("BigInt literal lost mixed arithmetic semantics");
console.log("native-boxed-literal-storage PASS");
