import {
	Readable,
	duplexPair,
	PassThrough,
	addAbortSignal,
	destroy,
	getDefaultHighWaterMark,
	isDestroyed,
	isDisturbed,
	isErrored,
	isReadable,
	isWritable,
	setDefaultHighWaterMark,
} from "node:stream";
import { arrayBuffer, buffer, bytes, json, text } from "node:stream/consumers";
import { ReadableStream, TransformStream, WritableStream } from "node:stream/web";

const euro = Buffer.from("€uro");
const split = new Readable({ read() {}, encoding: "utf8" });
const pieces = [];
split.on("data", (chunk) => pieces.push([typeof chunk, chunk]));
split.on("end", () => console.log("utf8 option", JSON.stringify(pieces)));
split.push(euro.subarray(0, 1));
split.push(euro.subarray(1, 3));
split.push(euro.subarray(3));
split.push(null);

const hex = new Readable({ read() {} });
hex.setEncoding("hex");
const hexPieces = [];
hex.on("data", (chunk) => hexPieces.push(chunk));
hex.on("end", () =>
	console.log("hex", hexPieces.join("|"), hex.readableEncoding ?? "n/a"),
);
hex.push(Buffer.from([1, 2]));
hex.push(Buffer.from([255]));
hex.push(null);

const tail = new Readable({ read() {} });
tail.setEncoding("utf8");
let tailText = "";
tail.on("data", (chunk) => (tailText += chunk));
tail.on("end", () => console.log("tail", JSON.stringify(tailText)));
tail.push(euro.subarray(0, 2));
tail.push(null);

console.log(getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));
setDefaultHighWaterMark(false, 1024);
console.log(getDefaultHighWaterMark(false), new Readable().readableHighWaterMark);
setDefaultHighWaterMark(false, 65536);

const probe = new Readable({ read() {} });
console.log(
	isReadable(probe),
	isWritable(probe),
	isErrored(probe),
	isDestroyed(probe),
	isDisturbed(probe),
);
console.log(isReadable({}), isWritable({}), isDestroyed({}));
const pass = new PassThrough();
console.log(isWritable(pass));
let destroyError;
pass.on("error", (error) => (destroyError = `${error.name} ${error.code}`));
destroy(pass);
console.log(isDestroyed(pass), isReadable(pass));
setTimeout(() => console.log("destroy", destroyError), 0);

const controller = new AbortController();
const aborted = new Readable({ read() {} });
aborted.on("error", (error) => console.log("abort", error.name, error.code));
console.log(addAbortSignal(controller.signal, aborted) === aborted);
controller.abort();

console.log(await text(Readable.from(["a", "b", "€"])));
console.log(await json(Readable.from([Buffer.from('{"k":'), Buffer.from("[1,2]}")])));
const joined = await buffer(Readable.from([Buffer.from([1]), Buffer.from([2, 3])]));
console.log(Buffer.isBuffer(joined), joined);
const raw = await bytes(Readable.from([Buffer.from("xy")]));
console.log(raw instanceof Uint8Array, Buffer.isBuffer(raw), [...raw]);
const ab = await arrayBuffer(Readable.from([Buffer.from("abc")]));
console.log(ab instanceof ArrayBuffer, ab.byteLength);
console.log(
	ReadableStream === globalThis.ReadableStream,
	TransformStream === globalThis.TransformStream,
	typeof WritableStream,
);
const [left, right] = duplexPair();
right.on("data", (chunk) => console.log("right got", chunk));
right.on("end", () => console.log("right end"));
left.on("data", (chunk) => console.log("left got", String(chunk)));
left.write("x");
right.write("back");
left.end();
