import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { finished, Stream, Writable } from "node:stream";

const selection = process.env.MAL_TEST_FINISHED_CASE;

function monitor(stream, options = {}) {
	let cleanup;
	const promise = new Promise((resolve, reject) => {
		cleanup = finished(stream, options, function (error) {
			assert.equal(this, stream);
			cleanup();
			if (error) reject(error);
			else resolve();
		});
	});
	return promise;
}

function legacyWritable() {
	const stream = new Stream();
	stream.writable = true;
	stream.write = () => true;
	return stream;
}

if (selection === "legacy") {
	for (const event of ["finish", "end", "close"]) {
		const stream = legacyWritable();
		const done = monitor(stream, { readable: false });
		stream.writable = false;
		stream.emit(event);
		await done;
		for (const name of ["finish", "end", "close", "error"])
			assert.equal(stream.listenerCount(name), 0);
	}
	const ended = legacyWritable();
	ended.writable = false;
	await monitor(ended, { readable: false });
	const readable = new Stream();
	readable.readable = true;
	readable.pipe = (destination) => destination;
	const done = monitor(readable);
	readable.readable = false;
	readable.emit("end");
	await done;
} else if (selection === "errors") {
	const premature = legacyWritable();
	const failed = monitor(premature);
	premature.emit("close");
	await assert.rejects(failed, { code: "ERR_STREAM_PREMATURE_CLOSE" });
	const broken = legacyWritable();
	const error = new Error("write failed");
	const errored = monitor(broken);
	broken.emit("error", error);
	await assert.rejects(errored, (caught) => caught === error);
	const modern = new Writable({
		write(chunk, encoding, callback) {
			callback();
		},
	});
	const modernDone = monitor(modern);
	modern.emit("close");
	await assert.rejects(modernDone, { code: "ERR_STREAM_PREMATURE_CLOSE" });
} else if (selection === "http") {
	let completed;
	const server = createServer((request, response) => {
		assert.equal(response.writable, true);
		completed = monitor(response);
		response.end("stream body");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const request = get(`http://127.0.0.1:${server.address().port}/`);
		const [response] = await once(request, "response");
		const chunks = [];
		for await (const chunk of response) chunks.push(chunk);
		assert.equal(Buffer.concat(chunks).toString(), "stream body");
		await completed;
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
} else {
	throw new Error(`Unknown case: ${selection}`);
}
console.log("LEGACY FINISHED PASS");
