async function collect(readable) {
	const chunks = [];
	for await (const chunk of readable) chunks.push(chunk);
	return chunks;
}

const upper = new TransformStream({
	start(controller) {
		console.log("start", typeof controller.enqueue, controller.desiredSize);
	},
	transform(chunk, controller) {
		controller.enqueue(String(chunk).toUpperCase());
	},
	flush(controller) {
		controller.enqueue("!");
	},
});
const writer = upper.writable.getWriter();
writer.write("a");
writer.write("b");
writer.close();
console.log(await collect(upper.readable));

const identity = new TransformStream();
const piped = new ReadableStream({
	start(controller) {
		controller.enqueue(1);
		controller.enqueue(2);
		controller.close();
	},
}).pipeThrough(identity);
console.log(await collect(piped));

const failing = new TransformStream({
	transform() {
		throw new Error("bad chunk");
	},
});
const failingRead = failing.readable
	.getReader()
	.read()
	.catch((error) => `read rejected ${error.message}`);
const failingWriter = failing.writable.getWriter();
const failingWrite = failingWriter
	.write("x")
	.catch((error) => `write rejected ${error.message}`);
console.log(await failingWrite);
console.log(await failingRead);

const terminated = new TransformStream({
	transform(chunk, controller) {
		controller.enqueue(chunk);
		controller.terminate();
	},
});
const terminatedWriter = terminated.writable.getWriter();
terminatedWriter.write("only");
console.log(await collect(terminated.readable));
await terminatedWriter
	.write("late")
	.catch((error) => console.log("after terminate", error.constructor.name));

const backpressure = new TransformStream({}, undefined, { highWaterMark: 1 });
const bpWriter = backpressure.writable.getWriter();
console.log("desired", bpWriter.desiredSize);
bpWriter.write("x");
console.log("desired after write", bpWriter.desiredSize);

try {
	new TransformStream({ readableType: "bytes" });
} catch (error) {
	console.log(error.constructor.name);
}
console.log(
	Object.prototype.toString.call(new TransformStream()),
	typeof TransformStreamDefaultController,
);

const encoded = await collect(
	new ReadableStream({
		start(controller) {
			controller.enqueue("h\ud83d");
			controller.enqueue("\ude00!");
			controller.close();
		},
	}).pipeThrough(new TextEncoderStream()),
);
console.log(encoded.map((chunk) => [...chunk]));

const euro = new TextEncoder().encode("€uro");
const decoded = await collect(
	new ReadableStream({
		start(controller) {
			controller.enqueue(euro.subarray(0, 1));
			controller.enqueue(euro.subarray(1));
			controller.close();
		},
	}).pipeThrough(new TextDecoderStream()),
);
console.log(
	decoded,
	new TextDecoderStream("utf-8", { fatal: true }).fatal,
	new TextEncoderStream().encoding,
);

async function roundTrip(format) {
	const input = new TextEncoder().encode("hello hello hello compression ".repeat(20));
	const compressed = await collect(
		new ReadableStream({
			start(controller) {
				controller.enqueue(input);
				controller.close();
			},
		}).pipeThrough(new CompressionStream(format)),
	);
	const restored = await collect(
		new ReadableStream({
			start(controller) {
				for (const chunk of compressed) controller.enqueue(chunk);
				controller.close();
			},
		})
			.pipeThrough(new DecompressionStream(format))
			.pipeThrough(new TextDecoderStream()),
	);
	const total = compressed.reduce((sum, chunk) => sum + chunk.length, 0);
	console.log(
		format,
		total < input.length,
		restored.join("") === new TextDecoder().decode(input),
	);
}
await roundTrip("gzip");
await roundTrip("deflate");
await roundTrip("deflate-raw");
try {
	new CompressionStream("brotli-ish");
} catch (error) {
	console.log(error.constructor.name);
}
const broken = new DecompressionStream("gzip");
const brokenWriter = broken.writable.getWriter();
brokenWriter.write(new Uint8Array([1, 2, 3])).catch(() => {});
await broken.readable
	.getReader()
	.read()
	.catch((error) => console.log("bad gzip", error.constructor.name));
