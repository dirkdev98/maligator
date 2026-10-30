const values = [
	0,
	-0,
	0.1,
	-0.1,
	1.005,
	1.25,
	999.5,
	999999999.5,
	1000000000.25,
	1000000000000000128,
	Number.MIN_VALUE,
	Number.MIN_VALUE * 2,
	Number.MIN_VALUE * (2 ** 52 - 1),
	2 ** -1022,
	Number.MAX_VALUE,
	-Number.MAX_VALUE,
	NaN,
	Infinity,
	-Infinity,
];
for (const factor of [1 - Number.EPSILON, 1, 1 + Number.EPSILON]) {
	values.push(1e-101 * factor, 5e-101 * factor, -5e-101 * factor);
}
const bits = new DataView(new ArrayBuffer(8));
let seed = 1;
for (let index = 0; index < 128; index++) {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	bits.setUint32(0, seed);
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	bits.setUint32(4, seed);
	values.push(bits.getFloat64(0));
}
const output = [];
for (const value of values) {
	for (const method of ["toFixed", "toExponential", "toPrecision"]) {
		for (const digits of [0, 1, 2, 6, 17, 100]) {
			if (method === "toPrecision" && digits === 0) continue;
			output.push(value[method](digits));
		}
	}
}
console.log(JSON.stringify(output));
