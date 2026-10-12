import buffer, { isAscii, isUtf8 } from "node:buffer";

const results = [];
function record(name, value) {
	results.push([name, value]);
}
function validate(name, input) {
	for (const [kind, check] of [
		["ascii", isAscii],
		["utf8", isUtf8],
	]) {
		try {
			record(`${name}:${kind}`, check(input));
		} catch (error) {
			record(`${name}:${kind}`, [error.name, error.code]);
		}
	}
}

record("exports", buffer.isAscii === isAscii && buffer.isUtf8 === isUtf8);
record("metadata", [isAscii.name, isAscii.length, isUtf8.name, isUtf8.length]);
const sequences = [
	[],
	[0],
	[0x7f],
	[0x80],
	[0xc2, 0x80],
	[0xc2],
	[0xc0, 0x80],
	[0xe0, 0xa0, 0x80],
	[0xe0, 0x80, 0x80],
	[0xed, 0x9f, 0xbf],
	[0xed, 0xa0, 0x80],
	[0xef, 0xbb, 0xbf],
	[0xf0, 0x90, 0x80, 0x80],
	[0xf4, 0x8f, 0xbf, 0xbf],
	[0xf4, 0x90, 0x80, 0x80],
	[0xf5, 0x80, 0x80, 0x80],
	[0xf0, 0x90, 0x80],
	[0xff],
	[65, 0xe2, 0x82, 0xac, 66],
];
for (let index = 0; index < sequences.length; index++) {
	const bytes = new Uint8Array(sequences[index]);
	validate(`bytes-${index}`, bytes);
	validate(`buffer-${index}`, Buffer.from(bytes));
	validate(`backing-${index}`, bytes.buffer);
}
const backing = new Uint8Array([0xff, 65, 66, 0xff]);
validate("offset", new Uint8Array(backing.buffer, 1, 2));
const words = new Uint16Array(2);
new Uint8Array(words.buffer).set([65, 66, 67, 68]);
validate("uint16-bytes", words);
validate("data-view", new DataView(words.buffer));
const shared = new SharedArrayBuffer(4);
new Uint8Array(shared).set([0xe2, 0x82, 0xac, 65]);
validate("shared", shared);
validate("shared-view", new Uint8Array(shared, 0, 3));
validate("shared-buffer", Buffer.from(shared, 3, 1));
const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
const fixed = new Uint8Array(resizable, 4, 4);
const tracking = new Uint8Array(resizable, 4);
resizable.resize(2);
validate("out-of-bounds-fixed", fixed);
validate("out-of-bounds-tracking", tracking);
resizable.resize(8);
validate("restored-fixed", fixed);
const detached = new ArrayBuffer(4);
const detachedView = new Uint8Array(detached);
detached.transfer();
validate("detached-buffer", detached);
validate("detached-view", detachedView);
for (const value of [undefined, null, true, 7, "abc", [], {}, new Number(3)])
	validate(`invalid-${typeof value}-${String(value)}`, value);
let observations = [];
const proxy = new Proxy(new Uint8Array([65]), {
	get(target, key) {
		observations.push(String(key));
		return Reflect.get(target, key);
	},
});
validate("proxy", proxy);
record("proxy-observations", observations);
const sentinel = { sentinel: true };
const throwing = {
	get constructor() {
		throw sentinel;
	},
};
for (const fn of [isAscii, isUtf8]) {
	try {
		fn(throwing);
	} catch (error) {
		record("constructor-throw", error === sentinel);
	}
	record("construct", Reflect.construct(fn, [new Uint8Array([65])]) instanceof fn);
}
console.log(JSON.stringify(results));
