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
console.log("TYPED ARRAY LENGTH PASS " + checks);
