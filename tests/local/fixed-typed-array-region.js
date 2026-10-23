const results = [];
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
function kernel(left, right, output, count) {
	for (let i = 0; i < count; i++) output[i] = left[i] + right[i];
	return output;
}
function values(array) {
	return Array.from(array, (value) =>
		Object.is(value, -0)
			? "-0"
			: Number.isNaN(value)
				? "NaN"
				: value === Infinity
					? "Infinity"
					: value === -Infinity
						? "-Infinity"
						: value,
	);
}
const numericKinds = [
	Float64Array,
	Float32Array,
	Int32Array,
	Uint32Array,
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
];
for (const Ctor of numericKinds) {
	const left = new Ctor([1, 2, 3, 4]),
		right = new Ctor([10, 20, 30, 40]);
	for (const count of [0, 1, 4, 6, 2.5, -1, NaN])
		results.push(values(kernel(left, right, new Ctor(4), count)));
}
const left = new Float64Array([-0, 0, NaN, Infinity, -Infinity, 1.5]);
const right = new Float64Array([-0, -0, 1, -Infinity, Infinity, 2.25]);
results.push(values(kernel(left, right, new Float64Array(6), 6)));
const extremes = new Float64Array([
	-0,
	0,
	NaN,
	Infinity,
	-Infinity,
	1.5,
	-1.75,
	2147483647,
	2147483648,
	4294967295,
	4294967296,
	9007199254740991,
	2 ** 63,
	-(2 ** 63),
	1e100,
	-1e100,
	1 + 2 ** -24,
	1 + 3 * 2 ** -24,
	2 ** -149,
	2 ** -150,
	3.4028234663852886e38,
	-3.4028234663852886e38,
	0.5,
	2.5,
	3.5,
	-129.5,
	127.5,
	128.5,
	254.5,
	255.5,
	256.5,
	-32769.5,
	32767.5,
	32768.5,
	65535.5,
	65536.5,
]);
const additions = new Float64Array(extremes.length);
additions.fill(-0);
additions[7] = 1;
additions[9] = 1;
additions[10] = -1;
additions[11] = 1;
for (const Ctor of numericKinds)
	results.push(
		values(kernel(extremes, additions, new Ctor(extremes.length), extremes.length)),
	);
function roundedReadback(a, b, c, count) {
	for (let i = 0; i < count; i++) {
		c[i] = a[i] + b[i];
		b[i] = c[i] - a[i];
	}
}
for (const Ctor of numericKinds) {
	const a = new Float64Array([16777216, 4294967296, 1e100, -0]),
		b = new Float64Array([1, 1.75, 1, -0]),
		c = new Ctor(a.length);
	roundedReadback(a, b, c, a.length);
	results.push(values(b), values(c));
}
for (const offsets of [
	[0, 1, 2],
	[2, 1, 0],
	[1, 0, 1],
	[0, 0, 0],
]) {
	const buffer = new ArrayBuffer(8 * 12),
		whole = new Float64Array(buffer);
	for (let i = 0; i < whole.length; i++) whole[i] = i + 1;
	const a = new Float64Array(buffer, offsets[0] * 8, 8),
		b = new Float64Array(buffer, offsets[1] * 8, 8),
		c = new Float64Array(buffer, offsets[2] * 8, 8);
	kernel(a, b, c, 8);
	results.push(values(whole));
}
for (const Output of numericKinds) {
	for (const offset of [0, 4, 8]) {
		const buffer = new ArrayBuffer(8 * 12),
			whole = new Float64Array(buffer);
		for (let i = 0; i < whole.length; i++) whole[i] = i + 0.25;
		const a = new Float32Array(buffer, 4, 8),
			b = new Uint32Array(buffer, 0, 8),
			c = new Output(buffer, Output.BYTES_PER_ELEMENT === 8 ? offset * 2 : offset, 8);
		kernel(a, b, c, 8);
		results.push(values(new Uint32Array(buffer)));
	}
}
const detached = new Float64Array([1, 2, 3]);
detached.buffer.transfer();
results.push(
	values(kernel(detached, new Float64Array([4, 5, 6]), new Float64Array(3), 3)),
);
const resizable = new ArrayBuffer(8 * 4, { maxByteLength: 8 * 8 }),
	fixed = new Float64Array(resizable, 0, 4),
	tracking = new Float64Array(resizable);
