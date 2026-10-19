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
