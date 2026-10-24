// DataView accessors and `byteLength` read memory inline only for intact views; every
// other receiver, offset, value and buffer state must reach the builtin's semantics.
const results = [];
const attempt = (label, run) => {
	try {
		results.push([label, run()]);
	} catch (error) {
		results.push([label, error.constructor.name]);
	}
};

const types = [
	"Int8",
	"Uint8",
	"Int16",
	"Uint16",
	"Int32",
	"Uint32",
	"Float32",
	"Float64",
];
const samples = [
	0,
	1,
	-1,
	127,
	128,
	255,
	256,
	-129,
	65535,
	65536,
	2 ** 31,
	-(2 ** 31),
	2 ** 32 + 5,
	1.5,
	-2.75,
	1e40,
	NaN,
	Infinity,
	-0,
];

// Static method names, so each pair takes the inline accessors when they apply.
function roundTrip(view, type, offset, value, little) {
	switch (type) {
		case "Int8":
			view.setInt8(offset, value, little);
			return view.getInt8(offset, little);
		case "Uint8":
			view.setUint8(offset, value, little);
			return view.getUint8(offset, little);
		case "Int16":
			view.setInt16(offset, value, little);
			return view.getInt16(offset, little);
		case "Uint16":
			view.setUint16(offset, value, little);
			return view.getUint16(offset, little);
		case "Int32":
			view.setInt32(offset, value, little);
			return view.getInt32(offset, little);
		case "Uint32":
			view.setUint32(offset, value, little);
			return view.getUint32(offset, little);
		case "Float32":
			view.setFloat32(offset, value, little);
			return view.getFloat32(offset, little);
		default:
			view.setFloat64(offset, value, little);
			return view.getFloat64(offset, little);
	}
}

const view = new DataView(new ArrayBuffer(32));
for (const type of types)
	for (const little of [true, false, undefined, 1, ""])
		for (const value of samples)
			for (const offset of [0, 3, 8]) {
				const read = roundTrip(view, type, offset, value, little);
				results.push([type, little, value, offset, Object.is(read, -0) ? "-0" : read]);
			}

function sumWords(view, count) {
	let sum = 0;
	for (let i = 0; i < count; i++) sum = (sum + view.getUint32(i * 4, true)) >>> 0;
	return sum;
}
for (let i = 0; i < 8; i++) view.setUint32(i * 4, (i * 2654435761) >>> 0, true);
for (let round = 0; round < 100; round++) sumWords(view, 8);
results.push(["sum", sumWords(view, 8)]);

attempt("past-end", () => view.getUint32(29));
attempt("negative", () => view.getInt8(-1));
attempt("fraction", () => view.getUint8(1.9));
attempt("string-offset", () => view.getUint16("4", true));
attempt("object-offset", () => view.getUint16({ valueOf: () => 6 }));
attempt("missing-offset", () => view.getUint8());
attempt("huge-offset", () => view.getUint8(2 ** 53));
attempt("string-value", () => roundTrip(view, "Uint16", 0, "300", true));
attempt("object-value", () => roundTrip(view, "Int32", 0, { valueOf: () => -7 }, false));
attempt("missing-value", () => {
	view.setFloat64(0);
	return String(view.getFloat64(0));
});
attempt("symbol-value", () => view.setInt8(0, Symbol()));
attempt("bigint-value", () => view.setInt8(0, 1n));
attempt("bigint-accessor", () => {
	view.setBigInt64(0, -5n, true);
	return String(view.getBigInt64(0, true));
});

const counts = [];
attempt("evaluation-order", () =>
	view.setUint8(
		{ valueOf: () => (counts.push("offset"), 1) },
		{ valueOf: () => (counts.push("value"), 9) },
	),
);
results.push(["order", counts.join(",")]);

const detached = new DataView(new ArrayBuffer(8));
detached.buffer.transfer();
attempt("detached-get", () => detached.getUint8(0));
attempt("detached-set", () => detached.setUint8(0, 1));
attempt("detached-length", () => detached.byteLength);

const resizable = new ArrayBuffer(16, { maxByteLength: 32 });
const fixed = new DataView(resizable, 4, 8);
const tracking = new DataView(resizable, 4);
attempt("fixed-length", () => fixed.byteLength);
attempt("tracking-length", () => tracking.byteLength);
resizable.resize(8);
attempt("shrunk-fixed-get", () => fixed.getUint8(0));
attempt("shrunk-fixed-length", () => fixed.byteLength);
attempt("shrunk-tracking-length", () => tracking.byteLength);
attempt("shrunk-tracking-get", () => tracking.getUint8(3));
attempt("shrunk-tracking-past", () => tracking.getUint8(4));
resizable.resize(32);
attempt("grown-tracking-length", () => tracking.byteLength);

const shared = new DataView(new SharedArrayBuffer(8));
attempt("shared", () => roundTrip(shared, "Int16", 2, -300, true));
attempt("shared-length", () => shared.byteLength);

const shadowed = new DataView(new ArrayBuffer(8));
shadowed.getUint8 = () => "own";
Object.defineProperty(shadowed, "byteLength", { value: 99 });
attempt("own-method", () => shadowed.getUint8(0));
attempt("own-length", () => shadowed.byteLength);

class Window extends DataView {
	get byteLength() {
		return -1;
	}
}
const windowed = new Window(new ArrayBuffer(8), 2);
attempt("subclass-get", () => roundTrip(windowed, "Uint16", 0, 513, false));
attempt("subclass-length", () => windowed.byteLength);

const offsetView = new DataView(new ArrayBuffer(16), 8, 4);
attempt("offset-view", () => roundTrip(offsetView, "Uint32", 0, 0xdeadbeef, true));
attempt("offset-view-past", () => offsetView.getUint16(3));
attempt("offset-view-length", () => offsetView.byteLength);

attempt("wrong-receiver", () => DataView.prototype.getUint8.call(new Uint8Array(4), 0));
attempt("borrowed-method", () => {
	const borrowed = { getUint8: DataView.prototype.getUint8 };
	return borrowed.getUint8(0);
});

function lengths(view, rounds) {
	let total = 0;
	for (let i = 0; i < rounds; i++) total += view.byteLength;
	return total;
}
results.push(["lengths", lengths(view, 100), lengths(offsetView, 100)]);

function positiveEndian(view, value) {
	const little = (value >>> 0) + 1;
	return view.getUint16(0, little);
}
function objectEndian(view, value) {
	return view.getUint16(0, { value });
}
function optionalEndian(view, value, flag) {
	const little = flag ? +value : undefined;
	return view.getUint16(0, little);
}
const truthView = new DataView(new ArrayBuffer(4));
truthView.setUint8(0, 1);
truthView.setUint8(1, 2);
for (const value of [0, -0, NaN, 1, -1, Infinity]) {
	attempt("positive-endian", () => positiveEndian(truthView, value));
	attempt("object-endian", () => objectEndian(truthView, value));
	attempt("number-endian", () => optionalEndian(truthView, value, true));
	attempt("undefined-endian", () => optionalEndian(truthView, value, false));
}
console.log(JSON.stringify(results));
