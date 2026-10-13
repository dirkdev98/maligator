const mode = process.env.TYPED_MATH_KIND ?? "rounding";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function rounding(data, output, count) {
	let index = 0;
	for (; index < count; index++)
		output[index] =
			Math.fround(Math.round(data[index])) +
			Math.floor(data[index]) +
			Math.ceil(data[index]) +
			Math.trunc(data[index]) +
			Math.sign(data[index]);
	return index;
}
function minPair(left, right, output, count) {
	for (let index = 0; index < count; index++)
		output[index] = Math.min(left[index], right[index]);
}
function maxPair(left, right, output, count) {
	for (let index = 0; index < count; index++)
		output[index] = Math.max(left[index], right[index]);
}
function absolute(data, output, count, ignored) {
	for (let index = 0; index < count; index++)
		output[index] = Math.abs(data[index], ignored);
}
function clamp(data, output, count, limit) {
	for (let index = 0; index < count; index++)
		output[index] = Math.max(-limit, Math.min(data[index], limit));
}
function roots(data, output, count) {
	for (let index = 0; index < count; index++)
		output[index] = Math.sqrt(+data[index]) + Math.cbrt(data[index]);
}
function transcendental(data, output, count) {
	for (let index = 0; index < count; index++) {
		const value = data[index];
		output[index] =
			Math.sin(value) +
			Math.cos(value) +
			Math.tan(value) +
			Math.asin(value) +
			Math.acos(value) +
			Math.atan(value) +
			Math.sinh(value) +
			Math.cosh(value) +
			Math.tanh(value) +
			Math.asinh(value) +
			Math.acosh(value + 1) +
			Math.atanh(value) +
			Math.exp(value) +
			Math.expm1(value) +
			Math.log(value) +
			Math.log2(value) +
			Math.log10(value) +
			Math.log1p(value);
	}
}
function descending(data, start, bound, seed) {
	let total = seed;
	let index = start;
	for (; index >= bound; index--) total += Math.abs(data[index]);
	return [index, total];
}
function extraEffects(data, output, count, effect) {
	for (let index = 0; index < count; index++)
		output[index] = Math.abs(data[index], effect(index));
}
globalThis.mathRounding = rounding;
globalThis.mathMinPair = minPair;
globalThis.mathMaxPair = maxPair;
globalThis.mathAbsolute = absolute;
globalThis.mathClamp = clamp;
globalThis.mathRoots = roots;
globalThis.mathTranscendental = transcendental;
globalThis.mathDescending = descending;
globalThis.mathExtraEffects = extraEffects;
function scalar(value) {
	if (Object.is(value, -0)) return "-0";
	if (!Number.isFinite(value)) return String(value);
	return mode === "transcendental" || mode === "roots" ? value.toPrecision(10) : value;
}
const values = (data) => Array.from(data, scalar);
const rows = [];
const input = [
	-0,
	0,
	-0.5,
	0.5,
	-1.5,
	1.5,
	-2.5,
	2.5,
	16777217,
	NaN,
	Infinity,
	-Infinity,
];
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
if (mode === "fallback") {
	const events = [];
	const ordinary = {
		get 0() {
			events.push("get0");
			collectGarbage();
			return {
				valueOf() {
					events.push("number0");
					collectGarbage();
					return -3;
				},
			};
		},
		get 1() {
			events.push("get1");
			collectGarbage();
			return -4;
		},
	};
	const output = new Float64Array(4);
	globalThis.mathAbsolute(ordinary, output, 2, Symbol("ignored"));
	rows.push(values(output), events.slice());
	if (events.join() !== "get0,number0,get1") throw new Error("coercion order");
	const data = new Float64Array([1, -2, 3, -4]);
	const limit = {
		valueOf() {
			events.push("limit");
			collectGarbage();
			return 2;
		},
	};
	globalThis.mathClamp(data, output, 4, limit);
	rows.push(values(output), events.slice());
	const detached = new Float64Array([1, 2]);
	detached.buffer.transfer();
	globalThis.mathRounding(detached, output, 2);
	rows.push(values(output));
	const resizable = new ArrayBuffer(32, { maxByteLength: 64 });
	const tracking = new Float64Array(resizable);
	tracking.set([1, -2, 3, -4]);
	globalThis.mathAbsolute(tracking, output, 4);
	rows.push(values(output));
	const shared = new Float64Array(new SharedArrayBuffer(32));
	shared.set([0, 64, 729, 4096]);
	globalThis.mathRoots(shared, output, 4);
	rows.push(values(output));
	let thrown = 0;
	try {
		globalThis.mathAbsolute(new BigInt64Array([1n]), output, 1);
	} catch (error) {
		if (error instanceof TypeError) thrown++;
	}
	const original = { reason: "coerce" };
	try {
		globalThis.mathAbsolute(
			[
				{
					valueOf() {
						events.push("throw");
						throw original;
					},
				},
			],
			output,
			1,
		);
	} catch (error) {
		if (error === original) thrown++;
	}
	if (thrown !== 2 || events.filter((event) => event === "throw").length !== 1)
		throw new Error("original throw");
	rows.push(thrown);
} else if (mode === "effects") {
	const data = new Float64Array([-1, -2, -3]);
	const output = new Float64Array(3),
		events = [];
	globalThis.mathExtraEffects(data, output, 3, (index) => {
		events.push(index);
		collectGarbage();
		return Symbol("ignored");
	});
	rows.push(values(output), events);
	if (events.join() !== "0,1,2") throw new Error("extra evaluation");
	if (process.env.MAL_PRIMORDIALS !== "locked") {
		const original = Math.abs;
		try {
			Math.abs = (value) => {
				events.push("override");
				return value * 2;
			};
			globalThis.mathAbsolute(data, output, 3);
			rows.push(values(output), events.slice());
		} finally {
			Math.abs = original;
		}
	}
} else {
	for (const Type of kinds) {
		const data = new Type(input),
			right = new Type(input.slice().reverse()),
			output = new Type(input.length);
		if (mode === "rounding")
			rows.push(globalThis.mathRounding(data, output, data.length), values(output));
		else if (mode === "minmax") {
			globalThis.mathMinPair(data, right, output, data.length);
			rows.push(values(output));
			globalThis.mathMaxPair(data, right, output, data.length);
			rows.push(values(output));
			const zeroLeft = new Type([0, -0, 0, -0, NaN, 1]),
				zeroRight = new Type([-0, 0, 0, -0, 1, NaN]);
			globalThis.mathMinPair(zeroLeft, zeroRight, output, 6);
			rows.push(values(output));
			globalThis.mathMaxPair(zeroLeft, zeroRight, output, 6);
			rows.push(values(output));
		} else if (mode === "absolute") {
			globalThis.mathAbsolute(data, output, data.length, Symbol("ignored"));
			rows.push(values(output));
		} else if (mode === "clamp") {
			globalThis.mathClamp(data, output, data.length, 2.5);
			rows.push(values(output));
		} else if (mode === "roots") {
			globalThis.mathRoots(data, output, data.length);
			rows.push(values(output));
		} else if (mode === "descending") {
			rows.push(
				values(globalThis.mathDescending(data, 8, 0, -0)),
				values(globalThis.mathDescending(data, 0, 1, -0)),
			);
			const large = new Type(1024).fill(-3);
			rows.push(values(globalThis.mathDescending(large.subarray(4, 516), 511, 0, 1)));
		} else if (mode === "transcendental") {
			const source = new Float64Array([0.125, 0.25, 0.5, 0.75]);
			globalThis.mathTranscendental(source, output, 4);
			rows.push(values(output));
		}
		collectGarbage();
	}
	if (mode === "rounding" || mode === "clamp")
		for (const Type of [Float64Array, Float32Array, Uint8ClampedArray]) {
			const backing = Type.from({ length: 20 }, (_, index) => index / 2 - 4);
			const left = backing.subarray(0, 16),
				output = backing.subarray(1, 17);
			if (mode === "rounding") globalThis.mathRounding(left, output, 16);
			else globalThis.mathClamp(left, output, 16, 2.5);
			rows.push(values(backing));
		}
}
console.log(JSON.stringify([mode, rows]));
