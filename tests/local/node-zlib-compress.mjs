import { Buffer } from "node:buffer";
import zlib from "node:zlib";

const text = "node:zlib round trip; ".repeat(300);
const pairs = [
	["deflate", "inflate", zlib.Deflate, zlib.Inflate],
	["gzip", "gunzip", zlib.Gzip, zlib.Gunzip],
	["deflateRaw", "inflateRaw", zlib.DeflateRaw, zlib.InflateRaw],
	["brotliCompress", "brotliDecompress", zlib.BrotliCompress, zlib.BrotliDecompress],
];

function describe(error) {
	return `${error.name} ${error.code} ${error.message}`;
}

function collect(stream, input, write) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", (chunk) => chunks.push(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		write(stream, input);
	});
}

function writeSplit(stream, input) {
	const third = Math.floor(input.length / 3);
	stream.write(input.subarray(0, third));
	stream.write(input.subarray(third, 2 * third));
	stream.end(input.subarray(2 * third));
}

const inputs = [
	["string", text],
	["Buffer", Buffer.from(text)],
	["Uint8Array", new TextEncoder().encode(text)],
	["DataView", new DataView(new TextEncoder().encode(text).buffer)],
	["ArrayBuffer", new TextEncoder().encode(text).buffer],
];
for (const [kind, input] of inputs) {
	const encoded = zlib.deflateSync(input);
	console.log(`input ${kind}`, zlib.inflateSync(encoded).toString() === text);
}

for (const [compress, decompress] of pairs) {
	const encoded = zlib[`${compress}Sync`](text);
	console.log(
		`${compress}Sync`,
		encoded.length < text.length,
		zlib[`${decompress}Sync`](encoded).toString() === text,
	);
}

