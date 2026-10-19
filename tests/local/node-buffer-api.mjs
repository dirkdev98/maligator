import buffer from "node:buffer";

const hex = (value) =>
	Buffer.isBuffer(value)
		? `<${value.toString("hex")}>`
		: JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
const show = (label, run) => {
	try {
		console.log(label, hex(run()));
	} catch (error) {
		console.log(label, error.name, error.code, error.message);
	}
};

const data = Buffer.from([0x01, 0xfe, 0x80, 0x7f, 0x00, 0xff, 0x12, 0x34, 0x56, 0x78]);
for (const name of [
	"readUInt8",
	"readInt8",
	"readUInt16LE",
	"readUInt16BE",
	"readInt16LE",
	"readInt16BE",
	"readUInt32LE",
	"readUInt32BE",
	"readInt32LE",
	"readInt32BE",
	"readFloatLE",
	"readFloatBE",
	"readDoubleLE",
	"readDoubleBE",
	"readBigUInt64LE",
	"readBigUInt64BE",
	"readBigInt64LE",
	"readBigInt64BE",
]) {
	show(name, () => [data[name](), data[name](2)]);
}
for (const width of [1, 2, 3, 4, 5, 6]) {
	show(`readUIntLE/BE/IntLE/BE ${width}`, () => [
		data.readUIntLE(1, width),
		data.readUIntBE(1, width),
		data.readIntLE(1, width),
		data.readIntBE(1, width),
	]);
}
show("aliases are the same functions", () => [
	Buffer.prototype.readUint8 === Buffer.prototype.readUInt8,
	Buffer.prototype.writeBigUint64LE === Buffer.prototype.writeBigUInt64LE,
]);

const out = Buffer.alloc(16);
show("writes return the next offset", () => [
	out.writeUInt8(255),
	out.writeInt8(-2, 1),
	out.writeUInt16LE(0xbeef, 2),
	out.writeInt16BE(-300, 4),
	out.writeUInt32BE(0xdeadbeef, 6),
	out.writeInt32LE(-5, 10),
]);
show("written bytes", () => out);
show("float and double", () => [
	out.writeFloatBE(1.5, 0),
	out.writeDoubleLE(-0.1, 4),
	out.readFloatBE(0),
	out.readDoubleLE(4),
]);
show("bigint", () => [
	out.writeBigInt64BE(-2n, 0),
	out.writeBigUInt64LE(2n ** 64n - 1n, 8),
	out.readBigInt64BE(0),
	out.readBigUInt64LE(8),
]);
for (const width of [1, 3, 5, 6]) {
	show(`writeUIntLE/IntBE ${width}`, () => [
		out.fill(0).writeUIntLE(2 ** (8 * width) - 2, 0, width),
		out.writeIntBE(-(2 ** (8 * width - 1)), 8, width),
		out,
	]);
}
show("writes truncate fractions", () => [
	out.fill(0).writeUInt16LE(513.9),
	out.readUInt16LE(0),
	out.writeInt32BE(-1.5),
	out.readInt32BE(0),
]);

const small = Buffer.alloc(4);
show("offset type", () => small.readUInt8("1"));
show("offset fraction", () => small.readUInt16LE(1.5));
show("offset range", () => small.readUInt32LE(1));
show("too small", () => Buffer.alloc(2).readUInt32BE());
show("value range", () => small.writeInt16LE(40000));
show("wide value range", () => small.writeUIntBE(2 ** 41, 0, 5));
show("bigint range", () => Buffer.alloc(8).writeBigInt64LE(2n ** 63n));
show("bigint mixing", () => Buffer.alloc(8).writeBigInt64LE(1));
show("byteLength range", () => small.readIntLE(0, 7));
show("missing variable offset", () => small.readUIntBE(undefined, 2));

const text = Buffer.from("this is a buffer is");
show("indexOf", () => [
	text.indexOf("is"),
	text.indexOf("is", 3),
	text.indexOf("is", -5),
	text.indexOf(105),
	text.indexOf(105 + 256),
	text.indexOf(Buffer.from("buf")),
	text.indexOf("6973", "hex"),
	text.indexOf(""),
	text.indexOf("", 100),
]);
show("lastIndexOf", () => [
	text.lastIndexOf("is"),
	text.lastIndexOf("is", 10),
	text.lastIndexOf("is", -5),
	text.lastIndexOf(105, 100),
	text.lastIndexOf(105, -100),
	text.lastIndexOf(""),
	text.lastIndexOf("", 3),
	text.lastIndexOf("is", null),
]);
show("includes", () => [
	text.includes("buffer"),
	text.includes("zz"),
	text.includes("is", 18),
]);
const wide = Buffer.from("abcabcab", "ucs2");
show("ucs2 search", () => [
	wide.indexOf("b", "ucs2"),
	wide.indexOf("b", 3, "ucs2"),
	wide.lastIndexOf("b", undefined, "ucs2"),
	wide.lastIndexOf("ca", 9, "ucs2"),
]);
show("search type", () => text.indexOf({}));
show("search encoding", () => text.indexOf("a", 0, "bogus"));

