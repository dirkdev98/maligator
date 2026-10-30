// Counted loops over DataView accessors run as fixed numeric regions while the view is an
// intact fixed DataView; every other receiver and buffer state must keep the loop's semantics.
const results = [];
const attempt = (label, run) => {
	try {
		results.push([label, run()]);
	} catch (error) {
		results.push([label, error.constructor.name]);
	}
};
const show = (values) =>
	Array.from(values, (value) =>
		Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : String(value),
	);

const samples = new Float64Array([
	0,
	1,
	-1,
	127.5,
	128,
	255,
	256,
	-129,
	65535.25,
	65536,
	2 ** 31,
	-(2 ** 31),
	2 ** 32 + 5,
	-2.75,
	1e40,
	NaN,
	Infinity,
	-0,
]);

// Each type writes alternating byte orders at an unaligned window and reads back big-endian.
function writeInt8(view, values) {
	for (let i = 0; i < values.length; i++) view.setInt8(i + 3, values[i], (i & 1) === 0);
}
function readInt8(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getInt8(i + 3);
	return out;
}
function writeUint8(view, values) {
	for (let i = 0; i < values.length; i++) view.setUint8(i + 3, values[i], (i & 1) === 0);
}
function readUint8(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getUint8(i + 3);
	return out;
}
function writeInt16(view, values) {
	for (let i = 0; i < values.length; i++)
		view.setInt16(i * 2 + 3, values[i], (i & 1) === 0);
}
function readInt16(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2 + 3);
	return out;
}
function writeUint16(view, values) {
	for (let i = 0; i < values.length; i++)
		view.setUint16(i * 2 + 3, values[i], (i & 1) === 0);
}
function readUint16(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2 + 3);
	return out;
}
function writeInt32(view, values) {
	for (let i = 0; i < values.length; i++)
		view.setInt32(i * 4 + 3, values[i], (i & 1) === 0);
}
function readInt32(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getInt32(i * 4 + 3);
	return out;
}
function writeUint32(view, values) {
	for (let i = 0; i < values.length; i++)
		view.setUint32(i * 4 + 3, values[i], (i & 1) === 0);
}
function readUint32(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4 + 3);
	return out;
}
function writeFloat32(view, values) {
	for (let i = 0; i < values.length; i++)
		view.setFloat32(i * 4 + 3, values[i], (i & 1) === 0);
}
function readFloat32(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4 + 3);
	return out;
}
function writeFloat64(view, values) {
	for (let i = 0; i < values.length; i++)
		view.setFloat64(i * 8 + 3, values[i], (i & 1) === 0);
}
function readFloat64(view, out) {
	for (let i = 0; i < out.length; i++) out[i] = view.getFloat64(i * 8 + 3);
	return out;
}
const kernels = [
	["Int8", writeInt8, readInt8, 1],
	["Uint8", writeUint8, readUint8, 1],
	["Int16", writeInt16, readInt16, 2],
	["Uint16", writeUint16, readUint16, 2],
	["Int32", writeInt32, readInt32, 4],
	["Uint32", writeUint32, readUint32, 4],
	["Float32", writeFloat32, readFloat32, 4],
	["Float64", writeFloat64, readFloat64, 8],
];
for (const [type, write, read, size] of kernels) {
	const view = new DataView(new ArrayBuffer(samples.length * size + 3));
	for (let round = 0; round < 3; round++) write(view, samples);
	results.push([type, show(read(view, new Float64Array(samples.length)))]);
}

// One loop storing through a TypedArray and a DataView with constant little-endian order.
function mixed(integers, view, round) {
	for (let i = 0; i < integers.length; i++) {
		integers[i] = (round * 37 + i * 17) >>> 0;
		view.setUint32(i * 4 + 1, integers[i], true);
	}
	let sum = 0;
	for (let i = 0; i < integers.length; i++) sum += view.getUint32(i * 4 + 1, 1);
	return sum;
}
const integers = new Uint32Array(64);
const mixedView = new DataView(new ArrayBuffer(260));
let mixedSum = 0;
for (let round = 0; round < 50; round++) mixedSum += mixed(integers, mixedView, round);
results.push(["mixed", mixedSum, show(integers.subarray(0, 4))]);

