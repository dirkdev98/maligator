import { compose, PassThrough, Readable, Transform, Writable } from "node:stream";

function upper() {
	return new Transform({
		transform(chunk, encoding, callback) {
			callback(null, String(chunk).toUpperCase());
		},
	});
}

function suffix(text) {
	return new Transform({
		transform(chunk, encoding, callback) {
			callback(null, `${chunk}${text}`);
		},
	});
}

async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(String(chunk));
	return chunks.join("|");
}

const composed = compose(upper(), suffix("!"));
console.log(
	composed.readable,
	composed.writable,
	typeof composed.write,
	typeof composed.pipe,
);
const output = collect(composed);
composed.write("a");
composed.write("b");
composed.end("c");
console.log(await output);

const objectStage = new Transform({
	objectMode: true,
	transform(chunk, encoding, callback) {
		callback(null, { value: chunk.value * 2 });
	},
});
const objects = compose(new PassThrough({ objectMode: true }), objectStage);
console.log(objects.writableObjectMode, objects.readableObjectMode);
const doubled = [];
objects.on("data", (chunk) => doubled.push(chunk.value));
await new Promise((resolve) => {
	objects.on("end", resolve);
	objects.write({ value: 1 });
	objects.end({ value: 2 });
});
console.log(doubled.join(","));

const failing = new Transform({
	transform(chunk, encoding, callback) {
		callback(new Error("stage failed"));
	},
});
const broken = compose(new PassThrough(), failing);
const brokenError = await new Promise((resolve) => {
	broken.on("error", resolve);
	broken.resume();
	broken.write("x");
});
console.log(brokenError.message, broken.destroyed);

const inner = new PassThrough();
const outer = compose(new PassThrough(), inner);
const destroyed = await new Promise((resolve) => {
	outer.on("error", (error) => resolve(error));
	outer.on("close", () => resolve("closed"));
	outer.destroy(new Error("outer destroyed"));
});
console.log(destroyed.message ?? destroyed, inner.destroyed);

const sink = [];
const writableTail = compose(
	upper(),
	new Writable({
		write(chunk, encoding, callback) {
			sink.push(String(chunk));
			callback();
		},
	}),
);
console.log(writableTail.readable, writableTail.writable);
await new Promise((resolve) => {
	writableTail.on("finish", resolve);
	writableTail.end("tail");
});
console.log(sink.join(","));

const source = compose(Readable.from(["r1", "r2"], { objectMode: false }), upper());
console.log(source.writable, await collect(source));

const duplex = new PassThrough();
console.log(compose(duplex) === duplex);
for (const args of [
	[],
	[new Writable({ write() {} }), upper()],
	[upper(), new Readable({ read() {} })],
]) {
	try {
		compose(...args);
		console.log("composed");
	} catch (error) {
		console.log(error.name, error.code, error.message.split(". Received")[0]);
	}
}
const { Duplex } = await import("node:stream");
const halves = new Duplex({ readable: false, writable: false });
console.log(
	halves.readable,
	halves.writable,
	halves.readableEnded,
	halves.writableEnded,
	halves.writableFinished,
);
const modes = new Duplex({ readableObjectMode: true });
console.log(modes.readableObjectMode, modes.writableObjectMode);
