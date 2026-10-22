// Loops bounded by a TypedArray's own `length` read storage directly only while that
// length is the intrinsic getter's answer for a fixed view.
const results = [];
function sum(values) {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i];
	return total;
}
function scaled(values, factor) {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i] * factor;
	return total;
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
for (const Ctor of kinds) {
	const values = new Ctor([1.5, -2, 300, 70000, -0, 4e9]);
	for (let round = 0; round < 50; round++) sum(values);
	results.push([Ctor.name, sum(values), scaled(values, 0.5), sum(new Ctor(0))]);
}

const special = new Float64Array([NaN, Infinity, -Infinity, -0, 2 ** 53]);
results.push(["special", String(sum(special))]);

// An own `length` shadows the intrinsic getter.
const own = new Float64Array([1, 2, 3, 4]);
Object.defineProperty(own, "length", { value: 2 });
results.push(["own-length", sum(own)]);

// Resizable buffers and length-tracking views keep the generic path.
const resizable = new ArrayBuffer(32, { maxByteLength: 64 });
const tracking = new Float64Array(resizable);
tracking.fill(2);
results.push(["tracking", sum(tracking)]);
resizable.resize(16);
results.push(["tracking-shrunk", sum(tracking)]);
const fixedOnResizable = new Float64Array(resizable, 0, 1);
results.push(["fixed-resizable", sum(fixedOnResizable)]);

// A subclass getter shadows `length` from a prototype between the view and the intrinsic.
class Short extends Float64Array {
	get length() {
		return 1;
	}
}
results.push(["subclass", sum(new Short([5, 6, 7]))]);

// BigInt arrays have no Number elements for the numeric loop.
attempt("bigint", () => sum(new BigInt64Array([1n, 2n])));
function attempt(label, run) {
	try {
		results.push([label, run()]);
	} catch (error) {
		results.push([label, error.constructor.name]);
	}
}

// Replacing the intrinsic getter must reach every later loop.
const plain = new Int32Array([1, 2, 3]);
results.push(["before", sum(plain)]);
const typedArrayPrototype = Object.getPrototypeOf(Int32Array.prototype);
const original = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length");
try {
	Object.defineProperty(typedArrayPrototype, "length", {
		get: () => 1,
		configurable: true,
	});
	results.push(["replaced", sum(plain)]);
} catch (error) {
	results.push(["replaced", error.constructor.name]);
} finally {
	Object.defineProperty(typedArrayPrototype, "length", original);
}
results.push(["restored", sum(plain)]);

console.log(JSON.stringify(results));