show("fill", () =>
	[
		Buffer.alloc(5).fill("ab", 1),
		Buffer.alloc(6).fill("Ȣaa"),
		Buffer.alloc(4).fill("abcd", "base64"),
		Buffer.alloc(3).fill(257),
		Buffer.alloc(3).fill(true),
		Buffer.alloc(4).fill(Buffer.from([1, 2, 3])),
		Buffer.from("abc").fill(""),
	].map(String),
);
show("fill hex bytes", () => Buffer.alloc(4).fill("0102", "hex"));
show("fill invalid", () => Buffer.alloc(4).fill("zz", "hex"));
show("fill empty view", () => Buffer.alloc(4).fill(Buffer.alloc(0)));
show("fill end range", () => Buffer.alloc(4).fill("a", 1, 10));
show("fill offset past end", () => Buffer.alloc(4).fill("a", 5));
show("fill encoding", () => Buffer.alloc(4).fill("a", "bogus"));

show("swap", () =>
	[
		Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap16(),
		Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap32(),
		Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64(),
	].map((b) => b.toString("hex")),
);
show("swap size", () => Buffer.alloc(3).swap32());
show("toJSON", () => Buffer.from([1, 2, 3]).toJSON());
show("JSON.stringify", () => JSON.stringify({ b: Buffer.from("hi") }));
const accented = Buffer.from("héllo");
show("slices", () => [
	accented.utf8Slice(),
	accented.latin1Slice(1, 3),
	accented.hexSlice(),
	accented.base64Slice(),
	accented.base64urlSlice(0, 4),
	accented.asciiSlice(),
	accented.utf8Slice(2),
	accented.utf8Slice(5),
]);
const target = Buffer.alloc(8);
show("encoded writes", () => [
	target.utf8Write("héllo"),
	target.hexWrite("abcd", 6),
	target.latin1Write("xyz", 1, 2),
	target.ucs2Write("hi", 3),
	target.base64Write("aGk=", 0),
	target.asciiWrite("é", 7),
	target,
]);
show("encoded write type", () => target.utf8Write(1));
show("encoded write offset", () => target.utf8Write("a", 9));
show("Uint8Array receivers", () => [
	Buffer.prototype.readUInt16BE.call(new Uint8Array([1, 2]), 0),
	Buffer.prototype.toString.call(new Uint8Array([104, 105])),
]);
show("parent and offset", () => {
	const view = Buffer.alloc(6).subarray(2);
	return [
		view.parent === view.buffer,
		view.offset,
		Object.getOwnPropertyDescriptor(Buffer.prototype, "offset").enumerable,
	];
});
show("inspect", () => [
	Buffer.from("hi").inspect(),
	Buffer.alloc(52).inspect(),
	Buffer.alloc(0).inspect(),
	Buffer.prototype[Symbol.for("nodejs.util.inspect.custom")] === Buffer.prototype.inspect,
]);
show("Buffer.of", () => Buffer.of(1, 2, 300));
show("allocUnsafeSlow", () => [Buffer.allocUnsafeSlow(3).length, Buffer.poolSize]);
show("alloc size type", () => Buffer.alloc("2"));
show(
	"toLocaleString",
	() => Buffer.prototype.toLocaleString === Buffer.prototype.toString,
);
show("module exports", () => [
	buffer.INSPECT_MAX_BYTES,
	typeof buffer.kMaxLength,
	typeof buffer.kStringMaxLength,
	typeof buffer.constants.MAX_LENGTH,
	buffer.atob("aGk="),
	buffer.btoa("hi"),
	typeof buffer.Blob,
]);

const {
	File: BufferFile,
	Blob: BufferBlob,
	atob: bufferAtob,
	INSPECT_MAX_BYTES,
} = buffer;
const file = new File(["ab", "c"], "x.txt", { type: "text/plain", lastModified: 5 });
const fileText = await file.text();
show("File", () => [
	file.name,
	file.size,
	file.type,
	file.lastModified,
	file instanceof Blob,
	String(file),
	BufferFile === File,
	BufferBlob === Blob,
]);
show("File text", () => [
	fileText,
	Object.getPrototypeOf(File) === Blob,
	File.length,
	new File([], 7).name,
]);
show("File missing args", () => new File(["a"]));
show("named exports", () => [typeof bufferAtob, INSPECT_MAX_BYTES]);
