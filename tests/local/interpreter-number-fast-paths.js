// Numbers take the interpreter's in-place unary, Math, DataView and typed-array
// length paths; every other operand, receiver or buffer state must reach the
// builtin with its conversions and errors intact.
const fallbacksOnly = process.env.MAL_TEST_NUMBER_FALLBACKS === "1";
const log = [];
const show = (value) =>
	Object.is(value, -0) ? "-0" : typeof value === "bigint" ? `${value}n` : String(value);

function counted(label, value) {
	return {
		valueOf() {
			log.push(label);
			return value;
		},
	};
}

function unary(values) {
	const out = [];
	for (const value of values) {
		let plus;
		try {
			plus = show(+value);
		} catch (error) {
			plus = error.constructor.name;
		}
		let increment = value;
		increment++;
		let decrement = value;
		decrement--;
		out.push(
			[plus, show(-value), show(~value), show(increment), show(decrement)].join(" "),
		);
	}
	return out;
}

const coercibleUnaryValues = ["12", "", null, undefined, true, 10n, counted("unary", 7)];
const numberUnaryValues = [
	0,
	-0,
	1,
	-1,
	2147483647,
	-2147483648,
	0.5,
	-1.5,
	NaN,
	Infinity,
	4294967296.5,
];
console.log(
	unary(
		fallbacksOnly
			? coercibleUnaryValues
			: [...numberUnaryValues, ...coercibleUnaryValues],
	).join("\n"),
);

function math(values) {
	const out = [];
	for (const value of values) {
		out.push(
			[
				Math.trunc(value),
				Math.floor(value),
				Math.round(value),
				Math.abs(value),
				Math.min(value, 3),
				Math.max(value, -3),
			]
				.map(show)
				.join(" "),
		);
	}
	return out;
}

const coercibleMathValues = ["4.5", counted("math", 2.5)];
const numberMathValues = [0, -0, 1.5, -1.5, -0.5, 2147483648.5, NaN, -Infinity];
console.log(
	math(
		fallbacksOnly ? coercibleMathValues : [...numberMathValues, ...coercibleMathValues],
	).join("\n"),
);
if (!fallbacksOnly) {
	console.log(Math.trunc(), Math.min(), Math.max(1, 2, 3), Math.min(4, 5, -6));
}

function views() {
	const out = [];
	const view = new DataView(new ArrayBuffer(16));
	if (fallbacksOnly) {
		view.setUint8(counted("set offset", 2), counted("set value", 23));
		return [view.getUint8(counted("get offset", 2))];
	}
	for (let index = 0; index < 4; index++) {
		view.setUint32(index * 4, 0x01020304 * (index + 1), (index & 1) === 0);
	}
	view.setInt8(1, -2);
	view.setInt16(2, -300, true);
	view.setFloat64(8, -1.25);
	view.setFloat32(4, 0.1);
	view.setUint8(0, 257.75);
	view.setInt32(12);
	for (let index = 0; index < 16; index++) out.push(view.getUint8(index));
	out.push(
		view.getInt16(2, true),
		view.getInt8(1),
		view.getFloat64(8),
		view.getFloat32(4),
	);
	out.push(
		view.getUint32(0),
		view.getUint32(0, true),
		view.getInt32(12, 1),
		view.getUint16(),
	);
	view.setUint16(counted("offset", 6), counted("value", 65535), counted("endian", 0));
	out.push(view.getUint16(6, false));
	for (const [label, action] of [
		["range", () => view.setUint32(13, 1)],
		["negative", () => view.getUint8(-1)],
		["fraction", () => view.getUint8(1.5)],
		["bigint", () => view.setUint8(0, 1n)],
		["symbol", () => view.getUint8(Symbol.iterator)],
	]) {
		try {
			out.push(`${label}:${show(action())}`);
		} catch (error) {
			out.push(`${label}:${error.constructor.name}`);
		}
	}
	const offsetView = new DataView(new ArrayBuffer(12), 4, 4);
	offsetView.setUint32(0, 0xdeadbeef);
	out.push(offsetView.getUint32(0).toString(16), offsetView.getUint8(3));
	const detached = new ArrayBuffer(8);
	const detachedView = new DataView(detached);
	detached.transfer();
	try {
		detachedView.getUint8(0);
	} catch (error) {
		out.push(`detached:${error.constructor.name}`);
	}
	const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
	const fixedView = new DataView(resizable, 0, 8);
	fixedView.setUint32(4, 7);
	resizable.resize(4);
	try {
		fixedView.getUint32(4);
	} catch (error) {
		out.push(`shrunk:${error.constructor.name}`);
	}
	const getter = DataView.prototype.getUint8;
	out.push(getter.call(new DataView(new ArrayBuffer(2)), 1));
	return out;
}

console.log(views().map(show).join(" "));

function lengths() {
	const out = [];
	const plain = new Uint32Array(5);
	const buffer = new ArrayBuffer(16);
	const detaching = new Uint8Array(buffer);
	const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
	const tracking = new Uint16Array(resizable);
	class Sub extends Float64Array {}
	const subclass = new Sub(3);
	const shadowed = new Int8Array(4);
	Object.defineProperty(shadowed, "length", { value: 99 });
	const arrays = fallbacksOnly
		? [detaching, tracking, shadowed]
		: [plain, detaching, tracking, subclass, shadowed];
	for (let round = 0; round < 3; round++) {
		if (round === (fallbacksOnly ? 0 : 1)) {
			buffer.transfer();
			resizable.resize(8);
		}
		for (const array of arrays) out.push(array.length);
	}
	return out;
}

console.log(lengths().join(" "));
console.log(log.join(" "));
