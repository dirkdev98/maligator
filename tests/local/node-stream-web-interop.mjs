import { Readable } from "node:stream";

const node = Readable.from(["a", "b", "c"], { objectMode: true });
const web = Readable.toWeb(node);
console.log(Object.prototype.toString.call(web));
const chunks = [];
for await (const chunk of web) chunks.push(chunk);
console.log(chunks);

const bytes = new Readable({ read() {} });
const bytesWeb = Readable.toWeb(bytes);
bytes.push(Buffer.from("hi"));
bytes.push(null);
const reader = bytesWeb.getReader();
const first = await reader.read();
console.log(first.value instanceof Uint8Array, Buffer.isBuffer(first.value), [
	...first.value,
]);
console.log((await reader.read()).done);

const source = new ReadableStream({
	start(controller) {
		controller.enqueue("x");
		controller.enqueue("y");
		controller.close();
	},
});
const fromWeb = Readable.fromWeb(source, { objectMode: true });
const received = [];
fromWeb.on("data", (chunk) => received.push(chunk));
fromWeb.on("end", () => console.log("fromWeb", received));

const failing = new ReadableStream({
	pull(controller) {
		controller.error(new Error("web failure"));
	},
});
const failingNode = Readable.fromWeb(failing);
failingNode.on("error", (error) => console.log("fromWeb error", error.message));
failingNode.resume();
const { Writable } = await import("node:stream");
const sink = [];
const nodeWritable = new Writable({
	highWaterMark: 1,
	write(chunk, encoding, callback) {
		sink.push(String(chunk));
		setTimeout(callback, 1);
	},
});
const webWritable = Writable.toWeb(nodeWritable);
const webWriter = webWritable.getWriter();
await webWriter.write("p");
await webWriter.write("q");
await webWriter.close();
console.log("Writable.toWeb", sink, nodeWritable.writableFinished);

const webSink = [];
const target = new WritableStream({
	write(chunk) {
		webSink.push(chunk);
	},
	close() {
		webSink.push("closed");
	},
});
const nodeFromWeb = Writable.fromWeb(target, { objectMode: true });
nodeFromWeb.write("m");
await new Promise((resolve) =>
	nodeFromWeb.end("n", () => {
		console.log("Writable.fromWeb", webSink);
		resolve();
	}),
);
const { Duplex, PassThrough } = await import("node:stream");
const pass = new PassThrough();
const duplexWeb = Duplex.toWeb(pass);
console.log(
	Object.keys(duplexWeb),
	duplexWeb.readable instanceof ReadableStream,
	duplexWeb.writable instanceof WritableStream,
);
const duplexWriter = duplexWeb.writable.getWriter();
const duplexReader = duplexWeb.readable.getReader();
await duplexWriter.write(new TextEncoder().encode("ok"));
console.log("Duplex.toWeb", new TextDecoder().decode((await duplexReader.read()).value));

const transform = new TransformStream({
	transform(chunk, controller) {
		controller.enqueue(String(chunk).toUpperCase());
	},
});
const duplexFromWeb = Duplex.fromWeb(transform, { objectMode: true });
duplexFromWeb.on("data", (chunk) => console.log("Duplex.fromWeb", chunk));
duplexFromWeb.write("z");
