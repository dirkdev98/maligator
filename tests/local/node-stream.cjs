let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

async function main() {
	const Stream = require("stream");
	const CanonicalStream = require("node:stream");
	const StreamPromises = require("stream/promises");
	const CanonicalStreamPromises = require("node:stream/promises");
	check(Stream === CanonicalStream, "bare/canonical identity");
	check(
		StreamPromises === CanonicalStreamPromises &&
			Stream.promises === StreamPromises &&
			typeof Stream.finished === "function" &&
			typeof Stream.pipeline === "function",
		"callback/promise CommonJS identity",
	);
	check(
		typeof Stream === "function" && Stream === Stream.Stream,
		"callable CommonJS export",
	);
	check(
		typeof Stream.Readable === "function" &&
			typeof Stream.Writable === "function" &&
			typeof Stream.Duplex === "function" &&
			typeof Stream.Transform === "function",
		"named constructor properties",
	);

	function LegacyTransform() {
		Stream.Transform.call(this);
	}
	LegacyTransform.prototype = Object.create(Stream.Transform.prototype);
	LegacyTransform.prototype.constructor = LegacyTransform;
	LegacyTransform.prototype._transform = function (chunk, encoding, done) {
		done(null, chunk + ":" + encoding);
	};

	const transform = new LegacyTransform();
	const output = [];
	transform.on("data", (chunk) => output.push(chunk));
	transform.end("cjs");
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	check(output.join(",") === "cjs:buffer", "CommonJS inherited transform");
	check(transform.readableEnded && transform.writableFinished, "CommonJS lifecycle");

	const legacy = Stream();
	let emitted = false;
	legacy.on("event", () => {
		emitted = true;
	});
	legacy.emit("event");
	check(emitted, "legacy Stream callable without new");

	console.log("RESULT " + passed + "/" + total);
}

main();
