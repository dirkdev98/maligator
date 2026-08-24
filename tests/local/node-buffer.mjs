import bufferDefault, { Buffer as ImportedBuffer, constants } from "node:buffer";

const results = [];
function check(name, value) {
	results.push([name, !!value]);
}
function throws(name, constructor, fn) {
	let error;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	check(name, error instanceof constructor);
}

check(
	"ESM and global constructor identity",
	ImportedBuffer === Buffer && bufferDefault.Buffer === Buffer,
);
check(
	"buffer constants expose the string limit",
	bufferDefault.constants === constants && constants.MAX_STRING_LENGTH > 0,
);
const basic = Buffer.from([0, 1, 255, 256, -1]);
check(
	"Uint8Array compatibility and branding",
	basic instanceof Buffer &&
		basic instanceof Uint8Array &&
		ArrayBuffer.isView(basic) &&
		Buffer.isBuffer(basic) &&
		!Buffer.isBuffer(new Uint8Array(1)) &&
		basic.join(",") === "0,1,255,0,255",
);

check("utf8 round trip", Buffer.from("hé😀").toString() === "hé😀");
check("utf8 byte length", Buffer.byteLength("hé😀", "utf8") === 7);
check(
	"utf8 replaces lone surrogates and malformed bytes",
	Buffer.from("\ud800").toString("hex") === "efbfbd" &&
		Buffer.from([0xe1, 0x80, 0x41]).toString() === "�A" &&
		Buffer.from([0xed, 0xa0, 0x80]).toString() === "���",
);
check(
	"latin1 and binary aliases",
	Buffer.from("éÿ", "latin1").toString("binary") === "éÿ",
);
check(
	"utf16le and ucs2 aliases",
	Buffer.from("A😀\ud800", "utf16le").toString("hex") === "41003dd800de00d8" &&
		Buffer.from([0x41, 0, 0x42]).toString("ucs-2") === "A" &&
		Buffer.byteLength("A😀", "utf-16le") === 6,
);
check(
	"ascii decode masks high bit",
	Buffer.from([0xc1, 0x7a]).toString("ascii") === "Az",
);
check(
	"hex encode and forgiving decode",
	Buffer.from("68656c6c6f-tail", "hex").toString() === "hello" &&
		Buffer.from("hello").toString("hex") === "68656c6c6f",
);
check(
	"base64 round trip",
	Buffer.from("aGVs bG8=!!", "base64").toString() === "hello" &&
		Buffer.from("hello").toString("base64") === "aGVsbG8=",
);
check(
	"base64url round trip and cross-alphabet input",
	Buffer.from([0xfb, 0xff]).toString("base64url") === "-_8" &&
		Buffer.from("-_8", "base64").toString("hex") === "fbff" &&
		Buffer.from("+/8=", "base64url").toString("hex") === "fbff",
);

const backing = new ArrayBuffer(5);
const whole = new Uint8Array(backing);
whole.set([9, 1, 2, 3, 9]);
const shared = Buffer.from(backing, 1, 3);
shared[0] = 7;
whole[2] = 8;
check("ArrayBuffer construction is a shared view", whole[1] === 7 && shared[1] === 8);

const sourceView = new Uint8Array(backing, 1, 3);
const copiedView = Buffer.from(sourceView);
sourceView[0] = 4;
check("typed-array construction copies elements", copiedView[0] === 7);
const copiedBuffer = Buffer.from(copiedView);
copiedView[1] = 5;
check("Buffer construction copies", copiedBuffer[1] === 8);
const dataView = new DataView(backing, 1, 3);
const copiedDataView = Buffer.from(dataView);
dataView.setUint8(0, 6);
check(
	"DataView construction follows Node array-like semantics",
	copiedDataView.length === 0 && Buffer.byteLength(dataView) === 3,
);
const resizableDataViewBuffer = new ArrayBuffer(4, { maxByteLength: 8 });
const fixedDataView = new DataView(resizableDataViewBuffer, 1, 3);
const trackingDataView = new DataView(resizableDataViewBuffer, 1);
resizableDataViewBuffer.resize(2);
check(
	"DataView byteLength tracks a resized backing store",
	Buffer.byteLength(trackingDataView) === 1,
);
throws("DataView byteLength rejects an out-of-bounds view", TypeError, () =>
	Buffer.byteLength(fixedDataView),
);
const detachedDataViewBuffer = new ArrayBuffer(1);
const detachedDataView = new DataView(detachedDataViewBuffer);
detachedDataViewBuffer.transfer();
throws("DataView byteLength rejects a detached view", TypeError, () =>
	Buffer.byteLength(detachedDataView),
);

