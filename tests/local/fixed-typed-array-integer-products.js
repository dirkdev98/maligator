function negativeProducts(left, right, signedZero) {
	for (let index = 0; index < left.length; index++) {
		left[index] = index * -3;
		right[index] = -3 * index;
		signedZero[index] = index * -0;
	}
}
function unsafeProducts(output, rounded) {
	for (let index = 0; index < output.length; index++) {
		const product = index * 1073741825 * 1073741825;
		output[index] = product;
		rounded[index] = product + 1 - product;
	}
}
function integralStores(negative, positive) {
	for (let index = 0; index < negative.length; index++) {
		negative[index] = index * 977 - 4294967295;
		positive[index] = index * 977 + 4294967295;
	}
}
function clampedStores(output) {
	for (let index = 0; index < output.length; index++) output[index] = index * 127 - 128;
}
function carriedProducts(output) {
	for (let round = 0; round < 3; round++) {
		for (let index = 0; index < output.length; index++)
			output[index] = index * 977 + round;
	}
}
function fractionalInput(output, fraction) {
	for (let index = 0; index < output.length; index++)
		output[index] = index * 977 + fraction;
}
function writeIntegers(view) {
	for (let index = 0; index < 8; index++) {
		view.setInt8(index * 16, index * 977 - 4294967295);
		view.setUint8(index * 16 + 1, index * 977 - 4294967295);
		view.setInt16(index * 16 + 2, index * 977 - 4294967295, (index & 1) === 0);
		view.setUint16(index * 16 + 4, index * 977 - 4294967295, (index & 1) === 0);
		view.setInt32(index * 16 + 6, index * 977 - 4294967295, (index & 1) === 0);
		view.setUint32(index * 16 + 10, index * 977 + 4294967295, (index & 1) === 0);
	}
}
function values(array) {
	return Array.from(array, (value) => (Object.is(value, -0) ? "-0" : value));
}
const left = new Float64Array(8);
const right = new Float64Array(8);
const signedZero = new Float64Array(8);
for (let pass = 0; pass < 2; pass++) negativeProducts(left, right, signedZero);
const unsafe = new Float64Array(8);
const rounded = new Float64Array(8);
unsafeProducts(unsafe, rounded);
const modular = [];
for (const Ctor of [
	Int8Array,
	Uint8Array,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
]) {
	const negative = new Ctor(8);
	const positive = new Ctor(8);
	integralStores(negative, positive);
	modular.push([values(negative), values(positive)]);
}
const clamped = new Uint8ClampedArray(8);
clampedStores(clamped);
const carried = new Uint32Array(8);
carriedProducts(carried);
const fractional = new Float64Array(8);
fractionalInput(fractional, 0.25);
const bytes = new ArrayBuffer(128);
writeIntegers(new DataView(bytes));
console.log(
	JSON.stringify({
		negativeZero: [values(left), values(right), values(signedZero)],
		unsafe: [values(unsafe), values(rounded)],
		modular,
		clamped: values(clamped),
		carried: values(carried),
		fractional: values(fractional),
		dataView: values(new Uint8Array(bytes)),
	}),
);
