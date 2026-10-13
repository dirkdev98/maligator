import { Buffer } from "node:buffer";
const results = [];
function copy(label, ...args) {
	try {
		const value = Buffer.copyBytesFrom(...args);
		results.push([label, Buffer.isBuffer(value), [...value]]);
	} catch (error) {
		results.push([label, error.name, error.code]);
	}
}
for (const Type of [
	Uint8Array,
	Int8Array,
	Uint8ClampedArray,
	Uint16Array,
	Int16Array,
	Uint32Array,
	Int32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
]) {
	const view = new Type(4);
	const bytes = new Uint8Array(view.buffer);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i + 1;
	copy(Type.name, view);
	copy(Type.name + ":slice", view, 1, 2);
}
const input = new Uint16Array([0x1234, 0x5678]);
for (const offset of [
	undefined,
	0,
	1,
	2,
	3,
	-1,
	0.5,
	NaN,
	Infinity,
	Number.MAX_SAFE_INTEGER,
	Number.MAX_SAFE_INTEGER + 1,
	"1",
	null,
	1n,
	Symbol("o"),
])
	copy("offset:" + String(offset), input, offset, 1);
for (const length of [
	undefined,
	0,
	1,
	99,
	-1,
	0.5,
	NaN,
	Infinity,
	Number.MAX_SAFE_INTEGER,
	Number.MAX_SAFE_INTEGER + 1,
	"1",
	null,
	1n,
	Symbol("l"),
])
	copy("length:" + String(length), input, 0, length);
copy("empty ignores offset", new Uint8Array(0), Symbol("o"), Symbol("l"));
copy("past end ignores length", input, 2, Symbol("l"));
copy("DataView", new DataView(input.buffer));
copy("ArrayBuffer", input.buffer);
copy("proxy", new Proxy(input, {}));
const backing = new ArrayBuffer(8, { maxByteLength: 16 });
const view = new Uint16Array(backing, 4, 2);
backing.resize(2);
copy("out of bounds", view);
backing.resize(8);
copy("restored", view);
const detached = new Uint8Array([1, 2]);
detached.buffer.transfer();
copy("detached", detached);
const shared = new Uint16Array(new SharedArrayBuffer(8));
new Uint8Array(shared.buffer).set([1, 2, 3, 4, 5, 6, 7, 8]);
copy("shared", shared, 1, 2);
const original = new Uint8Array([1, 2]);
const cloned = Buffer.copyBytesFrom(original);
original[0] = 9;
results.push(["independent", [...cloned]]);
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
copy("view byte offset", new Uint16Array(bytes.buffer, 2, 2), 1, 1);
const effects = [];
const throwing = {
	get constructor() {
		effects.push("constructor");
		throw original;
	},
};
try {
	Buffer.copyBytesFrom(throwing);
} catch (error) {
	results.push(["constructor throws", error === original, effects]);
}
const functionNameEffects = [];
function namedInput() {}
Object.defineProperty(namedInput, "name", {
	value: {
		[Symbol.toPrimitive](hint) {
			functionNameEffects.push(hint);
			throw original;
		},
	},
});
try {
	Buffer.copyBytesFrom(namedInput);
} catch (error) {
	results.push(["function name throws", error === original, functionNameEffects]);
}
const metadata = Buffer.copyBytesFrom;
results.push([
	"metadata",
	metadata.name,
	metadata.length,
	Object.getOwnPropertyDescriptor(metadata, "prototype"),
]);
const ntEffects = [];
const nt = new Proxy(function Target() {}, {
	get(target, key) {
		ntEffects.push(String(key));
		return Reflect.get(target, key);
	},
});
const instance = Reflect.construct(metadata, [new Uint8Array([3])], nt);
results.push([
	"construct",
	Buffer.isBuffer(instance),
	instance instanceof metadata,
	[...instance],
	ntEffects,
]);
console.log(JSON.stringify(results));