const sliced = shared.slice(1, 3);
const subarray = shared.subarray(-2);
sliced[0] = 42;
subarray[1] = 43;
check(
	"slice and subarray share backing storage",
	shared[1] === 42 &&
		shared[2] === 43 &&
		Buffer.isBuffer(sliced) &&
		Buffer.isBuffer(subarray),
);

const allocated = Buffer.alloc(5, "ab");
const repeatedFill = Buffer.alloc(257, "abc");
const unsafe = Buffer.allocUnsafe(4);
check("alloc fill", allocated.toString() === "ababa");
check(
	"alloc repeats native string fill",
	repeatedFill[0] === 97 && repeatedFill[128] === 99 && repeatedFill[256] === 98,
);
check(
	"allocUnsafe is safely zero-filled",
	unsafe.length === 4 &&
		unsafe[0] === 0 &&
		unsafe[1] === 0 &&
		unsafe[2] === 0 &&
		unsafe[3] === 0,
);

const concatenated = Buffer.concat([Buffer.from("ab"), new Uint8Array([99, 100])]);
const padded = Buffer.concat([Buffer.from("x")], 3);
check("concat copies Buffer and Uint8Array", concatenated.toString() === "abcd");
check("concat totalLength truncates or zero-pads", padded.toString("hex") === "780000");

const typedCopies = [
	Buffer.from(new Int8Array([-1]))[0],
	Buffer.from(new Uint8Array([254]))[0],
	Buffer.from(new Uint8ClampedArray([253]))[0],
	Buffer.from(new Int16Array([257]))[0],
	Buffer.from(new Uint16Array([258]))[0],
	Buffer.from(new Int32Array([-2]))[0],
	Buffer.from(new Uint32Array([260]))[0],
	Buffer.from(new Float32Array([261.75]))[0],
	Buffer.from(new Float64Array([-3.5]))[0],
];
check(
	"Buffer.from converts every numeric TypedArray variant",
	typedCopies.join() === "255,254,253,1,2,254,4,5,253",
);
check(
	"static and prototype compare",
	Buffer.compare(Buffer.from("a"), Buffer.from("b")) === -1 &&
		Buffer.from("b").compare(Buffer.from("a")) === 1 &&
		Buffer.from("same").equals(new Uint8Array([115, 97, 109, 101])),
);

