import { Buffer } from "node:buffer";

let checks = 0;
function equal(actual, expected, name) {
	checks++;
	if (!Object.is(actual, expected))
		throw new Error(name + ": " + actual + " != " + expected);
}
function lengthOf(view) {
	return view.length;
}
function keyed(view, key) {
	return view[key];
}
function scan(view, visit) {
	let sum = 0;
	for (let i = 0; i < view.length; i++) {
		if (visit) visit(i);
		sum += Number(view[i] || 0);
	}
	return sum;
}
const constructors = [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
];
for (const Ctor of constructors) {
	const view = new Ctor(3);
	equal(lengthOf(view), 3, Ctor.name);
	equal(lengthOf(new Ctor(5)), 5, Ctor.name + " shared shape");
	equal(keyed(view, "length"), 3, "computed length");
	equal(keyed(view, "byteLength"), 3 * Ctor.BYTES_PER_ELEMENT, "alternating key");
	equal(keyed(view, "length"), 3, "computed refill");
}
const buffer = Buffer.from([1, 2, 3]);
equal(scan(buffer), 6, "Buffer indexed loop");
equal(lengthOf(buffer), 3, "Buffer length");
class Bytes extends Uint8Array {}
const subclass = new Bytes([4, 5]);
equal(scan(subclass), 9, "subclass");
subclass.extra = true;
equal(lengthOf(subclass), 2, "shape change");
Object.defineProperty(subclass, "length", { value: 1, configurable: true });
equal(lengthOf(subclass), 1, "own data shadow");
equal(scan(subclass), 4, "shadowed loop bound");
delete subclass.length;
equal(lengthOf(subclass), 2, "delete own shadow");
let reads = 0;
Object.defineProperty(subclass, "length", {
	get() {
		reads++;
		return 7;
	},
	configurable: true,
});
equal(lengthOf(subclass), 7, "own getter");
equal(lengthOf(subclass), 7, "own getter repeated");
equal(reads, 2, "getter invoked per read");
delete subclass.length;
equal(lengthOf(subclass), 2, "own getter removed");
const nativeGetter = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"length",
).get;
const first = Object.create(Uint8Array.prototype);
const second = Object.create(Uint8Array.prototype);
Object.setPrototypeOf(subclass, first);
equal(lengthOf(subclass), 2, "custom chain");
Object.defineProperty(first, "length", { value: 8, configurable: true });
equal(lengthOf(subclass), 8, "intermediate shadow");
delete first.length;
equal(lengthOf(subclass), 2, "intermediate restored");
Object.defineProperty(second, "length", {
	get() {
		return 11;
	},
	configurable: true,
});
Object.setPrototypeOf(subclass, second);
equal(lengthOf(subclass), 11, "same shape different prototype");
Object.defineProperty(second, "length", { get: nativeGetter, configurable: true });
equal(lengthOf(subclass), 2, "borrowed intrinsic getter");
Object.defineProperty(second, "length", {
	get() {
		return 13;
	},
	configurable: true,
});
equal(lengthOf(subclass), 13, "cached holder changed");
delete second.length;
equal(lengthOf(subclass), 2, "holder restored");
const proxyPrototype = new Proxy(Uint8Array.prototype, {
	get(target, key, receiver) {
		return key === "length" ? 17 : Reflect.get(target, key, receiver);
	},
});
Object.setPrototypeOf(subclass, proxyPrototype);
equal(lengthOf(subclass), 17, "proxy chain");
Object.setPrototypeOf(subclass, Bytes.prototype);
equal(lengthOf(subclass), 2, "proxy removed");
const backing = new ArrayBuffer(8, { maxByteLength: 16 });
const tracking = new Uint8Array(backing);
const fixed = new Uint8Array(backing, 2, 4);
equal(lengthOf(tracking), 8, "tracking initial");
equal(lengthOf(fixed), 4, "fixed initial");
backing.resize(3);
equal(lengthOf(tracking), 3, "tracking shrunk");
equal(lengthOf(fixed), 0, "fixed out of bounds");
backing.resize(12);
equal(lengthOf(tracking), 12, "tracking grown");
equal(lengthOf(fixed), 4, "fixed restored");
backing.transfer();
equal(lengthOf(tracking), 0, "tracking detached");
equal(lengthOf(fixed), 0, "fixed detached");
const duringLoop = new ArrayBuffer(4, { maxByteLength: 8 });
const changing = new Uint8Array(duringLoop);
changing.fill(1);
equal(
	scan(changing, (i) => {
		if (i === 1) duringLoop.resize(2);
	}),
	2,
	"resize during loop",
);
const detached = new Uint8Array([1, 2, 3]);
equal(
	scan(detached, (i) => {
		if (i === 1) detached.buffer.transfer();
	}),
	1,
	"detach during loop",
);
for (let i = 0; i < 40; i++) {
	const view = new Uint8Array(2);
	Object.setPrototypeOf(view, Object.create(Uint8Array.prototype));
	equal(lengthOf(view), 2, "temporary prototype");
}
equal(lengthOf(buffer), 3, "Buffer after collection");

