const mode = process.env.TYPED_MATH_KERNEL ?? "integer";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function integer(left, right, output, count) {
	for (let index = 0; index < count; index++)
		output[index] = Math.imul(left[index], right[index]) + Math.clz32(left[index]);
}
function half(data, output, count, ignored) {
	for (let index = 0; index < count; index++)
		output[index] = Math.f16round(data[index], ignored);
}
function power(left, right, output, count) {
	for (let index = 0; index < count; index++)
		output[index] = Math.pow(left[index], right[index]);
}
function angle(left, right, output, count) {
	for (let index = 0; index < count; index++)
		output[index] = Math.atan2(left[index], right[index]);
}
function norm(left, right, output, count, last) {
	for (let index = 0; index < count; index++)
		output[index] = Math.hypot(left[index], right[index], last);
}
function limits(left, right, output, count, last) {
	for (let index = 0; index < count; index++) {
		if (index & 1) output[index] = Math.min(left[index], right[index], last, null);
		else output[index] = Math.max(left[index], right[index], last, true);
	}
}
function missing(data, output, count) {
	for (let index = 0; index < count; index++)
		output[index] =
			Math.imul(data[index]) + Math.clz32(undefined) + Math.imul(data[index], true);
}
globalThis.typedInteger = integer;
globalThis.typedHalf = half;
globalThis.typedPower = power;
globalThis.typedAngle = angle;
globalThis.typedNorm = norm;
globalThis.typedLimits = limits;
globalThis.typedMissing = missing;
function scalar(value) {
	if (Object.is(value, -0)) return "-0";
	if (!Number.isFinite(value)) return String(value);
	return mode === "angle" || mode === "norm" ? value.toPrecision(12) : value;
}
const values = (data) => Array.from(data, scalar);
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
if (mode === "fallback") {
	const events = [];
	const left = new Float64Array([NaN, -0, 3]),
		right = new Float64Array([Infinity, 0, 4]),
		output = new Float64Array(3);
	const last = {
		valueOf() {
			events.push("last");
			collectGarbage();
			return 12;
		},
	};
	globalThis.typedNorm(left, right, output, 3, last);
	rows.push(values(output), events.slice());
	if (events.join() !== "last,last,last") throw new Error("hypot skipped coercion");
	globalThis.typedLimits(left, right, output, 3, last);
	rows.push(values(output), events.slice());
	let thrown = 0;
	const sentinel = {};
	try {
		globalThis.typedNorm(left, right, output, 3, {
			valueOf() {
				events.push("throw");
				throw sentinel;
			},
		});
	} catch (error) {
		if (error === sentinel) thrown++;
	}
	try {
		globalThis.typedHalf(new BigInt64Array([1n]), output, 1);
	} catch (error) {
		if (error instanceof TypeError) thrown++;
	}
	if (thrown !== 2 || events.filter((event) => event === "throw").length !== 1)
		throw new Error("exception replay");
	const proxy = new Proxy(new Float64Array([3, 4, 5]), {
		get(target, key) {
			events.push(String(key));
			collectGarbage();
			return target[key];
		},
	});
	globalThis.typedInteger(proxy, right, output, 3);
	rows.push(values(output), events, thrown);
} else {
	const base =
		mode === "power"
			? [NaN, NaN, -1, -1, -0, -0, -2, -2, Infinity, -Infinity, 0.5, 4]
			: mode === "norm"
				? [3, 0, -0, Infinity, NaN, 1e308, 1e-300, -3, NaN, Infinity, 12, -5]
				: mode === "half"
					? [
							-0,
							0,
							2 ** -25,
							3 * 2 ** -25,
							1 + 2 ** -11,
							1 + 3 * 2 ** -11,
							65504,
							65520,
							NaN,
							Infinity,
							-Infinity,
							-65520,
						]
					: [
							-0,
							0,
							-1,
							1,
							-0.5,
							0.5,
							4294967295,
							2147483648,
							NaN,
							Infinity,
							-Infinity,
							16777217,
						];
	const other =
		mode === "power"
			? [0, 1, Infinity, -Infinity, -3, 2, 3, 0.5, 0, 3, Infinity, 0.5]
			: mode === "norm"
				? [4, -0, 0, NaN, Infinity, 1e308, 1e-300, -4, 1, 1, 5, 12]
				: [0, -0, 0, -0, 3, -3, 4294967295, 3, 1, Infinity, -Infinity, 7];
	for (const Type of kinds) {
		const left = new Type(base),
			right = new Type(other),
			output = new Type(base.length);
		if (mode === "integer") globalThis.typedInteger(left, right, output, base.length);
		else if (mode === "half")
			globalThis.typedHalf(left, output, base.length, Symbol("ignored"));
		else if (mode === "power") globalThis.typedPower(left, right, output, base.length);
		else if (mode === "angle") globalThis.typedAngle(left, right, output, base.length);
		else if (mode === "norm") globalThis.typedNorm(left, right, output, base.length, 12);
		else if (mode === "limits")
			globalThis.typedLimits(left, right, output, base.length, 0);
		else globalThis.typedMissing(left, output, base.length);
		rows.push(values(output));
		collectGarbage();
	}
	if (mode === "integer" || mode === "half")
		for (const Type of [Float64Array, Float32Array, Int32Array]) {
			const backing = Type.from({ length: 20 }, (_, index) => index + 0.5),
				left = backing.subarray(0, 16),
				output = backing.subarray(1, 17);
			if (mode === "integer") globalThis.typedInteger(left, left, output, 16);
			else globalThis.typedHalf(left, output, 16);
			rows.push(values(backing));
		}
}
console.log(JSON.stringify([mode, rows]));
