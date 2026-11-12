import { PassThrough, Readable, Writable, pipeline } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";

function collector(sink) {
	return new Writable({
		objectMode: true,
		write(chunk, encoding, callback) {
			sink.push(String(chunk));
			callback();
		},
	});
}

const generated = [];
await new Promise((resolve) =>
	pipeline(
		async function* () {
			yield "a";
			yield "b";
		},
		async function* (source) {
			for await (const chunk of source) yield String(chunk).toUpperCase();
		},
		collector(generated),
		(error, value) => {
			console.log("generator source", error, value, generated.join(","));
			resolve();
		},
	),
);

const fromArray = [];
await pipelinePromise(["x", "y", "z"], collector(fromArray));
console.log("array source", fromArray.join(","));

const fromStream = [];
await pipelinePromise(
	Readable.from(["1", "2", "3"]),
	async function* (source) {
		for await (const chunk of source) yield `${chunk}!`;
	},
	new PassThrough({ objectMode: true }),
	collector(fromStream),
);
console.log("stream source", fromStream.join(","));

const consumed = await pipelinePromise(
	Readable.from(["p", "q"]),
	async function (source) {
		let text = "";
		for await (const chunk of source) text += chunk;
		return text.toUpperCase();
	},
);
console.log("consumer value", consumed);

const callbackValue = await new Promise((resolve) =>
	pipeline(
		["m", "n"],
		async (source) => {
			const parts = [];
			for await (const chunk of source) parts.push(chunk);
			return parts.join("+");
		},
		(error, value) => resolve([error, value]),
	),
);
console.log("callback value", JSON.stringify(callbackValue));

const failure = await pipelinePromise(async function* () {
	yield "ok";
	throw new Error("source failed");
}, collector([])).catch((error) => error.message);
console.log("source error", failure);

const consumerFailure = await pipelinePromise(["1"], async () => {
	throw new Error("consumer failed");
}).catch((error) => error.message);
console.log("consumer error", consumerFailure);

try {
	pipeline(
		() => 5,
		collector([]),
		() => {},
	);
} catch (error) {
	console.log(error.name, error.code, error.message);
}

const controller = new AbortController();
const aborted = pipelinePromise(
	async function* (options) {
		yield "first";
		await new Promise((resolve) => setTimeout(resolve, 50));
		yield "late";
	},
	collector([]),
	{ signal: controller.signal },
).catch((error) => [error.name, error.code]);
setTimeout(() => controller.abort(), 5);
console.log("aborted", JSON.stringify(await aborted));

const unended = new PassThrough({ objectMode: true });
await pipelinePromise(["keep"], unended, { end: false });
console.log("end false", unended.writableEnded, String(unended.read()));

const nodeUnended = new PassThrough({ objectMode: true });
await pipelinePromise(Readable.from(["keep-node"]), nodeUnended, { end: false });
console.log("node end false", nodeUnended.writableEnded, String(nodeUnended.read()));
nodeUnended.end();

const shared = new PassThrough({ objectMode: true });
const sharedChunks = [];
shared.on("data", (chunk) => sharedChunks.push(String(chunk)));
await Promise.all([
	pipelinePromise(Readable.from(["foo"]), shared, { end: false }),
	pipelinePromise(Readable.from(["bar", "baz"]), shared, { end: false }),
]);
console.log("shared destination", shared.writableEnded, sharedChunks.join(","));
shared.end();

const fanout = Readable.from(["both"]);
const automaticChunks = [];
const retainedChunks = [];
const automatic = collector(automaticChunks);
const retained = collector(retainedChunks);
fanout.pipe(automatic);
fanout.pipe(retained, { end: false });
await new Promise((resolve) => fanout.on("end", resolve));
console.log(
	"mixed end policy",
	automatic.writableEnded,
	retained.writableEnded,
	automaticChunks.join(","),
	retainedChunks.join(","),
);
retained.end();

const detachable = new PassThrough({ objectMode: true });
const removedChunks = [];
const remainingChunks = [];
const removed = collector(removedChunks);
const remaining = collector(remainingChunks);
detachable.pipe(removed, { end: false });
detachable.pipe(remaining, { end: false });
detachable.unpipe(removed);
detachable.end("remaining");
await new Promise((resolve) => detachable.on("end", resolve));
console.log(
	"unpipe retains end policy",
	remaining.writableEnded,
	removedChunks.join(","),
	remainingChunks.join(","),
);
removed.end();
remaining.end();

const webOut = [];
await pipelinePromise(
	new ReadableStream({
		start(controller) {
			controller.enqueue("w1");
			controller.enqueue("w2");
			controller.close();
		},
	}),
	new WritableStream({
		write(chunk) {
			webOut.push(chunk);
		},
	}),
);
console.log("web stages", webOut.join(","));
const nodeToWeb = [];
await pipelinePromise(
	Readable.from(["n1", "n2"]),
	new WritableStream({
		write(chunk) {
			nodeToWeb.push(String(chunk));
		},
	}),
);
console.log("node to web", nodeToWeb.join(","));
const webToNode = [];
await pipelinePromise(
	new ReadableStream({
		start(controller) {
			controller.enqueue("x1");
			controller.close();
		},
	}),
	collector(webToNode),
);
console.log("web to node", webToNode.join(","));
