const mode = process.env.TYPED_SINGLE_KIND || "inplace";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
const rows = [];
function inplace(data, start, count, scale, bias) {
	let i = start;
	for (; i < count; i++) data[i] = data[i] * scale + bias;
	return i;
}
function copy(source, output, start, count) {
	let i = start;
	for (; i < count; i++) output[i] = source[i];
	return i;
}
function shift(data, start, count) {
	let i = start;
	for (; i < count; i++) data[i + 1] = data[i] * 0.5;
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
if (mode === "inplace") {
	for (const Type of kinds) {
		const data = new Type(inputs);
		rows.push(inplace(data, 0, data.length, 0.5, -0), values(data));
		const large = new Type(1024);
		large.fill(3);
		rows.push(inplace(large, 0, large.length, 2, 1), large[0], large[1023]);
		collectGarbage?.();
	}
} else if (mode === "copy") {
	const source = new Float64Array(inputs);
	for (const Type of kinds) {
		const output = new Type(source.length);
		rows.push(copy(source, output, 0, source.length), values(output));
	}
	for (const [from, to] of [
		[0, 1],
		[1, 0],
		[0, 0],
	]) {
		const buffer = new ArrayBuffer(8 * 10),
			all = new Float64Array(buffer);
		all.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		copy(
			new Float64Array(buffer, from * 8, 8),
			new Float64Array(buffer, to * 8, 8),
			0,
			8,
		);
		rows.push(values(all));
	}
	const buffer = new ArrayBuffer(64),
		sourceView = new Float32Array(buffer),
		outputView = new Uint8Array(buffer, 1);
	sourceView.fill(3.25);
	copy(sourceView, outputView, 0, 12);
	rows.push(values(new Uint8Array(buffer)));
} else if (mode === "shift") {
	for (const Type of kinds) {
		const data = new Type([255, 1, 2, 3, 4, 5, 6, 7]);
		rows.push(shift(data, 0, 7), values(data));
	}
} else if (mode === "fallback") {
	const events = [];
	const source = {
		0: {
			valueOf() {
				events.push("coerce");
				collectGarbage?.();
				return 3;
			},
		},
		get 1() {
			events.push("get");
			return this.second ?? 5;
		},
		set 1(value) {
			events.push(`setter:${value}`);
			this.second = value;
		},
	};
	const proxy = new Proxy(source, {
		get(target, key) {
			events.push(`read:${key}`);
			return target[key];
		},
		set(target, key, value) {
			events.push(`write:${key}:${value}`);
			target[key] = value;
			return true;
		},
	});
	rows.push(
		inplace(
			proxy,
			0,
			{
				valueOf() {
					events.push("bound");
					return 2;
				},
			},
			2,
			1,
		),
	);
	rows.push(events, source[0]);
	const concatenated = new Float64Array([2, 3]);
	rows.push(inplace(concatenated, 0, 2, 2, "1"), values(concatenated));
	const observed = new Float64Array([2, 3]);
	const coercions = [];
	const scale = {
		valueOf() {
			coercions.push("scale");
			collectGarbage?.();
			return 2;
		},
	};
	const bias = {
		valueOf() {
			coercions.push("bias");
			observed[1] = 7;
			return 1;
		},
	};
	rows.push(inplace(observed, 0, 2, scale, bias), values(observed), coercions);
	const sparse = [2, , 8];
	rows.push(inplace(sparse, 0, 3, 2, 1), values(sparse));
	for (const [start, count] of [
		[0, 0],
		[1, 1],
		[-1, 2],
		[0.5, 2],
		[0, 2.5],
		[NaN, 3],
		[0, NaN],
		[4294967295, 4294967296],
	]) {
		const data = new Float64Array([2, 4, 8]);
		rows.push(inplace(data, start, count, 2, 1), values(data));
	}
	const detached = new Float64Array([1, 2, 3]);
	detached.buffer.transfer();
	rows.push(inplace(detached, 0, 3, 2, 1), detached.length);
	const buffer = new ArrayBuffer(32, { maxByteLength: 64 }),
		tracking = new Float64Array(buffer),
		fixed = new Float64Array(buffer, 0, 4);
	tracking.set([1, 2, 3, 4]);
	buffer.resize(16);
	rows.push(inplace(fixed, 0, 4, 2, 1), values(tracking));
	rows.push(inplace(tracking, 0, 2, 2, 1), values(tracking));
	const shared = new Float64Array(new SharedArrayBuffer(24));
	shared.set([1, 2, 3]);
	rows.push(inplace(shared, 0, 3, 2, 1), values(shared));
	try {
		inplace(new BigInt64Array([1n]), 0, 1, 2, 1);
	} catch (error) {
		rows.push(error.name);
	}
} else throw new Error("unknown mode");
console.log(JSON.stringify(rows));