fixed.set([1, 2, 3, 4]);
resizable.resize(8 * 2);
results.push(values(kernel(fixed, tracking, new Float64Array(4), 4)));
const shared = new Float64Array(new SharedArrayBuffer(8 * 3));
shared.set([1, 2, 3]);
results.push(values(kernel(shared, shared, new Float64Array(3), 3)));
for (const Ctor of numericKinds.slice(1)) {
	const detachedInput = new Ctor([1, 2, 3]),
		detachedOutput = new Ctor(3),
		input = new Ctor([3, 4, 5]);
	detachedInput.buffer.transfer();
	detachedOutput.buffer.transfer();
	results.push(values(kernel(detachedInput, input, new Ctor(3), 3)));
	kernel(input, input, detachedOutput, 3);
	results.push(detachedOutput.length, detachedOutput[0]);
	const buffer = new ArrayBuffer(16, { maxByteLength: 32 }),
		fixedInput = new Ctor(buffer, 0, 4),
		trackingInput = new Ctor(buffer);
	fixedInput.set([1, 2, 3, 4]);
	results.push(values(kernel(fixedInput, trackingInput, new Ctor(4), 4)));
	buffer.resize(8);
	results.push(values(kernel(fixedInput, trackingInput, new Ctor(4), 4)));
	const sharedInput = new Ctor(new SharedArrayBuffer(12));
	sharedInput.set([1, 2, 3]);
	results.push(values(kernel(sharedInput, sharedInput, new Ctor(3), 3)));
}
try {
	kernel(new BigInt64Array([1n]), new BigInt64Array([2n]), new Int32Array(1), 1);
} catch (error) {
	results.push(error.name);
}
const order = [];
const ordinary = {
	0: {
		valueOf() {
			order.push("coerce");
			return 3;
		},
	},
	get 1() {
		order.push("get");
		return 4;
	},
};
const destination = new Proxy(
	{},
	{
		set(target, key, value) {
			order.push("set:" + key + ":" + value);
			target[key] = value;
			return true;
		},
	},
);
kernel(ordinary, [10, 20], destination, {
	valueOf() {
		order.push("bound");
		return 2;
	},
});
results.push(order, destination[0], destination[1]);
function interrupted(a, b, c, count, hook) {
	for (let i = 0; i < count; i++) {
		c[i] = a[i] + b[i];
		hook(i);
	}
	return c;
}
const mutable = new Float64Array([1, 2, 3]);
results.push(
	values(
		interrupted(mutable, new Float64Array([3, 4, 5]), new Float64Array(3), 3, (i) => {
			if (i === 0) mutable.buffer.transfer();
			if (typeof gc === "function") gc();
		}),
	),
);
const big = new Float64Array(4096);
for (let i = 0; i < big.length; i++) big[i] = i % 7;
for (let round = 0; round < 12; round++) kernel(big, big, big, big.length);
results.push(big[0], big[4095]);
for (const Ctor of numericKinds.slice(1)) {
	const data = new Ctor(4096);
	for (let i = 0; i < data.length; i++) data[i] = i % 7;
	for (let round = 0; round < 12; round++) {
		kernel(data, data, data, data.length);
		if (typeof gc === "function") gc();
	}
	results.push(values(data.slice(0, 8)), values(data.slice(-8)));
}
function affineKernel(left, right, output, start, count) {
	for (let i = start; i < count; i++) {
		output[i - 1] = left[i - 1] + right[i + 1];
		right[i] = output[i - 1] - left[i];
	}
	return output;
}
function branchAffine(left, right, output, start, count) {
	for (let i = start; i < count; i++) {
		if (i & 1) output[i - 1] = left[i] + right[i + 1];
		else output[i] = left[i - 1] + right[i];
	}
	return output;
}
function changingOffset(left, right, output, count) {
	let offset = 1;
	for (let i = 0; i < count; i++) {
		output[i + offset] = left[i] + right[i];
		offset = 2;
	}
	return output;
}
function previousKey(left, right, output, count) {
	let key = 0;
	for (let i = 0; i < count; i++) {
		output[key] = left[i] + right[i];
		key = i + 2;
	}
	return output;
}
for (const Ctor of numericKinds) {
	for (const [start, count] of [
		[1, 5],
		[1, 2],
		[2, 5],
		[0, 3],
		[-1, 3],
		[0.5, 3],
		[1, 7],
		[1, 2.5],
		[2, 2],
		[3, 1],
		[NaN, 4],
		[1, NaN],
		[Infinity, Infinity],
	]) {
		const a = new Float64Array([16777216, 2.5, 4, 8, 16, 32]);
		const b = new Float64Array([1, 2, 3, 4, 5, 6]);
		results.push(values(affineKernel(a, b, new Ctor(6), start, count)), values(b));
		results.push(values(branchAffine(a, b, new Ctor(6), start, count)));
	}
	const all = new Ctor([1, 2, 3, 4, 5, 6]);
	results.push(values(affineKernel(all, all, all, 1, 5)));
	results.push(values(changingOffset(all, all, new Ctor(6), 4)));
	results.push(values(previousKey(all, all, new Ctor(6), 4)));
}
for (const offsets of [
	[0, 1, 2],
	[2, 1, 0],
]) {
	const buffer = new ArrayBuffer(8 * 12),
		whole = new Float64Array(buffer);
	for (let i = 0; i < whole.length; i++) whole[i] = i + 0.25;
	affineKernel(
		new Float64Array(buffer, offsets[0] * 8, 8),
		new Float64Array(buffer, offsets[1] * 8, 8),
		new Float64Array(buffer, offsets[2] * 8, 8),
		1,
		7,
	);
	results.push(values(whole));
}
for (const Ctor of numericKinds) {
	const buffer = new ArrayBuffer(8 * 12),
		whole = new Float64Array(buffer);
	for (let i = 0; i < whole.length; i++) whole[i] = i + 0.25;
	affineKernel(
		new Float64Array(buffer, 0, 8),
		new Float32Array(buffer, 4, 8),
		new Ctor(buffer, Ctor.BYTES_PER_ELEMENT * 2, 8),
		1,
		7,
	);
	results.push(values(new Uint32Array(buffer)));
}
const affineOrder = [];
const affineSource = new Proxy(
	{ 0: 2, 1: 3, 2: 4, 3: 5 },
	{
		get(target, key) {
			affineOrder.push(`get:${key}`);
			return target[key];
		},
	},
);
const affineDestination = new Proxy(
	{},
	{
		set(target, key, value) {
			affineOrder.push(`set:${key}:${value}`);
			target[key] = value;
			return true;
		},
	},
);
affineKernel(
	affineSource,
	[2, 3, 4, 5],
	affineDestination,
	{
		valueOf() {
			affineOrder.push("start");
			return 1;
		},
	},
	{
		valueOf() {
			affineOrder.push("bound");
			return 3;
		},
	},
);
results.push(affineOrder, affineDestination[0], affineDestination[1]);
const affineDetached = new Float64Array([1, 2, 3, 4]);
affineDetached.buffer.transfer();
results.push(
	values(
		affineKernel(
			affineDetached,
			new Float64Array([1, 2, 3, 4]),
			new Float64Array(4),
			1,
			3,
		),
	),
);
results.push(values(affineKernel(fixed, tracking, new Float64Array(4), 1, 3)));
results.push(values(affineKernel(shared, shared, new Float64Array(3), 1, 2)));
const affineLarge = new Float64Array(4096);
affineLarge.fill(0.25);
for (let round = 0; round < 12; round++) {
	affineKernel(affineLarge, affineLarge, affineLarge, 1, affineLarge.length - 1);
	gc?.();
}
results.push(values(affineLarge.slice(0, 8)), values(affineLarge.slice(-8)));
// A spread read past the table's end sends the iteration back to the original loop.
function bumpThenRead(output, table, count) {
	let total = 0;
	for (let i = 0; i < count; i++) {
		output[i] = output[i] + 1;
		total += table[i * 5];
	}
	return [total, ...values(output)];
}
function readThenBump(output, table, count) {
	let total = 0;
	for (let i = 0; i < count; i++) {
		total += table[i * 5];
		output[i] = output[i] + 1;
	}
	return [total, ...values(output)];
}
// Locally constructed views carry exact element kinds; the loop reads one through
// another view's keys and writes it back at the counter.
function propagateKinds(size, spread) {
	const kinds = new Uint16Array(size);
	const operands = Uint32Array.from(
		kinds,
		(_, index) => (index * 17 + spread) % (size + spread),
	);
	let checksum = 0;
	for (let pass = 0; pass < 3; pass++)
		for (let index = 1; index < kinds.length; index++) {
			const kind = kinds[operands[index]] | (1 << ((index + pass) & 7));
			if (kind !== kinds[index]) kinds[index] = kind;
			checksum = (checksum + kind) % 1_000_003;
		}
	return [checksum, ...values(kinds.slice(0, 6))];
}
results.push(propagateKinds(64, 0), propagateKinds(64, 9), propagateKinds(1, 0));
for (const run of [bumpThenRead, readThenBump]) {
	results.push(run(new Float64Array(8), new Float64Array(20).fill(2), 8));
	results.push(run(new Int16Array(6), new Uint8Array(40).fill(3), 6));
}
console.log(JSON.stringify(results));
