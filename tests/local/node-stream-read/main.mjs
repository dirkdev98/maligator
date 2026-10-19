import { PassThrough, Readable } from "node:stream";

const log = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));

const pass = new PassThrough();
console.log(typeof pass.read, pass.read.length);
pass.write("hello ");
pass.write("world");
await tick();
console.log(
	pass.readableLength,
	String(pass.read(3)),
	pass.readableLength,
	String(pass.read()),
	pass.read(),
);
pass.end();
pass.on("end", () => log.push("end"));
await tick();
console.log(pass.read(), log.join(","));

let index = 0;
const counter = new Readable({
	highWaterMark: 4,
	read() {
		index += 1;
		this.push(index <= 3 ? `c${index}` : null);
	},
});
const seen = [];
counter.on("readable", () => {
	let chunk;
	while ((chunk = counter.read()) !== null) seen.push(String(chunk));
	seen.push("|");
});
await new Promise((resolve) => counter.on("end", resolve));
console.log(seen.join(""), counter.readableEnded);

const objects = new Readable({ objectMode: true, read() {} });
objects.push({ a: 1 });
objects.push({ b: 2 });
objects.push(null);
console.log(
	JSON.stringify(objects.read()),
	JSON.stringify(objects.read(5)),
	objects.read(),
	objects.readableLength,
);
await tick();
console.log(objects.read());

const text = new Readable({ encoding: "utf8", read() {} });
text.push("abc");
text.push("def");
console.log(text.read(4), text.read(1), text.read(), text.read());

const big = new Readable({ highWaterMark: 2, read() {} });
big.read(100);
console.log(big.readableHighWaterMark);
try {
	big.read(2 ** 31);
} catch (error) {
	console.log(error.code, error.name);
}

const zero = new Readable({ read() {} });
zero.push(Buffer.from("xyz"));
console.log(
	zero.read(0),
	zero.readableLength,
	String(zero.read("2")),
	String(zero.read(10)),
);
zero.push(null);
console.log(String(zero.read(10)), zero.read());

const { Transform, Writable, pipeline } = await import("node:stream");
const lifecycle = [];
const upper = new Transform({
	transform(chunk, encoding, callback) {
		callback(null, String(chunk).toUpperCase());
	},
});
for (const event of ["data", "prefinish", "end", "finish", "close"]) {
	upper.on(event, (value) =>
		lifecycle.push(value === undefined ? event : `${event}:${value}`),
	);
}
upper.end("x");
await new Promise((resolve) => setTimeout(resolve, 20));
console.log(lifecycle.join(","), upper.destroyed);

const sinkEvents = [];
const sink = new Writable({
	write(chunk, encoding, callback) {
		callback();
	},
});
for (const event of ["prefinish", "finish", "close"])
	sink.on(event, () => sinkEvents.push(event));
sink.end("y");
const kept = new Readable({ autoDestroy: false, read() {} });
kept.resume();
kept.push(null);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log(sinkEvents.join(","), sink.destroyed, kept.readableEnded, kept.destroyed);

const buffered = new PassThrough();
buffered.end("abc");
buffered.on("finish", () => {});
await tick();
console.log(String(buffered.read()), buffered.read(), buffered.readableEnded);
await tick();
console.log(buffered.readableEnded, buffered.destroyed);

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const crypto = await import("node:crypto");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mal-stream-read-"));
const file = path.join(directory, "input.txt");
fs.writeFileSync(file, "hash me through a pipeline\n");
const hash = crypto.createHash("sha256");
await new Promise((resolve, reject) =>
	pipeline(fs.createReadStream(file), hash, (error) =>
		error ? reject(error) : resolve(),
	),
);
console.log(hash.read().toString("hex"));
fs.rmSync(directory, { recursive: true, force: true });

const slow = new Writable({
	highWaterMark: 5,
	write(chunk, encoding, callback) {
		setTimeout(callback, 1);
	},
});
slow.write("abc");
slow.write("de");
console.log(
	slow.writableLength,
	slow.writableHighWaterMark,
	slow.writableObjectMode,
	Object.hasOwn(slow, "writableObjectMode"),
);
const objectDuplex = new PassThrough({ objectMode: true });
console.log(
	objectDuplex.writableObjectMode,
	objectDuplex.writableHighWaterMark,
	"writableLength" in Writable.prototype,
);
await new Promise((resolve) => slow.end(resolve));