function descending(view, count) {
	for (let i = count - 1; i >= 0; i--) view.setUint16(i * 2, i * 1000 + 7);
	let sum = 0;
	for (let i = count - 1; i >= 0; i--) sum += view.getUint16(i * 2);
	return sum;
}
results.push(["descending", descending(new DataView(new ArrayBuffer(40)), 20)]);

// The last iteration's offset leaves the view, so the stores before it still happen.
const short = new DataView(new ArrayBuffer(30));
attempt("past-end", () => writeUint32(short, new Float64Array([1, 2, 3, 4, 5, 6, 7, 8])));
results.push(["past-end-bytes", show(readUint8(short, new Float64Array(27)))]);

const own = new DataView(new ArrayBuffer(16));
const ownCalls = [];
own.setUint32 = (offset, value) => ownCalls.push([offset, value]);
writeUint32(own, new Float64Array([1, 2]));
results.push(["own-method", ownCalls]);

const swapped = new DataView(new ArrayBuffer(16));
Object.setPrototypeOf(swapped, {
	getUint8: (offset) => offset * 10,
});
results.push(["swapped-prototype", show(readUint8(swapped, new Float64Array(3)))]);

const plain = { getUint16: (offset) => offset + 0.5 };
results.push(["plain-receiver", show(readUint16(plain, new Float64Array(3)))]);

const detached = new DataView(new ArrayBuffer(16));
detached.buffer.transfer();
attempt("detached-read", () => show(readUint8(detached, new Float64Array(2))));
attempt("detached-empty", () => show(readUint8(detached, new Float64Array(0))));

const resizable = new ArrayBuffer(24, { maxByteLength: 64 });
const fixed = new DataView(resizable, 4, 16);
const tracking = new DataView(resizable, 4);
writeUint8(fixed, new Float64Array([9, 8, 7]));
results.push(["fixed-resizable", show(readUint8(fixed, new Float64Array(3)))]);
writeUint16(tracking, new Float64Array([300, 400]));
results.push(["tracking", show(readUint16(tracking, new Float64Array(2)))]);
resizable.resize(8);
attempt("shrunk-fixed", () => show(readUint8(fixed, new Float64Array(2))));
attempt("shrunk-tracking", () => show(readUint8(tracking, new Float64Array(2))));

const shared = new DataView(new SharedArrayBuffer(16));
writeInt16(shared, new Float64Array([-5, 6]));
results.push(["shared", show(readInt16(shared, new Float64Array(2)))]);

class Window extends DataView {}
const windowed = new Window(new ArrayBuffer(16), 2);
writeFloat32(windowed, new Float64Array([1.5, -2]));
results.push(["subclass", show(readFloat32(windowed, new Float64Array(2)))]);

// After loops ran as regions, replacing an accessor must reach the replacement wherever
// the intrinsics are mutable, and must leave the loop intact where they are locked.
const patchedView = new DataView(new ArrayBuffer(8));
for (let round = 0; round < 3; round++) readUint8(patchedView, new Float64Array(4));
const original = DataView.prototype.getUint8;
const replacement = () => 42;
try {
	DataView.prototype.getUint8 = replacement;
} catch {}
const patched = DataView.prototype.getUint8 === replacement;
const patchedRead = readUint8(patchedView, new Float64Array(2));
results.push([
	"prototype-patch",
	patchedRead.every((value) => value === (patched ? 42 : 0)) ? "consistent" : "stale",
]);
try {
	DataView.prototype.getUint8 = original;
} catch {}

console.log(JSON.stringify(results));
