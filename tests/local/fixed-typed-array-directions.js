const mode = process.env.TYPED_DIRECTION_KIND || "reverse";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
const rows = [];
function reverse(data, start, bound, scale, bias) {
	let i = start;
	for (; i >= bound; i--) data[i] = data[i] * scale + bias;
	return i;
}
function reverseExclusive(source, output, start, bound) {
	let i = start;
	for (; i > bound; i--) output[i - 1] = source[i - 1];
	return i;
}
function inclusive(source, output, start, bound) {
	let i = start;
	for (; i <= bound; i++) output[i] = source[i];
	return i;
}
function reverseStride(source, output, start, bound) {
	let i = start;
	for (; bound < i; i -= 3) {
		output[i - 1] = source[i - 1];
		output[i - 2] = source[i - 2];
		output[i - 3] = source[i - 3];
	}
	return i;
}
function inclusiveStride(data, start, bound) {
	let i = start;
	for (; bound >= i; i += 3) data[i] = data[i] * 2;
	return i;
}
function reverseWide(data, start, bound) {
	let i = start;
	for (; i >= bound; i -= 2147483647) data[i] = data[i] * 2;
	return i;
}
function values(data) {
	return Array.from(data, (value) =>
		Object.is(value, -0)
			? "-0"
			: Number.isNaN(value)
				? "NaN"
				: !Number.isFinite(value)
					? String(value)
					: value,
	);
}
const kinds = [
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
const inputs = [
	-0,
	0.5,
	1.5,
	2.5,
	127.5,
	255.5,
	-129.5,
	16777217,
	4294967295,
	NaN,
	Infinity,
	-Infinity,
];
if (mode === "reverse") {
	for (const Type of kinds) {
		const data = new Type(inputs);
		rows.push(reverse(data, data.length - 1, 0, 0.5, -0), values(data));
		const large = new Type(1024);
		large.fill(3);
		rows.push(reverse(large, 1023, 0, 2, 1), large[0], large[1023]);
		collectGarbage?.();
	}
	for (const [from, to] of [
		[0, 1],
		[1, 0],
		[0, 0],
	]) {
		const buffer = new ArrayBuffer(80),
			all = new Float64Array(buffer);
		all.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		rows.push(
			reverseExclusive(
				new Float64Array(buffer, from * 8, 8),
				new Float64Array(buffer, to * 8, 8),
				8,
				0,
			),
			values(all),
		);
	}
	const buffer = new ArrayBuffer(64),
		source = new Float32Array(buffer),
		output = new Uint8Array(buffer, 1);
	source.fill(3.25);
	rows.push(reverseExclusive(source, output, 12, 0), values(new Uint8Array(buffer)));
} else if (mode === "inclusive") {
	const source = new Float64Array(inputs);
	for (const Type of kinds) {
		const output = new Type(source.length);
		rows.push(inclusive(source, output, 0, source.length - 1), values(output));
		const one = new Type([3]);
		rows.push(inclusive(one, one, -0, -0), values(one));
	}
	const data = new Float64Array(1024);
	data.fill(7);
	rows.push(inclusive(data, data, 0, 1023), data[0], data[1023]);
} else if (mode === "stride") {
	for (const Type of kinds) {
		const data = new Type(inputs),
			output = new Type(data.length);
		rows.push(reverseStride(data, output, data.length, 0), values(output));
		rows.push(inclusiveStride(data, 1, 9), values(data));
		rows.push(reverseWide(data, 3, 0), values(data));
	}
	for (const bound of [0, 1, 2]) {
		const data = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		rows.push(
			reverseStride(data.subarray(0, 9), data.subarray(1), 9, bound),
			values(data),
		);
	}
} else if (mode === "fallback") {
	const events = [];
	const object = { 0: 2, 1: 4, 2: 8 };
	const proxy = new Proxy(object, {
		get(target, key) {
			events.push(`get:${key}`);
			collectGarbage?.();
			return target[key];
		},
		set(target, key, value) {
			events.push(`set:${key}:${value}`);
			target[key] = value;
			return true;
		},
	});
	const bound = {
		valueOf() {
			events.push("bound");
			return 0;
		},
	};
	rows.push(reverse(proxy, 2, bound, 2, 1), object, events);
	const coerced = new Float64Array([2, 3, 4]);
	const order = [];
	const scale = {
		valueOf() {
			order.push("scale");
			collectGarbage?.();
			return 2;
		},
	};
	const bias = {
		valueOf() {
			order.push("bias");
			coerced[0] = 7;
			return 1;
		},
	};
	rows.push(reverse(coerced, 2, 0, scale, bias), values(coerced), order);
	const concatenated = new Float64Array([2, 3]);
	rows.push(reverse(concatenated, 1, 0, 2, "1"), values(concatenated));
	for (const [start, stop] of [
		[-1, 0],
		[0, 1],
		[1, -1],
		[1.5, 0],
		[2, 0.5],
		[NaN, 0],
		[0, NaN],
		[4294967296, 4294967295],
	]) {
		const data = new Float64Array([2, 4, 8]);
		rows.push(reverse(data, start, stop, 2, 1), values(data));
	}
	for (const [start, stop] of [
		[1, 0],
		[-1, 1],
		[0.5, 1],
		[0, 1.5],
		[NaN, 0],
		[0, NaN],
		[4294967295, 4294967295],
	]) {
		const data = new Float64Array([2, 4, 8]);
		rows.push(inclusive(data, data, start, stop), values(data));
	}
	const sparse = [2, , 8];
	rows.push(reverse(sparse, 2, 0, 2, 1), values(sparse));
	const low = new Float64Array([1, 2, 3]);
	rows.push(reverseStride(low, low, 2, -1), values(low));
	const detached = new Float64Array([1, 2, 3]);
	detached.buffer.transfer();
	rows.push(reverse(detached, 2, 0, 2, 1), detached.length);
	const buffer = new ArrayBuffer(32, { maxByteLength: 64 }),
		tracking = new Float64Array(buffer),
		fixed = new Float64Array(buffer, 0, 4);
	tracking.set([1, 2, 3, 4]);
	buffer.resize(16);
	rows.push(reverse(fixed, 3, 0, 2, 1), values(tracking));
	rows.push(reverse(tracking, 1, 0, 2, 1), values(tracking));
	const shared = new Float64Array(new SharedArrayBuffer(24));
	shared.set([1, 2, 3]);
	rows.push(reverse(shared, 2, 0, 2, 1), values(shared));
	try {
		reverse(new BigInt64Array([1n]), 0, 0, 2, 1);
	} catch (error) {
		rows.push(error.name);
	}
} else throw new Error("unknown mode");
console.log(JSON.stringify(rows));