function byteLengthOf(view) {
	return view.byteLength;
}
for (const Ctor of constructors) {
	equal(byteLengthOf(new Ctor(3)), 3 * Ctor.BYTES_PER_ELEMENT, Ctor.name + " byteLength");
}
const words = new Uint32Array(5);
let warmBytes = 0;
for (let i = 0; i < 64; i++) warmBytes += byteLengthOf(words);
equal(warmBytes, 64 * 20, "warm byteLength site");
equal(byteLengthOf(buffer), 3, "Buffer byteLength");
const sized = new Bytes([1, 2, 3]);
equal(byteLengthOf(sized), 3, "subclass byteLength");
Object.defineProperty(sized, "byteLength", { value: 99, configurable: true });
equal(byteLengthOf(sized), 99, "own byteLength shadow");
delete sized.byteLength;
equal(byteLengthOf(sized), 3, "own byteLength shadow removed");
const middle = Object.create(Bytes.prototype);
Object.setPrototypeOf(sized, middle);
equal(byteLengthOf(sized), 3, "byteLength through custom chain");
Object.defineProperty(middle, "byteLength", {
	get() {
		return 31;
	},
	configurable: true,
});
equal(byteLengthOf(sized), 31, "intermediate byteLength getter");
delete middle.byteLength;
equal(byteLengthOf(sized), 3, "intermediate byteLength removed");
Object.setPrototypeOf(
	sized,
	new Proxy(Uint8Array.prototype, {
		get(target, key, receiver) {
			return key === "byteLength" ? 23 : Reflect.get(target, key, receiver);
		},
	}),
);
equal(byteLengthOf(sized), 23, "byteLength through proxy chain");
Object.setPrototypeOf(sized, Bytes.prototype);
equal(byteLengthOf(sized), 3, "byteLength proxy removed");
const growable = new ArrayBuffer(8, { maxByteLength: 16 });
const trackingWords = new Uint16Array(growable);
const fixedWords = new Uint16Array(growable, 2, 2);
equal(byteLengthOf(trackingWords), 8, "tracking byteLength");
equal(byteLengthOf(fixedWords), 4, "fixed byteLength");
growable.resize(3);
equal(byteLengthOf(trackingWords), 2, "tracking byteLength shrunk");
equal(byteLengthOf(fixedWords), 0, "fixed byteLength out of bounds");
growable.resize(12);
equal(byteLengthOf(trackingWords), 12, "tracking byteLength grown");
equal(byteLengthOf(fixedWords), 4, "fixed byteLength restored");
growable.transfer();
equal(byteLengthOf(trackingWords), 0, "tracking byteLength detached");
equal(byteLengthOf(fixedWords), 0, "fixed byteLength detached");
Object.defineProperty(Uint32Array.prototype, "byteLength", {
	value: 7,
	configurable: true,
});
equal(byteLengthOf(words), 7, "kind prototype byteLength shadow");
delete Uint32Array.prototype.byteLength;
equal(byteLengthOf(words), 20, "kind prototype byteLength restored");
const plainBuffer = new ArrayBuffer(16);
let warmBufferBytes = 0;
for (let i = 0; i < 64; i++) warmBufferBytes += byteLengthOf(plainBuffer);
equal(warmBufferBytes, 64 * 16, "warm ArrayBuffer byteLength site");
class Chunk extends ArrayBuffer {}
const chunk = new Chunk(6, { maxByteLength: 12 });
equal(byteLengthOf(chunk), 6, "ArrayBuffer subclass byteLength");
chunk.resize(9);
equal(byteLengthOf(chunk), 9, "resized ArrayBuffer byteLength");
Object.defineProperty(chunk, "byteLength", { value: 1, configurable: true });
equal(byteLengthOf(chunk), 1, "own ArrayBuffer byteLength shadow");
delete chunk.byteLength;
equal(byteLengthOf(chunk), 9, "own ArrayBuffer byteLength removed");
const moved = chunk.transfer();
equal(byteLengthOf(chunk), 0, "detached ArrayBuffer byteLength");
equal(byteLengthOf(moved), 9, "transferred ArrayBuffer byteLength");
const shared = new SharedArrayBuffer(4);
equal(byteLengthOf(shared), 4, "SharedArrayBuffer byteLength");
Object.setPrototypeOf(shared, ArrayBuffer.prototype);
let sharedError = "";
try {
	byteLengthOf(shared);
} catch (error) {
	sharedError = error.constructor.name;
}
equal(sharedError, "TypeError", "ArrayBuffer getter rejects a SharedArrayBuffer");
equal(byteLengthOf(plainBuffer), 16, "ArrayBuffer byteLength after rejection");
const intrinsicBufferByteLength = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
);
Object.defineProperty(ArrayBuffer.prototype, "byteLength", {
	get() {
		return "redefined";
	},
	configurable: true,
});
equal(byteLengthOf(plainBuffer), "redefined", "redefined ArrayBuffer byteLength getter");
Object.defineProperty(ArrayBuffer.prototype, "byteLength", intrinsicBufferByteLength);
equal(byteLengthOf(plainBuffer), 16, "ArrayBuffer byteLength getter restored");
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
);
Object.defineProperty(typedArrayPrototype, "byteLength", {
	get() {
		return -this.length;
	},
	configurable: true,
});
equal(byteLengthOf(words), -5, "redefined intrinsic byteLength getter");
equal(keyed(words, "byteLength"), -5, "redefined intrinsic byteLength computed");
Object.defineProperty(typedArrayPrototype, "byteLength", intrinsicByteLength);
equal(byteLengthOf(words), 20, "intrinsic byteLength getter restored");
console.log("TYPED ARRAY LENGTH PASS " + checks);