const writable = Buffer.alloc(8);
const written = writable.write("hé", 1, 4, "utf8");
check(
	"write returns bytes and honors offset",
	written === 3 && writable.slice(1, 4).toString() === "hé",
);
check("write avoids partial utf8", Buffer.alloc(1).write("é") === 0);
const integers = Buffer.alloc(8);
check(
	"iconv-lite integer primitives",
	integers.writeUInt32LE(0x12345678, 0) === 4 &&
		integers.writeUInt32BE(0x90abcdef, 4) === 8 &&
		integers.toString("hex") === "7856341290abcdef" &&
		integers.readUInt16LE(1) === 0x3456,
);
const postgresIntegers = Buffer.alloc(16);
check(
	"postgres integer primitives",
	postgresIntegers.writeUInt16BE(0xabcd, 0) === 2 &&
		postgresIntegers.writeUInt32BE(0xf1234567, 2) === 6 &&
		postgresIntegers.writeBigInt64BE(-0x102030405060708n, 8) === 16 &&
		postgresIntegers.readUInt16BE(0) === 0xabcd &&
		postgresIntegers.readUInt32BE(2) === 0xf1234567 &&
		postgresIntegers.readInt32BE(2) === -249346713 &&
		postgresIntegers.readBigInt64BE(8) === -0x102030405060708n,
);
const copied = new Uint8Array(5);
const copySource = Buffer.from("abcdef");
check(
	"copy supports ranges and Uint8Array targets",
	copySource.copy(copied, 1, 2, 6) === 4 &&
		copied.every((byte, index) => byte === [0, 99, 100, 101, 102][index]),
);
const overlap = Buffer.from("abcde");
check(
	"copy preserves overlapping bytes",
	overlap.copy(overlap, 1, 0, 4) === 4 && overlap.toString() === "aabcd",
);

const empty = Buffer.alloc(0);
check(
	"empty Buffer operations",
	empty.toString() === "" &&
		Buffer.compare(empty, Buffer.alloc(0)) === 0 &&
		Buffer.concat([empty, Buffer.from("x")]).toString() === "x",
);

const arrayLike = Buffer.from({ 0: 257, 1: -2, length: "2" });
check(
	"array-like length and element coercion",
	arrayLike[0] === 1 && arrayLike[1] === 254,
);
const rootedElement = Buffer.from({
	length: 1,
	get 0() {
		return {
			valueOf() {
				for (let i = 0; i < 100; i++) ({ i });
				return 7;
			},
		};
	},
});
check("array-like element remains rooted during coercion", rootedElement[0] === 7);
check(
	"Buffer methods use Node descriptors",
	Object.getOwnPropertyDescriptor(Buffer, "from").enumerable &&
		Object.getOwnPropertyDescriptor(Buffer.prototype, "toString").enumerable,
);
check(
	"API-specific encoding fallbacks",
	Buffer.from("é", null).toString("hex") === "c3a9" &&
		Buffer.byteLength("é", "unknown") === 2 &&
		Buffer.byteLength("61zz", "hex") === 1 &&
		Buffer.byteLength("aGVs bG8=!!", "base64") === 5 &&
		Buffer.from("abc").toString("utf8", -1) === "abc",
);
check("constructor number form", Buffer(2).length === 2 && new Buffer(2).length === 2);

throws("Buffer.from rejects numbers", TypeError, () => Buffer.from(3));
throws("Buffer.from rejects BigInt typed arrays", TypeError, () =>
	Buffer.from(new BigInt64Array([1n])),
);
throws("unknown encoding rejects", TypeError, () => Buffer.from("x", "wat"));
throws("negative allocation rejects", RangeError, () => Buffer.alloc(-1));
throws("missing allocation size rejects", TypeError, () => Buffer.alloc());
throws("string allocation size rejects", TypeError, () => Buffer.alloc("2"));
throws("NaN allocation size rejects", RangeError, () => Buffer.alloc(NaN));
throws("fractional concat totalLength rejects", RangeError, () => Buffer.concat([], 1.5));
throws("invalid ArrayBuffer range rejects", RangeError, () => Buffer.from(backing, 4, 2));
throws("compare rejects non-byte views", TypeError, () =>
	Buffer.compare(basic, new Uint16Array(1)),
);
throws("prototype receiver is branded", TypeError, () =>
	Buffer.prototype.toString.call(new Uint8Array(1)),
);
throws("compare rejects negative ranges", RangeError, () =>
	Buffer.from("a").compare(Buffer.from("a"), -1),
);
throws("write rejects excessive lengths", RangeError, () =>
	Buffer.alloc(1).write("x", 0, 2),
);
throws("write rejects fractional offsets", RangeError, () =>
	Buffer.alloc(1).write("x", 0.5),
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