const gzipped = zlib.gzipSync(text, { level: 9 });
console.log("gzip header", gzipped[0], gzipped[1], gzipped[2]);
const deflated = zlib.deflateSync(text, { level: 1, windowBits: 9 });
console.log("zlib header", deflated[0] & 0x0f, (deflated[0] * 256 + deflated[1]) % 31);
console.log("unzip gzip", zlib.unzipSync(gzipped).toString() === text);
console.log("unzip deflate", zlib.unzipSync(deflated).toString() === text);
console.log(
	"level 0 stores",
	zlib.deflateRawSync(text, { level: 0 }).length > text.length,
);
const quality = zlib.brotliCompressSync(text, {
	params: {
		[zlib.constants.BROTLI_PARAM_QUALITY]: 4,
		[zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length,
	},
});
console.log("brotli params", zlib.brotliDecompressSync(quality).toString() === text);
const varied = Array.from({ length: 4000 }, (_, i) =>
	((i * 7919) % 10007).toString(36),
).join(" ");
const variedGzip = zlib.gzipSync(varied);
const partial = variedGzip.subarray(0, variedGzip.length >> 1);
console.log(
	"sync finishFlush",
	zlib.gunzipSync(partial, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).length > 0,
);
const info = zlib.deflateSync("abc", { info: true });
console.log("info", Buffer.isBuffer(info.buffer), typeof info.engine);

console.log(
	"crc32",
	zlib.crc32("123456789"),
	zlib.crc32(Buffer.from("56789"), zlib.crc32("1234")),
);
console.log("codes", zlib.codes.Z_DATA_ERROR, zlib.codes["-5"], zlib.codes.Z_OK);
console.log(
	"constants",
	Object.keys(zlib.constants).length,
	zlib.constants.Z_MAX_CHUNK,
	zlib.constants.BROTLI_DEFAULT_QUALITY,
);

for (const [label, run] of [
	["level", () => zlib.deflateSync("x", { level: 10 })],
	["windowBits", () => zlib.gzipSync("x", { windowBits: 16 })],
	["chunkSize", () => zlib.createGzip({ chunkSize: 10 })],
	["strategy type", () => zlib.deflateSync("x", { strategy: "fast" })],
	["input", () => zlib.gzipSync(42)],
	["callback", () => zlib.gzip("x")],
	["crc32 value", () => zlib.crc32("x", -1)],
	["truncated", () => zlib.gunzipSync(zlib.gzipSync(text).subarray(0, 20))],
	[
		"maxOutputLength",
		() => zlib.inflateSync(zlib.deflateSync(text), { maxOutputLength: 100 }),
	],
]) {
	try {
		run();
		console.log(label, "no error");
	} catch (error) {
		console.log(label, describe(error));
	}
}

for (const [compress, decompress] of pairs) {
	const encoded = await new Promise((resolve, reject) =>
		zlib[compress](text, { level: 6 }, (error, result) =>
			error ? reject(error) : resolve(result),
		),
	);
	const decoded = await new Promise((resolve, reject) =>
		zlib[decompress](encoded, (error, result) =>
			error ? reject(error) : resolve(result),
		),
	);
	console.log(`async ${compress}`, decoded.toString() === text);
}
await new Promise((resolve) =>
	zlib.gunzip(Buffer.from("garbage"), (error, result) => {
		console.log("async error", error.name, error.code, error.errno, result);
		resolve();
	}),
);

for (const [compress, decompress, Compressor, Decompressor] of pairs) {
	const plain = Buffer.from(text);
	const created = zlib[`create${compress[0].toUpperCase()}${compress.slice(1)}`]({
		chunkSize: 128,
	});
	const encoded = await collect(created, plain, writeSplit);
	console.log(`stream ${compress}`, created instanceof Compressor, created.bytesWritten);
	const constructed = new Decompressor();
	const decoded = await collect(constructed, encoded, writeSplit);
	console.log(
		`stream ${decompress}`,
		constructed instanceof Decompressor,
		decoded.toString() === text,
	);
	console.log(`call ${Compressor.name}`, Compressor() instanceof Compressor);
}

const flushing = zlib.createGzip();
const flushed = [];
flushing.on("data", (chunk) => flushed.push(chunk));
flushing.write("first part ");
await new Promise((resolve) => flushing.flush(resolve));
const prefix = Buffer.concat(flushed);
console.log(
	"flush emits decodable prefix",
	zlib.gunzipSync(prefix, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString(),
);
await new Promise((resolve) =>
	flushing.params(9, zlib.constants.Z_DEFAULT_STRATEGY, resolve),
);
flushing.end("second part");
await new Promise((resolve) => flushing.on("end", resolve));
console.log("params then end", zlib.gunzipSync(Buffer.concat(flushed)).toString());

try {
	zlib.inflateSync(Buffer.from("not a zlib stream"));
} catch (error) {
	console.log("corrupt", error.name, error.code, error.errno);
}

const brotliFlushing = zlib.createBrotliCompress();
const brotliFlushed = [];
brotliFlushing.on("data", (chunk) => brotliFlushed.push(chunk));
brotliFlushing.write("brotli flush ");
await new Promise((resolve) => brotliFlushing.flush(resolve));
await new Promise((resolve) => brotliFlushing.flush(resolve));
brotliFlushing.end("done");
await new Promise((resolve) => brotliFlushing.on("end", resolve));
console.log(
	"brotli flush",
	zlib.brotliDecompressSync(Buffer.concat(brotliFlushed)).toString(),
);

const resettable = zlib.createDeflate();
resettable.reset();
const afterReset = await collect(resettable, Buffer.from(text), writeSplit);
console.log("reset", zlib.inflateSync(afterReset).toString() === text);
const closing = zlib.createInflate();
await new Promise((resolve) => closing.close(resolve));
console.log("close", closing._closed, closing.destroyed);

const vector = "node vector ".repeat(20);
for (const [decompress, encoded] of [
	["inflateRawSync", "y8tPSVUoS00uyS9SyBsBbAA="],
	["brotliDecompressSync", "G+8A+B2pU5+7WbnZNcgYmZwGKXujEwPGAnqU1Bs="],
	["unzipSync", "H4sIAAAAAAAAE8vLT0lVKEtNLskvUsgbAWwAaG8ml/AAAAA="],
]) {
	console.log(
		`node vector ${decompress}`,
		zlib[decompress](Buffer.from(encoded, "base64")).toString() === vector,
	);
}
for (const [compress] of pairs) {
	console.log(`blob ${compress} ${zlib[`${compress}Sync`](text).toString("base64")}`);
}
