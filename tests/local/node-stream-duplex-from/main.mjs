import { compose, Duplex, PassThrough, pipeline, Readable, Writable } from "node:stream";

async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(String(chunk));
	return chunks.join("|");
}

console.log(Duplex.from.length, JSON.stringify(Duplex.from.name));
const duplex = new PassThrough();
console.log(Duplex.from(duplex) === duplex);

const upper = Duplex.from(async function* (source) {
	for await (const chunk of source) yield String(chunk).toUpperCase();
});
console.log(
	upper instanceof Duplex,
	upper.readable,
	upper.writable,
	upper.readableObjectMode,
);
const upperOut = collect(upper);
upper.write("a");
upper.write("b");
upper.end();
console.log("generator", await upperOut);

const sunk = [];
const sink = Duplex.from(async function (source) {
	for await (const chunk of source) sunk.push(String(chunk));
});
console.log(sink.readable, sink.writable);
await new Promise((resolve) => {
	sink.on("finish", resolve);
	sink.write("x");
	sink.end("y");
});
console.log("async sink", sunk.join(","));

console.log("iterable", await collect(Duplex.from(["i1", "i2"])));
console.log(
	"async iterable",
	await collect(
		Duplex.from(
			(async function* () {
				yield "g1";
				yield "g2";
			})(),
		),
	),
);
console.log("promise", await collect(Duplex.from(Promise.resolve("p1"))));
console.log("readable", await collect(Duplex.from(Readable.from(["r1", "r2"]))));

const written = [];
const writableOnly = Duplex.from(
	new Writable({
		write(chunk, encoding, callback) {
			written.push(String(chunk));
			callback();
		},
	}),
);
console.log(writableOnly.readable, writableOnly.writable);
await new Promise((resolve) => writableOnly.end("w1", resolve));
console.log("writable", written.join(","));

const pairSink = [];
const pair = Duplex.from({
	readable: Readable.from(["pr"]),
	writable: new Writable({
		write(chunk, encoding, callback) {
			pairSink.push(String(chunk));
			callback();
		},
	}),
});
pair.write("pw");
pair.end();
console.log("pair", await collect(pair), pairSink.join(","));

console.log(
	"web",
	await collect(
		Duplex.from(
			new ReadableStream({
				start(c) {
					c.enqueue("web1");
					c.close();
				},
			}),
		),
	),
);
console.log(
	"blob",
	await collect(Duplex.from(new Blob(["blob-text"]))).then((text) => text.length),
);

for (const body of [5, () => 5, null]) {
	try {
		Duplex.from(body);
		console.log("created");
	} catch (error) {
		console.log(error.name, error.code, error.message.split(". Received")[0]);
	}
}

const composed = compose(
	async function* (source) {
		for await (const chunk of source) yield `<${chunk}>`;
	},
	new PassThrough({ objectMode: true }),
);
const composedOut = collect(composed);
composed.end("c1");
console.log("compose function head", await composedOut);

const single = compose(async function* (source) {
	for await (const chunk of source) yield `[${chunk}]`;
});
const singleOut = collect(single);
single.end("s1");
console.log("compose single", await singleOut);

const tailed = [];
await new Promise((resolve) =>
	pipeline(
		Readable.from(["t1", "t2"]),
		compose(new PassThrough({ objectMode: true }), async function* (source) {
			for await (const chunk of source) yield String(chunk).toUpperCase();
		}),
		new Writable({
			objectMode: true,
			write(chunk, encoding, callback) {
				tailed.push(chunk);
				callback();
			},
		}),
		(error) => {
			console.log("compose tail in pipeline", error, tailed.join(","));
			resolve();
		},
	),
);
