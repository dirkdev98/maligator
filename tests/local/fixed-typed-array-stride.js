const mode = process.env.TYPED_STRIDE_KIND || "all";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;
function threeLanes(left, right, output, start, count) {
	let i = start;
	for (; i < count; i += 3) {
		output[i] = left[i] + right[i];
		output[i + 1] = left[i + 1] + right[i + 1];
		output[i + 2] = left[i + 2] + right[i + 2];
	}
	return i;
}
function fourLanes(left, right, output, start, count) {
	let i = start;
	for (; i < count; i += 4) {
		output[i] = left[i] + right[i];
		output[i + 1] = left[i + 1] + right[i + 1];
		output[i + 2] = left[i + 2] + right[i + 2];
		output[i + 3] = left[i + 3] + right[i + 3];
	}
	return i;
}
function strideEdges(left, right, output, start, count) {
	let i = start;
	for (; i < count; i += 2) output[i] = left[i] + right[i];
	return i;
}
function overshoot(left, right, output, start, count) {
	let i = start;
	for (; i < count; i += 2147483647) output[i] = left[i] + right[i];
	return i;
}
function invalidEntries(left, right, output, start, count) {
	let i = start;
	for (; i < count; i += 2) {
		if (i > 5) break;
		output[i] = left[i] + right[i];
	}
	return i;
}
globalThis.threeLanes = threeLanes;
globalThis.fourLanes = fourLanes;
globalThis.strideEdges = strideEdges;
globalThis.overshoot = overshoot;
globalThis.invalidEntries = invalidEntries;
const results = [];
function record(array) {
	return Array.from(array, (value) => String(value));
}
function runLanes(kernel) {
	for (const Ctor of [
		Float64Array,
		Float32Array,
		Int32Array,
		Uint32Array,
		Int8Array,
		Uint8Array,
		Uint8ClampedArray,
		Int16Array,
		Uint16Array,
	]) {
		const left = new Float64Array(12),
			right = new Float32Array(12),
			output = new Ctor(12);
		for (let i = 0; i < 12; i++) {
			left[i] = i * 1.25 - 3;
			right[i] = i + 0.25;
		}
		results.push(kernel(left, right, output, 0, 12), record(output));
	}
	for (const shift of [0, 1, -1]) {
		const buffer = new ArrayBuffer(8 * 16),
			whole = new Float64Array(buffer);
		for (let i = 0; i < whole.length; i++) whole[i] = i + 0.25;
		const left = new Float64Array(buffer, shift < 0 ? 8 : 0, 12);
		const right = new Float64Array(buffer, 0, 12);
		const output = new Float64Array(buffer, shift > 0 ? 8 : 0, 12);
		results.push(kernel(left, right, output, 0, 12), record(whole));
	}
	const mixedBuffer = new ArrayBuffer(128);
	const mixedLeft = new Float64Array(mixedBuffer, 0, 12),
		mixedRight = new Float32Array(mixedBuffer, 4, 12),
		mixedOut = new Uint8ClampedArray(mixedBuffer, 8, 12);
	for (let i = 0; i < mixedLeft.length; i++) mixedLeft[i] = i * 0.75;
	results.push(
		kernel(mixedLeft, mixedRight, mixedOut, 0, 12),
		record(new Uint8Array(mixedBuffer)),
	);
	const large = new Float64Array(4096 * 3);
	large.fill(0.125);
	for (let round = 0; round < 8; round++) {
		kernel(large, large, large, 0, large.length);
		collectGarbage?.();
	}
	results.push(record(large.slice(0, 8)), record(large.slice(-8)));
}
function runOvershoot() {
	const output = new Float64Array(2);
	const end = overshoot(new Float64Array([1, 2]), new Float64Array([3, 4]), output, 1, 2);
	if (end !== 2147483648 || output[1] !== 6) throw new Error("inexact stride overshoot");
	results.push(end, record(output));
}
function runEdges() {
	const left = new Float64Array([1, 2, 3, 4, 5, 6]),
		right = new Int16Array([6, 5, 4, 3, 2, 1]);
	for (const start of [-1, -0, 0.5, 1, 2, 6])
		for (const count of [-1, 0, 1, 2.5, 5, 6, 8, NaN]) {
			const output = new Float64Array(6);
			results.push(
				String(strideEdges(left, right, output, start, count)),
				record(output),
			);
		}
	for (const kernel of [threeLanes, fourLanes]) {
		for (const start of [0, 1, 2])
			for (const count of [0, 1, 5, 6, 7]) {
				const output = new Uint8ClampedArray(6);
				results.push(kernel(left, right, output, start, count), record(output));
			}
	}
	for (const [start, count] of [
		[0, Infinity],
		[Infinity, Infinity],
		[NaN, 6],
		[0, 4294967296],
		[4294967295, 4294967296],
		[0, "6"],
	]) {
		const output = new Float64Array(6);
		results.push(
			String(invalidEntries(left, right, output, start, count)),
			record(output),
		);
	}
	for (const [start, count] of [
		[Symbol("start"), 6],
		[0, Symbol("bound")],
	]) {
		try {
			invalidEntries(left, right, new Float64Array(6), start, count);
			throw new Error("missing comparison throw");
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			results.push("symbol comparison");
		}
	}
	runOvershoot();
	const trace = [],
		destination = {};
	const source = new Proxy(
		{ 0: 2, 2: 4 },
		{
			get(target, key) {
				trace.push("get:" + key);
				return target[key];
			},
		},
	);
	const target = new Proxy(destination, {
		set(object, key, value) {
			trace.push("set:" + key + ":" + value);
			object[key] = value;
			return true;
		},
	});
	const start = {
		valueOf() {
			trace.push("start");
			return 0;
		},
	};
	const count = {
		valueOf() {
			trace.push("bound");
			return 3;
		},
	};
	results.push(strideEdges(source, [1, 2, 3], target, start, count), trace, destination);
	const detached = new Float64Array([1, 2, 3, 4, 5, 6]);
	detached.buffer.transfer();
	const detachedOut = new Float64Array(6);
	results.push(threeLanes(detached, right, detachedOut, 0, 6), record(detachedOut));
	const buffer = new ArrayBuffer(48, { maxByteLength: 96 });
	const tracking = new Float64Array(buffer);
	tracking.set(left);
	const dynamicOut = new Float64Array(6);
	results.push(threeLanes(tracking, right, dynamicOut, 0, 6), record(dynamicOut));
	const shared = new Float64Array(new SharedArrayBuffer(48));
	shared.set(left);
	results.push(threeLanes(shared, right, dynamicOut, 0, 6), record(dynamicOut));
}
if (mode === "all" || mode === "three") runLanes(threeLanes);
if (mode === "all" || mode === "four") runLanes(fourLanes);
if (mode === "all" || mode === "edges") runEdges();
if (mode === "overshoot") runOvershoot();
console.log(JSON.stringify(results));
