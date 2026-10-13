const results = [];
function kernel(left, right, output, count) {
	for (let i = 0; i < count; i++) output[i] = left[i] + right[i];
	return output;
}
function values(array) {
	return Array.from(array, (value) =>
		Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : value,
	);
}
for (const Ctor of [Float64Array, Float32Array, Int32Array, Uint8Array]) {
	const left = new Ctor([1, 2, 3, 4]),
		right = new Ctor([10, 20, 30, 40]);
	for (const count of [0, 1, 4, 6, 2.5, -1, NaN])
		results.push(values(kernel(left, right, new Ctor(4), count)));
}
const left = new Float64Array([-0, 0, NaN, Infinity, -Infinity, 1.5]);
const right = new Float64Array([-0, -0, 1, -Infinity, Infinity, 2.25]);
results.push(values(kernel(left, right, new Float64Array(6), 6)));
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
console.log(JSON.stringify(results));
