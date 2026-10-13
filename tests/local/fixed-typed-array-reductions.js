const mode = process.env.TYPED_REDUCTION_KIND ?? "reduce";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function sum(data, start, bound, seed) {
	let total = seed,
		index = start;
	for (; index < bound; index++) total += data[index];
	return [index, total];
}
function reverseDot(left, right, start, bound, seed) {
	let total = seed,
		index = start;
	for (; index >= bound; index--) total += left[index] * right[index];
	return [index, total];
}
function wide(left, right, a, b, c, d, e, output, count) {
	let index = 0;
	for (; index < count; index++)
		output[index] =
			left[index] + right[index] + a[index] + b[index] + c[index] + d[index] + e[index];
	return index;
}
function lanes(left, right, third, output, start, count) {
	let index = start;
	for (; index < count; index += 8) {
		output[index] = left[index] + right[index] + third[index];
		output[index + 1] = left[index + 1] + right[index + 1] + third[index + 1];
		output[index + 2] = left[index + 2] + right[index + 2] + third[index + 2];
		output[index + 3] = left[index + 3] + right[index + 3] + third[index + 3];
		output[index + 4] = left[index + 4] + right[index + 4] + third[index + 4];
		output[index + 5] = left[index + 5] + right[index + 5] + third[index + 5];
		output[index + 6] = left[index + 6] + right[index + 6] + third[index + 6];
		output[index + 7] = left[index + 7] + right[index + 7] + third[index + 7];
	}
	return index;
}
globalThis.typedSum = sum;
globalThis.typedReverseDot = reverseDot;
globalThis.typedWide = wide;
globalThis.typedLanes = lanes;
function scalar(value) {
	return Object.is(value, -0)
		? "-0"
		: typeof value === "bigint"
			? String(value) + "n"
			: Number.isNaN(value)
				? "NaN"
				: value === Infinity
					? "Infinity"
					: value === -Infinity
						? "-Infinity"
						: value;
}
function values(data) {
	return Array.from(data, scalar);
}
const rows = [];
const kinds = [
	Float64Array,
	Float32Array,
	Int32Array,
	Uint32Array,
	Int16Array,
	Uint16Array,
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
];
const input = [
	-0,
	0.5,
	1.5,
	2.5,
	-3.5,
	127.5,
	255.5,
	-129.5,
	16777217,
	4294967295,
	NaN,
	Infinity,
	-Infinity,
];
if (mode === "immutable") {
	const source = new Float64Array([1, 2, 3, 4]);
	const data = new Float64Array(source.buffer.transferToImmutable());
	const total = globalThis.typedSum(data, 0, 4, 0);
	const product = globalThis.typedReverseDot(data, data, 3, 0, 0);
	if (total[0] !== 4 || total[1] !== 10 || product[0] !== -1 || product[1] !== 30)
		throw new Error("immutable reduction");
	const output = new Float64Array(4);
	globalThis.typedWide(data, data, data, data, data, data, data, output, 4);
	if (values(output).join() !== "7,14,21,28") throw new Error("immutable input");
	let thrown;
	try {
		globalThis.typedWide(output, output, output, output, output, output, output, data, 4);
	} catch (error) {
		thrown = error;
	}
	if (!(thrown instanceof TypeError) || values(data).join() !== "1,2,3,4")
		throw new Error("immutable output modified");
	collectGarbage();
	rows.push("immutable PASS");
} else if (mode === "reduce") {
	for (const Type of kinds) {
		const data = new Type(input),
			right = new Type(input.slice().reverse());
		for (const [start, bound, seed] of [
			[0, 10, 0],
			[0, 1, -0],
			[3, 3, -0],
			[0, data.length, 0],
			[1, 5, 0.125],
		])
			rows.push(values(globalThis.typedSum(data, start, bound, seed)));
		rows.push(values(globalThis.typedReverseDot(data, right, 9, 1, 0.5)));
		const backing = new Type(520);
		backing.fill(3);
		const sub = new Type(backing.buffer, Type.BYTES_PER_ELEMENT * 4, 512);
		rows.push(
			values(globalThis.typedSum(sub, 0, 512, 1)),
			values(globalThis.typedReverseDot(sub, sub, 511, 0, 1)),
		);
		collectGarbage();
	}
} else if (mode === "wide" || mode === "lanes") {
	for (const Type of kinds) {
		const data = Type.from({ length: 64 }, (_, index) => index - 9.5),
			second = Type.from({ length: 64 }, (_, index) => index * 0.25),
			third = new Type(64).fill(1.75),
			out = new Type(64);
		const end =
			mode === "wide"
				? globalThis.typedWide(data, second, third, data, second, third, data, out, 64)
				: globalThis.typedLanes(data, second, third, out, 0, 57);
		rows.push(end, values(out));
		for (const offset of [0, 1, 2]) {
			const backing = Type.from({ length: 72 }, (_, index) => index * 0.5);
			const left = new Type(backing.buffer, 0, 64),
				output = new Type(backing.buffer, offset * Type.BYTES_PER_ELEMENT, 64);
			rows.push(
				mode === "wide"
					? globalThis.typedWide(left, left, left, left, left, left, left, output, 64)
					: globalThis.typedLanes(left, left, left, output, 0, 57),
				values(backing),
			);
		}
		collectGarbage();
	}
} else {
	const events = [];
	const ordinary = {
		get 0() {
			events.push("get0");
			collectGarbage();
			return 2;
		},
		get 1() {
			events.push("get1");
			collectGarbage();
			return 3;
		},
	};
	const seed = {
		valueOf() {
			events.push("seed");
			collectGarbage();
			return 10;
		},
	};
	rows.push(values(globalThis.typedSum(ordinary, 0, 2, seed)), events.slice());
	if (events.join() !== "get0,seed,get1") throw new Error("reordered reduction effects");
	const proxy = new Proxy(new Float64Array([1, 2, 3]), {
		get(target, key) {
			events.push("proxy:" + key);
			collectGarbage();
			return target[key];
		},
	});
	rows.push(values(globalThis.typedSum(proxy, 0, 3, 0)), events.slice());
	const data = new Float64Array([1, 2, 3]);
	for (const [start, bound, seed] of [
		[-1, 3, 0],
		[0.5, 3, 0],
		[0, 5, 0],
		[3, 0, -0],
		[0, NaN, 0],
		[0, "3", 0],
		[0, 3, "start"],
	])
		rows.push(values(globalThis.typedSum(data, start, bound, seed)));
	const detached = new Float64Array([1, 2, 3]);
	detached.buffer.transfer();
	rows.push(values(globalThis.typedSum(detached, 0, 3, 0)));
	const resizable = new ArrayBuffer(32, { maxByteLength: 64 }),
		tracking = new Float64Array(resizable),
		fixed = new Float64Array(resizable, 0, 4);
	tracking.set([1, 2, 3, 4]);
	rows.push(values(globalThis.typedSum(tracking, 0, 4, 0)));
	resizable.resize(16);
	rows.push(values(globalThis.typedSum(fixed, 0, 4, 0)));
	const shared = new Float64Array(new SharedArrayBuffer(24));
	shared.set([1, 2, 3]);
	rows.push(values(globalThis.typedSum(shared, 0, 3, 0)));
	rows.push(values(globalThis.typedSum(new BigInt64Array([1n, 2n, 3n]), 0, 3, 0n)));
	let threw = false;
	try {
		globalThis.typedSum(new BigInt64Array([1n]), 0, 1, 0);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		threw = true;
	}
	if (!threw) throw new Error("mixed BigInt sum");
	const original = { marker: true };
	let calls = 0,
		caught;
	try {
		globalThis.typedSum(
			{
				get 0() {
					calls++;
					collectGarbage();
					return 1;
				},
				get 1() {
					calls++;
					collectGarbage();
					throw original;
				},
			},
			0,
			3,
			0,
		);
	} catch (error) {
		caught = error;
	}
	if (caught !== original || calls !== 2) throw new Error("reduction replay");
	rows.push(calls);
}
console.log(JSON.stringify([mode, rows]));
