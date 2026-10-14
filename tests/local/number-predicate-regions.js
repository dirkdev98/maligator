"use strict";
const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function finite(left, right, output, count) {
	for (let i = 0; i < count; i++) {
		const x = left[i],
			y = right[i];
		output[i] = Number.isFinite(x) ? y + 1 : y - 1;
	}
	return output;
}
function integer(left, right, output, count) {
	for (let i = 0; i < count; i++) {
		const x = left[i],
			y = right[i];
		output[i] = Number.isInteger(x) ? y + 1 : y - 1;
	}
	return output;
}
function safe(left, right, output, count) {
	for (let i = 0; i < count; i++) {
		const x = left[i],
			y = right[i];
		output[i] = Number.isSafeInteger(x) ? y + 1 : y - 1;
	}
	return output;
}
function nan(left, right, output, count) {
	for (let i = 0; i < count; i++) {
		const x = left[i],
			y = right[i];
		output[i] = Number.isNaN(x) ? y + 1 : y - 1;
	}
	return output;
}
function dynamic(left, right, output, count, input) {
	for (let i = 0; i < count; i++) {
		const x = left[i],
			y = right[i];
		output[i] = Number.isInteger(input) ? x + y : x - y;
	}
	return output;
}
function recordFinite(record) {
	record.y = Number.isFinite(record.x) ? record.y + 1 : record.y - 1;
	record.z = record.y + record.z;
	return Number.isFinite(record.z);
}
function recordInteger(record) {
	record.y = Number.isInteger(record.x) ? record.y + 1 : record.y - 1;
	record.z = record.y + record.z;
	return Number.isInteger(record.z);
}
function recordSafe(record) {
	record.y = Number.isSafeInteger(record.x) ? record.y + 1 : record.y - 1;
	record.z = record.y + record.z;
	return Number.isSafeInteger(record.z);
}
function recordNan(record) {
	record.y = Number.isNaN(record.x) ? record.y + 1 : record.y - 1;
	record.z = record.y + record.z;
	return Number.isNaN(record.z);
}
function extra(left, right, output, count, hook) {
	for (let i = 0; i < count; i++) {
		const x = left[i],
			y = right[i];
		output[i] = Number.isFinite(x, hook(i)) ? y + 1 : y - 1;
	}
	return output;
}
function booleans(left, output, count) {
	for (let i = 0; i < count; i++) output[i] = Number.isFinite(left[i]);
	return output;
}
globalThis.predFinite = finite;
globalThis.predInteger = integer;
globalThis.predSafe = safe;
globalThis.predNan = nan;
globalThis.predDynamic = dynamic;
globalThis.predRecordFinite = recordFinite;
globalThis.predRecordInteger = recordInteger;
globalThis.predRecordSafe = recordSafe;
globalThis.predRecordNan = recordNan;
globalThis.predExtra = extra;
globalThis.predBooleans = booleans;
const mode = process.env.NUMBER_PREDICATE_MODE ?? "typed-finite";
const values = [
	NaN,
	Infinity,
	-Infinity,
	-0,
	0,
	0.5,
	-1.5,
	1,
	-1,
	9007199254740991,
	9007199254740992,
	Number.MIN_VALUE,
	Number.MAX_VALUE,
];
const text = (value) => (Object.is(value, -0) ? "-0" : String(value));
const out = [];
if (mode.startsWith("typed-")) {
	const method = { finite, integer, safe, nan }[mode.slice(6)];
	for (const Kind of [Float64Array, Float32Array, Int16Array, Uint8ClampedArray]) {
		const left = new Kind(values),
			right = new Float64Array(values.length).fill(10),
			output = new Float64Array(values.length);
		out.push(Array.from(method(left, right, output, left.length), text));
		collect();
	}
	const data = new Float64Array([0, 1.5, NaN, 4, Infinity, 6]);
	out.push(
		Array.from(
			method(data.subarray(0, 5), new Float64Array(5).fill(3), data.subarray(1), 5),
			text,
		),
	);
	const long = new Float64Array(2048).fill(1.5),
		right = new Float64Array(2048).fill(4),
		result = new Float64Array(2048);
	method(long, right, result, 2048);
	collect();
	out.push([result[0], result[2047]]);
} else if (mode.startsWith("record-")) {
	const method = {
		finite: recordFinite,
		integer: recordInteger,
		safe: recordSafe,
		nan: recordNan,
	}[mode.slice(7)];
	for (const x of values) {
		const record = { x, y: 10, z: 2 };
		for (let i = 0; i < 4; i++)
			out.push([method(record), text(record.y), text(record.z)]);
		collect();
	}
} else if (mode === "fallback") {
	let coercions = 0;
	const object = {
		valueOf() {
			coercions++;
			throw Error("coerced");
		},
	};
	const mixed = [
		undefined,
		null,
		true,
		"1",
		1n,
		Symbol("x"),
		object,
		new Number(1),
		1,
		NaN,
	];
	for (const method of [finite, integer, safe, nan])
		out.push(
			Array.from(
				method(
					mixed,
					new Float64Array(mixed.length).fill(5),
					new Float64Array(mixed.length),
					mixed.length,
				),
			),
		);
	for (const input of mixed)
		out.push(
			Array.from(
				dynamic(
					new Float64Array([2, 3]),
					new Float64Array([4, 5]),
					new Float64Array(2),
					2,
					input,
				),
			),
		);
	for (const method of [recordFinite, recordInteger, recordSafe, recordNan])
		for (const x of mixed) {
			const record = { x, y: 2, z: 3 };
			out.push([method(record), record.y, record.z]);
		}
	out.push(coercions, Array.from(booleans([1, "1", Infinity], new Float64Array(3), 3)));
	const events = [];
	const getterLeft = {
		get 0() {
			events.push("get0");
			collect();
			return 1;
		},
		get 1() {
			events.push("get1");
			return "1";
		},
	};
	out.push(
		Array.from(integer(getterLeft, new Float64Array([5, 6]), new Float64Array(2), 2)),
		events,
	);
	const short = new Float64Array(1);
	out.push(Array.from(finite(short, new Float64Array([2, 3]), new Float64Array(2), 2)));
	const zero = new Float64Array([7]);
	finite(
		new Proxy(
			{},
			{
				get() {
					throw Error("zero");
				},
			},
		),
		zero,
		zero,
		0,
	);
	out.push(zero[0]);
	const buffer = new ArrayBuffer(8);
	const detached = new Float64Array(buffer);
	structuredClone(buffer, { transfer: [buffer] });
	out.push(Array.from(finite(detached, new Float64Array([2]), new Float64Array(1), 1)));
	const resizable = new ArrayBuffer(16, { maxByteLength: 32 });
	out.push(
		Array.from(
			integer(
				new Float64Array(resizable),
				new Float64Array([2, 3]),
				new Float64Array(2),
				2,
			),
		),
	);
	out.push(
		Array.from(
			safe(new BigInt64Array([1n, 2n]), new Float64Array([2, 3]), new Float64Array(2), 2),
		),
	);
	if (typeof SharedArrayBuffer !== "undefined")
		out.push(
			Array.from(
				finite(
					new Float64Array(new SharedArrayBuffer(16)),
					new Float64Array([2, 3]),
					new Float64Array(2),
					2,
				),
			),
		);
} else if (mode === "effects") {
	const events = [],
		left = new Float64Array([1, Infinity, 3]),
		right = new Float64Array([5, 6, 7]),
		output = new Float64Array(3);
	out.push(
		Array.from(
			extra(left, right, output, 3, (i) => {
				events.push(i);
				collect();
				left[i + 1] = 2;
			}),
		),
		events,
	);
	const marker = { marker: 1 };
	try {
		extra(left, right, output, 3, () => {
			collect();
			throw marker;
		});
	} catch (error) {
		out.push(error === marker);
	}
	if (process.env.MAL_PRIMORDIALS !== "locked") {
		const original = Number.isFinite;
		let calls = 0;
		Number.isFinite = function (value) {
			calls++;
			collect();
			return typeof value === "string";
		};
		try {
			out.push(Array.from(finite([1, "1"], right, new Float64Array(2), 2)), calls);
		} finally {
			Number.isFinite = original;
		}
		let captured = 0;
		out.push(
			Array.from(
				extra([1], right, new Float64Array(1), 1, () => {
					Number.isFinite = () => {
						captured++;
						return false;
					};
				}),
			),
			captured,
		);
		Number.isFinite = original;
	}
} else throw Error(mode);
console.log(JSON.stringify(out));
